"""Async matching worker integrating swap-service snapshots and RabbitMQ kirana.events."""

import json
import uuid
from collections.abc import Awaitable, Callable
from datetime import date
from typing import Any

import aio_pika
import httpx
import structlog
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection

from .config import settings
from .models import MatchAssignment, StateMatchingSnapshot, build_match_found_envelope
from .solver import solve_bipartite_matches

logger = structlog.get_logger("swap.matcher.worker")

KIRANA_EVENTS_EXCHANGE = "kirana.events"
KIRANA_DLX_EXCHANGE = "kirana.dlx"
MATCHER_QUEUE_NAME = "swap.matcher.listings"
MATCH_FOUND_ROUTING_KEY = "swap.match.found.v1"
LISTING_CREATED_ROUTING_KEY = "swap.listing.created.v1"

PublishFn = Callable[[str, bytes, dict[str, Any]], Awaitable[None]]


class SwapMatcherWorker:
    """Fetches state snapshots from swap-service, solves min-cost matches, emits events."""

    def __init__(
        self,
        *,
        swap_service_url: str | None = None,
        amqp_url: str | None = None,
        max_radius_km: float | None = None,
        http_client: httpx.AsyncClient | None = None,
        publisher: PublishFn | None = None,
    ) -> None:
        self._swap_service_url = (swap_service_url or settings.swap_service_url).rstrip("/")
        self._amqp_url = amqp_url or settings.rabbitmq_url
        self._max_radius_km = max_radius_km if max_radius_km is not None else settings.max_radius_km
        self._http_client = http_client
        self._owns_http_client = http_client is None
        self._publisher = publisher

        self._connection: AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractChannel | None = None
        self._events_exchange: aio_pika.abc.AbstractExchange | None = None

    async def _get_http_client(self) -> httpx.AsyncClient:
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(timeout=settings.http_timeout_seconds)
        return self._http_client

    async def connect_rabbit(self) -> None:
        """Connect to RabbitMQ with publisher confirms enabled."""
        if self._publisher is not None:
            return
        self._connection = await aio_pika.connect_robust(self._amqp_url)
        self._channel = await self._connection.channel(publisher_confirms=True)
        await self._channel.set_qos(prefetch_count=10)
        self._events_exchange = await self._channel.declare_exchange(
            KIRANA_EVENTS_EXCHANGE,
            type=aio_pika.ExchangeType.TOPIC,
            durable=True,
        )
        await self._channel.declare_exchange(
            KIRANA_DLX_EXCHANGE,
            type=aio_pika.ExchangeType.DIRECT,
            durable=True,
        )

    async def close(self) -> None:
        if self._owns_http_client and self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None
        if self._channel is not None and not self._channel.is_closed:
            await self._channel.close()
        if self._connection is not None and not self._connection.is_closed:
            await self._connection.close()

    async def _publish(self, routing_key: str, body: bytes, headers: dict[str, Any]) -> None:
        if self._publisher is not None:
            await self._publisher(routing_key, body, headers)
            return

        if self._events_exchange is None:
            await self.connect_rabbit()
        assert self._events_exchange is not None

        msg = aio_pika.Message(
            body=body,
            content_type="application/json",
            headers=headers,
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
        )
        await self._events_exchange.publish(msg, routing_key=routing_key)

    async def fetch_state_snapshot(
        self,
        state: str,
        *,
        correlation_id: str,
    ) -> StateMatchingSnapshot:
        """Fetch OPEN listings and shortages for a single state from swap-service."""
        client = await self._get_http_client()
        url = f"{self._swap_service_url}/v1/swaps/internal/matching-snapshot"
        resp = await client.get(
            url,
            params={"state": state},
            headers={
                "x-internal-service": "swap-matcher",
                "x-correlation-id": correlation_id,
            },
        )
        resp.raise_for_status()
        return StateMatchingSnapshot.model_validate(resp.json())

    async def run_for_state(
        self,
        state: str,
        *,
        as_of_date: date | None = None,
        correlation_id: str | None = None,
    ) -> list[MatchAssignment]:
        """Run a full min-cost matching cycle for `state` and publish swap.match.found.v1."""
        corr_id = correlation_id or str(uuid.uuid4())
        snapshot = await self.fetch_state_snapshot(state, correlation_id=corr_id)
        listings, shortages = snapshot.hydrated_items()

        matches = solve_bipartite_matches(
            listings,
            shortages,
            as_of_date=as_of_date,
            max_radius_km=self._max_radius_km,
        )

        for match in matches:
            envelope = build_match_found_envelope(match, correlation_id=corr_id)
            body = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
            await self._publish(
                MATCH_FOUND_ROUTING_KEY,
                body,
                {
                    "x-correlation-id": envelope["correlationId"],
                    "x-event-id": envelope["id"],
                },
            )

        logger.info(
            "Completed state bipartite matching pass",
            state=state,
            listings=len(listings),
            shortages=len(shortages),
            matches=len(matches),
            correlation_id=corr_id,
        )
        return matches

    async def start_consuming(self) -> None:
        """Listen for swap.listing.created.v1 and trigger state-scoped batch matching."""
        await self.connect_rabbit()
        assert self._channel is not None and self._events_exchange is not None

        queue = await self._channel.declare_queue(
            MATCHER_QUEUE_NAME,
            durable=True,
            arguments={
                "x-dead-letter-exchange": KIRANA_DLX_EXCHANGE,
                "x-dead-letter-routing-key": f"{MATCHER_QUEUE_NAME}.dlq",
            },
        )
        await queue.bind(self._events_exchange, routing_key=LISTING_CREATED_ROUTING_KEY)
        await queue.consume(self._on_listing_created)
        logger.info("Swap matcher listening for listing events", queue=MATCHER_QUEUE_NAME)

    async def _on_listing_created(self, message: AbstractIncomingMessage) -> None:
        try:
            envelope = json.loads(message.body.decode("utf-8"))
            payload = envelope.get("payload") or {}
            state = payload.get("state")
            corr_id = envelope.get("correlationId") or str(uuid.uuid4())
            if state:
                await self.run_for_state(str(state), correlation_id=str(corr_id))
            await message.ack()
        except Exception as exc:  # noqa: BLE001
            logger.error("Failed processing swap.listing.created.v1", error=str(exc))
            await message.reject(requeue=False)

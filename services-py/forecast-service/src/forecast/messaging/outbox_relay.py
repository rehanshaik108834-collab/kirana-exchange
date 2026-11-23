"""Transactional outbox relay for Kirana Forecast Service (ADR-003)."""

import json
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import aio_pika
import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..api.metrics import metrics
from ..db.models import OutboxEvent
from .consumer import KIRANA_EVENTS_EXCHANGE

logger = structlog.get_logger("forecast.outbox_relay")

PublishFn = Callable[[str, bytes, dict[str, Any]], Awaitable[None]]


def build_event_envelope(event: OutboxEvent) -> dict[str, Any]:
    """Serialize an OutboxEvent row into the canonical KiranaEventEnvelope."""
    occurred = event.occurred_at
    if occurred.tzinfo is None:
        occurred = occurred.replace(tzinfo=UTC)
    return {
        "id": str(event.id),
        "type": event.event_type,
        "version": int(event.version),
        "occurredAt": occurred.isoformat(),
        "correlationId": str(event.correlation_id),
        "producer": event.producer,
        "payload": event.payload,
    }


class ForecastOutboxRelay:
    """Polls unpublished outbox_events and publishes them to kirana.events with confirms."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        *,
        amqp_url: str | None = None,
        publisher: PublishFn | None = None,
        batch_size: int = 50,
    ) -> None:
        self._session_factory = session_factory
        self._amqp_url = amqp_url
        self._publisher = publisher
        self._batch_size = batch_size
        self._connection: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractChannel | None = None
        self._exchange: aio_pika.abc.AbstractExchange | None = None

    async def connect(self) -> None:
        """Establish RabbitMQ connection with publisher confirms enabled."""
        if self._publisher is not None:
            return
        if not self._amqp_url:
            raise ValueError("amqp_url is required when no custom publisher is supplied")

        self._connection = await aio_pika.connect_robust(self._amqp_url)
        self._channel = await self._connection.channel(publisher_confirms=True)
        self._exchange = await self._channel.declare_exchange(
            KIRANA_EVENTS_EXCHANGE,
            type=aio_pika.ExchangeType.TOPIC,
            durable=True,
        )
        logger.info("Forecast outbox relay connected to RabbitMQ")

    async def close(self) -> None:
        if self._channel is not None and not self._channel.is_closed:
            await self._channel.close()
        if self._connection is not None and not self._connection.is_closed:
            await self._connection.close()

    async def _publish(self, routing_key: str, body: bytes, headers: dict[str, Any]) -> None:
        if self._publisher is not None:
            await self._publisher(routing_key, body, headers)
            return

        if self._exchange is None:
            await self.connect()
        assert self._exchange is not None

        msg = aio_pika.Message(
            body=body,
            content_type="application/json",
            headers=headers,
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
        )
        await self._exchange.publish(msg, routing_key=routing_key, mandatory=False)

    async def relay_once(self, *, kill_after_publish_count: int | None = None) -> int:
        """Relay one locked batch of unpublished outbox events.

        If `kill_after_publish_count` is set (fault-injection testing), raises RuntimeError
        after publishing N messages so the DB transaction rolls back and leaves those rows
        unpublished for at-least-once recovery on the next run.
        """
        published = 0
        async with self._session_factory() as session:
            async with session.begin():
                bind = session.bind
                is_sqlite = bind is not None and bind.dialect.name == "sqlite"

                stmt = (
                    select(OutboxEvent)
                    .where(OutboxEvent.published_at.is_(None))
                    .order_by(OutboxEvent.occurred_at.asc())
                    .limit(self._batch_size)
                )
                if not is_sqlite:
                    stmt = stmt.with_for_update(skip_locked=True)

                rows = list((await session.execute(stmt)).scalars().all())
                if not rows:
                    return 0

                now_utc = datetime.now(UTC)
                for row in rows:
                    envelope = build_event_envelope(row)
                    body = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
                    headers = {
                        "x-correlation-id": str(row.correlation_id),
                        "x-event-id": str(row.id),
                    }
                    await self._publish(row.event_type, body, headers)
                    published += 1

                    if (
                        kill_after_publish_count is not None
                        and published >= kill_after_publish_count
                    ):
                        raise RuntimeError(
                            f"Simulated relay crash after publishing {published} event(s)"
                        )

                    row.published_at = now_utc

        metrics.inc_outbox_published(published)
        logger.info("Relayed forecast outbox batch", count=published)
        return published

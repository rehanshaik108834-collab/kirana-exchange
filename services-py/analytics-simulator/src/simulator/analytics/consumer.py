"""Idempotent RabbitMQ CQRS projection consumer for analytics_db."""

import json
import uuid
from datetime import UTC, date, datetime
from typing import Any

import aio_pika
import structlog
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = structlog.get_logger("analytics.consumer")

KIRANA_EVENTS_EXCHANGE = "kirana.events"
KIRANA_DLX_EXCHANGE = "kirana.dlx"
ANALYTICS_QUEUE_NAME = "analytics.cqrs.projections"
ANALYTICS_CONSUMER_NAME = "analytics-cqrs-consumer"

ANALYTICS_BINDING_KEYS: tuple[str, ...] = (
    "shop.created.v1",
    "shop.moved.v1",
    "swap.listing.created.v1",
    "saga.swap.completed.v1",
    "saga.swap.cancelled.v1",
    "groupbuy.window.closed.v1",
)


def _parse_event_date(occurred_at: Any) -> date:
    if isinstance(occurred_at, datetime):
        return occurred_at.date()
    if isinstance(occurred_at, date):
        return occurred_at
    if isinstance(occurred_at, str) and occurred_at:
        try:
            return datetime.fromisoformat(occurred_at).date()
        except ValueError:
            return date.fromisoformat(occurred_at[:10])
    return datetime.now(UTC).date()


def _bind_uuid(val: str | uuid.UUID, is_sqlite: bool) -> str | uuid.UUID:
    parsed = val if isinstance(val, uuid.UUID) else uuid.UUID(str(val))
    return str(parsed) if is_sqlite else parsed


async def _upsert_metrics_delta(
    session: AsyncSession,
    *,
    metric_date: date,
    is_sqlite: bool,
    dead_stock_delta: float = 0.0,
    stockouts_delta: int = 0,
    cash_delta: float = 0.0,
    swaps_completed_delta: int = 0,
    swaps_failed_delta: int = 0,
    groupbuy_savings_delta: float = 0.0,
) -> None:
    now_fn = "CURRENT_TIMESTAMP" if is_sqlite else "NOW()"
    sql = text(
        f"""
        INSERT INTO network_metrics_projection
            (metric_date, dead_stock_value_reduced, stockouts_avoided,
             cash_released, swaps_completed, swaps_failed, groupbuy_savings, updated_at)
        VALUES
            (:metric_date, :dead_stock, :stockouts,
             :cash, :completed, :failed, :gb_savings, {now_fn})
        ON CONFLICT (metric_date) DO UPDATE SET
            dead_stock_value_reduced =
                network_metrics_projection.dead_stock_value_reduced + EXCLUDED.dead_stock_value_reduced,
            stockouts_avoided =
                network_metrics_projection.stockouts_avoided + EXCLUDED.stockouts_avoided,
            cash_released =
                network_metrics_projection.cash_released + EXCLUDED.cash_released,
            swaps_completed =
                network_metrics_projection.swaps_completed + EXCLUDED.swaps_completed,
            swaps_failed =
                network_metrics_projection.swaps_failed + EXCLUDED.swaps_failed,
            groupbuy_savings =
                network_metrics_projection.groupbuy_savings + EXCLUDED.groupbuy_savings,
            updated_at = {now_fn}
        """
    )
    await session.execute(
        sql,
        {
            "metric_date": metric_date,
            "dead_stock": round(dead_stock_delta, 2),
            "stockouts": int(stockouts_delta),
            "cash": round(cash_delta, 2),
            "completed": int(swaps_completed_delta),
            "failed": int(swaps_failed_delta),
            "gb_savings": round(groupbuy_savings_delta, 2),
        },
    )


async def apply_analytics_event_atomic(
    session: AsyncSession,
    envelope: dict[str, Any],
) -> bool:
    """Apply one KiranaEventEnvelope into analytics_db projections inside an open transaction.

    Returns True if applied, False if duplicate (already recorded in processed_messages).
    """
    raw_id = envelope.get("id") or envelope.get("messageId")
    if not raw_id:
        logger.error("Analytics event missing message id", envelope=envelope)
        return False

    bind = session.bind
    is_sqlite = bind is not None and bind.dialect.name == "sqlite"
    now_fn = "CURRENT_TIMESTAMP" if is_sqlite else "NOW()"
    max_fn = "MAX" if is_sqlite else "GREATEST"
    min_fn = "MIN" if is_sqlite else "LEAST"

    message_id = _bind_uuid(str(raw_id), is_sqlite)

    # 1. Atomic idempotency check
    dedup_sql = text(
        f"""
        INSERT INTO processed_messages (message_id, consumer_name, processed_at)
        VALUES (:message_id, :consumer_name, {now_fn})
        ON CONFLICT (message_id, consumer_name) DO NOTHING
        RETURNING message_id
        """
    )
    inserted = (
        await session.execute(
            dedup_sql,
            {"message_id": message_id, "consumer_name": ANALYTICS_CONSUMER_NAME},
        )
    ).scalar_one_or_none()
    if inserted is None:
        logger.info("Duplicate analytics event ignored", message_id=str(raw_id))
        return False

    event_type = str(envelope.get("type") or envelope.get("eventType") or "")
    payload = envelope.get("payload") or {}
    metric_date = _parse_event_date(envelope.get("occurredAt"))

    if event_type == "shop.created.v1":
        shop_id_str = str(payload["shopId"])
        name = str(payload.get("name") or f"Kirana Shop {shop_id_str[:8]}")
        await session.execute(
            text(
                f"""
                INSERT INTO shop_map_projection
                    (shop_id, name, lat, lng, state, reputation_score, active_listings_count, updated_at)
                VALUES
                    (:shop_id, :name, :lat, :lng, :state, 100.00, 0, {now_fn})
                ON CONFLICT (shop_id) DO UPDATE SET
                    name = EXCLUDED.name,
                    lat = EXCLUDED.lat,
                    lng = EXCLUDED.lng,
                    state = EXCLUDED.state,
                    updated_at = {now_fn}
                """
            ),
            {
                "shop_id": _bind_uuid(shop_id_str, is_sqlite),
                "name": name[:120],
                "lat": round(float(payload["lat"]), 6),
                "lng": round(float(payload["lng"]), 6),
                "state": str(payload["state"]),
            },
        )

    elif event_type == "shop.moved.v1":
        shop_id_str = str(payload["shopId"])
        await session.execute(
            text(
                f"""
                UPDATE shop_map_projection
                SET lat = :lat, lng = :lng, state = :state, updated_at = {now_fn}
                WHERE shop_id = :shop_id
                """
            ),
            {
                "shop_id": _bind_uuid(shop_id_str, is_sqlite),
                "lat": round(float(payload["lat"]), 6),
                "lng": round(float(payload["lng"]), 6),
                "state": str(payload["state"]),
            },
        )

    elif event_type == "swap.listing.created.v1":
        shop_id_str = str(payload["shopId"])
        await session.execute(
            text(
                f"""
                UPDATE shop_map_projection
                SET active_listings_count = active_listings_count + 1, updated_at = {now_fn}
                WHERE shop_id = :shop_id
                """
            ),
            {"shop_id": _bind_uuid(shop_id_str, is_sqlite)},
        )

    elif event_type == "saga.swap.completed.v1":
        qty = max(0, int(payload.get("qty", 0)))
        price = max(0.0, float(payload.get("price", 0.0)))
        value = round(qty * price, 2)
        seller_id = payload.get("sellerShopId")
        buyer_id = payload.get("buyerShopId")

        if seller_id:
            await session.execute(
                text(
                    f"""
                    UPDATE shop_map_projection
                    SET active_listings_count = {max_fn}(0, active_listings_count - 1),
                        reputation_score = {min_fn}(100.00, reputation_score + 2.00),
                        updated_at = {now_fn}
                    WHERE shop_id = :shop_id
                    """
                ),
                {"shop_id": _bind_uuid(str(seller_id), is_sqlite)},
            )
        if buyer_id and str(buyer_id) != str(seller_id):
            await session.execute(
                text(
                    f"""
                    UPDATE shop_map_projection
                    SET reputation_score = {min_fn}(100.00, reputation_score + 2.00),
                        updated_at = {now_fn}
                    WHERE shop_id = :shop_id
                    """
                ),
                {"shop_id": _bind_uuid(str(buyer_id), is_sqlite)},
            )

        await _upsert_metrics_delta(
            session,
            metric_date=metric_date,
            is_sqlite=is_sqlite,
            dead_stock_delta=value,
            stockouts_delta=qty,
            cash_delta=value,
            swaps_completed_delta=1,
        )

    elif event_type == "saga.swap.cancelled.v1":
        reason = str(payload.get("reason") or "")
        buyer_id = payload.get("buyerShopId")
        if buyer_id and reason in ("BUYER_TIMEOUT", "NO_SHOW"):
            await session.execute(
                text(
                    f"""
                    UPDATE shop_map_projection
                    SET reputation_score = {max_fn}(0.00, reputation_score - 10.00),
                        updated_at = {now_fn}
                    WHERE shop_id = :shop_id
                    """
                ),
                {"shop_id": _bind_uuid(str(buyer_id), is_sqlite)},
            )

        await _upsert_metrics_delta(
            session,
            metric_date=metric_date,
            is_sqlite=is_sqlite,
            swaps_failed_delta=1,
        )

    elif event_type == "groupbuy.window.closed.v1":
        outcome = str(payload.get("outcome") or "")
        savings = max(0.0, float(payload.get("totalSavings", 0.0)))
        if outcome == "ALLOCATING" and savings > 0.0:
            await _upsert_metrics_delta(
                session,
                metric_date=metric_date,
                is_sqlite=is_sqlite,
                groupbuy_savings_delta=savings,
            )

    return True


class AnalyticsProjectionConsumer:
    """Consumes domain events from kirana.events to maintain analytics_db read models."""

    def __init__(self, amqp_url: str, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._amqp_url = amqp_url
        self._session_factory = session_factory
        self._connection: AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractChannel | None = None

    async def start(self) -> None:
        self._connection = await aio_pika.connect_robust(self._amqp_url)
        self._channel = await self._connection.channel()
        await self._channel.set_qos(prefetch_count=20)

        events_exchange = await self._channel.declare_exchange(
            KIRANA_EVENTS_EXCHANGE,
            type=aio_pika.ExchangeType.TOPIC,
            durable=True,
        )
        await self._channel.declare_exchange(
            KIRANA_DLX_EXCHANGE,
            type=aio_pika.ExchangeType.DIRECT,
            durable=True,
        )
        queue = await self._channel.declare_queue(
            ANALYTICS_QUEUE_NAME,
            durable=True,
            arguments={
                "x-dead-letter-exchange": KIRANA_DLX_EXCHANGE,
                "x-dead-letter-routing-key": f"{ANALYTICS_QUEUE_NAME}.dlq",
            },
        )
        for key in ANALYTICS_BINDING_KEYS:
            await queue.bind(events_exchange, routing_key=key)

        await queue.consume(self._on_message)
        logger.info("Analytics CQRS consumer listening", queue=ANALYTICS_QUEUE_NAME)

    async def _on_message(self, message: AbstractIncomingMessage) -> None:
        try:
            envelope = json.loads(message.body.decode("utf-8"))
            async with self._session_factory() as session, session.begin():
                await apply_analytics_event_atomic(session, envelope)
            await message.ack()
        except Exception as exc:  # noqa: BLE001
            logger.error("Failed projecting analytics event", error=str(exc))
            await message.reject(requeue=False)

    async def close(self) -> None:
        if self._channel is not None and not self._channel.is_closed:
            await self._channel.close()
        if self._connection is not None and not self._connection.is_closed:
            await self._connection.close()

"""Idempotent RabbitMQ event consumer for Kirana Forecast Service."""

import json
import uuid
from datetime import UTC, date, datetime
from typing import Any

import aio_pika
import structlog
from aio_pika.abc import AbstractIncomingMessage, AbstractRobustConnection
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = structlog.get_logger("forecast.consumer")

KIRANA_EVENTS_EXCHANGE = "kirana.events"
KIRANA_DLX_EXCHANGE = "kirana.dlx"
QUEUE_NAME = "forecast.inventory.events"
CONSUMER_NAME = "forecast-inventory-consumer"
RETRY_DELAYS_MS = (5_000, 30_000, 300_000)
MAX_RETRIES = 3


def _parse_date(val: Any) -> date:
    """Parse string or datetime to date object."""
    if isinstance(val, date) and not isinstance(val, datetime):
        return val
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, str):
        # Handle ISO strings like '2026-11-23T10:00:00.000Z' or '2026-11-23'
        clean = val.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(clean).date()
        except ValueError:
            return date.fromisoformat(val[:10])
    return datetime.now(UTC).date()


async def handle_event_atomic(
    session: AsyncSession,
    envelope: dict[str, Any],
) -> bool:
    """Process one KiranaEventEnvelope inside an already-open DB transaction.

    Returns True if newly applied, False if duplicate (already in processed_messages).
    """
    raw_message_id = envelope.get("id") or envelope.get("messageId")
    if not raw_message_id:
        logger.error("Event envelope missing message id", envelope=envelope)
        return False

    message_id = uuid.UUID(str(raw_message_id))
    event_type = envelope.get("type") or envelope.get("eventType")
    payload = envelope.get("payload", {})

    # Detect database dialect for SQL compatibility (PostgreSQL vs SQLite for unit tests)
    bind = session.bind
    is_sqlite = bind is not None and bind.dialect.name == "sqlite"
    now_fn = "CURRENT_TIMESTAMP" if is_sqlite else "NOW()"

    # 1. Atomic idempotency check in processed_messages
    dedup_sql = text(
        f"""
        INSERT INTO processed_messages (message_id, consumer_name, processed_at)
        VALUES (:message_id, :consumer_name, {now_fn})
        ON CONFLICT (message_id, consumer_name) DO NOTHING
        RETURNING message_id
        """
    )
    result = await session.execute(
        dedup_sql,
        {
            "message_id": str(message_id) if is_sqlite else message_id,
            "consumer_name": CONSUMER_NAME,
        },
    )
    inserted = result.scalar_one_or_none()
    if inserted is None:
        logger.info(
            "Duplicate event discarded via processed_messages",
            message_id=str(message_id),
            event_type=event_type,
        )
        return False

    # 2. Branch on event type
    if event_type == "inventory.sale.recorded.v1":
        shop_id = uuid.UUID(str(payload["shopId"]))
        product_id = uuid.UUID(str(payload["productId"]))
        qty_sold = int(payload.get("qty", 0))
        stockout_flag = bool(payload.get("stockoutFlag", False))
        sale_date = _parse_date(payload.get("soldAt"))

        stockout_expr = (
            "(sales_history_read_model.stockout_flag OR :stockout_flag)"
            if is_sqlite
            else "sales_history_read_model.stockout_flag OR EXCLUDED.stockout_flag"
        )
        upsert_sales_sql = text(
            f"""
            INSERT INTO sales_history_read_model
                (shop_id, product_id, sale_date, qty_sold, stockout_flag, updated_at)
            VALUES
                (:shop_id, :product_id, :sale_date, :qty_sold, :stockout_flag, {now_fn})
            ON CONFLICT (shop_id, product_id, sale_date) DO UPDATE SET
                qty_sold = sales_history_read_model.qty_sold + EXCLUDED.qty_sold,
                stockout_flag = {stockout_expr},
                updated_at = {now_fn}
            """
        )
        await session.execute(
            upsert_sales_sql,
            {
                "shop_id": str(shop_id) if is_sqlite else shop_id,
                "product_id": str(product_id) if is_sqlite else product_id,
                "sale_date": sale_date,
                "qty_sold": qty_sold,
                "stockout_flag": stockout_flag,
            },
        )
        logger.info(
            "Updated sales_history_read_model",
            shop_id=str(shop_id),
            product_id=str(product_id),
            sale_date=str(sale_date),
            qty_sold=qty_sold,
            stockout_flag=stockout_flag,
        )

    elif event_type == "inventory.stock.updated.v1":
        batch_id = uuid.UUID(str(payload["batchId"]))
        shop_id = uuid.UUID(str(payload["shopId"]))
        product_id = uuid.UUID(str(payload["productId"]))
        qty = int(payload.get("qty", 0))
        reserved_qty = int(payload.get("reservedQty", 0))
        cost_price = float(payload.get("costPrice", 0.0))
        expiry_date = _parse_date(payload["expiryDate"])

        upsert_batch_sql = text(
            f"""
            INSERT INTO batch_snapshot_read_model
                (batch_id, shop_id, product_id, qty, reserved_qty,
                 cost_price, expiry_date, updated_at)
            VALUES
                (:batch_id, :shop_id, :product_id, :qty, :reserved_qty,
                 :cost_price, :expiry_date, {now_fn})
            ON CONFLICT (batch_id) DO UPDATE SET
                shop_id = EXCLUDED.shop_id,
                product_id = EXCLUDED.product_id,
                qty = EXCLUDED.qty,
                reserved_qty = EXCLUDED.reserved_qty,
                cost_price = EXCLUDED.cost_price,
                expiry_date = EXCLUDED.expiry_date,
                updated_at = {now_fn}
            """
        )
        await session.execute(
            upsert_batch_sql,
            {
                "batch_id": str(batch_id) if is_sqlite else batch_id,
                "shop_id": str(shop_id) if is_sqlite else shop_id,
                "product_id": str(product_id) if is_sqlite else product_id,
                "qty": qty,
                "reserved_qty": reserved_qty,
                "cost_price": cost_price,
                "expiry_date": expiry_date,
            },
        )
        logger.info(
            "Updated batch_snapshot_read_model",
            batch_id=str(batch_id),
            shop_id=str(shop_id),
            product_id=str(product_id),
            qty=qty,
            reserved_qty=reserved_qty,
        )

    return True


class ForecastEventConsumer:
    """Connects to RabbitMQ, asserts durable queue + retry/dlq topology, and consumes events."""

    def __init__(self, amqp_url: str, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._amqp_url = amqp_url
        self._session_factory = session_factory
        self._connection: AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractChannel | None = None
        self._dlx_exchange: aio_pika.abc.AbstractExchange | None = None

    async def start(self) -> None:
        """Assert exchanges, queues, and bindings, then start consuming."""
        logger.info("Connecting to RabbitMQ", url=self._amqp_url)
        self._connection = await aio_pika.connect_robust(self._amqp_url)
        self._channel = await self._connection.channel()
        await self._channel.set_qos(prefetch_count=20)

        # 1. Assert durable exchanges
        events_exchange = await self._channel.declare_exchange(
            KIRANA_EVENTS_EXCHANGE,
            type=aio_pika.ExchangeType.TOPIC,
            durable=True,
        )
        self._dlx_exchange = await self._channel.declare_exchange(
            KIRANA_DLX_EXCHANGE,
            type=aio_pika.ExchangeType.DIRECT,
            durable=True,
        )

        # 2. Main queue (dead letters unhandled failures to DLQ)
        main_queue = await self._channel.declare_queue(
            QUEUE_NAME,
            durable=True,
            arguments={
                "x-dead-letter-exchange": KIRANA_DLX_EXCHANGE,
                "x-dead-letter-routing-key": f"{QUEUE_NAME}.dlq",
            },
        )

        # 3. Retry queue (dead letters after TTL back to main queue via dlx)
        retry_queue = await self._channel.declare_queue(
            f"{QUEUE_NAME}.retry",
            durable=True,
            arguments={
                "x-dead-letter-exchange": KIRANA_DLX_EXCHANGE,
                "x-dead-letter-routing-key": QUEUE_NAME,
            },
        )

        # 4. Dead letter queue
        dlq_queue = await self._channel.declare_queue(
            f"{QUEUE_NAME}.dlq",
            durable=True,
        )

        # 5. Bindings
        await main_queue.bind(events_exchange, routing_key="inventory.sale.recorded.v1")
        await main_queue.bind(events_exchange, routing_key="inventory.stock.updated.v1")
        await main_queue.bind(self._dlx_exchange, routing_key=QUEUE_NAME)
        await retry_queue.bind(self._dlx_exchange, routing_key=f"{QUEUE_NAME}.retry")
        await dlq_queue.bind(self._dlx_exchange, routing_key=f"{QUEUE_NAME}.dlq")

        logger.info("RabbitMQ topology asserted", queue=QUEUE_NAME)
        await main_queue.consume(self._on_message)

    async def _on_message(self, message: AbstractIncomingMessage) -> None:
        """Handle incoming AMQP message with retry ladder."""
        try:
            envelope = json.loads(message.body.decode("utf-8"))
        except Exception as exc:
            logger.error("Failed to decode message JSON", error=str(exc))
            await message.reject(requeue=False)
            return

        correlation_id = envelope.get("correlationId") or str(uuid.uuid4())
        structlog.contextvars.bind_contextvars(correlation_id=correlation_id)

        try:
            async with self._session_factory() as session:
                async with session.begin():
                    await handle_event_atomic(session, envelope)
            await message.ack()
        except Exception as exc:
            retry_count = int(message.headers.get("x-retry-count", 0)) if message.headers else 0
            logger.warning(
                "Event processing failed, evaluating retry",
                error=str(exc),
                retry_count=retry_count,
            )

            if retry_count < MAX_RETRIES and self._dlx_exchange is not None:
                delay_ms = RETRY_DELAYS_MS[retry_count]
                headers = dict(message.headers or {})
                headers["x-retry-count"] = retry_count + 1

                retry_msg = aio_pika.Message(
                    body=message.body,
                    headers=headers,
                    expiration=str(delay_ms),
                    delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                )
                await self._dlx_exchange.publish(
                    retry_msg,
                    routing_key=f"{QUEUE_NAME}.retry",
                )
                logger.info(
                    "Routed message to retry queue", delay_ms=delay_ms, retry=retry_count + 1
                )
                await message.ack()
            else:
                logger.error(
                    "Max retries exceeded; routing message to DLQ", retry_count=retry_count
                )
                if self._dlx_exchange is not None:
                    dlq_msg = aio_pika.Message(
                        body=message.body,
                        headers=message.headers,
                        delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                    )
                    await self._dlx_exchange.publish(
                        dlq_msg,
                        routing_key=f"{QUEUE_NAME}.dlq",
                    )
                await message.ack()
        finally:
            structlog.contextvars.unbind_contextvars("correlation_id")

    async def close(self) -> None:
        """Close RabbitMQ channel and connection."""
        if self._channel is not None and not self._channel.is_closed:
            await self._channel.close()
        if self._connection is not None and not self._connection.is_closed:
            await self._connection.close()
        logger.info("RabbitMQ consumer connection closed")

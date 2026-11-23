"""Tests for idempotent RabbitMQ event consumption and read-model upserts."""

import uuid
from collections.abc import AsyncGenerator
from datetime import date

import pytest
import pytest_asyncio
from forecast.db.models import (
    Base,
    BatchSnapshotReadModel,
    ProcessedMessage,
    SalesHistoryReadModel,
)
from forecast.messaging.consumer import CONSUMER_NAME, handle_event_atomic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


@pytest_asyncio.fixture
async def session_factory() -> AsyncGenerator[async_sessionmaker[AsyncSession], None]:
    """Provide an isolated in-memory SQLite session factory with all tables created."""
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        echo=False,
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


@pytest.mark.asyncio
async def test_idempotent_consumer_duplicate_sale_and_aggregation(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Verify that duplicate sales events are ignored, and multiple sales on same date aggregate."""
    shop_id = str(uuid.uuid4())
    product_id = str(uuid.uuid4())
    batch_id = str(uuid.uuid4())
    message_id_1 = str(uuid.uuid4())
    message_id_2 = str(uuid.uuid4())

    envelope_1 = {
        "id": message_id_1,
        "type": "inventory.sale.recorded.v1",
        "correlationId": str(uuid.uuid4()),
        "payload": {
            "saleId": str(uuid.uuid4()),
            "shopId": shop_id,
            "productId": product_id,
            "batchId": batch_id,
            "qty": 3,
            "soldAt": "2026-11-23T10:00:00.000Z",
            "stockoutFlag": False,
        },
    }

    # 1. First delivery of envelope 1: must succeed and insert read model
    async with session_factory() as session:
        async with session.begin():
            applied_1 = await handle_event_atomic(session, envelope_1)
        assert applied_1 is True

    # Check read model
    stmt = select(SalesHistoryReadModel).where(
        SalesHistoryReadModel.shop_id == uuid.UUID(shop_id),
        SalesHistoryReadModel.product_id == uuid.UUID(product_id),
    )
    async with session_factory() as session:
        row = (await session.execute(stmt)).scalar_one()
        assert row.qty_sold == 3
        assert row.stockout_flag is False
        assert row.sale_date == date(2026, 11, 23)

        # Check processed_messages
        proc_stmt = select(ProcessedMessage).where(
            ProcessedMessage.message_id == uuid.UUID(message_id_1),
            ProcessedMessage.consumer_name == CONSUMER_NAME,
        )
        proc = (await session.execute(proc_stmt)).scalar_one_or_none()
        assert proc is not None

    # 2. Duplicate delivery of envelope 1: must be discarded and NOT double-count qty
    async with session_factory() as session:
        async with session.begin():
            applied_duplicate = await handle_event_atomic(session, envelope_1)
        assert applied_duplicate is False

    async with session_factory() as session:
        row_after_dup = (await session.execute(stmt)).scalar_one()
        assert row_after_dup.qty_sold == 3  # Strictly 3, not 6!

    # 3. Second distinct sale on the same date with stockoutFlag = True
    envelope_2 = {
        "id": message_id_2,
        "type": "inventory.sale.recorded.v1",
        "correlationId": str(uuid.uuid4()),
        "payload": {
            "saleId": str(uuid.uuid4()),
            "shopId": shop_id,
            "productId": product_id,
            "batchId": batch_id,
            "qty": 2,
            "soldAt": "2026-11-23T15:30:00.000Z",
            "stockoutFlag": True,
        },
    }

    async with session_factory() as session:
        async with session.begin():
            applied_2 = await handle_event_atomic(session, envelope_2)
        assert applied_2 is True

    async with session_factory() as session:
        row_after_second = (await session.execute(stmt)).scalar_one()
        assert row_after_second.qty_sold == 5  # 3 + 2
        assert row_after_second.stockout_flag is True  # False OR True -> True


@pytest.mark.asyncio
async def test_idempotent_consumer_stock_updated(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Verify that inventory.stock.updated.v1 upserts batch snapshot read model idempotently."""
    shop_id = str(uuid.uuid4())
    product_id = str(uuid.uuid4())
    batch_id = str(uuid.uuid4())
    message_id = str(uuid.uuid4())

    envelope = {
        "id": message_id,
        "type": "inventory.stock.updated.v1",
        "correlationId": str(uuid.uuid4()),
        "payload": {
            "batchId": batch_id,
            "shopId": shop_id,
            "productId": product_id,
            "qty": 45,
            "reservedQty": 5,
            "costPrice": 120.50,
            "expiryDate": "2027-06-30",
        },
    }

    async with session_factory() as session:
        async with session.begin():
            applied = await handle_event_atomic(session, envelope)
        assert applied is True

    stmt = select(BatchSnapshotReadModel).where(
        BatchSnapshotReadModel.batch_id == uuid.UUID(batch_id)
    )
    async with session_factory() as session:
        batch = (await session.execute(stmt)).scalar_one()
        assert batch.qty == 45
        assert batch.reserved_qty == 5
        assert float(batch.cost_price) == 120.50
        assert batch.expiry_date == date(2027, 6, 30)

    # Redelivery of duplicate message: ignored
    async with session_factory() as session:
        async with session.begin():
            dup_applied = await handle_event_atomic(session, envelope)
        assert dup_applied is False

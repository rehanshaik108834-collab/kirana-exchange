"""Tests verifying idempotent CQRS projections in analytics_db match transactional totals."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from simulator.analytics.consumer import apply_analytics_event_atomic
from simulator.analytics.models import (
    AnalyticsBase,
    NetworkMetricsProjection,
    ShopMapProjection,
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_cqrs_projections_exact_totals_and_duplicate_deduplication() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(AnalyticsBase.metadata.create_all)
    factory = async_sessionmaker(bind=engine, expire_on_commit=False)

    seller_id = str(uuid.uuid4())
    buyer_id = str(uuid.uuid4())
    occurred = datetime.now(UTC).isoformat()

    events = [
        {
            "id": str(uuid.uuid4()),
            "type": "shop.created.v1",
            "occurredAt": occurred,
            "payload": {
                "shopId": seller_id,
                "name": "Sri Lakshmi Kirana",
                "lat": 17.4126,
                "lng": 78.4398,
                "state": "Telangana",
            },
        },
        {
            "id": str(uuid.uuid4()),
            "type": "shop.created.v1",
            "occurredAt": occurred,
            "payload": {
                "shopId": buyer_id,
                "name": "Banjara Mart",
                "lat": 17.4201,
                "lng": 78.4412,
                "state": "Telangana",
            },
        },
        {
            "id": str(uuid.uuid4()),
            "type": "swap.listing.created.v1",
            "occurredAt": occurred,
            "payload": {"shopId": seller_id, "listingId": str(uuid.uuid4())},
        },
        {
            "id": str(uuid.uuid4()),
            "type": "saga.swap.completed.v1",
            "occurredAt": occurred,
            "payload": {
                "sellerShopId": seller_id,
                "buyerShopId": buyer_id,
                "qty": 10,
                "price": 45.5,
            },
        },
        {
            "id": str(uuid.uuid4()),
            "type": "saga.swap.cancelled.v1",
            "occurredAt": occurred,
            "payload": {
                "sellerShopId": seller_id,
                "buyerShopId": buyer_id,
                "reason": "BUYER_TIMEOUT",
            },
        },
        {
            "id": str(uuid.uuid4()),
            "type": "groupbuy.window.closed.v1",
            "occurredAt": occurred,
            "payload": {
                "windowId": str(uuid.uuid4()),
                "outcome": "ALLOCATING",
                "totalSavings": 1500.0,
            },
        },
    ]

    # Apply every event TWICE to verify processed_messages idempotency
    for ev in events:
        async with factory() as session, session.begin():
            applied_first = await apply_analytics_event_atomic(session, ev)
        async with factory() as session, session.begin():
            applied_second = await apply_analytics_event_atomic(session, ev)
        assert applied_first is True
        assert applied_second is False

    async with factory() as session:
        seller = (
            await session.execute(
                select(ShopMapProjection).where(ShopMapProjection.shop_id == uuid.UUID(seller_id))
            )
        ).scalar_one()
        buyer = (
            await session.execute(
                select(ShopMapProjection).where(ShopMapProjection.shop_id == uuid.UUID(buyer_id))
            )
        ).scalar_one()
        metrics = (await session.execute(select(NetworkMetricsProjection))).scalar_one()

        assert seller.active_listings_count == 0
        assert float(seller.reputation_score) == 100.0
        # Buyer gained +2 on completion (capped at 100), then lost -10 on BUYER_TIMEOUT -> 90.0
        assert float(buyer.reputation_score) == 90.0

        assert metrics.swaps_completed == 1
        assert metrics.swaps_failed == 1
        assert metrics.stockouts_avoided == 10
        assert float(metrics.cash_released) == 455.0
        assert float(metrics.dead_stock_value_reduced) == 455.0
        assert float(metrics.groupbuy_savings) == 1500.0

    await engine.dispose()

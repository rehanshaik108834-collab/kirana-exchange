"""Integration tests for the nightly batch worker, fallback mode, outbox emission, and scale."""

import json
import uuid
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from forecast.db.models import (
    Base,
    BatchRiskFlag,
    BatchSnapshotReadModel,
    Forecast,
    OutboxEvent,
    SalesHistoryReadModel,
)
from forecast.worker.batch_runner import cache_key_for_shop, run_nightly_batch
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


class FakeRedis:
    def __init__(self, fail_writes: bool = False) -> None:
        self.store: dict[str, tuple[str, int | None]] = {}
        self.fail_writes = fail_writes

    async def get(self, key: str) -> str | None:
        item = self.store.get(key)
        return item[0] if item else None

    async def set(self, key: str, value: str, ex: int | None = None) -> bool:
        if self.fail_writes:
            raise ConnectionError("Redis unavailable")
        self.store[key] = (value, ex)
        return True


@pytest.fixture
async def sqlite_session_factory():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(bind=engine, expire_on_commit=False)
    yield factory
    await engine.dispose()


async def test_batch_worker_fallback_atomicity_and_cache(sqlite_session_factory, tmp_path: Path):
    shop_id = uuid.uuid4()
    fast_prod = uuid.uuid4()
    slow_prod = uuid.uuid4()
    expiring_batch_id = uuid.uuid4()
    healthy_batch_id = uuid.uuid4()
    as_of = date(2026, 4, 1)

    async with sqlite_session_factory() as session:
        async with session.begin():
            for d in range(21):
                sale_dt = as_of - timedelta(days=21 - d)
                session.add(
                    SalesHistoryReadModel(
                        shop_id=shop_id,
                        product_id=fast_prod,
                        sale_date=sale_dt,
                        qty_sold=5,
                        stockout_flag=False,
                    )
                )
                session.add(
                    SalesHistoryReadModel(
                        shop_id=shop_id,
                        product_id=slow_prod,
                        sale_date=sale_dt,
                        qty_sold=1 if d % 5 == 0 else 0,
                        stockout_flag=False,
                    )
                )

            # Fast product low on stock -> should trigger reorder_qty > 0, no risk flags
            session.add(
                BatchSnapshotReadModel(
                    batch_id=healthy_batch_id,
                    shop_id=shop_id,
                    product_id=fast_prod,
                    qty=8,
                    reserved_qty=0,
                    cost_price=Decimal("20.00"),
                    expiry_date=as_of + timedelta(days=120),
                )
            )
            # Slow product heavily overstocked & expiring soon -> EXPIRY + DEAD_STOCK + Outbox
            session.add(
                BatchSnapshotReadModel(
                    batch_id=expiring_batch_id,
                    shop_id=shop_id,
                    product_id=slow_prod,
                    qty=40,
                    reserved_qty=0,
                    cost_price=Decimal("45.00"),
                    expiry_date=as_of + timedelta(days=15),
                )
            )

    fake_redis = FakeRedis()
    summary = await run_nightly_batch(
        sqlite_session_factory,
        redis_client=fake_redis,
        artifact_dir=tmp_path / "empty_models",
        as_of_date=as_of,
        correlation_id=uuid.uuid4(),
    )

    assert summary.shops_processed == 1
    assert summary.fallback_active is True
    assert summary.model_used == "fallback"
    assert summary.risk_flags_written == 2
    assert summary.outbox_events_queued == 2
    assert summary.cache_writes == 1

    # Verify DB state
    async with sqlite_session_factory() as session:
        weekly_forecasts = list(
            (
                await session.execute(
                    select(Forecast).where(Forecast.shop_id == shop_id, Forecast.horizon_days == 7)
                )
            )
            .scalars()
            .all()
        )
        assert len(weekly_forecasts) == 2
        assert all(f.model_used == "fallback" for f in weekly_forecasts)
        fast_fc = next(f for f in weekly_forecasts if f.product_id == fast_prod)
        assert fast_fc.reorder_qty > 0

        risk_flags = list((await session.execute(select(BatchRiskFlag))).scalars().all())
        assert {rf.risk_type for rf in risk_flags} == {"EXPIRY", "DEAD_STOCK"}

        outbox_rows = list((await session.execute(select(OutboxEvent))).scalars().all())
        assert len(outbox_rows) == 2
        assert all(o.event_type == "forecast.batch.at_risk.v1" for o in outbox_rows)
        assert all(o.published_at is None for o in outbox_rows)

    # Verify Redis hydration
    cached_raw = await fake_redis.get(cache_key_for_shop(shop_id))
    assert cached_raw is not None
    cached_payload = json.loads(cached_raw)
    assert cached_payload["modelUsed"] == "fallback"
    assert cached_payload["fallbackActive"] is True
    assert cached_payload["summary"]["clearThisCount"] == 2
    assert cached_payload["summary"]["orderThisCount"] == 1


async def test_batch_worker_throughput_within_500_shop_budget(
    sqlite_session_factory, tmp_path: Path
):
    """Benchmark 20 shops x 10 SKUs x 20 days and verify projected 500-shop run <= 15 min."""
    as_of = date(2026, 4, 1)
    num_shops = 20
    num_skus = 10
    product_ids = [uuid.uuid4() for _ in range(num_skus)]

    async with sqlite_session_factory() as session:
        async with session.begin():
            for _ in range(num_shops):
                sid = uuid.uuid4()
                for p_idx, pid in enumerate(product_ids):
                    for d in range(20):
                        session.add(
                            SalesHistoryReadModel(
                                shop_id=sid,
                                product_id=pid,
                                sale_date=as_of - timedelta(days=20 - d),
                                qty_sold=(p_idx % 4) + 1,
                                stockout_flag=False,
                            )
                        )
                    session.add(
                        BatchSnapshotReadModel(
                            batch_id=uuid.uuid4(),
                            shop_id=sid,
                            product_id=pid,
                            qty=50,
                            reserved_qty=0,
                            cost_price=Decimal("30.00"),
                            expiry_date=as_of + timedelta(days=30),
                        )
                    )

    summary = await run_nightly_batch(
        sqlite_session_factory,
        redis_client=FakeRedis(),
        artifact_dir=tmp_path / "missing",
        as_of_date=as_of,
    )
    assert summary.shops_processed == num_shops
    projected_500_shops_seconds = summary.duration_seconds * (500.0 / num_shops)
    assert projected_500_shops_seconds <= 900.0

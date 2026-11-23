"""API tests for Redis cache-aside, tenant isolation (403), degraded Redis, and p95 latency."""

import time
import uuid
from datetime import date, timedelta
from decimal import Decimal

import numpy as np
import pytest
from forecast.api.main import create_app
from forecast.api.metrics import metrics
from forecast.db.models import Base, BatchSnapshotReadModel, SalesHistoryReadModel
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine


class InMemoryRedis:
    def __init__(self, broken: bool = False) -> None:
        self.data: dict[str, str] = {}
        self.broken = broken

    async def get(self, key: str) -> str | None:
        if self.broken:
            raise ConnectionError("Redis down")
        return self.data.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> bool:
        if self.broken:
            raise ConnectionError("Redis down")
        self.data[key] = value
        return True

    async def aclose(self) -> None:
        return None


@pytest.fixture
async def seeded_app(tmp_path):
    metrics.reset()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    factory = async_sessionmaker(bind=engine, expire_on_commit=False)

    shop_id = uuid.uuid4()
    other_shop_id = uuid.uuid4()
    product_id = uuid.uuid4()
    as_of = date(2026, 4, 1)

    async with factory() as session:
        async with session.begin():
            for d in range(14):
                session.add(
                    SalesHistoryReadModel(
                        shop_id=shop_id,
                        product_id=product_id,
                        sale_date=as_of - timedelta(days=14 - d),
                        qty_sold=4,
                        stockout_flag=False,
                    )
                )
            session.add(
                BatchSnapshotReadModel(
                    batch_id=uuid.uuid4(),
                    shop_id=shop_id,
                    product_id=product_id,
                    qty=10,
                    reserved_qty=0,
                    cost_price=Decimal("25.00"),
                    expiry_date=as_of + timedelta(days=90),
                )
            )

    app = create_app()
    app.state.session_factory = factory
    app.state.redis_client = InMemoryRedis()
    app.state.artifact_dir = tmp_path / "no_model"

    yield app, shop_id, other_shop_id, as_of
    await engine.dispose()


async def test_cross_shop_isolation_returns_rfc9457_403(seeded_app):
    app, shop_id, other_shop_id, _ = seeded_app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get(
            f"/v1/forecasts/shops/{shop_id}",
            headers={"x-user-role": "owner", "x-shop-id": str(other_shop_id)},
        )
    assert res.status_code == 403
    assert res.headers["content-type"].startswith("application/problem+json")
    body = res.json()
    assert body["status"] == 403
    assert "correlationId" in body


async def test_run_batch_and_cache_aside_metrics_and_p95_latency(seeded_app):
    app, shop_id, _, as_of = seeded_app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # Non-admin blocked from triggering batch
        forbidden = await client.post(
            "/v1/forecasts/run-batch",
            headers={"x-user-role": "owner", "x-shop-id": str(shop_id)},
        )
        assert forbidden.status_code == 403

        # Admin triggers batch -> populates DB and Redis cache
        trigger = await client.post(
            "/v1/forecasts/run-batch",
            headers={"x-user-role": "admin"},
            json={"asOfDate": as_of.isoformat()},
        )
        assert trigger.status_code == 200
        assert trigger.json()["modelUsed"] == "fallback"

        # Clear cache to observe MISS then HIT
        app.state.redis_client.data.clear()

        miss_res = await client.get(
            f"/v1/forecasts/shops/{shop_id}",
            headers={"x-user-role": "owner", "x-shop-id": str(shop_id)},
        )
        assert miss_res.status_code == 200
        assert miss_res.headers["X-Cache"] == "MISS"
        assert miss_res.json()["modelUsed"] == "fallback"

        # Measure 30 cached reads -> verify HIT and p95 < 200 ms
        latencies_ms: list[float] = []
        for _ in range(30):
            t0 = time.perf_counter()
            hit_res = await client.get(
                f"/v1/forecasts/shops/{shop_id}",
                headers={"x-user-role": "owner", "x-shop-id": str(shop_id)},
            )
            latencies_ms.append((time.perf_counter() - t0) * 1000.0)
            assert hit_res.status_code == 200
            assert hit_res.headers["X-Cache"] == "HIT"

        p95_ms = float(np.percentile(latencies_ms, 95))
        assert p95_ms < 200.0

        # Verify Prometheus metrics reflect 1 miss, 30 hits, fallback active
        metrics_res = await client.get("/metrics")
        assert metrics_res.status_code == 200
        text_body = metrics_res.text
        assert "forecast_cache_misses_total 1" in text_body
        assert "forecast_cache_hits_total 30" in text_body
        assert "forecast_fallback_active 1" in text_body


async def test_graceful_fallback_to_db_when_redis_is_down(seeded_app):
    app, shop_id, _, as_of = seeded_app
    app.state.redis_client = InMemoryRedis(broken=True)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.get(
            f"/v1/forecasts/shops/{shop_id}",
            headers={"x-user-role": "admin"},
        )
    assert res.status_code == 200
    assert res.headers["X-Cache"] == "MISS"
    assert res.json()["shopId"] == str(shop_id)

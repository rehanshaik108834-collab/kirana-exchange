"""API tests for admin-only CQRS endpoints, RFC 9457 403 guards, and simulation persistence."""

import uuid
from datetime import UTC, datetime

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from simulator.analytics.api import create_app
from simulator.analytics.consumer import apply_analytics_event_atomic
from simulator.analytics.models import AnalyticsBase


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_analytics_api_rbac_map_metrics_and_simulation_persistence() -> None:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(AnalyticsBase.metadata.create_all)
    factory = async_sessionmaker(bind=engine, expire_on_commit=False)

    # Seed one shop and one completed swap through the CQRS consumer
    shop_id = str(uuid.uuid4())
    buyer_id = str(uuid.uuid4())
    now_iso = datetime.now(UTC).isoformat()

    async with factory() as session, session.begin():
        await apply_analytics_event_atomic(
            session,
            {
                "id": str(uuid.uuid4()),
                "type": "shop.created.v1",
                "occurredAt": now_iso,
                "payload": {
                    "shopId": shop_id,
                    "name": "Deccan Kirana",
                    "lat": 17.385,
                    "lng": 78.4867,
                    "state": "Telangana",
                },
            },
        )
        await apply_analytics_event_atomic(
            session,
            {
                "id": str(uuid.uuid4()),
                "type": "saga.swap.completed.v1",
                "occurredAt": now_iso,
                "payload": {
                    "sellerShopId": shop_id,
                    "buyerShopId": buyer_id,
                    "qty": 8,
                    "price": 50.0,
                },
            },
        )

    app = create_app()
    app.state.engine = engine
    app.state.session_factory = factory

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        # 1. Health endpoint
        health_res = await client.get("/health")
        assert health_res.status_code == 200
        assert health_res.json()["status"] == "ok"

        # 2. Non-admin blocked with RFC 9457 403
        forbidden = await client.get("/v1/analytics/map", headers={"x-user-role": "shop_owner"})
        assert forbidden.status_code == 403
        assert forbidden.headers["content-type"].startswith("application/problem+json")

        # 3. Admin reads CQRS map projection
        map_res = await client.get("/v1/analytics/map", headers={"x-user-role": "admin"})
        assert map_res.status_code == 200
        map_body = map_res.json()
        assert map_body["totalShops"] == 1
        assert map_body["shops"][0]["name"] == "Deccan Kirana"

        # 4. Admin reads CQRS metrics projection
        metrics_res = await client.get("/v1/analytics/metrics", headers={"x-user-role": "admin"})
        assert metrics_res.status_code == 200
        totals = metrics_res.json()["totals"]
        assert totals["swapsCompleted"] == 1
        assert totals["stockoutsAvoided"] == 8
        assert totals["cashReleased"] == 400.0

        # 5. Admin triggers paired simulation -> persists both runs (with & without exchange)
        sim_res = await client.post(
            "/v1/analytics/simulations/run",
            headers={"x-user-role": "admin"},
            json={
                "seed": 7,
                "shop_count": 8,
                "skus_per_shop": 10,
                "days": 30,
                "acceptance_rate": 0.5,
                "radius_km": 5.0,
            },
        )
        assert sim_res.status_code == 200
        sim_data = sim_res.json()
        assert sim_data["with_exchange"]["groupbuy_savings_inr"] > 0

        list_res = await client.get("/v1/analytics/simulations", headers={"x-user-role": "admin"})
        assert list_res.status_code == 200
        runs = list_res.json()
        assert len(runs) == 2
        assert {r["exchangeEnabled"] for r in runs} == {False, True}

    await engine.dispose()

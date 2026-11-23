"""Tests for FastAPI middleware, health check, and RFC 9457 error serialization."""

import uuid
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from forecast.api.main import app


@pytest.mark.asyncio
async def test_health_echoes_correlation_id() -> None:
    custom_cid = str(uuid.uuid4())

    with (
        patch("forecast.api.routes.check_db_health", new_callable=AsyncMock) as mock_db,
        patch("redis.asyncio.from_url") as mock_redis,
    ):
        mock_db.return_value = True
        mock_r = AsyncMock()
        mock_r.ping.return_value = True
        mock_redis.return_value = mock_r

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            res = await client.get("/health", headers={"x-correlation-id": custom_cid})

        assert res.status_code == 200
        assert res.headers.get("x-correlation-id") == custom_cid
        data = res.json()
        assert data["status"] == "ok"
        assert data["service"] == "forecast-service"
        assert data["database"] == "up"
        assert data["redis"] == "up"
        assert data["correlationId"] == custom_cid


@pytest.mark.asyncio
async def test_health_generates_correlation_id_when_missing() -> None:
    with (
        patch("forecast.api.routes.check_db_health", new_callable=AsyncMock) as mock_db,
        patch("redis.asyncio.from_url") as mock_redis,
    ):
        mock_db.return_value = True
        mock_r = AsyncMock()
        mock_r.ping.return_value = True
        mock_redis.return_value = mock_r

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            res = await client.get("/health")

        assert res.status_code == 200
        cid = res.headers.get("x-correlation-id")
        assert cid is not None
        # Must be valid UUID
        parsed_uuid = uuid.UUID(cid)
        assert str(parsed_uuid) == cid
        assert res.json()["correlationId"] == cid


@pytest.mark.asyncio
async def test_health_degraded_when_redis_is_down() -> None:
    with (
        patch("forecast.api.routes.check_db_health", new_callable=AsyncMock) as mock_db,
        patch("redis.asyncio.from_url") as mock_redis,
    ):
        mock_db.return_value = True
        # Redis raises connection exception
        mock_redis.side_effect = ConnectionError("Redis unreachable")

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            res = await client.get("/health")

        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "degraded"
        assert data["database"] == "up"
        assert data["redis"] == "down"


@pytest.mark.asyncio
async def test_rfc_9457_problem_details_on_404() -> None:
    custom_cid = str(uuid.uuid4())

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        res = await client.get(
            "/v1/forecasts/nonexistent", headers={"x-correlation-id": custom_cid}
        )

    assert res.status_code == 404
    assert res.headers.get("content-type") == "application/problem+json"
    assert res.headers.get("x-correlation-id") == custom_cid

    problem = res.json()
    assert problem["type"] == "https://kirana.exchange/errors/404"
    assert problem["title"] == "Not Found"
    assert problem["status"] == 404
    assert problem["detail"] == "Not Found"
    assert problem["instance"] == "/v1/forecasts/nonexistent"
    assert problem["correlationId"] == custom_cid

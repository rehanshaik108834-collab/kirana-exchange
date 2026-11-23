"""Health, Prometheus metrics, and forecast read/trigger routes."""

import json
import uuid
from datetime import date
from pathlib import Path
from typing import Any

import redis.asyncio as aioredis
import structlog
from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from ..config import settings
from ..db.session import check_db_health, get_session_factory
from ..worker.batch_runner import (
    build_shop_forecast_payload,
    cache_key_for_shop,
    run_nightly_batch,
)
from .metrics import metrics

router = APIRouter()
logger = structlog.get_logger("forecast.api.routes")


class RunBatchRequest(BaseModel):
    asOfDate: date | None = None
    shopIds: list[uuid.UUID] | None = None


def _get_session_factory(request: Request):
    return getattr(request.app.state, "session_factory", None) or get_session_factory()


def _get_artifact_dir(request: Request) -> Path:
    override = getattr(request.app.state, "artifact_dir", None)
    return Path(override) if override is not None else Path(settings.model_artifact_dir)


def _get_redis_client(request: Request) -> Any | None:
    if getattr(request.app.state, "redis_disabled", False):
        return None
    client = getattr(request.app.state, "redis_client", None)
    if client is not None:
        return client
    client = aioredis.from_url(
        settings.redis_url,
        decode_responses=True,
        socket_connect_timeout=1.5,
        socket_timeout=1.5,
    )
    request.app.state.redis_client = client
    return client


@router.get("/health", summary="Health check endpoint")
async def health(request: Request, response: Response) -> dict[str, str]:
    """Verify live connectivity against forecast_db and Redis.

    Reports degraded status cleanly if Redis is down, as forecasting
    falls back smoothly to PostgreSQL.
    """
    correlation_id = getattr(request.state, "correlation_id", "unknown")

    db_healthy = await check_db_health()

    redis_healthy = False
    try:
        r = aioredis.from_url(settings.redis_url, socket_connect_timeout=1.5, socket_timeout=1.5)
        redis_healthy = bool(await r.ping())
        await r.aclose()
    except Exception as exc:
        logger.warning("Redis health check failed", error=str(exc))
        redis_healthy = False

    if not db_healthy:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        overall_status = "unhealthy"
    elif not redis_healthy:
        overall_status = "degraded"
    else:
        overall_status = "ok"

    return {
        "status": overall_status,
        "service": "forecast-service",
        "database": "up" if db_healthy else "down",
        "redis": "up" if redis_healthy else "down",
        "correlationId": correlation_id,
    }


@router.get("/metrics", summary="Prometheus metrics endpoint")
async def prometheus_metrics() -> PlainTextResponse:
    """Expose service counters and gauges in Prometheus text format."""
    return PlainTextResponse(
        content=metrics.render_prometheus(),
        media_type="text/plain; version=0.0.4; charset=utf-8",
    )


@router.get(
    "/v1/forecasts/shops/{shop_id}",
    summary="Get cached weekly demand forecasts and batch risk flags for a shop",
)
async def get_shop_forecasts(
    shop_id: uuid.UUID,
    request: Request,
    response: Response,
) -> dict[str, Any]:
    """Serve shop-scoped Order-This / Clear-This forecasts via Redis cache-aside."""
    user_role = (request.headers.get("x-user-role") or "").lower()
    caller_shop_id = request.headers.get("x-shop-id")

    if user_role != "admin" and caller_shop_id != str(shop_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not authorized to access forecasts for another shop",
        )

    cache_key = cache_key_for_shop(shop_id)
    redis_client = _get_redis_client(request)

    # 1. Cache-aside lookup
    if redis_client is not None:
        try:
            cached_raw = await redis_client.get(cache_key)
            if cached_raw is not None:
                metrics.inc_cache_hit()
                response.headers["X-Cache"] = "HIT"
                if isinstance(cached_raw, bytes):
                    cached_raw = cached_raw.decode("utf-8")
                return json.loads(cached_raw)
        except Exception as exc:
            logger.warning(
                "Redis cache lookup failed; falling back to forecast_db",
                shop_id=str(shop_id),
                error=str(exc),
            )

    metrics.inc_cache_miss()
    response.headers["X-Cache"] = "MISS"

    # 2. Database read-through
    session_factory = _get_session_factory(request)
    async with session_factory() as session:
        payload = await build_shop_forecast_payload(session, shop_id)

    # 3. Populate cache best-effort
    if redis_client is not None:
        try:
            await redis_client.set(
                cache_key,
                json.dumps(payload),
                ex=settings.forecast_cache_ttl_seconds,
            )
        except Exception as exc:
            logger.warning(
                "Redis cache populate failed",
                shop_id=str(shop_id),
                error=str(exc),
            )

    return payload


@router.post(
    "/v1/forecasts/run-batch",
    summary="Trigger on-demand forecast and risk batch run (admin only)",
)
async def trigger_forecast_batch(
    request: Request,
    body: RunBatchRequest | None = None,
) -> dict[str, Any]:
    """Trigger the nightly forecast & risk engine on demand (admin only)."""
    user_role = (request.headers.get("x-user-role") or "").lower()
    if user_role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required to trigger forecast batch execution",
        )

    correlation_id = getattr(request.state, "correlation_id", str(uuid.uuid4()))
    summary = await run_nightly_batch(
        _get_session_factory(request),
        redis_client=_get_redis_client(request),
        artifact_dir=_get_artifact_dir(request),
        as_of_date=body.asOfDate if body else None,
        shop_ids=body.shopIds if body else None,
        correlation_id=correlation_id,
    )

    return {
        "asOfDate": summary.as_of_date.isoformat(),
        "shopsProcessed": summary.shops_processed,
        "forecastsWritten": summary.forecasts_written,
        "riskFlagsWritten": summary.risk_flags_written,
        "outboxEventsQueued": summary.outbox_events_queued,
        "modelUsed": summary.model_used,
        "fallbackActive": summary.fallback_active,
        "durationSeconds": summary.duration_seconds,
        "cacheWrites": summary.cache_writes,
        "cacheErrors": summary.cache_errors,
    }

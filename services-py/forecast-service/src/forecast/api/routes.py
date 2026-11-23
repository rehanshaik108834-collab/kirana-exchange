"""Health and diagnostics routes."""

import redis.asyncio as aioredis
import structlog
from fastapi import APIRouter, Request, Response, status

from ..config import settings
from ..db.session import check_db_health

router = APIRouter()
logger = structlog.get_logger("forecast.api.health")


@router.get("/health", summary="Health check endpoint")
async def health(request: Request, response: Response) -> dict[str, str]:
    """Verify live connectivity against forecast_db and Redis.

    Reports degraded status cleanly if Redis is down, as forecasting
    falls back smoothly to PostgreSQL.
    """
    correlation_id = getattr(request.state, "correlation_id", "unknown")

    # 1. Check PostgreSQL (forecast_db)
    db_healthy = await check_db_health()

    # 2. Check Redis
    redis_healthy = False
    try:
        r = aioredis.from_url(settings.redis_url, socket_connect_timeout=1.5, socket_timeout=1.5)
        redis_healthy = bool(await r.ping())
        await r.aclose()
    except Exception as exc:
        logger.warning("Redis health check failed", error=str(exc))
        redis_healthy = False

    # Status classification
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

"""FastAPI admin analytics & simulation service (port 3011, analytics_db)."""

import http
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog
from fastapi import APIRouter, FastAPI, HTTPException, Query, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from .config import analytics_settings
from .consumer import AnalyticsProjectionConsumer
from .experiment import PairedExperimentRequest, run_paired_experiment
from .models import NetworkMetricsProjection, ShopMapProjection, SimulationRun
from .session import check_db_health, ensure_schema, get_session_factory

logger = structlog.get_logger("analytics.api")
PROBLEM_CONTENT_TYPE = "application/problem+json"

router = APIRouter()


class CorrelationIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        correlation_id = request.headers.get("x-correlation-id") or str(uuid.uuid4())
        request.state.correlation_id = correlation_id
        structlog.contextvars.bind_contextvars(correlation_id=correlation_id)
        try:
            response = await call_next(request)
        finally:
            structlog.contextvars.unbind_contextvars("correlation_id")
        response.headers["x-correlation-id"] = correlation_id
        return response


def _problem(status_code: int, title: str, detail: str, path: str, corr_id: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "type": f"https://kirana-exchange.local/errors/{status_code}",
            "title": title,
            "status": status_code,
            "detail": detail,
            "instance": path,
            "correlationId": corr_id,
        },
        media_type=PROBLEM_CONTENT_TYPE,
        headers={"x-correlation-id": corr_id},
    )


def _assert_admin(request: Request) -> None:
    role = (request.headers.get("x-user-role") or "").lower()
    if role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required to access network analytics and simulations",
        )


def _get_session_factory(request: Request):
    return getattr(request.app.state, "session_factory", None) or get_session_factory()


@router.get("/health", summary="Health check for analytics-simulator")
async def health(request: Request, response: Response) -> dict[str, str]:
    corr_id = getattr(request.state, "correlation_id", "unknown")
    custom_engine = getattr(request.app.state, "engine", None)
    db_ok = await check_db_health(custom_engine)
    if not db_ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {
        "status": "ok" if db_ok else "unhealthy",
        "service": "analytics-simulator",
        "database": "up" if db_ok else "down",
        "correlationId": corr_id,
    }


@router.get("/v1/analytics/map", summary="Admin live network map CQRS projection")
async def get_network_map(
    request: Request,
    state: str | None = Query(default=None),
) -> dict[str, Any]:
    _assert_admin(request)
    factory = _get_session_factory(request)

    async with factory() as session:
        stmt = select(ShopMapProjection).order_by(ShopMapProjection.updated_at.desc())
        if state:
            stmt = stmt.where(ShopMapProjection.state == state)
        rows = list((await session.execute(stmt)).scalars().all())

    by_state: dict[str, int] = {}
    shops: list[dict[str, Any]] = []
    for r in rows:
        by_state[r.state] = by_state.get(r.state, 0) + 1
        shops.append(
            {
                "shopId": str(r.shop_id),
                "name": r.name,
                "lat": float(r.lat),
                "lng": float(r.lng),
                "state": r.state,
                "reputationScore": float(r.reputation_score),
                "activeListingsCount": int(r.active_listings_count),
                "updatedAt": r.updated_at.isoformat() if r.updated_at else None,
            }
        )

    return {
        "totalShops": len(shops),
        "totalActiveListings": sum(s["activeListingsCount"] for s in shops),
        "byState": by_state,
        "shops": shops,
    }


@router.get("/v1/analytics/metrics", summary="Admin daily network impact metrics CQRS projection")
async def get_network_metrics(
    request: Request,
    days: int = Query(default=30, ge=1, le=365),
) -> dict[str, Any]:
    _assert_admin(request)
    factory = _get_session_factory(request)
    cutoff = datetime.now(UTC).date() - timedelta(days=days)

    async with factory() as session:
        stmt = (
            select(NetworkMetricsProjection)
            .where(NetworkMetricsProjection.metric_date >= cutoff)
            .order_by(NetworkMetricsProjection.metric_date.asc())
        )
        rows = list((await session.execute(stmt)).scalars().all())

    daily = [
        {
            "date": r.metric_date.isoformat(),
            "deadStockValueReduced": float(r.dead_stock_value_reduced),
            "stockoutsAvoided": int(r.stockouts_avoided),
            "cashReleased": float(r.cash_released),
            "swapsCompleted": int(r.swaps_completed),
            "swapsFailed": int(r.swaps_failed),
            "groupbuySavings": float(r.groupbuy_savings),
        }
        for r in rows
    ]

    totals = {
        "deadStockValueReduced": round(sum(d["deadStockValueReduced"] for d in daily), 2),
        "stockoutsAvoided": sum(d["stockoutsAvoided"] for d in daily),
        "cashReleased": round(sum(d["cashReleased"] for d in daily), 2),
        "swapsCompleted": sum(d["swapsCompleted"] for d in daily),
        "swapsFailed": sum(d["swapsFailed"] for d in daily),
        "groupbuySavings": round(sum(d["groupbuySavings"] for d in daily), 2),
    }

    return {"days": days, "totals": totals, "daily": daily}


@router.get("/v1/analytics/simulations", summary="List persisted simulation experiment runs")
async def list_simulations(
    request: Request,
    limit: int = Query(default=50, ge=1, le=200),
) -> list[dict[str, Any]]:
    _assert_admin(request)
    factory = _get_session_factory(request)

    async with factory() as session:
        stmt = select(SimulationRun).order_by(SimulationRun.created_at.desc()).limit(limit)
        rows = list((await session.execute(stmt)).scalars().all())

    return [
        {
            "id": str(r.id),
            "configHash": r.config_hash,
            "seed": int(r.seed),
            "shopCount": int(r.shop_count),
            "exchangeEnabled": bool(r.exchange_enabled),
            "acceptanceRate": float(r.acceptance_rate),
            "radiusKm": float(r.radius_km),
            "metricsSummary": r.metrics_summary,
            "createdAt": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.post(
    "/v1/analytics/simulations/run",
    summary="Execute paired With/Without-Exchange simulation experiment",
)
async def trigger_simulation(
    body: PairedExperimentRequest,
    request: Request,
) -> dict[str, Any]:
    _assert_admin(request)
    factory = _get_session_factory(request)

    async with factory() as session:
        result = await run_paired_experiment(session, body)

    return result.model_dump()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    consumer: AnalyticsProjectionConsumer | None = None
    if getattr(app.state, "session_factory", None) is None:
        try:
            await ensure_schema()
        except Exception as exc:  # noqa: BLE001
            logger.warning("analytics_db schema ensure skipped at startup", error=str(exc))

    if analytics_settings.rabbit_consumer_enabled:
        consumer = AnalyticsProjectionConsumer(
            analytics_settings.rabbitmq_url,
            getattr(app.state, "session_factory", None) or get_session_factory(),
        )
        try:
            await consumer.start()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed starting analytics RabbitMQ consumer", error=str(exc))
            consumer = None

    yield

    if consumer is not None:
        await consumer.close()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Kirana Analytics & Simulator Service",
        description="CQRS network projections and paired With/Without-Exchange simulator",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(CorrelationIdMiddleware)

    @app.exception_handler(StarletteHTTPException)
    async def http_exc_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        corr_id = getattr(request.state, "correlation_id", str(uuid.uuid4()))
        try:
            title = http.HTTPStatus(exc.status_code).phrase
        except ValueError:
            title = "HTTP Error"
        return _problem(exc.status_code, title, str(exc.detail), request.url.path, corr_id)

    @app.exception_handler(RequestValidationError)
    async def val_exc_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
        corr_id = getattr(request.state, "correlation_id", str(uuid.uuid4()))
        return _problem(422, "Unprocessable Entity", str(exc.errors()), request.url.path, corr_id)

    app.include_router(router)
    return app


app = create_app()

"""FastAPI application entrypoint for Kirana Forecast Service."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ..config import settings
from .middleware import CorrelationIdMiddleware, register_exception_handlers
from .routes import router as forecast_router

logger = structlog.get_logger("forecast.api.main")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan management."""
    logger.info(
        "Starting forecast-service",
        env=settings.app_env,
        port=settings.app_port,
    )
    yield
    redis_client = getattr(app.state, "redis_client", None)
    if redis_client is not None and hasattr(redis_client, "aclose"):
        try:
            await redis_client.aclose()
        except Exception as exc:
            logger.warning("Failed to close Redis client cleanly", error=str(exc))
    logger.info("Shutting down forecast-service")


def create_app() -> FastAPI:
    """Create and configure FastAPI application instance."""
    app = FastAPI(
        title="Kirana Forecast & Risk Service",
        description="ML-powered demand forecasting and inventory risk service for Kirana Exchange",
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
    register_exception_handlers(app)
    app.include_router(forecast_router)

    return app


app = create_app()

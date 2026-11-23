"""FastAPI application entrypoint for Kirana Forecast Service."""

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ..config import settings
from .middleware import CorrelationIdMiddleware, register_exception_handlers
from .routes import router as health_router

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
    logger.info("Shutting down forecast-service")


def create_app() -> FastAPI:
    """Create and configure FastAPI application instance."""
    app = FastAPI(
        title="Kirana Forecast & Risk Service",
        description="ML-powered demand forecasting and inventory risk service for Kirana Exchange",
        version="0.1.0",
        lifespan=lifespan,
    )

    # CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Correlation ID middleware
    app.add_middleware(CorrelationIdMiddleware)

    # RFC 9457 exception handlers
    register_exception_handlers(app)

    # Routes
    app.include_router(health_router)

    return app


app = create_app()

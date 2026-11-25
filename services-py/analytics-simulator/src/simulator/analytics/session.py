"""Async SQLAlchemy engine and session management for analytics_db."""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .config import analytics_settings
from .models import AnalyticsBase

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            analytics_settings.database_url,
            echo=False,
            pool_pre_ping=True,
            pool_size=10,
            max_overflow=10,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            bind=get_engine(),
            autocommit=False,
            autoflush=False,
            expire_on_commit=False,
        )
    return _session_factory


async def ensure_schema(engine: AsyncEngine | None = None) -> None:
    """Create analytics_db CQRS tables idempotently if not yet present."""
    target = engine or get_engine()
    async with target.begin() as conn:
        await conn.run_sync(AnalyticsBase.metadata.create_all)


async def check_db_health(engine: AsyncEngine | None = None) -> bool:
    """Execute live SELECT 1 against analytics_db."""
    target = engine or get_engine()
    try:
        async with target.connect() as conn:
            result = await conn.execute(text("SELECT 1"))
            return result.scalar() == 1
    except Exception:  # noqa: BLE001
        return False

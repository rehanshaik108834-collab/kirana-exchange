"""SQLAlchemy declarative models for analytics_db CQRS read models & simulation runs."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import JSON, TypeDecorator


class GUID(TypeDecorator):
    """Platform-independent UUID type (PostgreSQL UUID, SQLite CHAR(36))."""

    impl = String(36)
    cache_ok = True

    def load_dialect_impl(self, dialect: Any) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PG_UUID(as_uuid=True))
        return dialect.type_descriptor(String(36))

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return value
        if dialect.name == "postgresql":
            return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
        return str(value)

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return value
        if isinstance(value, uuid.UUID):
            return value
        return uuid.UUID(str(value))


class JSONBType(TypeDecorator):
    """Platform-independent JSONB type (PostgreSQL JSONB, SQLite JSON)."""

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect: Any) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())


class AnalyticsBase(DeclarativeBase):
    """Declarative base for all analytics_db tables."""


class ShopMapProjection(AnalyticsBase):
    """CQRS map read model for the admin Leaflet live network map."""

    __tablename__ = "shop_map_projection"

    shop_id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    lat: Mapped[Decimal] = mapped_column(Numeric(9, 6), nullable=False)
    lng: Mapped[Decimal] = mapped_column(Numeric(9, 6), nullable=False)
    state: Mapped[str] = mapped_column(String(64), nullable=False)
    reputation_score: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), nullable=False, default=Decimal("100.00")
    )
    active_listings_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class NetworkMetricsProjection(AnalyticsBase):
    """Daily aggregated network impact metrics for the admin Recharts dashboard."""

    __tablename__ = "network_metrics_projection"

    metric_date: Mapped[date] = mapped_column(Date, primary_key=True, nullable=False)
    dead_stock_value_reduced: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, default=Decimal("0.00")
    )
    stockouts_avoided: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cash_released: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, default=Decimal("0.00")
    )
    swaps_completed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    swaps_failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    groupbuy_savings: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), nullable=False, default=Decimal("0.00")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class SimulationRun(AnalyticsBase):
    """Persisted With-Exchange vs. Without-Exchange simulation experiment runs."""

    __tablename__ = "simulation_runs"

    id: Mapped[uuid.UUID] = mapped_column(
        GUID, primary_key=True, default=uuid.uuid4, nullable=False
    )
    config_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    seed: Mapped[int] = mapped_column(Integer, nullable=False)
    shop_count: Mapped[int] = mapped_column(Integer, nullable=False)
    exchange_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False)
    acceptance_rate: Mapped[Decimal] = mapped_column(Numeric(4, 2), nullable=False)
    radius_km: Mapped[Decimal] = mapped_column(Numeric(4, 2), nullable=False)
    metrics_summary: Mapped[dict[str, Any]] = mapped_column(JSONBType, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    __table_args__ = (
        UniqueConstraint("config_hash", "seed", "exchange_enabled", name="uq_sim_run"),
    )


class ProcessedMessage(AnalyticsBase):
    """Idempotency ledger preventing duplicate CQRS projection updates."""

    __tablename__ = "processed_messages"

    message_id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, nullable=False)
    consumer_name: Mapped[str] = mapped_column(String(64), primary_key=True, nullable=False)
    processed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

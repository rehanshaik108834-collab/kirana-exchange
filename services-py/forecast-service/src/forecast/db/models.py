"""SQLAlchemy declarative models for forecast_db."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Index,
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
    """Platform-independent GUID/UUID type.

    Uses PostgreSQL's UUID type when on Postgres, otherwise CHAR(36).
    """

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
    """Platform-independent JSONB type.

    Uses PostgreSQL's JSONB type when on Postgres, otherwise JSON.
    """

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect: Any) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())


class Base(DeclarativeBase):
    """Base class for all models."""

    pass


class SalesHistoryReadModel(Base):
    """Aggregated daily sales read model for rapid past-only ML feature computation."""

    __tablename__ = "sales_history_read_model"

    shop_id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, nullable=False)
    sale_date: Mapped[date] = mapped_column(Date, primary_key=True, nullable=False)
    qty_sold: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    stockout_flag: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (Index("idx_sales_rm_shop_prod_date", "shop_id", "product_id", "sale_date"),)


class BatchSnapshotReadModel(Base):
    """Batch snapshot read model maintained from inventory.stock.updated.v1."""

    __tablename__ = "batch_snapshot_read_model"

    batch_id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, nullable=False)
    shop_id: Mapped[uuid.UUID] = mapped_column(GUID, nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(GUID, nullable=False)
    qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    reserved_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_price: Mapped[Decimal] = mapped_column(
        Numeric(10, 2), nullable=False, default=Decimal("0.00")
    )
    expiry_date: Mapped[date] = mapped_column(Date, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    __table_args__ = (
        Index("idx_batch_snapshot_shop_prod", "shop_id", "product_id"),
        Index("idx_batch_snapshot_expiry", "expiry_date"),
    )


class Forecast(Base):
    """Multi-horizon probabilistic SKU sales forecasts."""

    __tablename__ = "forecasts"

    id: Mapped[uuid.UUID] = mapped_column(
        GUID, primary_key=True, default=uuid.uuid4, nullable=False
    )
    shop_id: Mapped[uuid.UUID] = mapped_column(GUID, nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(GUID, nullable=False)
    forecast_date: Mapped[date] = mapped_column(Date, nullable=False)
    horizon_days: Mapped[int] = mapped_column(Integer, nullable=False)
    predicted_qty: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    lower_bound: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    upper_bound: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    demand_class: Mapped[str] = mapped_column(String(20), nullable=False)
    model_used: Mapped[str] = mapped_column(String(40), nullable=False)
    reorder_qty: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    __table_args__ = (
        UniqueConstraint(
            "shop_id",
            "product_id",
            "forecast_date",
            "horizon_days",
            name="uq_forecast_shop_product_date_horizon",
        ),
        Index("idx_forecasts_lookup", "shop_id", "forecast_date"),
    )


class BatchRiskFlag(Base):
    """Risk assessments for expiring and dead stock batches."""

    __tablename__ = "batch_risk_flags"

    id: Mapped[uuid.UUID] = mapped_column(
        GUID, primary_key=True, default=uuid.uuid4, nullable=False
    )
    batch_id: Mapped[uuid.UUID] = mapped_column(GUID, nullable=False)
    shop_id: Mapped[uuid.UUID] = mapped_column(GUID, nullable=False)
    product_id: Mapped[uuid.UUID] = mapped_column(GUID, nullable=False)
    risk_type: Mapped[str] = mapped_column(String(20), nullable=False)
    days_of_cover: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    expected_unsold_qty: Mapped[int] = mapped_column(Integer, nullable=False)
    recommended_action: Mapped[str] = mapped_column(String(32), nullable=False)
    flagged_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    __table_args__ = (
        UniqueConstraint("batch_id", "risk_type", name="uq_batch_risk_type"),
        CheckConstraint("risk_type IN ('DEAD_STOCK', 'EXPIRY')", name="chk_risk_type"),
        CheckConstraint(
            "recommended_action IN ("
            "'SWAP_TO_NEIGHBOUR', 'BUNDLE_DISCOUNT', 'RETURN_TO_DISTRIBUTOR'"
            ")",
            name="chk_recommended_action",
        ),
        Index("idx_batch_risk_shop", "shop_id", "risk_type"),
    )


class ProcessedMessage(Base):
    """Idempotency record to prevent duplicate event consumption."""

    __tablename__ = "processed_messages"

    message_id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, nullable=False)
    consumer_name: Mapped[str] = mapped_column(String(64), primary_key=True, nullable=False)
    processed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )


class OutboxEvent(Base):
    """Transactional outbox for reliable event emission."""

    __tablename__ = "outbox_events"

    id: Mapped[uuid.UUID] = mapped_column(
        GUID, primary_key=True, default=uuid.uuid4, nullable=False
    )
    aggregate_type: Mapped[str] = mapped_column(String(64), nullable=False)
    aggregate_id: Mapped[uuid.UUID] = mapped_column(GUID, nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    correlation_id: Mapped[uuid.UUID] = mapped_column(GUID, nullable=False)
    producer: Mapped[str] = mapped_column(String(64), nullable=False, default="forecast-service")
    payload: Mapped[dict[str, Any]] = mapped_column(JSONBType, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    published_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    __table_args__ = (
        Index("idx_outbox_unpublished", "occurred_at", postgresql_where=(published_at.is_(None))),
    )

"""0001_init_forecast_schema

Revision ID: 0001_init_forecast_schema
Revises: None
Create Date: 2026-11-23 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0001_init_forecast_schema"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # 1. sales_history_read_model
    op.create_table(
        "sales_history_read_model",
        sa.Column("shop_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("sale_date", sa.Date(), nullable=False),
        sa.Column("qty_sold", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("stockout_flag", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("shop_id", "product_id", "sale_date"),
    )
    op.create_index(
        "idx_sales_rm_shop_prod_date",
        "sales_history_read_model",
        ["shop_id", "product_id", "sale_date"],
    )

    # 2. batch_snapshot_read_model
    op.create_table(
        "batch_snapshot_read_model",
        sa.Column("batch_id", sa.UUID(), nullable=False),
        sa.Column("shop_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("qty", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reserved_qty", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("cost_price", sa.Numeric(10, 2), nullable=False, server_default="0.00"),
        sa.Column("expiry_date", sa.Date(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("batch_id"),
    )
    op.create_index(
        "idx_batch_snapshot_shop_prod",
        "batch_snapshot_read_model",
        ["shop_id", "product_id"],
    )
    op.create_index(
        "idx_batch_snapshot_expiry",
        "batch_snapshot_read_model",
        ["expiry_date"],
    )

    # 3. forecasts
    op.create_table(
        "forecasts",
        sa.Column("id", sa.UUID(), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("shop_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("forecast_date", sa.Date(), nullable=False),
        sa.Column("horizon_days", sa.Integer(), nullable=False),
        sa.Column("predicted_qty", sa.Numeric(10, 2), nullable=False),
        sa.Column("lower_bound", sa.Numeric(10, 2), nullable=False),
        sa.Column("upper_bound", sa.Numeric(10, 2), nullable=False),
        sa.Column("demand_class", sa.String(20), nullable=False),
        sa.Column("model_used", sa.String(40), nullable=False),
        sa.Column("reorder_qty", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "shop_id",
            "product_id",
            "forecast_date",
            "horizon_days",
            name="uq_forecast_shop_product_date_horizon",
        ),
    )
    op.create_index("idx_forecasts_lookup", "forecasts", ["shop_id", "forecast_date"])

    # 4. batch_risk_flags
    op.create_table(
        "batch_risk_flags",
        sa.Column("id", sa.UUID(), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("batch_id", sa.UUID(), nullable=False),
        sa.Column("shop_id", sa.UUID(), nullable=False),
        sa.Column("product_id", sa.UUID(), nullable=False),
        sa.Column("risk_type", sa.String(20), nullable=False),
        sa.Column("days_of_cover", sa.Numeric(8, 2), nullable=False),
        sa.Column("expected_unsold_qty", sa.Integer(), nullable=False),
        sa.Column("recommended_action", sa.String(32), nullable=False),
        sa.Column(
            "flagged_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("batch_id", "risk_type", name="uq_batch_risk_type"),
        sa.CheckConstraint("risk_type IN ('DEAD_STOCK', 'EXPIRY')", name="chk_risk_type"),
        sa.CheckConstraint(
            "recommended_action IN ("
            "'SWAP_TO_NEIGHBOUR', 'BUNDLE_DISCOUNT', 'RETURN_TO_DISTRIBUTOR'"
            ")",
            name="chk_recommended_action",
        ),
    )
    op.create_index("idx_batch_risk_shop", "batch_risk_flags", ["shop_id", "risk_type"])

    # 5. processed_messages
    op.create_table(
        "processed_messages",
        sa.Column("message_id", sa.UUID(), nullable=False),
        sa.Column("consumer_name", sa.String(64), nullable=False),
        sa.Column(
            "processed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("message_id", "consumer_name"),
    )

    # 6. outbox_events
    op.create_table(
        "outbox_events",
        sa.Column("id", sa.UUID(), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("aggregate_type", sa.String(64), nullable=False),
        sa.Column("aggregate_id", sa.UUID(), nullable=False),
        sa.Column("event_type", sa.String(64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("correlation_id", sa.UUID(), nullable=False),
        sa.Column("producer", sa.String(64), nullable=False, server_default="forecast-service"),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "occurred_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_outbox_unpublished",
        "outbox_events",
        ["occurred_at"],
        postgresql_where=sa.text("published_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_outbox_unpublished", table_name="outbox_events")
    op.drop_table("outbox_events")
    op.drop_table("processed_messages")
    op.drop_index("idx_batch_risk_shop", table_name="batch_risk_flags")
    op.drop_table("batch_risk_flags")
    op.drop_index("idx_forecasts_lookup", table_name="forecasts")
    op.drop_table("forecasts")
    op.drop_index("idx_batch_snapshot_expiry", table_name="batch_snapshot_read_model")
    op.drop_index("idx_batch_snapshot_shop_prod", table_name="batch_snapshot_read_model")
    op.drop_table("batch_snapshot_read_model")
    op.drop_index("idx_sales_rm_shop_prod_date", table_name="sales_history_read_model")
    op.drop_table("sales_history_read_model")

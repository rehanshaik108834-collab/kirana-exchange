-- Kirana Exchange Phase 2 database initialization schemas.
-- Apply each service section to its isolated database. There are no cross-service FKs.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Shared tables for event-producing services.
CREATE TABLE outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(64) NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    correlation_id UUID NOT NULL,
    producer VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_outbox_unpublished
    ON outbox_events (occurred_at ASC)
    WHERE published_at IS NULL;

CREATE TABLE processed_messages (
    message_id UUID NOT NULL,
    consumer_name VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, consumer_name)
);

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID NOT NULL,
    actor_role VARCHAR(32) NOT NULL,
    action VARCHAR(64) NOT NULL,
    entity_type VARCHAR(64) NOT NULL,
    entity_id UUID NOT NULL,
    correlation_id UUID NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_entity ON audit_logs (entity_type, entity_id, created_at DESC);

-- auth_db
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) UNIQUE,
    email VARCHAR(255) UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('shop_owner', 'shop_staff', 'admin')),
    shop_id UUID NULL,
    failed_attempts INT NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_user_contact CHECK (phone IS NOT NULL OR email IS NOT NULL)
);

CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id UUID NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    replaced_by_id UUID NULL REFERENCES refresh_tokens(id),
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_user_family ON refresh_tokens (user_id, family_id);

-- shop_db
CREATE TABLE shops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    address TEXT NOT NULL,
    lat NUMERIC(9, 6) NOT NULL CHECK (lat BETWEEN -90 AND 90),
    lng NUMERIC(9, 6) NOT NULL CHECK (lng BETWEEN -180 AND 180),
    state VARCHAR(64) NOT NULL,
    gst_scheme VARCHAR(20) NOT NULL CHECK (gst_scheme IN ('REGULAR', 'COMPOSITION', 'UNREGISTERED')),
    operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
    swap_radius_km NUMERIC(4, 2) NOT NULL DEFAULT 2.00
        CHECK (swap_radius_km > 0 AND swap_radius_km <= 10),
    reputation_score NUMERIC(5, 2) NOT NULL DEFAULT 100.00
        CHECK (reputation_score BETWEEN 0 AND 100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shops_state ON shops (state);

CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL,
    reporter_shop_id UUID NOT NULL REFERENCES shops(id),
    accused_shop_id UUID NOT NULL REFERENCES shops(id),
    reason TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
    resolution_notes TEXT NULL,
    resolved_by UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_disputes_status ON disputes (status, created_at DESC);

-- catalog_db
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TABLE products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ean VARCHAR(14) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    brand VARCHAR(120) NOT NULL,
    pack_size VARCHAR(64) NOT NULL,
    category VARCHAR(80) NOT NULL,
    mrp NUMERIC(10, 2) NOT NULL CHECK (mrp > 0),
    gst_rate NUMERIC(4, 2) NOT NULL CHECK (gst_rate IN (0, 5, 12, 18, 28)),
    shelf_life_days INT NOT NULL DEFAULT 180 CHECK (shelf_life_days > 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    merged_into_id UUID NULL REFERENCES products(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_products_name_trgm
    ON products USING GIN (name gin_trgm_ops)
    WHERE is_active = TRUE;

CREATE INDEX idx_products_brand_trgm
    ON products USING GIN (brand gin_trgm_ops)
    WHERE is_active = TRUE;

-- inventory_db
CREATE TABLE inventory_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL,
    product_id UUID NOT NULL,
    batch_code VARCHAR(64) NOT NULL,
    qty INT NOT NULL CHECK (qty >= 0),
    reserved_qty INT NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0 AND reserved_qty <= qty),
    cost_price NUMERIC(10, 2) NOT NULL CHECK (cost_price >= 0),
    expiry_date DATE NOT NULL,
    days_of_cover NUMERIC(8, 2) NULL CHECK (days_of_cover IS NULL OR days_of_cover >= 0),
    version INT NOT NULL DEFAULT 1,
    idempotency_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_batch_shop_product_code UNIQUE (shop_id, product_id, batch_code),
    CONSTRAINT uq_batch_idempotency UNIQUE (shop_id, idempotency_key)
);

CREATE INDEX idx_batches_shop_expiry
    ON inventory_batches (shop_id, expiry_date ASC)
    WHERE qty > 0;

CREATE INDEX idx_batches_shop_product ON inventory_batches (shop_id, product_id);

CREATE TABLE sales_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL,
    product_id UUID NOT NULL,
    batch_id UUID NOT NULL REFERENCES inventory_batches(id),
    qty INT NOT NULL CHECK (qty > 0),
    sold_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    stockout_flag BOOLEAN NOT NULL DEFAULT FALSE,
    idempotency_key UUID NOT NULL,
    CONSTRAINT uq_sales_idempotency UNIQUE (shop_id, idempotency_key)
);

CREATE INDEX idx_sales_shop_sold_at ON sales_events (shop_id, sold_at DESC);

-- forecast_db
CREATE TABLE sales_history_read_model (
    sale_id UUID PRIMARY KEY,
    shop_id UUID NOT NULL,
    product_id UUID NOT NULL,
    batch_id UUID NOT NULL,
    qty INT NOT NULL CHECK (qty >= 0),
    sold_date DATE NOT NULL,
    stockout_flag BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX idx_sales_rm_shop_prod_date
    ON sales_history_read_model (shop_id, product_id, sold_date ASC);

CREATE TABLE forecasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL,
    product_id UUID NOT NULL,
    week DATE NOT NULL,
    series_class VARCHAR(20) NOT NULL
        CHECK (series_class IN ('SMOOTH', 'ERRATIC', 'INTERMITTENT', 'LUMPY')),
    expected_qty NUMERIC(10, 2) NOT NULL CHECK (expected_qty >= 0),
    lower NUMERIC(10, 2) NOT NULL CHECK (lower >= 0),
    upper NUMERIC(10, 2) NOT NULL CHECK (upper >= lower),
    safety_stock NUMERIC(10, 2) NOT NULL CHECK (safety_stock >= 0),
    reorder_qty INT NOT NULL CHECK (reorder_qty >= 0),
    model_used VARCHAR(32) NOT NULL,
    model_version VARCHAR(32) NOT NULL,
    trained_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_forecast_shop_product_week UNIQUE (shop_id, product_id, week)
);

CREATE INDEX idx_forecasts_shop_week ON forecasts (shop_id, week DESC);

CREATE TABLE batch_risk_flags (
    batch_id UUID PRIMARY KEY,
    shop_id UUID NOT NULL,
    product_id UUID NOT NULL,
    days_of_cover NUMERIC(8, 2) NOT NULL,
    risk_type VARCHAR(20) NOT NULL CHECK (risk_type IN ('DEAD_STOCK', 'EXPIRY')),
    suggested_action VARCHAR(32) NOT NULL
        CHECK (suggested_action IN ('SWAP_TO_NEIGHBOUR', 'BUNDLE_DISCOUNT', 'RETURN_TO_DISTRIBUTOR')),
    flagged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_risk_flags_shop ON batch_risk_flags (shop_id, risk_type);

-- swap_db
CREATE TABLE swap_listings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL,
    batch_id UUID NOT NULL UNIQUE,
    product_id UUID NOT NULL,
    state VARCHAR(64) NOT NULL,
    qty INT NOT NULL CHECK (qty > 0),
    cost_price NUMERIC(10, 2) NOT NULL CHECK (cost_price >= 0),
    suggested_price NUMERIC(10, 2) NOT NULL CHECK (suggested_price > 0),
    price NUMERIC(10, 2) NOT NULL CHECK (price > 0),
    batch_expiry_date DATE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'RESERVED', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
    expires_at TIMESTAMPTZ NOT NULL,
    idempotency_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_listing_idempotency UNIQUE (shop_id, idempotency_key)
);

CREATE INDEX idx_listings_state_product_open
    ON swap_listings (state, product_id, status)
    WHERE status = 'OPEN';

CREATE INDEX idx_listings_shop_status ON swap_listings (shop_id, status);

CREATE TABLE shortage_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL,
    product_id UUID NOT NULL,
    state VARCHAR(64) NOT NULL,
    reorder_qty INT NOT NULL CHECK (reorder_qty > 0),
    max_unit_price NUMERIC(10, 2) NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'MATCHED', 'FULFILLED', 'EXPIRED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_shortage_open UNIQUE (shop_id, product_id, status)
);

CREATE INDEX idx_shortage_state_prod
    ON shortage_requests (state, product_id)
    WHERE status = 'OPEN';

CREATE TABLE swap_offers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES swap_listings(id),
    seller_shop_id UUID NOT NULL,
    buyer_shop_id UUID NOT NULL,
    qty INT NOT NULL CHECK (qty > 0),
    offered_price NUMERIC(10, 2) NOT NULL CHECK (offered_price > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'COUNTERED', 'ACCEPTED', 'REJECTED', 'EXPIRED')),
    expires_at TIMESTAMPTZ NOT NULL,
    idempotency_key UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_different_shops CHECK (seller_shop_id <> buyer_shop_id),
    CONSTRAINT uq_offer_idempotency UNIQUE (buyer_shop_id, idempotency_key)
);

CREATE INDEX idx_offers_listing_status ON swap_offers (listing_id, status);

CREATE INDEX idx_offers_seller_pending
    ON swap_offers (seller_shop_id, status)
    WHERE status IN ('PENDING', 'COUNTERED');

-- saga_db
CREATE TABLE swap_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    offer_id UUID NOT NULL UNIQUE,
    listing_id UUID NOT NULL,
    seller_shop_id UUID NOT NULL,
    buyer_shop_id UUID NOT NULL,
    batch_id UUID NOT NULL,
    product_id UUID NOT NULL,
    qty INT NOT NULL CHECK (qty > 0),
    price NUMERIC(10, 2) NOT NULL CHECK (price > 0),
    cost_price NUMERIC(10, 2) NOT NULL CHECK (cost_price >= 0),
    expiry_date DATE NOT NULL,
    state VARCHAR(32) NOT NULL CHECK (state IN (
        'INITIATED',
        'RESERVING_STOCK',
        'AWAITING_HANDOVER',
        'HANDOVER_CONFIRMED',
        'COMMITTING_TRANSFER',
        'COMPLETED',
        'FAILED',
        'CANCELLED_COMPENSATED'
    )),
    handover_code_hash CHAR(64) NULL,
    handover_expires_at TIMESTAMPTZ NULL,
    seller_confirmed_at TIMESTAMPTZ NULL,
    buyer_confirmed_at TIMESTAMPTZ NULL,
    bill_record_id UUID NULL,
    tax_disclaimer TEXT NOT NULL
        DEFAULT 'Documented intra-state peer sale. Confirm GST treatment with your accountant.',
    cancel_reason VARCHAR(32) NULL,
    idempotency_key UUID NOT NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_saga_tx_idempotency UNIQUE (buyer_shop_id, idempotency_key)
);

CREATE INDEX idx_swap_tx_shops
    ON swap_transactions (seller_shop_id, buyer_shop_id, state);

CREATE TABLE swap_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES swap_transactions(id) ON DELETE CASCADE,
    step VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_swap_events_tx ON swap_events (transaction_id, timestamp ASC);

-- groupbuy_db
CREATE TABLE groupbuy_windows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    distributor_id VARCHAR(64) NOT NULL,
    state VARCHAR(64) NOT NULL,
    cutoff_at TIMESTAMPTZ NOT NULL,
    min_order_value NUMERIC(12, 2) NOT NULL CHECK (min_order_value > 0),
    delivery_fee NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
    price_tiers JSONB NOT NULL,
    extended_once BOOLEAN NOT NULL DEFAULT FALSE,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
        CHECK (status IN ('OPEN', 'EXTENDED', 'ALLOCATING', 'COMPLETED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gb_windows_cutoff
    ON groupbuy_windows (status, cutoff_at ASC)
    WHERE status IN ('OPEN', 'EXTENDED');

CREATE TABLE groupbuy_commitments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    window_id UUID NOT NULL REFERENCES groupbuy_windows(id),
    shop_id UUID NOT NULL,
    product_id UUID NOT NULL,
    qty INT NOT NULL CHECK (qty > 0),
    idempotency_key UUID NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_gb_commitment UNIQUE (window_id, shop_id, product_id),
    CONSTRAINT uq_gb_commit_idem UNIQUE (shop_id, idempotency_key)
);

CREATE INDEX idx_gb_commitments_window ON groupbuy_commitments (window_id, product_id);

CREATE TABLE groupbuy_allocations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    window_id UUID NOT NULL REFERENCES groupbuy_windows(id),
    shop_id UUID NOT NULL,
    product_id UUID NOT NULL,
    qty INT NOT NULL CHECK (qty > 0),
    unit_tier_price NUMERIC(10, 2) NOT NULL,
    delivery_share NUMERIC(10, 2) NOT NULL,
    landed_cost NUMERIC(10, 2) NOT NULL CHECK (landed_cost > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'ALLOCATED'
        CHECK (status IN ('ALLOCATED', 'DELIVERED', 'CANCELLED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_gb_allocations_shop ON groupbuy_allocations (shop_id, window_id);

-- notify_db
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id UUID NOT NULL,
    type VARCHAR(64) NOT NULL,
    channel VARCHAR(16) NOT NULL CHECK (channel IN ('SSE', 'EMAIL', 'BATCHED')),
    payload JSONB NOT NULL,
    read_at TIMESTAMPTZ NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_shop_sent ON notifications (shop_id, sent_at DESC);

-- analytics_db
CREATE TABLE shop_map_projection (
    shop_id UUID PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    lat NUMERIC(9, 6) NOT NULL,
    lng NUMERIC(9, 6) NOT NULL,
    state VARCHAR(64) NOT NULL,
    reputation_score NUMERIC(5, 2) NOT NULL DEFAULT 100.00,
    active_listings_count INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE network_metrics_projection (
    metric_date DATE PRIMARY KEY,
    dead_stock_value_reduced NUMERIC(14, 2) NOT NULL DEFAULT 0,
    stockouts_avoided INT NOT NULL DEFAULT 0,
    cash_released NUMERIC(14, 2) NOT NULL DEFAULT 0,
    swaps_completed INT NOT NULL DEFAULT 0,
    swaps_failed INT NOT NULL DEFAULT 0,
    groupbuy_savings NUMERIC(14, 2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE simulation_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    config_hash CHAR(64) NOT NULL,
    seed INT NOT NULL,
    shop_count INT NOT NULL,
    exchange_enabled BOOLEAN NOT NULL,
    acceptance_rate NUMERIC(4, 2) NOT NULL,
    radius_km NUMERIC(4, 2) NOT NULL,
    metrics_summary JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_sim_run UNIQUE (config_hash, seed, exchange_enabled)
);

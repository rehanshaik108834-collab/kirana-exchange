import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSwapSchema1700000000000 implements MigrationInterface {
  name = 'InitSwapSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS swap_listings (
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
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_state_product_open
        ON swap_listings (state, product_id, status)
        WHERE status = 'OPEN'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_listings_shop_status
        ON swap_listings (shop_id, status)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS shortage_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        product_id UUID NOT NULL,
        state VARCHAR(64) NOT NULL,
        reorder_qty INT NOT NULL CHECK (reorder_qty > 0),
        max_unit_price NUMERIC(10, 2) NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN'
          CHECK (status IN ('OPEN', 'MATCHED', 'FULFILLED', 'EXPIRED')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_shortage_open
        ON shortage_requests (shop_id, product_id)
        WHERE status = 'OPEN'
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_shortage_state_prod
        ON shortage_requests (state, product_id)
        WHERE status = 'OPEN'
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS swap_offers (
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
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_offers_listing_status
        ON swap_offers (listing_id, status)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_offers_seller_pending
        ON swap_offers (seller_shop_id, status)
        WHERE status IN ('PENDING', 'COUNTERED')
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS shop_geo_read_model (
        shop_id UUID PRIMARY KEY,
        lat NUMERIC(9, 6) NOT NULL,
        lng NUMERIC(9, 6) NOT NULL,
        state VARCHAR(64) NOT NULL,
        gst_scheme VARCHAR(20) NOT NULL DEFAULT 'UNREGISTERED',
        swap_radius_km NUMERIC(4, 2) NOT NULL DEFAULT 2.00,
        reputation_score NUMERIC(5, 2) NOT NULL DEFAULT 100.00,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_shop_geo_state ON shop_geo_read_model (state)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS risk_listing_drafts (
        batch_id UUID PRIMARY KEY,
        shop_id UUID NOT NULL,
        product_id UUID NOT NULL,
        risk_type VARCHAR(20) NOT NULL,
        days_of_cover NUMERIC(8, 2) NOT NULL,
        expected_unsold_qty INT NOT NULL DEFAULT 1,
        recommended_action VARCHAR(32) NOT NULL,
        dismissed BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_risk_drafts_shop ON risk_listing_drafts (shop_id, dismissed)
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        aggregate_type VARCHAR(64) NOT NULL,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        correlation_id UUID NOT NULL,
        producer VARCHAR(64) NOT NULL DEFAULT 'swap-service',
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
        ON outbox_events (occurred_at ASC)
        WHERE published_at IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id UUID NOT NULL,
        consumer_name VARCHAR(64) NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, consumer_name)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS processed_messages`);
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS risk_listing_drafts`);
    await queryRunner.query(`DROP TABLE IF EXISTS shop_geo_read_model`);
    await queryRunner.query(`DROP TABLE IF EXISTS swap_offers`);
    await queryRunner.query(`DROP TABLE IF EXISTS shortage_requests`);
    await queryRunner.query(`DROP TABLE IF EXISTS swap_listings`);
  }
}

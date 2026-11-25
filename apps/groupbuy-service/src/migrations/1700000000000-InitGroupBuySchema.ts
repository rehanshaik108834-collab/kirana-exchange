import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitGroupBuySchema1700000000000 implements MigrationInterface {
  name = 'InitGroupBuySchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS groupbuy_windows (
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
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_gb_windows_cutoff
        ON groupbuy_windows (status, cutoff_at ASC)
        WHERE status IN ('OPEN', 'EXTENDED');
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS groupbuy_commitments (
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
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_gb_commitments_window
        ON groupbuy_commitments (window_id, product_id);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS groupbuy_allocations (
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
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_gb_allocations_shop
        ON groupbuy_allocations (shop_id, window_id);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        aggregate_type VARCHAR(64) NOT NULL,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        correlation_id UUID NOT NULL,
        producer VARCHAR(64) NOT NULL DEFAULT 'groupbuy-service',
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        published_at TIMESTAMPTZ NULL
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
        ON outbox_events (occurred_at ASC)
        WHERE published_at IS NULL;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        message_id UUID NOT NULL,
        consumer_name VARCHAR(64) NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, consumer_name)
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS processed_messages;`);
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS groupbuy_allocations;`);
    await queryRunner.query(`DROP TABLE IF EXISTS groupbuy_commitments;`);
    await queryRunner.query(`DROP TABLE IF EXISTS groupbuy_windows;`);
  }
}

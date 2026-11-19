import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitInventorySchema1700000000000 implements MigrationInterface {
  name = 'InitInventorySchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS inventory_batches (
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
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_batches_shop_expiry
        ON inventory_batches (shop_id, expiry_date ASC)
        WHERE qty > 0;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_batches_shop_product
        ON inventory_batches (shop_id, product_id);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS sales_events (
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
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_sales_shop_sold_at
        ON sales_events (shop_id, sold_at DESC);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS idempotency_records (
        shop_id UUID NOT NULL,
        idempotency_key UUID NOT NULL,
        operation VARCHAR(32) NOT NULL,
        request_hash CHAR(64) NOT NULL,
        response_body JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (shop_id, idempotency_key)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outbox_events (
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

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
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
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_audit_entity
        ON audit_logs (entity_type, entity_id, created_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS sales_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS idempotency_records;`);
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS processed_messages;`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS inventory_batches;`);
  }
}

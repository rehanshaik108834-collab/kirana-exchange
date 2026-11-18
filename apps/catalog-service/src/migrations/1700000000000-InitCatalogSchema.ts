import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitCatalogSchema1700000000000 implements MigrationInterface {
  name = 'InitCatalogSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm";`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS products (
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
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_products_name_trgm
        ON products USING GIN (name gin_trgm_ops)
        WHERE is_active = TRUE;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_products_brand_trgm
        ON products USING GIN (brand gin_trgm_ops)
        WHERE is_active = TRUE;
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
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS products;`);
  }
}

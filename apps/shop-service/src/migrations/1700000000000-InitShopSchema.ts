import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitShopSchema1700000000000 implements MigrationInterface {
  name = 'InitShopSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS shops (
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
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS idx_shops_state ON shops (state);`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS disputes (
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
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes (status, created_at DESC);
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
    await queryRunner.query(`DROP TABLE IF EXISTS disputes;`);
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS processed_messages;`);
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS shops;`);
  }
}

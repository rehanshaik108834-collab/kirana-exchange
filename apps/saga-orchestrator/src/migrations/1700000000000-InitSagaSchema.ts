import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSagaSchema1700000000000 implements MigrationInterface {
  name = 'InitSagaSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS swap_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        offer_id UUID NOT NULL UNIQUE,
        listing_id UUID NOT NULL,
        seller_shop_id UUID NOT NULL,
        buyer_shop_id UUID NOT NULL,
        batch_id UUID NOT NULL,
        product_id UUID NOT NULL,
        shop_state VARCHAR(64) NOT NULL DEFAULT 'Unknown',
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
          'COMPENSATING',
          'COMPLETED',
          'FAILED',
          'FAILED_NO_STOCK',
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
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_swap_tx_shops
        ON swap_transactions (seller_shop_id, buyer_shop_id, state);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS swap_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id UUID NOT NULL REFERENCES swap_transactions(id) ON DELETE CASCADE,
        step VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_swap_events_tx
        ON swap_events (transaction_id, timestamp ASC);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        aggregate_type VARCHAR(64) NOT NULL,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        correlation_id UUID NOT NULL,
        producer VARCHAR(64) NOT NULL DEFAULT 'saga-orchestrator',
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS audit_logs;`);
    await queryRunner.query(`DROP TABLE IF EXISTS processed_messages;`);
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS swap_events;`);
    await queryRunner.query(`DROP TABLE IF EXISTS swap_transactions;`);
  }
}

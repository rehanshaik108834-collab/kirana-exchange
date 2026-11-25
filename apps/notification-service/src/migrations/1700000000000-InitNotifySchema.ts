import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitNotifySchema1700000000000 implements MigrationInterface {
  name = 'InitNotifySchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shop_id UUID NOT NULL,
        type VARCHAR(64) NOT NULL,
        channel VARCHAR(16) NOT NULL CHECK (channel IN ('SSE', 'EMAIL', 'BATCHED')),
        payload JSONB NOT NULL,
        read_at TIMESTAMPTZ NULL,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_notifications_shop_sent
        ON notifications (shop_id, sent_at DESC);
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS shop_contacts (
        shop_id UUID PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
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
    await queryRunner.query(`DROP TABLE IF EXISTS shop_contacts;`);
    await queryRunner.query(`DROP TABLE IF EXISTS notifications;`);
  }
}

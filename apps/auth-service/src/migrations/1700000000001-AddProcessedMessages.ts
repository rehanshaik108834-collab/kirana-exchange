import { MigrationInterface, QueryRunner } from 'typeorm';

/** Dedup table for auth-service event consumers (shop.created.v1 shop linking). */
export class AddProcessedMessages1700000000001 implements MigrationInterface {
  name = 'AddProcessedMessages1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
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
  }
}

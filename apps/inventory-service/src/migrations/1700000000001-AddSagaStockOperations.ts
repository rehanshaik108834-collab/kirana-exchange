import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSagaStockOperations1700000000001 implements MigrationInterface {
  name = 'AddSagaStockOperations1700000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS saga_stock_operations (
        transaction_id UUID NOT NULL,
        step VARCHAR(32) NOT NULL CHECK (step IN ('RESERVE', 'RELEASE', 'COMMIT_TRANSFER')),
        batch_id UUID NOT NULL,
        shop_id UUID NOT NULL,
        qty INT NOT NULL CHECK (qty >= 0),
        status VARCHAR(32) NOT NULL CHECK (status IN ('APPLIED', 'FAILED', 'NOOP_NOT_RESERVED')),
        result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (transaction_id, step)
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_saga_stock_ops_batch
        ON saga_stock_operations (batch_id, created_at DESC);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS saga_stock_operations;`);
  }
}

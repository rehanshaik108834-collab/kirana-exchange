import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it } from 'vitest';
import { InventoryBatch } from '../src/entities/inventory-batch.entity';
import { OutboxEvent } from '../src/entities/outbox-event.entity';
import { SagaStockOperation } from '../src/entities/saga-stock-operation.entity';
import { SaleEvent } from '../src/entities/sale-event.entity';
import { InitInventorySchema1700000000000 } from '../src/migrations/1700000000000-InitInventorySchema';
import { AddSagaStockOperations1700000000001 } from '../src/migrations/1700000000001-AddSagaStockOperations';
import { SagaInventoryService } from '../src/saga-inventory.service';

const RUN_PG_GATE = process.env.RUN_PG_CONCURRENCY_GATE === 'true';

describe.skipIf(!RUN_PG_GATE)('Live PostgreSQL Concurrency Gate (1,000 claims on 30 units)', () => {
  it('allocates exactly 30 units with 0 over-reserves under real PostgreSQL row contention', async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'kirana_admin',
      password: process.env.DB_PASSWORD || 'secretpassword',
      database: process.env.DB_NAME || 'inventory_db',
      entities: [InventoryBatch, SaleEvent, OutboxEvent, SagaStockOperation],
      migrations: [InitInventorySchema1700000000000, AddSagaStockOperations1700000000001],
      migrationsRun: true,
      extra: { max: 50 },
    });

    await dataSource.initialize();
    const shopId = uuidv4();
    const productId = uuidv4();
    const batchId = uuidv4();

    try {
      await dataSource.query(
        `INSERT INTO inventory_batches
          (id, shop_id, product_id, batch_code, qty, reserved_qty, cost_price, expiry_date, version, idempotency_key)
         VALUES ($1, $2, $3, $4, 30, 0, 50.00, '2026-12-31', 1, $5)`,
        [batchId, shopId, productId, `PG-GATE-${batchId.slice(0, 8)}`, uuidv4()],
      );

      const service = new SagaInventoryService(dataSource);
      const results = await Promise.all(
        Array.from({ length: 1000 }, () =>
          service.handleReserveStockCommand({
            transactionId: uuidv4(),
            batchId,
            sellerShopId: shopId,
            qty: 1,
          }),
        ),
      );

      const reserved = results.filter((r) => r.outcome === 'RESERVED');
      const failed = results.filter((r) => r.outcome === 'RESERVE_FAILED');

      expect(reserved).toHaveLength(30);
      expect(failed).toHaveLength(970);

      const [row] = (await dataSource.query(
        `SELECT qty, reserved_qty, version FROM inventory_batches WHERE id = $1`,
        [batchId],
      )) as Array<{ qty: number; reserved_qty: number; version: number }>;

      expect(Number(row.qty)).toBe(30);
      expect(Number(row.reserved_qty)).toBe(30);
      expect(Number(row.version)).toBe(31);
    } finally {
      await dataSource.query(`DELETE FROM outbox_events WHERE aggregate_id = $1`, [batchId]);
      await dataSource.query(`DELETE FROM saga_stock_operations WHERE batch_id = $1`, [batchId]);
      await dataSource.query(`DELETE FROM inventory_batches WHERE id = $1`, [batchId]);
      await dataSource.destroy();
    }
  }, 60_000);
});

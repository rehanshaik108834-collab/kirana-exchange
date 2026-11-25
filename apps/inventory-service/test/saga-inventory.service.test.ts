import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import { InventoryBatch } from '../src/entities/inventory-batch.entity';
import { OutboxEvent } from '../src/entities/outbox-event.entity';
import { SagaInventoryService } from '../src/saga-inventory.service';

interface SimBatch {
  id: string;
  shop_id: string;
  product_id: string;
  batch_code: string;
  qty: number;
  reserved_qty: number;
  cost_price: string;
  expiry_date: string;
  version: number;
  idempotency_key: string;
}

interface SimOp {
  transaction_id: string;
  step: string;
  batch_id: string;
  shop_id: string;
  qty: number;
  status: string;
  result_payload: Record<string, unknown>;
}

/**
 * In-memory atomic PostgreSQL store faithfully simulating row-level UPDATE locking,
 * CHECK (qty >= 0 AND reserved_qty >= 0 AND reserved_qty <= qty), and PRIMARY KEY
 * constraints on saga_stock_operations for high-contention concurrency testing.
 */
function createAtomicSimDataSource(initialBatches: SimBatch[]) {
  const batches = new Map<string, SimBatch>(initialBatches.map((b) => [b.id, { ...b }]));
  const ops = new Map<string, SimOp>();
  const outbox: Array<{ eventType: string; payload: Record<string, unknown> }> = [];

  const enforceCheck = (b: SimBatch) => {
    if (b.qty < 0 || b.reserved_qty < 0 || b.reserved_qty > b.qty) {
      throw new Error(`CHECK_VIOLATION: qty=${b.qty}, reserved=${b.reserved_qty}`);
    }
  };

  const makeManager = () => ({
    findOne: async (cls: unknown, opts: { where: { id?: string; shopId?: string } }) => {
      if (cls !== InventoryBatch) return null;
      const b = opts.where.id ? batches.get(opts.where.id) : undefined;
      if (!b || (opts.where.shopId && b.shop_id !== opts.where.shopId)) return null;
      return Object.assign(new InventoryBatch(), {
        id: b.id,
        shopId: b.shop_id,
        productId: b.product_id,
        batchCode: b.batch_code,
        qty: b.qty,
        reservedQty: b.reserved_qty,
        costPrice: b.cost_price,
        expiryDate: b.expiry_date,
        version: b.version,
      });
    },
    create: (_cls: unknown, data: Record<string, unknown>) => ({ ...data }),
    save: async (cls: unknown, entity: any) => {
      if (cls === OutboxEvent) {
        outbox.push({ eventType: entity.eventType, payload: entity.payload });
        return entity;
      }
      if (cls === InventoryBatch) {
        const id = entity.id || uuidv4();
        const row: SimBatch = {
          id,
          shop_id: entity.shopId,
          product_id: entity.productId,
          batch_code: entity.batchCode,
          qty: Number(entity.qty),
          reserved_qty: Number(entity.reservedQty ?? 0),
          cost_price: String(entity.costPrice),
          expiry_date: String(entity.expiryDate),
          version: Number(entity.version ?? 1),
          idempotency_key: String(entity.idempotencyKey),
        };
        enforceCheck(row);
        batches.set(id, row);
        return { ...entity, id };
      }
      return entity;
    },
    query: async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (
        normalized.startsWith(
          'SELECT transaction_id, step, status, qty, result_payload FROM saga_stock_operations',
        )
      ) {
        const txId = String(params[0]);
        if (normalized.includes("AND step = 'RESERVE'")) {
          const hit = ops.get(`${txId}:RESERVE`);
          return hit ? [hit] : [];
        }
        return [...ops.values()].filter((o) => o.transaction_id === txId);
      }

      if (normalized.startsWith('INSERT INTO saga_stock_operations')) {
        const txId = String(params[0]);
        const stepMatch = normalized.match(/'(RESERVE|RELEASE|COMMIT_TRANSFER)'/);
        const step = stepMatch ? stepMatch[1] : '';
        const statusMatch = normalized.match(/'(APPLIED|FAILED|NOOP_NOT_RESERVED)'/);
        const status = statusMatch ? statusMatch[1] : 'APPLIED';
        const key = `${txId}:${step}`;
        if (!ops.has(key)) {
          const isNoop = status === 'NOOP_NOT_RESERVED';
          ops.set(key, {
            transaction_id: txId,
            step,
            batch_id: String(params[1]),
            shop_id: String(params[2]),
            qty: isNoop ? 0 : Number(params[3]),
            status,
            result_payload: JSON.parse(String(isNoop ? params[3] : params[4])),
          });
        }
        return [];
      }

      if (normalized.includes('SET reserved_qty = reserved_qty + $1')) {
        const qty = Number(params[0]);
        const batchId = String(params[1]);
        const shopId = String(params[2]);
        const expectedVersion = params.length === 4 ? Number(params[3]) : undefined;
        const b = batches.get(batchId);
        if (!b || b.shop_id !== shopId) return [[], 0];
        if (expectedVersion !== undefined && b.version !== expectedVersion) return [[], 0];
        if (b.qty - b.reserved_qty < qty) return [[], 0];
        b.reserved_qty += qty;
        b.version += 1;
        enforceCheck(b);
        return [[{ ...b }], 1];
      }

      if (normalized.includes('SET reserved_qty = reserved_qty - $1')) {
        const qty = Number(params[0]);
        const batchId = String(params[1]);
        const shopId = String(params[2]);
        const b = batches.get(batchId);
        if (!b || b.shop_id !== shopId || b.reserved_qty < qty) return [[], 0];
        b.reserved_qty -= qty;
        b.version += 1;
        enforceCheck(b);
        return [[{ ...b }], 1];
      }

      if (normalized.includes('SET qty = qty - $1, reserved_qty = reserved_qty - $1')) {
        const qty = Number(params[0]);
        const batchId = String(params[1]);
        const shopId = String(params[2]);
        const b = batches.get(batchId);
        if (!b || b.shop_id !== shopId || b.qty < qty || b.reserved_qty < qty) return [[], 0];
        b.qty -= qty;
        b.reserved_qty -= qty;
        b.version += 1;
        enforceCheck(b);
        return [[{ ...b }], 1];
      }

      throw new Error(`Unhandled SQL in sim store: ${normalized}`);
    },
  });

  const dataSource: any = {
    transaction: async (cb: (m: any) => Promise<any>) => cb(makeManager()),
  };

  return { dataSource, batches, ops, outbox };
}

describe('SagaInventoryService — Concurrency Gate & Compensation Invariants', () => {
  const SELLER_SHOP = '11111111-1111-4111-8111-111111111111';
  const BUYER_SHOP = '22222222-2222-4222-8222-222222222222';
  const PRODUCT_ID = '33333333-3333-4333-8333-333333333333';
  const BATCH_ID = '44444444-4444-4444-8444-444444444444';

  it('CONCURRENCY GATE: 1,000 concurrent claims on 30 units allocate exactly 30 with 0 over-reserves (even when Redis is down)', async () => {
    const { dataSource, batches, outbox } = createAtomicSimDataSource([
      {
        id: BATCH_ID,
        shop_id: SELLER_SHOP,
        product_id: PRODUCT_ID,
        batch_code: 'B-GATE-30',
        qty: 30,
        reserved_qty: 0,
        cost_price: '48.50',
        expiry_date: '2026-08-15',
        version: 1,
        idempotency_key: uuidv4(),
      },
    ]);

    // Simulate Redis completely down (ADR-004: Postgres remains authoritative)
    const brokenRedis = {
      set: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      eval: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };

    const service = new SagaInventoryService(dataSource, brokenRedis as any);

    const claims = Array.from({ length: 1000 }, () =>
      service.handleReserveStockCommand({
        transactionId: uuidv4(),
        batchId: BATCH_ID,
        sellerShopId: SELLER_SHOP,
        qty: 1,
      }),
    );

    const results = await Promise.all(claims);

    const succeeded = results.filter((r) => r.outcome === 'RESERVED');
    const failed = results.filter((r) => r.outcome === 'RESERVE_FAILED');

    expect(succeeded).toHaveLength(30);
    expect(failed).toHaveLength(970);
    expect(failed.every((r) => r.reason === 'INSUFFICIENT_QTY')).toBe(true);

    const finalBatch = batches.get(BATCH_ID)!;
    expect(finalBatch.qty).toBe(30);
    expect(finalBatch.reserved_qty).toBe(30);
    expect(finalBatch.version).toBe(31);

    const reservedEvents = outbox.filter((e) => e.eventType === 'inventory.stock.reserved.v1');
    const failedEvents = outbox.filter((e) => e.eventType === 'inventory.stock.reserve_failed.v1');
    expect(reservedEvents).toHaveLength(30);
    expect(failedEvents).toHaveLength(970);
  });

  it('handles duplicate ReserveStockCmd, ReleaseStockCmd, and CommitTransferCmd idempotently', async () => {
    const { dataSource, batches, outbox } = createAtomicSimDataSource([
      {
        id: BATCH_ID,
        shop_id: SELLER_SHOP,
        product_id: PRODUCT_ID,
        batch_code: 'B-SWAP-01',
        qty: 20,
        reserved_qty: 0,
        cost_price: '62.75',
        expiry_date: '2026-06-30',
        version: 1,
        idempotency_key: uuidv4(),
      },
    ]);

    const service = new SagaInventoryService(dataSource);
    const txId = uuidv4();

    // 1. Reserve 8 units + duplicate retry
    const r1 = await service.handleReserveStockCommand({
      transactionId: txId,
      batchId: BATCH_ID,
      sellerShopId: SELLER_SHOP,
      qty: 8,
    });
    const r2 = await service.handleReserveStockCommand({
      transactionId: txId,
      batchId: BATCH_ID,
      sellerShopId: SELLER_SHOP,
      qty: 8,
    });
    expect(r1.outcome).toBe('RESERVED');
    expect(r2.outcome).toBe('DUPLICATE');
    expect(batches.get(BATCH_ID)!.reserved_qty).toBe(8);

    // 2. Commit transfer -> decrements seller qty & reserved_qty, creates buyer batch preserving cost_price & expiry_date
    const c1 = await service.handleCommitTransferCommand({
      transactionId: txId,
      sellerBatchId: BATCH_ID,
      sellerShopId: SELLER_SHOP,
      buyerShopId: BUYER_SHOP,
      productId: PRODUCT_ID,
      qty: 8,
    });
    const c2 = await service.handleCommitTransferCommand({
      transactionId: txId,
      sellerBatchId: BATCH_ID,
      sellerShopId: SELLER_SHOP,
      buyerShopId: BUYER_SHOP,
      productId: PRODUCT_ID,
      qty: 8,
    });

    expect(c1.outcome).toBe('TRANSFER_COMMITTED');
    expect(c2.outcome).toBe('DUPLICATE');
    expect(batches.get(BATCH_ID)!.qty).toBe(12);
    expect(batches.get(BATCH_ID)!.reserved_qty).toBe(0);

    const buyerBatch = batches.get(c1.buyerBatchId!)!;
    expect(buyerBatch.shop_id).toBe(BUYER_SHOP);
    expect(buyerBatch.product_id).toBe(PRODUCT_ID);
    expect(buyerBatch.qty).toBe(8);
    expect(buyerBatch.reserved_qty).toBe(0);
    expect(buyerBatch.cost_price).toBe('62.75');
    expect(buyerBatch.expiry_date).toBe('2026-06-30');

    const committedEvents = outbox.filter((e) => e.eventType === 'inventory.transfer.committed.v1');
    expect(committedEvents).toHaveLength(1);
    expect(committedEvents[0].payload.buyerBatchId).toBe(buyerBatch.id);
  });

  it('compensates safely via ReleaseStockCmd both when reserve succeeded and when reserve never landed', async () => {
    const { dataSource, batches, outbox } = createAtomicSimDataSource([
      {
        id: BATCH_ID,
        shop_id: SELLER_SHOP,
        product_id: PRODUCT_ID,
        batch_code: 'B-COMP-01',
        qty: 10,
        reserved_qty: 0,
        cost_price: '35.00',
        expiry_date: '2026-07-01',
        version: 1,
        idempotency_key: uuidv4(),
      },
    ]);

    const service = new SagaInventoryService(dataSource);

    // Case A: Reserve succeeded, then timeout triggers ReleaseStockCmd (+ duplicate replay)
    const txA = uuidv4();
    await service.handleReserveStockCommand({
      transactionId: txA,
      batchId: BATCH_ID,
      sellerShopId: SELLER_SHOP,
      qty: 6,
    });
    expect(batches.get(BATCH_ID)!.reserved_qty).toBe(6);

    const relA1 = await service.handleReleaseStockCommand({
      transactionId: txA,
      batchId: BATCH_ID,
      sellerShopId: SELLER_SHOP,
      qty: 6,
    });
    const relA2 = await service.handleReleaseStockCommand({
      transactionId: txA,
      batchId: BATCH_ID,
      sellerShopId: SELLER_SHOP,
      qty: 6,
    });
    expect(relA1.outcome).toBe('RELEASED');
    expect(relA2.outcome).toBe('DUPLICATE');
    expect(batches.get(BATCH_ID)!.reserved_qty).toBe(0);

    // Case B: Reserve never landed -> ReleaseStockCmd must still emit StockReleased(0) cleanly
    const txB = uuidv4();
    const relB = await service.handleReleaseStockCommand({
      transactionId: txB,
      batchId: BATCH_ID,
      sellerShopId: SELLER_SHOP,
      qty: 4,
    });
    expect(relB.outcome).toBe('RELEASE_NOOP');
    expect(batches.get(BATCH_ID)!.reserved_qty).toBe(0);

    const releasedEvents = outbox.filter((e) => e.eventType === 'inventory.stock.released.v1');
    expect(releasedEvents).toHaveLength(2);
    expect(releasedEvents[0].payload.releasedQty).toBe(6);
    expect(releasedEvents[1].payload.releasedQty).toBe(0);
  });

  it('reports VERSION_CONFLICT when expectedVersion does not match current batch version', async () => {
    const { dataSource } = createAtomicSimDataSource([
      {
        id: BATCH_ID,
        shop_id: SELLER_SHOP,
        product_id: PRODUCT_ID,
        batch_code: 'B-VER-01',
        qty: 10,
        reserved_qty: 0,
        cost_price: '20.00',
        expiry_date: '2026-09-01',
        version: 4,
        idempotency_key: uuidv4(),
      },
    ]);

    const service = new SagaInventoryService(dataSource);
    const res = await service.handleReserveStockCommand({
      transactionId: uuidv4(),
      batchId: BATCH_ID,
      sellerShopId: SELLER_SHOP,
      qty: 5,
      expectedVersion: 3,
    });

    expect(res.outcome).toBe('RESERVE_FAILED');
    expect(res.reason).toBe('VERSION_CONFLICT');
  });
});

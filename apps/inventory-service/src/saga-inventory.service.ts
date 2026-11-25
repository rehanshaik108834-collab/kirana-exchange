import { Inject, Injectable, Optional } from '@nestjs/common';
import { REDIS_CLIENT } from '@kirana/common';
import type Redis from 'ioredis';
import pino from 'pino';
import { DataSource, type EntityManager } from 'typeorm';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { InventoryBatch } from './entities/inventory-batch.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { toDateOnly } from './inventory.service';

const FAST_LOCK_TTL_MS = 2000;

const RELEASE_LOCK_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
`;

export interface ReserveStockCommandPayload {
  transactionId: string;
  batchId: string;
  sellerShopId: string;
  qty: number;
  expectedVersion?: number;
}

export interface ReleaseStockCommandPayload {
  transactionId: string;
  batchId: string;
  sellerShopId: string;
  qty: number;
}

export interface CommitTransferCommandPayload {
  transactionId: string;
  sellerBatchId: string;
  sellerShopId: string;
  buyerShopId: string;
  productId: string;
  qty: number;
  costPrice?: number;
  expiryDate?: string;
}

export interface SagaCommandResult {
  outcome:
    | 'RESERVED'
    | 'RESERVE_FAILED'
    | 'RELEASED'
    | 'RELEASE_NOOP'
    | 'TRANSFER_COMMITTED'
    | 'TRANSFER_FAILED'
    | 'DUPLICATE';
  eventType?: string;
  reason?: string;
  newBatchVersion?: number;
  buyerBatchId?: string;
}

interface RawBatchRow {
  id: string;
  shop_id: string;
  product_id: string;
  batch_code: string;
  qty: number;
  reserved_qty: number;
  cost_price: string;
  expiry_date: string | Date;
  version: number;
}

interface RawOpRow {
  transaction_id: string;
  step: string;
  status: string;
  qty: number;
  result_payload: Record<string, unknown>;
}

function extractReturningRows<T>(queryResult: unknown): T[] {
  if (Array.isArray(queryResult) && Array.isArray(queryResult[0])) {
    return queryResult[0] as T[];
  }
  return Array.isArray(queryResult) ? (queryResult as T[]) : [];
}

function normalizeUuid(value?: string): string {
  return value && isUuid(value) ? value : uuidv4();
}

@Injectable()
export class SagaInventoryService {
  private readonly logger = pino({ name: 'inventory-saga-service' });

  constructor(
    private readonly dataSource: DataSource,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  private async tryAcquireFastLock(batchId: string, lockToken: string): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const res = await this.redis.set(
        `lock:batch:${batchId}`,
        lockToken,
        'PX',
        FAST_LOCK_TTL_MS,
        'NX',
      );
      return res === 'OK';
    } catch (err) {
      this.logger.warn(
        { batchId, err: (err as Error).message },
        'Redis fast-path lock unavailable during saga reserve; continuing to PostgreSQL guard',
      );
      return false;
    }
  }

  private async releaseFastLock(batchId: string, lockToken: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, `lock:batch:${batchId}`, lockToken);
    } catch (err) {
      this.logger.warn(
        { batchId, err: (err as Error).message },
        'Redis fast-path lock release failed',
      );
    }
  }

  private async enqueueOutbox(
    manager: EntityManager,
    params: {
      aggregateType: string;
      aggregateId: string;
      eventType: string;
      correlationId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await manager.save(
      OutboxEvent,
      manager.create(OutboxEvent, {
        aggregateType: params.aggregateType,
        aggregateId: params.aggregateId,
        eventType: params.eventType,
        version: 1,
        correlationId: params.correlationId,
        producer: 'inventory-service',
        payload: params.payload,
        publishedAt: null,
      }),
    );
  }

  /**
   * Executes `ReserveStockCmd` with strict (transaction_id, 'RESERVE') idempotency and
   * ADR-004 authoritative PostgreSQL conditional UPDATE (`(qty - reserved_qty) >= qty`).
   */
  async handleReserveStockCommand(
    cmd: ReserveStockCommandPayload,
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SagaCommandResult> {
    const validCorr = normalizeUuid(correlationId);
    const lockToken = `${cmd.transactionId}:${uuidv4()}`;
    const lockAcquired = await this.tryAcquireFastLock(cmd.batchId, lockToken);

    const runInTx = async (manager: EntityManager): Promise<SagaCommandResult> => {
      // 1. Transaction-level idempotency check (protects against retries with new message IDs)
      const priorOps = (await manager.query(
        `SELECT transaction_id, step, status, qty, result_payload
         FROM saga_stock_operations
         WHERE transaction_id = $1 AND step = 'RESERVE'`,
        [cmd.transactionId],
      )) as RawOpRow[];

      if (priorOps.length > 0) {
        return { outcome: 'DUPLICATE' };
      }

      // 2. Authoritative PostgreSQL conditional reservation guard (ADR-004)
      const rawUpdate =
        cmd.expectedVersion !== undefined
          ? await manager.query(
              `
              UPDATE inventory_batches
              SET reserved_qty = reserved_qty + $1, version = version + 1, updated_at = NOW()
              WHERE id = $2
                AND shop_id = $3
                AND version = $4
                AND (qty - reserved_qty) >= $1
              RETURNING id, shop_id, product_id, batch_code, qty, reserved_qty, cost_price, expiry_date, version
              `,
              [cmd.qty, cmd.batchId, cmd.sellerShopId, cmd.expectedVersion],
            )
          : await manager.query(
              `
              UPDATE inventory_batches
              SET reserved_qty = reserved_qty + $1, version = version + 1, updated_at = NOW()
              WHERE id = $2
                AND shop_id = $3
                AND (qty - reserved_qty) >= $1
              RETURNING id, shop_id, product_id, batch_code, qty, reserved_qty, cost_price, expiry_date, version
              `,
              [cmd.qty, cmd.batchId, cmd.sellerShopId],
            );

      const updatedRows = extractReturningRows<RawBatchRow>(rawUpdate);

      if (updatedRows.length === 0) {
        const current = await manager.findOne(InventoryBatch, {
          where: { id: cmd.batchId, shopId: cmd.sellerShopId },
        });
        const reason = !current
          ? 'BATCH_NOT_FOUND'
          : cmd.expectedVersion !== undefined && current.version !== cmd.expectedVersion
            ? 'VERSION_CONFLICT'
            : 'INSUFFICIENT_QTY';

        const failPayload = {
          transactionId: cmd.transactionId,
          batchId: cmd.batchId,
          shopId: cmd.sellerShopId,
          requestedQty: cmd.qty,
          reason,
        };

        await manager.query(
          `
          INSERT INTO saga_stock_operations
            (transaction_id, step, batch_id, shop_id, qty, status, result_payload)
          VALUES ($1, 'RESERVE', $2, $3, $4, 'FAILED', $5::jsonb)
          ON CONFLICT (transaction_id, step) DO NOTHING
          `,
          [cmd.transactionId, cmd.batchId, cmd.sellerShopId, cmd.qty, JSON.stringify(failPayload)],
        );

        await this.enqueueOutbox(manager, {
          aggregateType: 'inventory_batch',
          aggregateId: cmd.batchId,
          eventType: 'inventory.stock.reserve_failed.v1',
          correlationId: validCorr,
          payload: failPayload,
        });

        return {
          outcome: 'RESERVE_FAILED',
          eventType: 'inventory.stock.reserve_failed.v1',
          reason,
        };
      }

      const updated = updatedRows[0];
      const newVersion = Number(updated.version);
      const reservedPayload = {
        transactionId: cmd.transactionId,
        batchId: updated.id,
        shopId: updated.shop_id,
        reservedQty: cmd.qty,
        newBatchVersion: newVersion,
      };

      await manager.query(
        `
        INSERT INTO saga_stock_operations
          (transaction_id, step, batch_id, shop_id, qty, status, result_payload)
        VALUES ($1, 'RESERVE', $2, $3, $4, 'APPLIED', $5::jsonb)
        ON CONFLICT (transaction_id, step) DO NOTHING
        `,
        [cmd.transactionId, updated.id, updated.shop_id, cmd.qty, JSON.stringify(reservedPayload)],
      );

      await this.enqueueOutbox(manager, {
        aggregateType: 'inventory_batch',
        aggregateId: updated.id,
        eventType: 'inventory.stock.reserved.v1',
        correlationId: validCorr,
        payload: reservedPayload,
      });

      await this.enqueueOutbox(manager, {
        aggregateType: 'inventory_batch',
        aggregateId: updated.id,
        eventType: 'inventory.stock.updated.v1',
        correlationId: validCorr,
        payload: {
          batchId: updated.id,
          shopId: updated.shop_id,
          productId: updated.product_id,
          qty: Number(updated.qty),
          reservedQty: Number(updated.reserved_qty),
          costPrice: Number(updated.cost_price),
          expiryDate: toDateOnly(updated.expiry_date),
        },
      });

      return {
        outcome: 'RESERVED',
        eventType: 'inventory.stock.reserved.v1',
        newBatchVersion: newVersion,
      };
    };

    try {
      return existingManager
        ? await runInTx(existingManager)
        : await this.dataSource.transaction(runInTx);
    } finally {
      if (lockAcquired) {
        await this.releaseFastLock(cmd.batchId, lockToken);
      }
    }
  }

  /**
   * Executes `ReleaseStockCmd` (saga compensation).
   * Safe and idempotent even if `ReserveStockCmd` never landed or previously failed:
   * still emits `inventory.stock.released.v1` so the saga can reach `CANCELLED_COMPENSATED`.
   */
  async handleReleaseStockCommand(
    cmd: ReleaseStockCommandPayload,
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SagaCommandResult> {
    const validCorr = normalizeUuid(correlationId);

    const runInTx = async (manager: EntityManager): Promise<SagaCommandResult> => {
      const priorOps = (await manager.query(
        `SELECT transaction_id, step, status, qty, result_payload
         FROM saga_stock_operations
         WHERE transaction_id = $1`,
        [cmd.transactionId],
      )) as RawOpRow[];

      if (priorOps.some((op) => op.step === 'RELEASE')) {
        return { outcome: 'DUPLICATE' };
      }

      const reserveOp = priorOps.find((op) => op.step === 'RESERVE');
      const commitOp = priorOps.find((op) => op.step === 'COMMIT_TRANSFER');

      // If reserve never succeeded (timeout before reserve landed) or transfer already committed,
      // record a safe no-op release so the orchestrator cleanly exits COMPENSATING.
      if (!reserveOp || reserveOp.status !== 'APPLIED' || commitOp?.status === 'APPLIED') {
        const noopPayload = {
          transactionId: cmd.transactionId,
          batchId: cmd.batchId,
          releasedQty: 0,
          newBatchVersion: null,
          reason: commitOp?.status === 'APPLIED' ? 'ALREADY_COMMITTED' : 'RESERVE_NOT_APPLIED',
        };

        await manager.query(
          `
          INSERT INTO saga_stock_operations
            (transaction_id, step, batch_id, shop_id, qty, status, result_payload)
          VALUES ($1, 'RELEASE', $2, $3, 0, 'NOOP_NOT_RESERVED', $4::jsonb)
          ON CONFLICT (transaction_id, step) DO NOTHING
          `,
          [cmd.transactionId, cmd.batchId, cmd.sellerShopId, JSON.stringify(noopPayload)],
        );

        await this.enqueueOutbox(manager, {
          aggregateType: 'inventory_batch',
          aggregateId: cmd.batchId,
          eventType: 'inventory.stock.released.v1',
          correlationId: validCorr,
          payload: noopPayload,
        });

        return {
          outcome: 'RELEASE_NOOP',
          eventType: 'inventory.stock.released.v1',
          reason: noopPayload.reason,
        };
      }

      const qtyToRelease = Math.min(cmd.qty, Number(reserveOp.qty));
      const rawRelease = await manager.query(
        `
        UPDATE inventory_batches
        SET reserved_qty = reserved_qty - $1, version = version + 1, updated_at = NOW()
        WHERE id = $2
          AND shop_id = $3
          AND reserved_qty >= $1
        RETURNING id, shop_id, product_id, batch_code, qty, reserved_qty, cost_price, expiry_date, version
        `,
        [qtyToRelease, cmd.batchId, cmd.sellerShopId],
      );
      const releasedRows = extractReturningRows<RawBatchRow>(rawRelease);

      if (releasedRows.length === 0) {
        throw new Error(
          `Failed to release ${qtyToRelease} reserved units on batch ${cmd.batchId} for tx ${cmd.transactionId}`,
        );
      }

      const updated = releasedRows[0];
      const newVersion = Number(updated.version);
      const releasedPayload = {
        transactionId: cmd.transactionId,
        batchId: updated.id,
        releasedQty: qtyToRelease,
        newBatchVersion: newVersion,
      };

      await manager.query(
        `
        INSERT INTO saga_stock_operations
          (transaction_id, step, batch_id, shop_id, qty, status, result_payload)
        VALUES ($1, 'RELEASE', $2, $3, $4, 'APPLIED', $5::jsonb)
        ON CONFLICT (transaction_id, step) DO NOTHING
        `,
        [
          cmd.transactionId,
          updated.id,
          updated.shop_id,
          qtyToRelease,
          JSON.stringify(releasedPayload),
        ],
      );

      await this.enqueueOutbox(manager, {
        aggregateType: 'inventory_batch',
        aggregateId: updated.id,
        eventType: 'inventory.stock.released.v1',
        correlationId: validCorr,
        payload: releasedPayload,
      });

      await this.enqueueOutbox(manager, {
        aggregateType: 'inventory_batch',
        aggregateId: updated.id,
        eventType: 'inventory.stock.updated.v1',
        correlationId: validCorr,
        payload: {
          batchId: updated.id,
          shopId: updated.shop_id,
          productId: updated.product_id,
          qty: Number(updated.qty),
          reservedQty: Number(updated.reserved_qty),
          costPrice: Number(updated.cost_price),
          expiryDate: toDateOnly(updated.expiry_date),
        },
      });

      return {
        outcome: 'RELEASED',
        eventType: 'inventory.stock.released.v1',
        newBatchVersion: newVersion,
      };
    };

    return existingManager
      ? await runInTx(existingManager)
      : await this.dataSource.transaction(runInTx);
  }

  /**
   * Executes `CommitTransferCmd` atomically after two-sided handover confirmation:
   * 1. Decrements seller batch `qty` and `reserved_qty` by `cmd.qty` (incrementing `version`).
   * 2. Creates a new buyer `inventory_batches` row preserving original `cost_price` and `expiry_date`.
   * 3. Emits `inventory.transfer.committed.v1` + `inventory.stock.updated.v1` for both batches.
   */
  async handleCommitTransferCommand(
    cmd: CommitTransferCommandPayload,
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SagaCommandResult> {
    const validCorr = normalizeUuid(correlationId);

    const runInTx = async (manager: EntityManager): Promise<SagaCommandResult> => {
      const priorOps = (await manager.query(
        `SELECT transaction_id, step, status, qty, result_payload
         FROM saga_stock_operations
         WHERE transaction_id = $1`,
        [cmd.transactionId],
      )) as RawOpRow[];

      if (priorOps.some((op) => op.step === 'COMMIT_TRANSFER')) {
        return { outcome: 'DUPLICATE' };
      }

      const reserveOp = priorOps.find((op) => op.step === 'RESERVE' && op.status === 'APPLIED');
      const releaseOp = priorOps.find((op) => op.step === 'RELEASE');

      if (!reserveOp || releaseOp) {
        const reason = releaseOp ? 'RESERVATION_ALREADY_RELEASED' : 'NO_ACTIVE_RESERVATION';
        const failPayload = {
          transactionId: cmd.transactionId,
          sellerBatchId: cmd.sellerBatchId,
          reason,
        };
        await manager.query(
          `
          INSERT INTO saga_stock_operations
            (transaction_id, step, batch_id, shop_id, qty, status, result_payload)
          VALUES ($1, 'COMMIT_TRANSFER', $2, $3, $4, 'FAILED', $5::jsonb)
          ON CONFLICT (transaction_id, step) DO NOTHING
          `,
          [
            cmd.transactionId,
            cmd.sellerBatchId,
            cmd.sellerShopId,
            cmd.qty,
            JSON.stringify(failPayload),
          ],
        );
        await this.enqueueOutbox(manager, {
          aggregateType: 'inventory_batch',
          aggregateId: cmd.sellerBatchId,
          eventType: 'inventory.transfer.failed.v1',
          correlationId: validCorr,
          payload: failPayload,
        });
        return {
          outcome: 'TRANSFER_FAILED',
          eventType: 'inventory.transfer.failed.v1',
          reason,
        };
      }

      // 1. Atomic decrement of seller batch qty & reserved_qty
      const rawSellerUpdate = await manager.query(
        `
        UPDATE inventory_batches
        SET qty = qty - $1,
            reserved_qty = reserved_qty - $1,
            version = version + 1,
            updated_at = NOW()
        WHERE id = $2
          AND shop_id = $3
          AND qty >= $1
          AND reserved_qty >= $1
        RETURNING id, shop_id, product_id, batch_code, qty, reserved_qty, cost_price, expiry_date, version
        `,
        [cmd.qty, cmd.sellerBatchId, cmd.sellerShopId],
      );
      const sellerRows = extractReturningRows<RawBatchRow>(rawSellerUpdate);

      if (sellerRows.length === 0) {
        throw new Error(
          `Unable to commit transfer of ${cmd.qty} units from seller batch ${cmd.sellerBatchId} for tx ${cmd.transactionId}`,
        );
      }

      const sellerBatch = sellerRows[0];
      // Preserve original seller batch cost_price and expiry_date strictly
      const preservedCostPrice =
        sellerBatch.cost_price !== undefined && sellerBatch.cost_price !== null
          ? Number(sellerBatch.cost_price).toFixed(2)
          : Number(cmd.costPrice ?? 0).toFixed(2);
      const preservedExpiryDate = toDateOnly(sellerBatch.expiry_date ?? cmd.expiryDate ?? '');
      const buyerBatchCode = `SWAP-${cmd.transactionId.slice(0, 8).toUpperCase()}`;

      // 2. Insert buyer batch with idempotency_key = transactionId
      const buyerBatch = manager.create(InventoryBatch, {
        shopId: cmd.buyerShopId,
        productId: cmd.productId || sellerBatch.product_id,
        batchCode: buyerBatchCode,
        qty: cmd.qty,
        reservedQty: 0,
        costPrice: preservedCostPrice,
        expiryDate: preservedExpiryDate,
        daysOfCover: null,
        version: 1,
        idempotencyKey: cmd.transactionId,
      });
      const savedBuyerBatch = await manager.save(InventoryBatch, buyerBatch);

      const committedPayload = {
        transactionId: cmd.transactionId,
        sellerBatchId: sellerBatch.id,
        buyerBatchId: savedBuyerBatch.id,
        sellerShopId: cmd.sellerShopId,
        buyerShopId: cmd.buyerShopId,
        productId: savedBuyerBatch.productId,
        qty: cmd.qty,
        costPrice: Number(preservedCostPrice),
        expiryDate: preservedExpiryDate,
        sellerNewVersion: Number(sellerBatch.version),
      };

      await manager.query(
        `
        INSERT INTO saga_stock_operations
          (transaction_id, step, batch_id, shop_id, qty, status, result_payload)
        VALUES ($1, 'COMMIT_TRANSFER', $2, $3, $4, 'APPLIED', $5::jsonb)
        ON CONFLICT (transaction_id, step) DO NOTHING
        `,
        [
          cmd.transactionId,
          sellerBatch.id,
          cmd.sellerShopId,
          cmd.qty,
          JSON.stringify(committedPayload),
        ],
      );

      // 3. Emit TransferCommitted + StockUpdated for seller and buyer batches
      await this.enqueueOutbox(manager, {
        aggregateType: 'inventory_batch',
        aggregateId: sellerBatch.id,
        eventType: 'inventory.transfer.committed.v1',
        correlationId: validCorr,
        payload: committedPayload,
      });

      await this.enqueueOutbox(manager, {
        aggregateType: 'inventory_batch',
        aggregateId: sellerBatch.id,
        eventType: 'inventory.stock.updated.v1',
        correlationId: validCorr,
        payload: {
          batchId: sellerBatch.id,
          shopId: sellerBatch.shop_id,
          productId: sellerBatch.product_id,
          qty: Number(sellerBatch.qty),
          reservedQty: Number(sellerBatch.reserved_qty),
          costPrice: Number(sellerBatch.cost_price),
          expiryDate: preservedExpiryDate,
        },
      });

      await this.enqueueOutbox(manager, {
        aggregateType: 'inventory_batch',
        aggregateId: savedBuyerBatch.id,
        eventType: 'inventory.stock.updated.v1',
        correlationId: validCorr,
        payload: {
          batchId: savedBuyerBatch.id,
          shopId: savedBuyerBatch.shopId,
          productId: savedBuyerBatch.productId,
          qty: savedBuyerBatch.qty,
          reservedQty: 0,
          costPrice: Number(preservedCostPrice),
          expiryDate: preservedExpiryDate,
        },
      });

      return {
        outcome: 'TRANSFER_COMMITTED',
        eventType: 'inventory.transfer.committed.v1',
        newBatchVersion: Number(sellerBatch.version),
        buyerBatchId: savedBuyerBatch.id,
      };
    };

    return existingManager
      ? await runInTx(existingManager)
      : await this.dataSource.transaction(runInTx);
  }
}

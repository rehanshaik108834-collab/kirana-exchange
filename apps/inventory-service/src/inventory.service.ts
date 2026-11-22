import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DomainProblemException,
  IdempotencyConflictProblem,
  InsufficientStockProblem,
  REDIS_CLIENT,
  VersionConflictProblem,
} from '@kirana/common';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import pino from 'pino';
import { DataSource } from 'typeorm';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { InventoryBatch } from './entities/inventory-batch.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { SaleEvent } from './entities/sale-event.entity';

const IDEMPOTENCY_TTL_SEC = 86400; // 24 hours per Section 5.3
const FAST_LOCK_TTL_MS = 2000;
const BULK_CHUNK_SIZE = 500;

const RELEASE_LOCK_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  else
    return 0
  end
`;

/**
 * node-postgres parses a DATE column into a JS Date at *local* midnight. toISOString() would
 * shift it to UTC (the previous day in IST), so rebuild YYYY-MM-DD from local-time getters.
 */
export function toDateOnly(value: string | Date): string {
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

interface CachedIdempotencyEnvelope<T> {
  requestHash: string;
  body: T;
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
  days_of_cover: string | null;
  version: number;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class InventoryService {
  private readonly logger = pino({ name: 'inventory-service' });

  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private normalizeUuid(value?: string): string {
    return value && isUuid(value) ? value : uuidv4();
  }

  private assertIdempotencyKey(idempotencyKey?: string): string {
    if (!idempotencyKey || !isUuid(idempotencyKey)) {
      throw new BadRequestException('A valid UUID Idempotency-Key header is required');
    }
    return idempotencyKey;
  }

  private hashPayload(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private extractReturningRows<T>(queryResult: unknown): T[] {
    if (Array.isArray(queryResult) && Array.isArray(queryResult[0])) {
      return queryResult[0] as T[];
    }
    return Array.isArray(queryResult) ? (queryResult as T[]) : [];
  }

  private mapRawBatch(row: RawBatchRow): InventoryBatch {
    const expiryDate = toDateOnly(row.expiry_date);

    return Object.assign(new InventoryBatch(), {
      id: row.id,
      shopId: row.shop_id,
      productId: row.product_id,
      batchCode: row.batch_code,
      qty: Number(row.qty),
      reservedQty: Number(row.reserved_qty),
      costPrice: String(row.cost_price),
      expiryDate,
      daysOfCover: row.days_of_cover === null ? null : String(row.days_of_cover),
      version: Number(row.version),
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private async readTier1Idempotency<T>(
    shopId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<T | null> {
    const key = `idem:inventory:${shopId}:${idempotencyKey}`;
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedIdempotencyEnvelope<T>;
      if (parsed.requestHash !== requestHash) {
        throw IdempotencyConflictProblem('Idempotency-Key reused with a different request payload');
      }
      return parsed.body;
    } catch (err) {
      if (err instanceof DomainProblemException) {
        throw err;
      }
      this.logger.warn(
        { key, err: (err as Error).message },
        'Redis Tier-1 idempotency read failed',
      );
      return null;
    }
  }

  private async writeTier1Idempotency<T>(
    shopId: string,
    idempotencyKey: string,
    requestHash: string,
    body: T,
  ): Promise<void> {
    const key = `idem:inventory:${shopId}:${idempotencyKey}`;
    const envelope: CachedIdempotencyEnvelope<T> = { requestHash, body };
    try {
      await this.redis.set(key, JSON.stringify(envelope), 'EX', IDEMPOTENCY_TTL_SEC);
    } catch (err) {
      this.logger.warn(
        { key, err: (err as Error).message },
        'Redis Tier-1 idempotency write failed',
      );
    }
  }

  private async tryAcquireFastLock(batchId: string, lockToken: string): Promise<boolean> {
    const lockKey = `lock:batch:${batchId}`;
    try {
      const res = await this.redis.set(lockKey, lockToken, 'PX', FAST_LOCK_TTL_MS, 'NX');
      return res === 'OK';
    } catch (err) {
      // ADR-004 graceful degradation: Redis fast-path lock is never the source of truth
      this.logger.warn(
        { batchId, err: (err as Error).message },
        'Redis fast-path lock unavailable; degrading to PostgreSQL authoritative guard',
      );
      return false;
    }
  }

  private async releaseFastLock(batchId: string, lockToken: string): Promise<void> {
    const lockKey = `lock:batch:${batchId}`;
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, lockKey, lockToken);
    } catch (err) {
      this.logger.warn(
        { batchId, err: (err as Error).message },
        'Redis fast-path lock release failed',
      );
    }
  }

  async listBatchesForShop(shopId: string): Promise<InventoryBatch[]> {
    return this.dataSource
      .getRepository(InventoryBatch)
      .createQueryBuilder('b')
      .where('b.shop_id = :shopId', { shopId })
      .orderBy('b.expiry_date', 'ASC')
      .getMany();
  }

  /**
   * Add a new stock batch (US-08) with Two-Tier Idempotency + Transactional Outbox.
   * INVARIANT:
   * 1. Tier 1 Redis check: `idem:inventory:${dto.shopId}:${idempotencyKey}`. If cached terminal JSON exists, return it.
   * 2. Inside a PostgreSQL transaction:
   *    - Insert `inventory_batches` row with `reserved_qty = 0`, `version = 1`, `idempotency_key`.
   *      (If PG throws 23505 on `uq_batch_idempotency`, fetch and return the existing batch).
   *    - Insert `outbox_events` row (`eventType: 'inventory.stock.updated.v1'`) with payload:
   *      `{ batchId, shopId, productId, qty, reservedQty: 0, costPrice, expiryDate }`.
   * 3. Cache terminal response in Redis for 86400s and return batch.
   */
  async addStockBatch(
    dto: {
      shopId: string;
      productId: string;
      batchCode: string;
      qty: number;
      costPrice: number;
      expiryDate: string;
    },
    idempotencyKey: string,
    correlationId: string,
  ): Promise<InventoryBatch> {
    const validIdemKey = this.assertIdempotencyKey(idempotencyKey);
    const validCorrelationId = this.normalizeUuid(correlationId);
    const requestHash = this.hashPayload({ op: 'addStockBatch', ...dto });

    const cached = await this.readTier1Idempotency<InventoryBatch>(
      dto.shopId,
      validIdemKey,
      requestHash,
    );
    if (cached) {
      return cached;
    }

    let savedBatch: InventoryBatch;
    try {
      savedBatch = await this.dataSource.transaction(async (manager) => {
        const existing = await manager.findOne(InventoryBatch, {
          where: { shopId: dto.shopId, idempotencyKey: validIdemKey },
        });
        if (existing) {
          if (existing.productId !== dto.productId || existing.batchCode !== dto.batchCode) {
            throw IdempotencyConflictProblem(
              'Idempotency-Key reused with a different batch payload',
            );
          }
          return existing;
        }

        const batch = manager.create(InventoryBatch, {
          shopId: dto.shopId,
          productId: dto.productId,
          batchCode: dto.batchCode.trim(),
          qty: dto.qty,
          reservedQty: 0,
          costPrice: dto.costPrice.toFixed(2),
          expiryDate: dto.expiryDate.slice(0, 10),
          daysOfCover: null,
          version: 1,
          idempotencyKey: validIdemKey,
        });
        const persisted = await manager.save(InventoryBatch, batch);

        const outbox = manager.create(OutboxEvent, {
          aggregateType: 'inventory_batch',
          aggregateId: persisted.id,
          eventType: 'inventory.stock.updated.v1',
          version: 1,
          correlationId: validCorrelationId,
          producer: 'inventory-service',
          payload: {
            batchId: persisted.id,
            shopId: persisted.shopId,
            productId: persisted.productId,
            qty: persisted.qty,
            reservedQty: 0,
            costPrice: Number(persisted.costPrice),
            expiryDate: persisted.expiryDate,
          },
          publishedAt: null,
        });
        await manager.save(OutboxEvent, outbox);

        return persisted;
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr?.code === '23505' && pgErr.constraint === 'uq_batch_idempotency') {
        const existing = await this.dataSource.getRepository(InventoryBatch).findOne({
          where: { shopId: dto.shopId, idempotencyKey: validIdemKey },
        });
        if (existing) {
          await this.writeTier1Idempotency(dto.shopId, validIdemKey, requestHash, existing);
          return existing;
        }
      }
      if (pgErr?.code === '23505' && pgErr.constraint === 'uq_batch_shop_product_code') {
        throw new ConflictException(
          `Batch ${dto.batchCode} already exists for this shop and product`,
        );
      }
      throw err;
    }

    await this.writeTier1Idempotency(dto.shopId, validIdemKey, requestHash, savedBatch);
    this.logger.info(
      { correlationId: validCorrelationId, batchId: savedBatch.id, shopId: savedBatch.shopId },
      'Stock batch created and StockUpdated outbox event persisted',
    );
    return savedBatch;
  }

  /**
   * Single-tap sales recording (US-09) with Optimistic Concurrency & Unreserved Stock Guard.
   * INVARIANT:
   * 1. Check Tier 1 Redis idempotency `idem:inventory:${dto.shopId}:${idempotencyKey}`.
   * 2. Inside a PostgreSQL transaction:
   *    - Check Tier 2 `sales_events` by `(shop_id, idempotency_key)` so retries after Redis eviction never double-decrement.
   *    - Execute atomic conditional UPDATE:
   *      `UPDATE inventory_batches
   *       SET qty = qty - $1, version = version + 1, updated_at = NOW()
   *       WHERE id = $2 AND shop_id = $3 AND version = $4 AND (qty - reserved_qty) >= $1
   *       RETURNING *`
   *    - If 0 rows returned: query the batch to distinguish 404 vs 409 version-conflict vs 409 insufficient-unreserved-stock.
   *    - Compute `stockoutFlag = (updatedBatch.qty - updatedBatch.reservedQty) === 0`.
   *    - Insert `sales_events` row (enforcing `UNIQUE (shop_id, idempotency_key)`).
   *    - Insert TWO `outbox_events` rows in the same transaction (`inventory.sale.recorded.v1` + `inventory.stock.updated.v1`).
   */
  async recordSale(
    dto: {
      shopId: string;
      batchId: string;
      qty: number;
      expectedVersion: number;
    },
    idempotencyKey: string,
    correlationId: string,
  ): Promise<{ sale: SaleEvent; batch: InventoryBatch }> {
    const validIdemKey = this.assertIdempotencyKey(idempotencyKey);
    const validCorrelationId = this.normalizeUuid(correlationId);
    const requestHash = this.hashPayload({ op: 'recordSale', ...dto });

    const cached = await this.readTier1Idempotency<{ sale: SaleEvent; batch: InventoryBatch }>(
      dto.shopId,
      validIdemKey,
      requestHash,
    );
    if (cached) {
      return cached;
    }

    let result: { sale: SaleEvent; batch: InventoryBatch };
    try {
      result = await this.dataSource.transaction(async (manager) => {
        // Tier-2 PostgreSQL idempotency check BEFORE version check
        const existingSale = await manager.findOne(SaleEvent, {
          where: { shopId: dto.shopId, idempotencyKey: validIdemKey },
        });
        if (existingSale) {
          if (existingSale.batchId !== dto.batchId || existingSale.qty !== dto.qty) {
            throw IdempotencyConflictProblem(
              'Idempotency-Key reused with a different sale payload',
            );
          }
          const existingBatch = await manager.findOne(InventoryBatch, {
            where: { id: existingSale.batchId, shopId: dto.shopId },
          });
          if (!existingBatch) {
            throw new NotFoundException(`Batch ${existingSale.batchId} not found`);
          }
          return { sale: existingSale, batch: existingBatch };
        }

        const rawUpdate = await manager.query(
          `
          UPDATE inventory_batches
          SET qty = qty - $1, version = version + 1, updated_at = NOW()
          WHERE id = $2
            AND shop_id = $3
            AND version = $4
            AND (qty - reserved_qty) >= $1
          RETURNING *
          `,
          [dto.qty, dto.batchId, dto.shopId, dto.expectedVersion],
        );
        const updatedRows = this.extractReturningRows<RawBatchRow>(rawUpdate);

        if (updatedRows.length === 0) {
          const current = await manager.findOne(InventoryBatch, {
            where: { id: dto.batchId, shopId: dto.shopId },
          });
          if (!current) {
            throw new NotFoundException(`Batch ${dto.batchId} not found for shop ${dto.shopId}`);
          }
          if (current.version !== dto.expectedVersion) {
            throw VersionConflictProblem(
              `Batch version changed: expected=${dto.expectedVersion}, actual=${current.version}`,
              { expectedVersion: dto.expectedVersion, currentVersion: current.version },
            );
          }
          const available = current.qty - current.reservedQty;
          throw InsufficientStockProblem(
            `Insufficient unreserved stock: requested=${dto.qty}, available=${available}`,
            { requested: dto.qty, available },
          );
        }

        const updatedBatch = this.mapRawBatch(updatedRows[0]);
        const stockoutFlag = updatedBatch.qty - updatedBatch.reservedQty === 0;

        const sale = manager.create(SaleEvent, {
          shopId: dto.shopId,
          productId: updatedBatch.productId,
          batchId: updatedBatch.id,
          qty: dto.qty,
          stockoutFlag,
          idempotencyKey: validIdemKey,
        });
        const persistedSale = await manager.save(SaleEvent, sale);

        const saleOutbox = manager.create(OutboxEvent, {
          aggregateType: 'sale_event',
          aggregateId: persistedSale.id,
          eventType: 'inventory.sale.recorded.v1',
          version: 1,
          correlationId: validCorrelationId,
          producer: 'inventory-service',
          payload: {
            saleId: persistedSale.id,
            shopId: persistedSale.shopId,
            productId: persistedSale.productId,
            batchId: persistedSale.batchId,
            qty: persistedSale.qty,
            soldAt: persistedSale.soldAt,
            stockoutFlag: persistedSale.stockoutFlag,
          },
          publishedAt: null,
        });

        const stockOutbox = manager.create(OutboxEvent, {
          aggregateType: 'inventory_batch',
          aggregateId: updatedBatch.id,
          eventType: 'inventory.stock.updated.v1',
          version: 1,
          correlationId: validCorrelationId,
          producer: 'inventory-service',
          payload: {
            batchId: updatedBatch.id,
            shopId: updatedBatch.shopId,
            productId: updatedBatch.productId,
            qty: updatedBatch.qty,
            reservedQty: updatedBatch.reservedQty,
            costPrice: Number(updatedBatch.costPrice),
            expiryDate: updatedBatch.expiryDate,
          },
          publishedAt: null,
        });

        await manager.save(OutboxEvent, [saleOutbox, stockOutbox]);

        return { sale: persistedSale, batch: updatedBatch };
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr?.code === '23505' && pgErr.constraint === 'uq_sales_idempotency') {
        const existingSale = await this.dataSource.getRepository(SaleEvent).findOne({
          where: { shopId: dto.shopId, idempotencyKey: validIdemKey },
        });
        if (existingSale) {
          if (existingSale.batchId !== dto.batchId || existingSale.qty !== dto.qty) {
            throw IdempotencyConflictProblem(
              'Idempotency-Key reused with a different sale payload',
            );
          }
          const existingBatch = await this.dataSource.getRepository(InventoryBatch).findOne({
            where: { id: existingSale.batchId, shopId: dto.shopId },
          });
          if (existingBatch) {
            const recovered = { sale: existingSale, batch: existingBatch };
            await this.writeTier1Idempotency(dto.shopId, validIdemKey, requestHash, recovered);
            return recovered;
          }
        }
      }
      throw err;
    }

    await this.writeTier1Idempotency(dto.shopId, validIdemKey, requestHash, result);
    this.logger.info(
      {
        correlationId: validCorrelationId,
        saleId: result.sale.id,
        batchId: result.batch.id,
        remainingQty: result.batch.qty,
        newVersion: result.batch.version,
      },
      'Sale recorded atomically with outbox events',
    );
    return result;
  }

  /**
   * Strict Stock Reservation Guard (US-12 & ADR-004).
   * INVARIANT:
   * 1. Tier 1 Redis idempotency check `idem:inventory:${dto.shopId}:${idempotencyKey}`.
   * 2. Optional Fast-Path Redis Lock: `SET lock:batch:${batchId} ${lockToken} NX PX 2000`.
   *    If Redis is down, log warning and continue straight to PostgreSQL (ADR-004).
   * 3. PostgreSQL Authoritative Guard (inside transaction):
   *    - Check Tier 2 `idempotency_records` for replay safety even after Redis eviction.
   *    - `UPDATE inventory_batches
   *       SET reserved_qty = reserved_qty + $1, version = version + 1, updated_at = NOW()
   *       WHERE id = $2 AND shop_id = $3 AND version = $4 AND (qty - reserved_qty) >= $1
   *       RETURNING *`
   * 4. Persist `inventory.stock.reserved.v1` in `outbox_events` and Tier-2 `idempotency_records` in the same tx.
   * 5. Release Redis fast-path lock via atomic Lua CAS in `finally`.
   */
  async reserveStock(
    batchId: string,
    dto: { shopId: string; qty: number; version: number; transactionId?: string },
    idempotencyKey: string,
    correlationId: string,
  ): Promise<InventoryBatch> {
    const validIdemKey = this.assertIdempotencyKey(idempotencyKey);
    const validCorrelationId = this.normalizeUuid(correlationId);
    const requestHash = this.hashPayload({ op: 'reserveStock', batchId, ...dto });

    const cached = await this.readTier1Idempotency<InventoryBatch>(
      dto.shopId,
      validIdemKey,
      requestHash,
    );
    if (cached) {
      return cached;
    }

    const lockToken = `${validCorrelationId}:${uuidv4()}`;
    const lockAcquired = await this.tryAcquireFastLock(batchId, lockToken);

    try {
      const reservedBatch = await this.dataSource.transaction(async (manager) => {
        const existingIdem = (await manager.query(
          `SELECT request_hash, response_body FROM idempotency_records WHERE shop_id = $1 AND idempotency_key = $2`,
          [dto.shopId, validIdemKey],
        )) as Array<{ request_hash: string; response_body: InventoryBatch }>;

        if (existingIdem.length > 0) {
          if (existingIdem[0].request_hash !== requestHash) {
            throw IdempotencyConflictProblem(
              'Idempotency-Key reused with a different reservation payload',
            );
          }
          return existingIdem[0].response_body;
        }

        const rawReserve = await manager.query(
          `
          UPDATE inventory_batches
          SET reserved_qty = reserved_qty + $1, version = version + 1, updated_at = NOW()
          WHERE id = $2
            AND shop_id = $3
            AND version = $4
            AND (qty - reserved_qty) >= $1
          RETURNING *
          `,
          [dto.qty, batchId, dto.shopId, dto.version],
        );
        const updatedRows = this.extractReturningRows<RawBatchRow>(rawReserve);

        if (updatedRows.length === 0) {
          const current = await manager.findOne(InventoryBatch, {
            where: { id: batchId, shopId: dto.shopId },
          });
          if (!current) {
            throw new NotFoundException(`Batch ${batchId} not found for shop ${dto.shopId}`);
          }
          if (current.version !== dto.version) {
            throw VersionConflictProblem(
              `Batch version changed: expected=${dto.version}, actual=${current.version}`,
              { expectedVersion: dto.version, currentVersion: current.version },
            );
          }
          const available = current.qty - current.reservedQty;
          throw InsufficientStockProblem(
            `Insufficient unreserved stock: requested=${dto.qty}, available=${available}`,
            { requested: dto.qty, available },
          );
        }

        const updatedBatch = this.mapRawBatch(updatedRows[0]);

        const outbox = manager.create(OutboxEvent, {
          aggregateType: 'inventory_batch',
          aggregateId: updatedBatch.id,
          eventType: 'inventory.stock.reserved.v1',
          version: 1,
          correlationId: validCorrelationId,
          producer: 'inventory-service',
          payload: {
            transactionId: dto.transactionId ?? null,
            batchId: updatedBatch.id,
            shopId: updatedBatch.shopId,
            reservedQty: dto.qty,
            newBatchVersion: updatedBatch.version,
          },
          publishedAt: null,
        });
        await manager.save(OutboxEvent, outbox);

        await manager.query(
          `
          INSERT INTO idempotency_records (shop_id, idempotency_key, operation, request_hash, response_body)
          VALUES ($1, $2, 'reserveStock', $3, $4::jsonb)
          ON CONFLICT (shop_id, idempotency_key) DO NOTHING
          `,
          [dto.shopId, validIdemKey, requestHash, JSON.stringify(updatedBatch)],
        );

        return updatedBatch;
      });

      await this.writeTier1Idempotency(dto.shopId, validIdemKey, requestHash, reservedBatch);
      this.logger.info(
        {
          correlationId: validCorrelationId,
          batchId: reservedBatch.id,
          reservedQty: reservedBatch.reservedQty,
          newVersion: reservedBatch.version,
        },
        'Stock reserved atomically via PostgreSQL guard',
      );
      return reservedBatch;
    } finally {
      if (lockAcquired) {
        await this.releaseFastLock(batchId, lockToken);
      }
    }
  }

  /**
   * Release previously reserved stock (saga compensation path), emitting `inventory.stock.released.v1`.
   */
  async releaseStock(
    batchId: string,
    dto: { shopId: string; qty: number; transactionId?: string },
    idempotencyKey: string,
    correlationId: string,
  ): Promise<InventoryBatch> {
    const validIdemKey = this.assertIdempotencyKey(idempotencyKey);
    const validCorrelationId = this.normalizeUuid(correlationId);
    const requestHash = this.hashPayload({ op: 'releaseStock', batchId, ...dto });

    const cached = await this.readTier1Idempotency<InventoryBatch>(
      dto.shopId,
      validIdemKey,
      requestHash,
    );
    if (cached) {
      return cached;
    }

    const releasedBatch = await this.dataSource.transaction(async (manager) => {
      const existingIdem = (await manager.query(
        `SELECT request_hash, response_body FROM idempotency_records WHERE shop_id = $1 AND idempotency_key = $2`,
        [dto.shopId, validIdemKey],
      )) as Array<{ request_hash: string; response_body: InventoryBatch }>;

      if (existingIdem.length > 0) {
        if (existingIdem[0].request_hash !== requestHash) {
          throw IdempotencyConflictProblem(
            'Idempotency-Key reused with a different release payload',
          );
        }
        return existingIdem[0].response_body;
      }

      const rawRelease = await manager.query(
        `
        UPDATE inventory_batches
        SET reserved_qty = reserved_qty - $1, version = version + 1, updated_at = NOW()
        WHERE id = $2
          AND shop_id = $3
          AND reserved_qty >= $1
        RETURNING *
        `,
        [dto.qty, batchId, dto.shopId],
      );
      const updatedRows = this.extractReturningRows<RawBatchRow>(rawRelease);

      if (updatedRows.length === 0) {
        const current = await manager.findOne(InventoryBatch, {
          where: { id: batchId, shopId: dto.shopId },
        });
        if (!current) {
          throw new NotFoundException(`Batch ${batchId} not found for shop ${dto.shopId}`);
        }
        throw new ConflictException(
          `Cannot release ${dto.qty} units when only ${current.reservedQty} are reserved`,
        );
      }

      const updatedBatch = this.mapRawBatch(updatedRows[0]);

      const outbox = manager.create(OutboxEvent, {
        aggregateType: 'inventory_batch',
        aggregateId: updatedBatch.id,
        eventType: 'inventory.stock.released.v1',
        version: 1,
        correlationId: validCorrelationId,
        producer: 'inventory-service',
        payload: {
          transactionId: dto.transactionId ?? null,
          batchId: updatedBatch.id,
          releasedQty: dto.qty,
          newBatchVersion: updatedBatch.version,
        },
        publishedAt: null,
      });
      await manager.save(OutboxEvent, outbox);

      await manager.query(
        `
        INSERT INTO idempotency_records (shop_id, idempotency_key, operation, request_hash, response_body)
        VALUES ($1, $2, 'releaseStock', $3, $4::jsonb)
        ON CONFLICT (shop_id, idempotency_key) DO NOTHING
        `,
        [dto.shopId, validIdemKey, requestHash, JSON.stringify(updatedBatch)],
      );

      return updatedBatch;
    });

    await this.writeTier1Idempotency(dto.shopId, validIdemKey, requestHash, releasedBatch);
    return releasedBatch;
  }

  /**
   * Bulk CSV/JSON Import (US-10): imports up to 10,000 inventory batch rows in chunked transactions
   * (500 rows/chunk) with `ON CONFLICT DO NOTHING RETURNING ...` and batched `outbox_events` inserts
   * so 10,000 rows complete in a few seconds with zero duplicate events.
   */
  async bulkImportBatches(
    shopId: string,
    rows: Array<{
      productId: string;
      batchCode: string;
      qty: number;
      costPrice: number;
      expiryDate: string;
      idempotencyKey?: string;
    }>,
    correlationId: string,
  ): Promise<{ importedCount: number }> {
    const validCorrelationId = this.normalizeUuid(correlationId);
    let importedCount = 0;

    for (let offset = 0; offset < rows.length; offset += BULK_CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + BULK_CHUNK_SIZE);

      const chunkInserted = await this.dataSource.transaction(async (manager) => {
        const batchValues: unknown[] = [];
        const batchPlaceholders: string[] = [];

        for (let i = 0; i < chunk.length; i++) {
          const r = chunk[i];
          const base = i * 7;
          const idemKey = this.normalizeUuid(r.idempotencyKey);
          batchPlaceholders.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, 0, $${base + 5}, $${base + 6}, 1, $${base + 7})`,
          );
          batchValues.push(
            shopId,
            r.productId,
            r.batchCode.trim(),
            r.qty,
            r.costPrice.toFixed(2),
            r.expiryDate.slice(0, 10),
            idemKey,
          );
        }

        const rawInserted = await manager.query(
          `
          INSERT INTO inventory_batches
            (shop_id, product_id, batch_code, qty, reserved_qty, cost_price, expiry_date, version, idempotency_key)
          VALUES ${batchPlaceholders.join(', ')}
          ON CONFLICT DO NOTHING
          RETURNING id, shop_id, product_id, qty, reserved_qty, cost_price, expiry_date
          `,
          batchValues,
        );
        const insertedRows = this.extractReturningRows<{
          id: string;
          shop_id: string;
          product_id: string;
          qty: number;
          reserved_qty: number;
          cost_price: string;
          expiry_date: string | Date;
        }>(rawInserted);

        if (insertedRows.length > 0) {
          const outboxValues: unknown[] = [];
          const outboxPlaceholders: string[] = [];

          for (let i = 0; i < insertedRows.length; i++) {
            const b = insertedRows[i];
            const base = i * 6;
            const expiryDate = toDateOnly(b.expiry_date);

            outboxPlaceholders.push(
              `($${base + 1}, $${base + 2}, $${base + 3}, 1, $${base + 4}, $${base + 5}, $${base + 6}::jsonb)`,
            );
            outboxValues.push(
              'inventory_batch',
              b.id,
              'inventory.stock.updated.v1',
              validCorrelationId,
              'inventory-service',
              JSON.stringify({
                batchId: b.id,
                shopId: b.shop_id,
                productId: b.product_id,
                qty: Number(b.qty),
                reservedQty: Number(b.reserved_qty),
                costPrice: Number(b.cost_price),
                expiryDate,
              }),
            );
          }

          await manager.query(
            `
            INSERT INTO outbox_events
              (aggregate_type, aggregate_id, event_type, version, correlation_id, producer, payload)
            VALUES ${outboxPlaceholders.join(', ')}
            `,
            outboxValues,
          );
        }

        return insertedRows.length;
      });

      importedCount += chunkInserted;
    }

    this.logger.info(
      { correlationId: validCorrelationId, shopId, requested: rows.length, importedCount },
      'Bulk inventory batch import completed',
    );

    return { importedCount };
  }
}

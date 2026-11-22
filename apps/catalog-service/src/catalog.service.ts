import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { REDIS_CLIENT } from '@kirana/common';
import Redis from 'ioredis';
import pino from 'pino';
import { DataSource, In } from 'typeorm';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { CreateProductDto, UpdateProductDto } from './dto/catalog.dto';
import { AuditLog } from './entities/audit-log.entity';
import { Product } from './entities/product.entity';

const PRODUCT_CACHE_TTL_SEC = 300;
const SEARCH_CACHE_TTL_SEC = 120;
const SEARCH_EPOCH_KEY = 'catalog:search:epoch';
const MAX_MERGE_HOPS = 5;

@Injectable()
export class CatalogService {
  private readonly logger = pino({ name: 'catalog-service' });

  // Track hits/misses to expose on /metrics for Grafana (Phase 5 Done-When check)
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private normalizeUuid(value?: string): string {
    return value && isUuid(value) ? value : uuidv4();
  }

  getCacheStats() {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total === 0 ? 0 : Number((this.cacheHits / total).toFixed(4)),
    };
  }

  private async safeRedisGet(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err) {
      this.logger.warn({ key, err: (err as Error).message }, 'Redis GET degraded to Postgres');
      return null;
    }
  }

  private async safeRedisSetEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch (err) {
      this.logger.warn({ key, err: (err as Error).message }, 'Redis SETEX failed; continuing');
    }
  }

  private async safeInvalidateCaches(eans: string[]): Promise<void> {
    try {
      const pipeline = this.redis.pipeline();
      for (const ean of eans) {
        pipeline.del(`catalog:product:ean:${ean}`);
      }
      // O(1) non-blocking search cache invalidation via monotonic epoch
      pipeline.incr(SEARCH_EPOCH_KEY);
      await pipeline.exec();
    } catch (err) {
      this.logger.warn({ eans, err: (err as Error).message }, 'Redis cache invalidation failed');
    }
  }

  /**
   * Look up an active product by exact EAN barcode using Redis cache-aside.
   * INVARIANT:
   * 1. Check Redis key `catalog:product:ean:${ean}`. If found, increment cacheHits and return parsed Product.
   * 2. On cache miss, increment cacheMisses and query `products` WHERE ean = :ean.
   *    (If merged into another product, follow mergedIntoId to return the canonical active product).
   * 3. Cache the result in Redis with TTL = PRODUCT_CACHE_TTL_SEC. If Redis is unavailable, degrade gracefully to Postgres.
   */
  async findByEan(ean: string): Promise<Product> {
    const normalizedEan = ean.trim();
    const cacheKey = `catalog:product:ean:${normalizedEan}`;

    const cached = await this.safeRedisGet(cacheKey);
    if (cached) {
      this.cacheHits += 1;
      return JSON.parse(cached) as Product;
    }

    this.cacheMisses += 1;
    const repo = this.dataSource.getRepository(Product);
    let current = await repo.findOne({ where: { ean: normalizedEan } });

    if (!current) {
      throw new NotFoundException(`Product with EAN ${normalizedEan} not found`);
    }

    let hops = 0;
    while (!current.isActive && current.mergedIntoId && hops < MAX_MERGE_HOPS) {
      const next = await repo.findOne({ where: { id: current.mergedIntoId } });
      if (!next) {
        break;
      }
      current = next;
      hops += 1;
    }

    if (!current.isActive) {
      throw new NotFoundException(`Product with EAN ${normalizedEan} is inactive`);
    }

    await this.safeRedisSetEx(cacheKey, PRODUCT_CACHE_TTL_SEC, JSON.stringify(current));
    return current;
  }

  /**
   * Returns products for up to 100 ids in one query (inventory screens show names for many batches).
   * Invalid UUIDs are rejected with 400; unknown ids are simply absent from the result.
   */
  async findByIds(idsRaw: string): Promise<Product[]> {
    const ids = [
      ...new Set(
        idsRaw
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (ids.length === 0) {
      return [];
    }
    if (ids.length > 100) {
      throw new BadRequestException('At most 100 ids per request');
    }
    const invalid = ids.filter((id) => !isUuid(id));
    if (invalid.length > 0) {
      throw new BadRequestException(`Invalid product id(s): ${invalid.slice(0, 5).join(', ')}`);
    }
    return this.dataSource.getRepository(Product).find({ where: { id: In(ids) } });
  }

  /**
   * Sub-100ms partial-name and brand search using PostgreSQL pg_trgm + Redis cache-aside.
   * INVARIANT:
   * 1. Normalize query (trim + lowercase). Fetch current epoch via `GET catalog:search:epoch` (default '1').
   * 2. Check Redis key `catalog:search:v${epoch}:${normalized}:${limit}`. Increment cacheHits/cacheMisses.
   * 3. On miss, run parameterized query against `products` WHERE is_active = TRUE AND (name ILIKE :like OR brand ILIKE :like OR ean = :exact)
   *    ORDER BY GREATEST(similarity(name, :q), similarity(brand, :q)) DESC LIMIT :limit.
   * 4. Store result array in Redis with TTL = SEARCH_CACHE_TTL_SEC and return.
   */
  async searchProducts(rawQuery: string, limit = 20): Promise<Product[]> {
    const normalized = rawQuery.trim().toLowerCase();
    if (!normalized) {
      return [];
    }

    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
    const epoch = (await this.safeRedisGet(SEARCH_EPOCH_KEY)) ?? '1';
    const cacheKey = `catalog:search:v${epoch}:${normalized}:${boundedLimit}`;

    const cached = await this.safeRedisGet(cacheKey);
    if (cached) {
      this.cacheHits += 1;
      return JSON.parse(cached) as Product[];
    }

    this.cacheMisses += 1;
    const tokens = normalized.split(/\s+/).filter(Boolean).slice(0, 5);
    const params: unknown[] = [normalized];
    const tokenClauses: string[] = [];

    for (const token of tokens) {
      params.push(`%${token}%`);
      const paramIndex = params.length;
      tokenClauses.push(`(name ILIKE $${paramIndex} OR brand ILIKE $${paramIndex})`);
    }

    params.push(boundedLimit);
    const limitIndex = params.length;

    const rows = await this.dataSource.query(
      `
      SELECT
        id,
        ean,
        name,
        brand,
        pack_size AS "packSize",
        category,
        mrp,
        gst_rate AS "gstRate",
        shelf_life_days AS "shelfLifeDays",
        is_active AS "isActive",
        merged_into_id AS "mergedIntoId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM products
      WHERE is_active = TRUE
        AND (ean = $1 OR (${tokenClauses.join(' AND ')}))
      ORDER BY
        (ean = $1) DESC,
        GREATEST(similarity(name, $1), similarity(brand, $1)) DESC
      LIMIT $${limitIndex}
      `,
      params,
    );

    const products = rows as Product[];
    await this.safeRedisSetEx(cacheKey, SEARCH_CACHE_TTL_SEC, JSON.stringify(products));
    return products;
  }

  /**
   * Admin create product + audit_logs entry in one PostgreSQL transaction,
   * followed by O(1) search cache epoch bump after commit.
   */
  async createProduct(
    dto: CreateProductDto,
    actorId: string,
    correlationId: string,
  ): Promise<Product> {
    const validActorId = this.normalizeUuid(actorId);
    const validCorrelationId = this.normalizeUuid(correlationId);

    let saved: Product;
    try {
      saved = await this.dataSource.transaction(async (manager) => {
        const product = manager.create(Product, {
          ean: dto.ean.trim(),
          name: dto.name.trim(),
          brand: dto.brand.trim(),
          packSize: dto.packSize.trim(),
          category: dto.category.trim(),
          mrp: dto.mrp.toFixed(2),
          gstRate: dto.gstRate.toFixed(2),
          shelfLifeDays: dto.shelfLifeDays ?? 180,
          isActive: true,
          mergedIntoId: null,
        });
        const persisted = await manager.save(Product, product);

        const audit = manager.create(AuditLog, {
          actorId: validActorId,
          actorRole: 'admin',
          action: 'PRODUCT_CREATED',
          entityType: 'product',
          entityId: persisted.id,
          correlationId: validCorrelationId,
          metadata: { ean: persisted.ean, name: persisted.name },
        });
        await manager.save(AuditLog, audit);

        return persisted;
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        throw new ConflictException(`Product with EAN ${dto.ean} already exists`);
      }
      throw err;
    }

    await this.safeInvalidateCaches([saved.ean]);
    this.logger.info(
      { correlationId: validCorrelationId, productId: saved.id, ean: saved.ean },
      'Catalog product created and search cache invalidated',
    );
    return saved;
  }

  /**
   * Admin edit product + audit_logs entry in one PostgreSQL transaction,
   * then immediately invalidates product EAN key and increments search epoch.
   */
  async updateProduct(
    id: string,
    dto: UpdateProductDto,
    actorId: string,
    correlationId: string,
  ): Promise<Product> {
    const validActorId = this.normalizeUuid(actorId);
    const validCorrelationId = this.normalizeUuid(correlationId);

    const updated = await this.dataSource.transaction(async (manager) => {
      const product = await manager.findOne(Product, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });

      if (!product) {
        throw new NotFoundException(`Product ${id} not found`);
      }

      if (dto.name !== undefined) product.name = dto.name.trim();
      if (dto.brand !== undefined) product.brand = dto.brand.trim();
      if (dto.packSize !== undefined) product.packSize = dto.packSize.trim();
      if (dto.category !== undefined) product.category = dto.category.trim();
      if (dto.mrp !== undefined) product.mrp = dto.mrp.toFixed(2);
      if (dto.gstRate !== undefined) product.gstRate = dto.gstRate.toFixed(2);
      if (dto.shelfLifeDays !== undefined) product.shelfLifeDays = dto.shelfLifeDays;
      if (dto.isActive !== undefined) product.isActive = dto.isActive;

      const persisted = await manager.save(Product, product);

      const audit = manager.create(AuditLog, {
        actorId: validActorId,
        actorRole: 'admin',
        action: 'PRODUCT_UPDATED',
        entityType: 'product',
        entityId: persisted.id,
        correlationId: validCorrelationId,
        metadata: { changes: dto },
      });
      await manager.save(AuditLog, audit);

      return persisted;
    });

    await this.safeInvalidateCaches([updated.ean]);
    this.logger.info(
      { correlationId: validCorrelationId, productId: updated.id, ean: updated.ean },
      'Catalog product updated and caches invalidated',
    );
    return updated;
  }

  /**
   * Admin duplicate merge: marks sourceId inactive, points merged_into_id -> targetId,
   * writes an `audit_logs` record inside one PostgreSQL transaction, then immediately
   * invalidates `catalog:product:ean:${source.ean}` and increments `catalog:search:epoch`.
   * INVARIANT:
   * - Reject if sourceId === targetId (BadRequestException).
   * - Lock both rows with pessimistic_write in sorted UUID order to prevent deadlocks.
   * - Invalidate Redis keys AFTER transaction commits.
   */
  async mergeDuplicateProducts(
    sourceId: string,
    targetId: string,
    actorId: string,
    correlationId: string,
  ): Promise<{ mergedSourceId: string; targetId: string }> {
    if (sourceId === targetId) {
      throw new BadRequestException('Cannot merge a product into itself');
    }

    const validActorId = this.normalizeUuid(actorId);
    const validCorrelationId = this.normalizeUuid(correlationId);

    const { sourceEan, targetEan } = await this.dataSource.transaction(async (manager) => {
      // Deterministic lock ordering by UUID prevents AB-BA deadlocks under concurrent merges
      const [firstId, secondId] = sourceId < targetId ? [sourceId, targetId] : [targetId, sourceId];

      const first = await manager.findOne(Product, {
        where: { id: firstId },
        lock: { mode: 'pessimistic_write' },
      });
      const second = await manager.findOne(Product, {
        where: { id: secondId },
        lock: { mode: 'pessimistic_write' },
      });

      const source = sourceId === firstId ? first : second;
      const target = targetId === firstId ? first : second;

      if (!source) {
        throw new NotFoundException(`Source product ${sourceId} not found`);
      }
      if (!target || !target.isActive) {
        throw new NotFoundException(`Active target product ${targetId} not found`);
      }

      source.isActive = false;
      source.mergedIntoId = target.id;
      await manager.save(Product, source);

      const audit = manager.create(AuditLog, {
        actorId: validActorId,
        actorRole: 'admin',
        action: 'PRODUCT_MERGED',
        entityType: 'product',
        entityId: source.id,
        correlationId: validCorrelationId,
        metadata: {
          sourceId: source.id,
          sourceEan: source.ean,
          targetId: target.id,
          targetEan: target.ean,
        },
      });
      await manager.save(AuditLog, audit);

      return { sourceEan: source.ean, targetEan: target.ean };
    });

    // Invalidate Redis AFTER Postgres commits so no stale read repopulates the cache mid-tx
    await this.safeInvalidateCaches([sourceEan, targetEan]);
    this.logger.info(
      { correlationId: validCorrelationId, sourceId, targetId, sourceEan, targetEan },
      'Duplicate product merged and caches invalidated',
    );

    return { mergedSourceId: sourceId, targetId };
  }
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { IdempotencyConflictProblem, REDIS_CLIENT } from '@kirana/common';
import type Redis from 'ioredis';
import pino from 'pino';
import { DataSource, In } from 'typeorm';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import {
  CreateGroupBuyWindowDto,
  ListWindowsQueryDto,
  UpsertCommitmentDto,
} from './dto/groupbuy.dto';
import { GroupBuyAllocation } from './entities/groupbuy-allocation.entity';
import { GroupBuyCommitment } from './entities/groupbuy-commitment.entity';
import { GroupBuyWindow } from './entities/groupbuy-window.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import {
  type ComputedAllocation,
  computeWindowAllocations,
  windowAdvisoryLockKey,
} from './pricing';

export const GB_CUTOFF_ZSET_KEY = 'gb:windows:cutoff';
export const EVT_WINDOW_CLOSED = 'groupbuy.window.closed.v1';
const DEFAULT_EXTENSION_HOURS = 24;

export interface GroupBuyActor {
  userId: string;
  role: string;
  shopId?: string;
}

export interface WindowCloseResult {
  windowId: string;
  outcome: 'ALLOCATING' | 'EXTENDED' | 'CANCELLED' | 'LOCKED' | 'ALREADY_CLOSED' | 'NOT_DUE';
  orderId?: string;
  totalValue?: number;
  totalSavings?: number;
  newCutoffAt?: string;
  allocations?: ComputedAllocation[];
}

export interface WindowDetailResponse {
  window: GroupBuyWindow;
  pooledQtyByProduct: Record<string, number>;
  unitTierPriceByProduct: Record<string, number>;
  currentTotalValue: number;
  progressPct: number;
  participatingShops: number;
  myCommitments: GroupBuyCommitment[];
  allocations: GroupBuyAllocation[];
}

@Injectable()
export class GroupBuyService {
  private readonly logger = pino({ name: 'groupbuy-service' });

  constructor(
    private readonly dataSource: DataSource,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  private normalizeCorrelationId(correlationId?: string): string {
    return correlationId && isUuid(correlationId) ? correlationId : uuidv4();
  }

  private assertShopId(actor: GroupBuyActor): string {
    if (!actor.shopId || !isUuid(actor.shopId)) {
      throw new ForbiddenException('A linked shop profile is required for group-buy commitments');
    }
    return actor.shopId;
  }

  private assertIdempotencyKey(key?: string): string {
    if (!key || !isUuid(key)) {
      throw new BadRequestException('Header Idempotency-Key must be a valid UUIDv4');
    }
    return key;
  }

  private async indexCutoff(windowId: string, cutoffAt: Date): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.zadd(GB_CUTOFF_ZSET_KEY, cutoffAt.getTime(), windowId);
    } catch (err) {
      this.logger.warn(
        { windowId, err: (err as Error).message },
        'Redis ZADD gb:windows:cutoff failed; scheduler will rely on PostgreSQL fallback',
      );
    }
  }

  private async removeCutoffIndex(windowId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.zrem(GB_CUTOFF_ZSET_KEY, windowId);
    } catch (err) {
      this.logger.warn(
        { windowId, err: (err as Error).message },
        'Redis ZREM gb:windows:cutoff failed',
      );
    }
  }

  /** Admin creates a virtual distributor group-buy window and indexes it in `gb:windows:cutoff`. */
  async createWindow(dto: CreateGroupBuyWindowDto, actor: GroupBuyActor): Promise<GroupBuyWindow> {
    if (actor.role !== 'admin') {
      throw new ForbiddenException('Admin role required to schedule distributor group-buy windows');
    }

    const cutoffAt = new Date(dto.cutoffAt);
    if (Number.isNaN(cutoffAt.getTime()) || cutoffAt.getTime() <= Date.now()) {
      throw new BadRequestException('cutoffAt must be a valid future ISO timestamp');
    }

    const repo = this.dataSource.getRepository(GroupBuyWindow);
    const created = repo.create({
      distributorId: dto.distributorId.trim(),
      state: dto.state.trim(),
      cutoffAt,
      minOrderValue: dto.minOrderValue.toFixed(2),
      deliveryFee: (dto.deliveryFee ?? 0).toFixed(2),
      priceTiers: dto.priceTiers,
      extendedOnce: false,
      status: 'OPEN',
    });

    const saved = await repo.save(created);
    await this.indexCutoff(saved.id, saved.cutoffAt);

    this.logger.info(
      { windowId: saved.id, distributorId: saved.distributorId, state: saved.state },
      'Group-buy window scheduled',
    );
    return saved;
  }

  async listWindows(query: ListWindowsQueryDto): Promise<GroupBuyWindow[]> {
    const where: Record<string, unknown> = {};
    if (query.state) where.state = query.state;
    if (query.status) where.status = query.status;

    return this.dataSource.getRepository(GroupBuyWindow).find({
      where,
      order: { cutoffAt: 'ASC' },
    });
  }

  async getWindowDetail(windowId: string, actor: GroupBuyActor): Promise<WindowDetailResponse> {
    const window = await this.dataSource
      .getRepository(GroupBuyWindow)
      .findOne({ where: { id: windowId } });

    if (!window) {
      throw new NotFoundException(`Group-buy window ${windowId} not found`);
    }

    const commitments = await this.dataSource
      .getRepository(GroupBuyCommitment)
      .find({ where: { windowId } });

    const pricing = computeWindowAllocations(
      commitments.map((c) => ({ shopId: c.shopId, productId: c.productId, qty: c.qty })),
      window.priceTiers,
      Number(window.deliveryFee),
    );

    const minVal = Number(window.minOrderValue);
    const progressPct =
      minVal > 0 ? Math.min(100, Math.round((pricing.totalOrderValue / minVal) * 100)) : 100;
    const participatingShops = new Set(commitments.map((c) => c.shopId)).size;

    const myCommitments = actor.shopId ? commitments.filter((c) => c.shopId === actor.shopId) : [];

    const allocRepo = this.dataSource.getRepository(GroupBuyAllocation);
    const allocations =
      actor.role === 'admin'
        ? await allocRepo.find({ where: { windowId } })
        : actor.shopId
          ? await allocRepo.find({ where: { windowId, shopId: actor.shopId } })
          : [];

    return {
      window,
      pooledQtyByProduct: pricing.pooledQtyByProduct,
      unitTierPriceByProduct: pricing.unitTierPriceByProduct,
      currentTotalValue: pricing.totalOrderValue,
      progressPct,
      participatingShops,
      myCommitments,
      allocations,
    };
  }

  /**
   * Adds or updates a shop's commitment before `cutoff_at` with UUID Idempotency-Key enforcement.
   * Commitments stay editable until window closure (`OPEN` or `EXTENDED`).
   */
  async upsertCommitment(
    windowId: string,
    dto: UpsertCommitmentDto,
    actor: GroupBuyActor,
    idempotencyKey?: string,
  ): Promise<GroupBuyCommitment> {
    const shopId = this.assertShopId(actor);
    const validKey = this.assertIdempotencyKey(idempotencyKey);

    const commitRepo = this.dataSource.getRepository(GroupBuyCommitment);

    // 1. Idempotency replay guard
    const priorByKey = await commitRepo.findOne({ where: { shopId, idempotencyKey: validKey } });
    if (priorByKey) {
      if (
        priorByKey.windowId !== windowId ||
        priorByKey.productId !== dto.productId ||
        priorByKey.qty !== dto.qty
      ) {
        throw IdempotencyConflictProblem(
          'Idempotency-Key was already used for a different group-buy commitment',
        );
      }
      return priorByKey;
    }

    const window = await this.dataSource
      .getRepository(GroupBuyWindow)
      .findOne({ where: { id: windowId } });

    if (!window) {
      throw new NotFoundException(`Group-buy window ${windowId} not found`);
    }
    if (window.status !== 'OPEN' && window.status !== 'EXTENDED') {
      throw new ConflictException(`Group-buy window is no longer open (status: ${window.status})`);
    }
    if (window.cutoffAt.getTime() <= Date.now()) {
      throw new ConflictException('Group-buy window cutoff has already passed');
    }
    if (dto.shopState && dto.shopState !== window.state) {
      throw new ForbiddenException(
        `Group-buy window is restricted to ${window.state}; cross-state commitments are not allowed`,
      );
    }

    const hasProduct = window.priceTiers.some((t) => t.productId === dto.productId);
    if (!hasProduct) {
      throw new BadRequestException(
        `Product ${dto.productId} is not available in this distributor window`,
      );
    }

    const existing = await commitRepo.findOne({
      where: { windowId, shopId, productId: dto.productId },
    });

    if (existing) {
      existing.qty = dto.qty;
      existing.idempotencyKey = validKey;
      return commitRepo.save(existing);
    }

    const created = commitRepo.create({
      windowId,
      shopId,
      productId: dto.productId,
      qty: dto.qty,
      idempotencyKey: validKey,
    });
    return commitRepo.save(created);
  }

  /** Withdraws a shop's commitment before `cutoff_at`. */
  async removeCommitment(
    windowId: string,
    productId: string,
    actor: GroupBuyActor,
  ): Promise<{ removed: boolean }> {
    const shopId = this.assertShopId(actor);
    const window = await this.dataSource
      .getRepository(GroupBuyWindow)
      .findOne({ where: { id: windowId } });

    if (!window) {
      throw new NotFoundException(`Group-buy window ${windowId} not found`);
    }
    if (window.status !== 'OPEN' && window.status !== 'EXTENDED') {
      throw new ConflictException(`Cannot withdraw commitment after window closure`);
    }
    if (window.cutoffAt.getTime() <= Date.now()) {
      throw new ConflictException('Group-buy window cutoff has already passed');
    }

    const result = await this.dataSource
      .getRepository(GroupBuyCommitment)
      .delete({ windowId, shopId, productId });
    return { removed: (result.affected ?? 0) > 0 };
  }

  /**
   * Closes a group-buy window EXACTLY ONCE across concurrent scheduler replicas.
   *
   * INVARIANT:
   * 1. Acquires transaction-scoped PostgreSQL advisory lock `pg_try_advisory_xact_lock(k1, k2)`.
   *    A competing scheduler instance immediately gets `{ outcome: 'LOCKED' }` and moves on.
   * 2. Performs conditional atomic status transition `WHERE id = $1 AND status IN ('OPEN', 'EXTENDED')`.
   * 3. If pooled demand < `min_order_value`:
   *    - First cutoff (`extended_once = FALSE`) -> extends cutoff by `extensionHours` (default 24h), `status = 'EXTENDED'`.
   *    - Second cutoff (`extended_once = TRUE`) -> `status = 'CANCELLED'`.
   * 4. Otherwise computes tiered `landed_cost`, persists `groupbuy_allocations`, transitions to
   *    `ALLOCATING`, and writes `groupbuy.window.closed.v1` to `outbox_events` in the same tx.
   */
  async closeWindow(
    windowId: string,
    options: { force?: boolean; extensionHours?: number; correlationId?: string; now?: Date } = {},
  ): Promise<WindowCloseResult> {
    const corrId = this.normalizeCorrelationId(options.correlationId);
    const now = options.now ?? new Date();
    const extensionHours = options.extensionHours ?? DEFAULT_EXTENSION_HOURS;
    const [lockK1, lockK2] = windowAdvisoryLockKey(windowId);

    const result = await this.dataSource.transaction(async (manager) => {
      // 1. Non-blocking transaction-scoped PostgreSQL advisory lock
      const lockRows = (await manager.query(
        `SELECT pg_try_advisory_xact_lock($1, $2) AS acquired`,
        [lockK1, lockK2],
      )) as Array<{ acquired: boolean }>;

      if (!lockRows[0]?.acquired) {
        return { windowId, outcome: 'LOCKED' as const };
      }

      const window = await manager.findOne(GroupBuyWindow, { where: { id: windowId } });
      if (!window) {
        throw new NotFoundException(`Group-buy window ${windowId} not found`);
      }

      if (window.status !== 'OPEN' && window.status !== 'EXTENDED') {
        return { windowId, outcome: 'ALREADY_CLOSED' as const };
      }

      if (!options.force && window.cutoffAt.getTime() > now.getTime()) {
        return { windowId, outcome: 'NOT_DUE' as const };
      }

      const commitments = await manager.find(GroupBuyCommitment, { where: { windowId } });
      const pricing = computeWindowAllocations(
        commitments.map((c) => ({ shopId: c.shopId, productId: c.productId, qty: c.qty })),
        window.priceTiers,
        Number(window.deliveryFee),
      );

      const minOrderValue = Number(window.minOrderValue);

      // Branch A: Minimum order value NOT met
      if (pricing.totalOrderValue < minOrderValue) {
        if (!window.extendedOnce) {
          const baseMs = Math.max(now.getTime(), window.cutoffAt.getTime());
          const newCutoff = new Date(baseMs + extensionHours * 3_600_000);

          const updated = await manager.query(
            `
            UPDATE groupbuy_windows
            SET status = 'EXTENDED',
                extended_once = TRUE,
                cutoff_at = $1,
                updated_at = NOW()
            WHERE id = $2 AND status = 'OPEN'
            RETURNING id
            `,
            [newCutoff, windowId],
          );
          const rows = Array.isArray(updated[0]) ? updated[0] : updated;
          if (rows.length === 0) {
            return { windowId, outcome: 'ALREADY_CLOSED' as const };
          }

          await manager.save(
            OutboxEvent,
            manager.create(OutboxEvent, {
              aggregateType: 'groupbuy_window',
              aggregateId: windowId,
              eventType: EVT_WINDOW_CLOSED,
              version: 1,
              correlationId: corrId,
              producer: 'groupbuy-service',
              payload: {
                windowId,
                distributorId: window.distributorId,
                state: window.state,
                totalValue: pricing.totalOrderValue,
                minOrderValue,
                outcome: 'EXTENDED',
                newCutoffAt: newCutoff.toISOString(),
                allocations: [],
              },
              publishedAt: null,
            }),
          );

          return {
            windowId,
            outcome: 'EXTENDED' as const,
            totalValue: pricing.totalOrderValue,
            newCutoffAt: newCutoff.toISOString(),
          };
        }

        // Already extended once -> cancel permanently
        const cancelled = await manager.query(
          `
          UPDATE groupbuy_windows
          SET status = 'CANCELLED', updated_at = NOW()
          WHERE id = $1 AND status IN ('OPEN', 'EXTENDED')
          RETURNING id
          `,
          [windowId],
        );
        const rows = Array.isArray(cancelled[0]) ? cancelled[0] : cancelled;
        if (rows.length === 0) {
          return { windowId, outcome: 'ALREADY_CLOSED' as const };
        }

        await manager.save(
          OutboxEvent,
          manager.create(OutboxEvent, {
            aggregateType: 'groupbuy_window',
            aggregateId: windowId,
            eventType: EVT_WINDOW_CLOSED,
            version: 1,
            correlationId: corrId,
            producer: 'groupbuy-service',
            payload: {
              windowId,
              distributorId: window.distributorId,
              state: window.state,
              totalValue: pricing.totalOrderValue,
              minOrderValue,
              outcome: 'CANCELLED',
              reason: 'MIN_ORDER_NOT_MET',
              allocations: [],
            },
            publishedAt: null,
          }),
        );

        return {
          windowId,
          outcome: 'CANCELLED' as const,
          totalValue: pricing.totalOrderValue,
        };
      }

      // Branch B: Minimum order value MET -> atomic ALLOCATING + allocations + outbox
      const transitioned = await manager.query(
        `
        UPDATE groupbuy_windows
        SET status = 'ALLOCATING', updated_at = NOW()
        WHERE id = $1 AND status IN ('OPEN', 'EXTENDED')
        RETURNING id
        `,
        [windowId],
      );
      const rows = Array.isArray(transitioned[0]) ? transitioned[0] : transitioned;
      if (rows.length === 0) {
        return { windowId, outcome: 'ALREADY_CLOSED' as const };
      }

      const orderId = uuidv4();
      const allocationEntities = pricing.allocations.map((a) =>
        manager.create(GroupBuyAllocation, {
          orderId,
          windowId,
          shopId: a.shopId,
          productId: a.productId,
          qty: a.qty,
          unitTierPrice: a.unitTierPrice.toFixed(2),
          deliveryShare: a.deliveryShare.toFixed(2),
          landedCost: a.landedCost.toFixed(2),
          status: 'ALLOCATED',
        }),
      );
      await manager.save(GroupBuyAllocation, allocationEntities);

      await manager.save(
        OutboxEvent,
        manager.create(OutboxEvent, {
          aggregateType: 'groupbuy_window',
          aggregateId: windowId,
          eventType: EVT_WINDOW_CLOSED,
          version: 1,
          correlationId: corrId,
          producer: 'groupbuy-service',
          payload: {
            windowId,
            orderId,
            distributorId: window.distributorId,
            state: window.state,
            totalValue: pricing.totalOrderValue,
            totalSavings: pricing.totalSavings,
            outcome: 'ALLOCATING',
            allocations: pricing.allocations,
          },
          publishedAt: null,
        }),
      );

      return {
        windowId,
        outcome: 'ALLOCATING' as const,
        orderId,
        totalValue: pricing.totalOrderValue,
        totalSavings: pricing.totalSavings,
        allocations: pricing.allocations,
      };
    });

    // Update Redis cutoff index post-commit
    if (result.outcome === 'EXTENDED' && result.newCutoffAt) {
      await this.indexCutoff(windowId, new Date(result.newCutoffAt));
    } else if (result.outcome === 'ALLOCATING' || result.outcome === 'CANCELLED') {
      await this.removeCutoffIndex(windowId);
    }

    return result;
  }

  /** Finds all due OPEN/EXTENDED windows (via Redis sorted set + PostgreSQL fallback) and closes them. */
  async processDueWindows(now = new Date()): Promise<WindowCloseResult[]> {
    const dueIds = new Set<string>();

    if (this.redis) {
      try {
        const redisIds = await this.redis.zrangebyscore(GB_CUTOFF_ZSET_KEY, '-inf', now.getTime());
        for (const id of redisIds) dueIds.add(id);
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message },
          'Redis ZRANGEBYSCORE failed; falling back to PostgreSQL due-window query',
        );
      }
    }

    // PostgreSQL remains source of truth even if Redis was flushed
    const pgDue = await this.dataSource.getRepository(GroupBuyWindow).find({
      where: { status: In(['OPEN', 'EXTENDED']) },
      select: ['id', 'cutoffAt'],
    });
    for (const w of pgDue) {
      if (w.cutoffAt.getTime() <= now.getTime()) {
        dueIds.add(w.id);
      }
    }

    const results: WindowCloseResult[] = [];
    for (const windowId of dueIds) {
      try {
        results.push(await this.closeWindow(windowId, { now }));
      } catch (err) {
        this.logger.error(
          { windowId, err: (err as Error).message },
          'Failed closing due group-buy window',
        );
      }
    }
    return results;
  }

  async getMyAllocations(actor: GroupBuyActor): Promise<GroupBuyAllocation[]> {
    const repo = this.dataSource.getRepository(GroupBuyAllocation);
    if (actor.role === 'admin') {
      return repo.find({ order: { createdAt: 'DESC' }, take: 100 });
    }
    const shopId = this.assertShopId(actor);
    return repo.find({
      where: { shopId },
      order: { createdAt: 'DESC' },
    });
  }
}

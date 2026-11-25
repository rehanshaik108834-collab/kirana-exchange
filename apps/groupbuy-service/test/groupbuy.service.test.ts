import { ForbiddenException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import { GroupBuyAllocation } from '../src/entities/groupbuy-allocation.entity';
import { GroupBuyCommitment } from '../src/entities/groupbuy-commitment.entity';
import { GroupBuyWindow } from '../src/entities/groupbuy-window.entity';
import { OutboxEvent } from '../src/entities/outbox-event.entity';
import { EVT_WINDOW_CLOSED, GB_CUTOFF_ZSET_KEY, GroupBuyService } from '../src/groupbuy.service';

const PROD_1 = '11111111-1111-4111-8111-111111111111';
const SHOP_A = '22222222-2222-4222-8222-222222222222';
const SHOP_B = '33333333-3333-4333-8333-333333333333';
const WINDOW_ID = '44444444-4444-4444-8444-444444444444';

function createSimGroupBuyStore(
  initialWindow: GroupBuyWindow,
  initialCommitments: GroupBuyCommitment[],
) {
  const windows = new Map<string, GroupBuyWindow>([[initialWindow.id, { ...initialWindow }]]);
  const commitments = new Map<string, GroupBuyCommitment>(
    initialCommitments.map((c) => [`${c.windowId}:${c.shopId}:${c.productId}`, { ...c }]),
  );
  const allocations: GroupBuyAllocation[] = [];
  const outbox: OutboxEvent[] = [];
  const activeAdvisoryLocks = new Set<string>();

  const makeManager = (heldLocks: string[]) => ({
    findOne: async (cls: unknown, opts: any) => {
      if (cls === GroupBuyWindow) {
        return windows.get(opts.where.id) ?? null;
      }
      if (cls === GroupBuyCommitment) {
        if (opts.where.idempotencyKey) {
          return (
            [...commitments.values()].find(
              (c) =>
                c.shopId === opts.where.shopId && c.idempotencyKey === opts.where.idempotencyKey,
            ) ?? null
          );
        }
        return (
          commitments.get(`${opts.where.windowId}:${opts.where.shopId}:${opts.where.productId}`) ??
          null
        );
      }
      return null;
    },
    find: async (cls: unknown, opts: any) => {
      if (cls === GroupBuyCommitment) {
        return [...commitments.values()].filter((c) => c.windowId === opts.where?.windowId);
      }
      if (cls === GroupBuyAllocation) {
        return allocations.filter((a) => a.windowId === opts.where?.windowId);
      }
      return [];
    },
    create: (_cls: unknown, data: any) => ({ ...data }),
    save: async (cls: unknown, entityOrArr: any) => {
      const list = Array.isArray(entityOrArr) ? entityOrArr : [entityOrArr];
      for (const item of list) {
        if (cls === GroupBuyAllocation) {
          allocations.push(Object.assign(new GroupBuyAllocation(), { id: uuidv4(), ...item }));
        } else if (cls === OutboxEvent) {
          outbox.push(Object.assign(new OutboxEvent(), { id: uuidv4(), ...item }));
        } else if (cls === GroupBuyCommitment) {
          const saved = Object.assign(new GroupBuyCommitment(), {
            id: item.id || uuidv4(),
            ...item,
          });
          commitments.set(`${saved.windowId}:${saved.shopId}:${saved.productId}`, saved);
          return saved;
        }
      }
      return entityOrArr;
    },
    query: async (sql: string, params: any[] = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim();

      if (norm.startsWith('SELECT pg_try_advisory_xact_lock')) {
        const key = `${params[0]}:${params[1]}`;
        if (activeAdvisoryLocks.has(key)) {
          return [{ acquired: false }];
        }
        activeAdvisoryLocks.add(key);
        heldLocks.push(key);
        // Yield briefly to guarantee overlapping concurrent callers contend on the same lock
        await new Promise((r) => setTimeout(r, 15));
        return [{ acquired: true }];
      }

      if (norm.includes("SET status = 'EXTENDED'")) {
        const w = windows.get(params[1]);
        if (!w || w.status !== 'OPEN') return [[], 0];
        w.status = 'EXTENDED';
        w.extendedOnce = true;
        w.cutoffAt = params[0];
        return [[{ id: w.id }], 1];
      }

      if (norm.includes("SET status = 'CANCELLED'")) {
        const w = windows.get(params[0]);
        if (!w || (w.status !== 'OPEN' && w.status !== 'EXTENDED')) return [[], 0];
        w.status = 'CANCELLED';
        return [[{ id: w.id }], 1];
      }

      if (norm.includes("SET status = 'ALLOCATING'")) {
        const w = windows.get(params[0]);
        if (!w || (w.status !== 'OPEN' && w.status !== 'EXTENDED')) return [[], 0];
        w.status = 'ALLOCATING';
        return [[{ id: w.id }], 1];
      }

      throw new Error(`Unhandled SQL in groupbuy sim: ${norm}`);
    },
  });

  const dataSource: any = {
    getRepository: (cls: unknown) => {
      const m = makeManager([]);
      return {
        findOne: (opts: any) => m.findOne(cls, opts),
        find: (opts: any) => m.find(cls, opts),
        create: (data: any) => m.create(cls, data),
        save: (entity: any) => m.save(cls, entity),
      };
    },
    transaction: async (cb: (m: any) => Promise<any>) => {
      const heldLocks: string[] = [];
      try {
        return await cb(makeManager(heldLocks));
      } finally {
        for (const k of heldLocks) activeAdvisoryLocks.delete(k);
      }
    },
  };

  return { dataSource, windows, commitments, allocations, outbox };
}

function makeWindow(overrides: Partial<GroupBuyWindow> = {}): GroupBuyWindow {
  return Object.assign(new GroupBuyWindow(), {
    id: WINDOW_ID,
    distributorId: 'dist-hyd-01',
    state: 'Telangana',
    cutoffAt: new Date(Date.now() - 60_000), // already due
    minOrderValue: '5000.00',
    deliveryFee: '300.00',
    priceTiers: [
      {
        productId: PROD_1,
        baseUnitPrice: 250,
        tiers: [{ minQty: 30, unitPrice: 200 }],
      },
    ],
    extendedOnce: false,
    status: 'OPEN',
    ...overrides,
  });
}

describe('GroupBuyService — Advisory-Locked Exactly-Once Closure & Extend-Once Rule', () => {
  it('CONCURRENT SCHEDULERS: two replicas racing to close the same window allocate EXACTLY ONCE', async () => {
    const store = createSimGroupBuyStore(makeWindow(), [
      Object.assign(new GroupBuyCommitment(), {
        id: uuidv4(),
        windowId: WINDOW_ID,
        shopId: SHOP_A,
        productId: PROD_1,
        qty: 20,
        idempotencyKey: uuidv4(),
      }),
      Object.assign(new GroupBuyCommitment(), {
        id: uuidv4(),
        windowId: WINDOW_ID,
        shopId: SHOP_B,
        productId: PROD_1,
        qty: 10,
        idempotencyKey: uuidv4(),
      }),
    ]);

    const fakeRedis: any = {
      zadd: vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
    };

    const schedulerA = new GroupBuyService(store.dataSource, fakeRedis);
    const schedulerB = new GroupBuyService(store.dataSource, fakeRedis);

    const [resA, resB] = await Promise.all([
      schedulerA.closeWindow(WINDOW_ID),
      schedulerB.closeWindow(WINDOW_ID),
    ]);

    const outcomes = [resA.outcome, resB.outcome].sort();
    expect(outcomes).toEqual(['ALLOCATING', 'LOCKED']);

    // Exactly 2 allocations (Shop A + Shop B) and exactly 1 outbox event
    expect(store.allocations).toHaveLength(2);
    expect(store.outbox).toHaveLength(1);
    expect(store.outbox[0].eventType).toBe(EVT_WINDOW_CLOSED);
    expect(store.outbox[0].payload.outcome).toBe('ALLOCATING');
    expect(store.outbox[0].payload.totalValue).toBe(6000);
    expect(fakeRedis.zrem).toHaveBeenCalledWith(GB_CUTOFF_ZSET_KEY, WINDOW_ID);

    // Subsequent closure attempt after lock release sees ALREADY_CLOSED
    const resC = await schedulerA.closeWindow(WINDOW_ID);
    expect(resC.outcome).toBe('ALREADY_CLOSED');
    expect(store.allocations).toHaveLength(2);
    expect(store.outbox).toHaveLength(1);
  });

  it('applies extend-once rule on first shortfall, then cancels permanently on second shortfall', async () => {
    const store = createSimGroupBuyStore(makeWindow({ minOrderValue: '10000.00' }), [
      Object.assign(new GroupBuyCommitment(), {
        id: uuidv4(),
        windowId: WINDOW_ID,
        shopId: SHOP_A,
        productId: PROD_1,
        qty: 10, // 10 * 250 = 2500 < 10000
        idempotencyKey: uuidv4(),
      }),
    ]);

    const fakeRedis: any = {
      zadd: vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
    };
    const service = new GroupBuyService(store.dataSource, fakeRedis);

    // 1st cutoff: extends by 24h and re-indexes Redis sorted set
    const first = await service.closeWindow(WINDOW_ID, { extensionHours: 24 });
    expect(first.outcome).toBe('EXTENDED');
    expect(store.windows.get(WINDOW_ID)!.status).toBe('EXTENDED');
    expect(store.windows.get(WINDOW_ID)!.extendedOnce).toBe(true);
    expect(fakeRedis.zadd).toHaveBeenCalledTimes(1);

    // 2nd cutoff (25h later): cancels permanently with zero allocations
    const afterExtension = new Date(Date.now() + 25 * 3_600_000);
    const second = await service.closeWindow(WINDOW_ID, { now: afterExtension });
    expect(second.outcome).toBe('CANCELLED');
    expect(store.windows.get(WINDOW_ID)!.status).toBe('CANCELLED');
    expect(store.allocations).toHaveLength(0);
    expect(store.outbox.map((e) => e.payload.outcome)).toEqual(['EXTENDED', 'CANCELLED']);
  });

  it('allows editing commitments before cutoff, replays idempotently, and blocks cross-state shops', async () => {
    const openWindow = makeWindow({ cutoffAt: new Date(Date.now() + 3_600_000) });
    const store = createSimGroupBuyStore(openWindow, []);
    const service = new GroupBuyService(store.dataSource);

    const key1 = uuidv4();
    const key2 = uuidv4();

    // Cross-state blocked
    await expect(
      service.upsertCommitment(
        WINDOW_ID,
        { productId: PROD_1, qty: 10, shopState: 'Maharashtra' },
        { userId: 'u1', role: 'shop_owner', shopId: SHOP_A },
        key1,
      ),
    ).rejects.toThrow(ForbiddenException);

    // Initial commitment + idempotent replay
    const c1 = await service.upsertCommitment(
      WINDOW_ID,
      { productId: PROD_1, qty: 10, shopState: 'Telangana' },
      { userId: 'u1', role: 'shop_owner', shopId: SHOP_A },
      key1,
    );
    const replay = await service.upsertCommitment(
      WINDOW_ID,
      { productId: PROD_1, qty: 10, shopState: 'Telangana' },
      { userId: 'u1', role: 'shop_owner', shopId: SHOP_A },
      key1,
    );
    expect(replay.id).toBe(c1.id);
    expect(replay.qty).toBe(10);

    // Editable before cutoff with a new Idempotency-Key
    const edited = await service.upsertCommitment(
      WINDOW_ID,
      { productId: PROD_1, qty: 18, shopState: 'Telangana' },
      { userId: 'u1', role: 'shop_owner', shopId: SHOP_A },
      key2,
    );
    expect(edited.id).toBe(c1.id);
    expect(edited.qty).toBe(18);
  });
});

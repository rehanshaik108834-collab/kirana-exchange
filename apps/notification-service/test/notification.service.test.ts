import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import { NotificationRecord } from '../src/entities/notification.entity';
import { ShopContact } from '../src/entities/shop-contact.entity';
import {
  batchQueueKey,
  dailyCapKey,
  NotificationService,
  SSE_NOTIFY_PREFIX,
} from '../src/notification.service';

const SHOP_1 = '11111111-1111-4111-8111-111111111111';

function createSimNotifyHarness() {
  const notifications: NotificationRecord[] = [];
  const contacts = new Map<string, ShopContact>();
  const counters = new Map<string, number>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const ssePublished: Array<{ channel: string; payload: any }> = [];

  const repoFor = (cls: unknown) => {
    if (cls === ShopContact) {
      return {
        findOne: async ({ where }: any) => contacts.get(where.shopId) ?? null,
        create: (data: any) => Object.assign(new ShopContact(), data),
        save: async (entity: ShopContact) => {
          contacts.set(entity.shopId, entity);
          return entity;
        },
      };
    }
    return {
      create: (data: any) =>
        Object.assign(new NotificationRecord(), { id: uuidv4(), sentAt: new Date(), ...data }),
      save: async (entity: NotificationRecord) => {
        notifications.push(entity);
        return entity;
      },
      find: async () => [...notifications],
      count: async () => notifications.filter((n) => n.readAt === null).length,
      findOne: async ({ where }: any) => notifications.find((n) => n.id === where.id) ?? null,
      update: async () => ({ affected: notifications.length }),
    };
  };

  const dataSource: any = { getRepository: repoFor };

  const fakeRedis: any = {
    incr: vi.fn(async (k: string) => {
      const next = (counters.get(k) ?? 0) + 1;
      counters.set(k, next);
      return next;
    }),
    expire: vi.fn().mockResolvedValue(1),
    rpush: vi.fn(async (k: string, val: string) => {
      const arr = lists.get(k) ?? [];
      arr.push(val);
      lists.set(k, arr);
      return arr.length;
    }),
    lrange: vi.fn(async (k: string) => [...(lists.get(k) ?? [])]),
    del: vi.fn(async (k: string) => {
      lists.delete(k);
      return 1;
    }),
    sadd: vi.fn(async (k: string, member: string) => {
      const s = sets.get(k) ?? new Set<string>();
      s.add(member);
      sets.set(k, s);
      return 1;
    }),
    srem: vi.fn(async (k: string, member: string) => {
      sets.get(k)?.delete(member);
      return 1;
    }),
    smembers: vi.fn(async (k: string) => [...(sets.get(k) ?? [])]),
    publish: vi.fn(async (channel: string, raw: string) => {
      ssePublished.push({ channel, payload: JSON.parse(raw) });
      return 1;
    }),
  };

  const mailer: any = {
    sendEmail: vi.fn().mockResolvedValue({ sent: true, messageId: '<msg-1@kirana.local>' }),
  };

  return { dataSource, fakeRedis, mailer, notifications, contacts, counters, lists, ssePublished };
}

describe('NotificationService — SSE, SMTP, Daily Caps & Alert Batching', () => {
  it('delivers URGENT alerts via SMTP email + Redis SSE Pub/Sub when under daily cap', async () => {
    const h = createSimNotifyHarness();
    const service = new NotificationService(h.dataSource, h.mailer, h.fakeRedis);
    const now = new Date('2026-04-01T10:00:00Z');

    const res = await service.dispatchAlert({
      shopId: SHOP_1,
      type: 'saga.handover.ready.v1',
      title: 'Swap handover PIN ready',
      body: 'Share PIN 482910 at pickup.',
      priority: 'URGENT',
      data: { handoverCode: '482910' },
      now,
    });

    expect(res.emailed).toBe(true);
    expect(res.channel).toBe('EMAIL');
    expect(res.capped).toBe(false);
    expect(h.mailer.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'shop-11111111@kirana.local',
        subject: '[Kirana Exchange] Swap handover PIN ready',
      }),
    );
    expect(h.ssePublished).toHaveLength(1);
    expect(h.ssePublished[0].channel).toBe(`${SSE_NOTIFY_PREFIX}${SHOP_1}`);
  });

  it('enforces Redis daily cap (notify:cap:*) by suppressing extra emails into notify:batch:*', async () => {
    const h = createSimNotifyHarness();
    const now = new Date('2026-04-01T10:00:00Z');
    // Pre-exhaust the daily cap (default 20)
    h.counters.set(dailyCapKey(SHOP_1, now), 20);

    const service = new NotificationService(h.dataSource, h.mailer, h.fakeRedis);
    const res = await service.dispatchAlert({
      shopId: SHOP_1,
      type: 'swap.offer.accepted.v1',
      title: 'Swap offer accepted',
      body: 'Offer accepted.',
      priority: 'URGENT',
      data: {},
      now,
    });

    expect(res.capped).toBe(true);
    expect(res.emailed).toBe(false);
    expect(res.channel).toBe('BATCHED');
    expect(h.mailer.sendEmail).not.toHaveBeenCalled();
    expect(h.lists.get(batchQueueKey(SHOP_1))).toHaveLength(1);
    // In-app SSE still pushes live so owner never misses transactional status
    expect(h.ssePublished).toHaveLength(1);
  });

  it('batches BATCHABLE alerts and flushes them as a single digest email', async () => {
    const h = createSimNotifyHarness();
    const service = new NotificationService(h.dataSource, h.mailer, h.fakeRedis);
    const now = new Date('2026-04-01T10:00:00Z');

    await service.dispatchAlert({
      shopId: SHOP_1,
      type: 'forecast.batch.at_risk.v1',
      title: 'Batch nearing expiry',
      body: '10 units at risk.',
      priority: 'BATCHABLE',
      data: {},
      now,
    });
    await service.dispatchAlert({
      shopId: SHOP_1,
      type: 'swap.match.found.v1',
      title: 'Nearby surplus match found',
      body: '1.2 km away.',
      priority: 'BATCHABLE',
      data: {},
      now,
    });

    expect(h.mailer.sendEmail).not.toHaveBeenCalled();
    expect(h.lists.get(batchQueueKey(SHOP_1))).toHaveLength(2);

    const flushed = await service.flushAllBatchedShops(now);
    expect(flushed).toEqual({ shopsFlushed: 1, alertsFlushed: 2 });
    expect(h.mailer.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.mailer.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: '[Kirana Exchange] Kirana Exchange Digest (2 alerts)',
      }),
    );
    expect(h.lists.has(batchQueueKey(SHOP_1))).toBe(false);
  });
});

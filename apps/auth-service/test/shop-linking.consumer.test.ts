import { describe, expect, it, vi } from 'vitest';
import { shopLinkingSubscription } from '../src/shop-linking.consumer';

/**
 * The handler only owns the data effect. Dedup (`processed_messages` insert in the same
 * transaction) is done by IdempotentConsumerRunner in @kirana/common and is covered by the
 * messaging gate tests (`pnpm --filter @kirana/common test:int`). Here we check the subscription
 * wiring and that the effect itself is idempotent (`shop_id IS NULL`), so a replay changes nothing.
 */
const envelope = (payload: Record<string, unknown>) =>
  ({
    id: '6f1c9b1e-0000-4000-8000-000000000001',
    type: 'shop.created.v1',
    version: 1,
    occurredAt: new Date().toISOString(),
    correlationId: '6f1c9b1e-0000-4000-8000-000000000002',
    producer: 'shop-service',
    payload,
  }) as any;

/** Fake manager emulating `UPDATE users SET shop_id = $1 WHERE id = $2 AND shop_id IS NULL`. */
function fakeManager(users: { id: string; shop_id: string | null }[]) {
  return {
    query: vi.fn(async (sql: string, [shopId, userId]: [string, string]) => {
      expect(sql).toMatch(/shop_id IS NULL/);
      const u = users.find((x) => x.id === userId && x.shop_id === null);
      if (u) u.shop_id = shopId;
      return [];
    }),
  };
}

describe('shopLinkingSubscription (shop.created.v1)', () => {
  it('binds the auth.shop-linking queue to shop.created.v1', () => {
    expect(shopLinkingSubscription.queue).toBe('auth.shop-linking');
    expect(shopLinkingSubscription.bindingKeys).toEqual(['shop.created.v1']);
    expect(shopLinkingSubscription.consumerName).toBe('auth-shop-linking');
  });

  it('links the owner to the shop; a redelivery changes nothing', async () => {
    const users = [{ id: 'owner-1', shop_id: null as string | null }];
    const manager = fakeManager(users);
    const evt = envelope({ shopId: 'shop-1', ownerId: 'owner-1' });

    await shopLinkingSubscription.handler(evt, manager as any);
    await shopLinkingSubscription.handler(evt, manager as any);

    expect(users[0].shop_id).toBe('shop-1');
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE users'), [
      'shop-1',
      'owner-1',
    ]);
  });

  it('never overwrites an existing link', async () => {
    const users = [{ id: 'owner-1', shop_id: 'shop-old' as string | null }];
    await shopLinkingSubscription.handler(
      envelope({ shopId: 'shop-new', ownerId: 'owner-1' }),
      fakeManager(users) as any,
    );
    expect(users[0].shop_id).toBe('shop-old');
  });

  it('skips events without ownerId or shopId', async () => {
    const manager = fakeManager([]);
    await shopLinkingSubscription.handler(envelope({ shopId: 'shop-1' }), manager as any);
    await shopLinkingSubscription.handler(envelope({ ownerId: 'owner-1' }), manager as any);
    expect(manager.query).not.toHaveBeenCalled();
  });
});

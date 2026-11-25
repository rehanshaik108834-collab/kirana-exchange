import { describe, expect, it, vi } from 'vitest';
import { NOTIFY_BINDING_KEYS, NotificationEventConsumer } from '../src/notification.consumer';

describe('NotificationEventConsumer', () => {
  const envelope = (type: string, payload: Record<string, unknown>) => ({
    id: '11111111-1111-4111-8111-111111111111',
    type,
    version: 1,
    occurredAt: '2026-04-01T00:00:00Z',
    correlationId: '22222222-2222-4222-8222-222222222222',
    producer: 'test',
    payload,
  });

  it('subscribes to all 8 domain events on kirana.events', () => {
    const consumer = new NotificationEventConsumer({} as any);
    const sub = consumer.getSubscription();
    expect(sub.bindingKeys).toEqual(NOTIFY_BINDING_KEYS);
    expect(sub.bindingKeys).toHaveLength(8);
  });

  it('routes saga.handover.ready.v1 with PIN ONLY to seller and hides PIN from buyer', async () => {
    const dispatchAlert = vi.fn().mockResolvedValue({});
    const consumer = new NotificationEventConsumer({ dispatchAlert } as any);

    await consumer.handleEvent(
      envelope('saga.handover.ready.v1', {
        transactionId: 'tx-1',
        listingId: 'list-1',
        sellerShopId: 'seller-1',
        buyerShopId: 'buyer-1',
        handoverCode: '654321',
        handoverExpiresAt: '2026-04-02T00:00:00Z',
      }),
      {} as any,
    );

    expect(dispatchAlert).toHaveBeenCalledTimes(2);
    const sellerCall = dispatchAlert.mock.calls[0][0];
    const buyerCall = dispatchAlert.mock.calls[1][0];

    expect(sellerCall.shopId).toBe('seller-1');
    expect(sellerCall.body).toContain('654321');
    expect(buyerCall.shopId).toBe('buyer-1');
    expect(buyerCall.body).not.toContain('654321');
    expect(buyerCall.data.handoverCode).toBeUndefined();
  });

  it('notifies each unique participating shop when groupbuy.window.closed.v1 arrives', async () => {
    const dispatchAlert = vi.fn().mockResolvedValue({});
    const consumer = new NotificationEventConsumer({ dispatchAlert } as any);

    await consumer.handleEvent(
      envelope('groupbuy.window.closed.v1', {
        windowId: 'win-1',
        distributorId: 'dist-1',
        outcome: 'ALLOCATING',
        totalValue: 12000,
        allocations: [
          { shopId: 'shop-a', qty: 10 },
          { shopId: 'shop-a', qty: 5 },
          { shopId: 'shop-b', qty: 8 },
        ],
      }),
      {} as any,
    );

    expect(dispatchAlert).toHaveBeenCalledTimes(2);
    expect(dispatchAlert.mock.calls.map((c) => c[0].shopId).sort()).toEqual(['shop-a', 'shop-b']);
  });
});

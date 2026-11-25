import { describe, expect, it, vi } from 'vitest';
import { SwapEventConsumer } from '../src/swap.consumer';

describe('SwapEventConsumer', () => {
  const baseEnvelope = (type: string, payload: Record<string, unknown>) => ({
    id: '11111111-1111-4111-8111-111111111111',
    type,
    version: 1,
    occurredAt: '2026-04-01T00:00:00Z',
    correlationId: '22222222-2222-4222-8222-222222222222',
    producer: 'test',
    payload,
  });

  it('syncs shop.created.v1 into shop_geo_read_model and Redis geo:shops', async () => {
    const geoService = { upsertShopLocation: vi.fn().mockResolvedValue(undefined) };
    const manager = { query: vi.fn().mockResolvedValue([]) };
    const consumer = new SwapEventConsumer(geoService as any);

    await consumer.handleEvent(
      baseEnvelope('shop.created.v1', {
        shopId: 'shop-1',
        lat: 17.4126,
        lng: 78.4398,
        state: 'Telangana',
        gstScheme: 'REGULAR',
      }),
      manager as any,
    );

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO shop_geo_read_model'),
      ['shop-1', '17.412600', '78.439800', 'Telangana', 'REGULAR', '2.00'],
    );
    expect(geoService.upsertShopLocation).toHaveBeenCalledWith('shop-1', 17.4126, 78.4398);
  });

  it('records forecast.batch.at_risk.v1 into risk_listing_drafts', async () => {
    const geoService = { upsertShopLocation: vi.fn() };
    const manager = { query: vi.fn().mockResolvedValue([]) };
    const consumer = new SwapEventConsumer(geoService as any);

    await consumer.handleEvent(
      baseEnvelope('forecast.batch.at_risk.v1', {
        batchId: 'batch-1',
        shopId: 'shop-1',
        productId: 'prod-1',
        riskType: 'EXPIRY',
        daysOfCover: 64.5,
        expectedUnsoldQty: 14,
        recommendedAction: 'SWAP_TO_NEIGHBOUR',
      }),
      manager as any,
    );

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO risk_listing_drafts'),
      ['batch-1', 'shop-1', 'prod-1', 'EXPIRY', '64.50', 14, 'SWAP_TO_NEIGHBOUR'],
    );
  });

  it('closes listing on saga.swap.completed.v1 and restores listing on saga.swap.cancelled.v1', async () => {
    const geoService = { upsertShopLocation: vi.fn() };
    const manager = { query: vi.fn().mockResolvedValue([]) };
    const consumer = new SwapEventConsumer(geoService as any);

    await consumer.handleEvent(
      baseEnvelope('saga.swap.completed.v1', { listingId: 'listing-1' }),
      manager as any,
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'COMPLETED'"),
      ['listing-1'],
    );

    await consumer.handleEvent(
      baseEnvelope('saga.swap.cancelled.v1', { listingId: 'listing-1' }),
      manager as any,
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = $1 AND status = 'RESERVED'"),
      ['listing-1'],
    );
  });
});

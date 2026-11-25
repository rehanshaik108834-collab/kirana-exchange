import { describe, expect, it, vi } from 'vitest';
import { GEO_SHOPS_KEY, GeoService, haversineKm } from '../src/geo.service';

describe('GeoService', () => {
  it('computes accurate Haversine distances between Hyderabad landmarks', () => {
    // Banjara Hills (17.4126, 78.4398) to Jubilee Hills (17.4319, 78.4073) ~= 4.06 km
    const dist = haversineKm(17.4126, 78.4398, 17.4319, 78.4073);
    expect(dist).toBeGreaterThan(3.5);
    expect(dist).toBeLessThan(4.6);
  });

  it('uses Redis GEOSEARCH when Redis returns hits', async () => {
    const fakeRedis = {
      geoadd: vi.fn().mockResolvedValue(1),
      call: vi.fn().mockResolvedValue([
        ['shop-a', '0.850'],
        ['shop-b', '1.920'],
      ]),
    };
    const geo = new GeoService(fakeRedis as any);

    await geo.upsertShopLocation('shop-a', 17.41, 78.44);
    expect(fakeRedis.geoadd).toHaveBeenCalledWith(GEO_SHOPS_KEY, 78.44, 17.41, 'shop-a');

    const hits = await geo.findNearbyShops(17.41, 78.44, 5, []);
    expect(hits).toEqual([
      { shopId: 'shop-a', distanceKm: 0.85 },
      { shopId: 'shop-b', distanceKm: 1.92 },
    ]);
  });

  it('falls back cleanly to Haversine filtering when Redis throws', async () => {
    const brokenRedis = {
      call: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
    const geo = new GeoService(brokenRedis as any);

    const hits = await geo.findNearbyShops(17.4126, 78.4398, 5, [
      { shopId: 'near-shop', lat: 17.42, lng: 78.44 },
      { shopId: 'far-shop', lat: 17.6, lng: 78.6 },
    ]);

    expect(hits.map((h) => h.shopId)).toEqual(['near-shop']);
    expect(hits[0].distanceKm).toBeLessThan(1.5);
  });
});

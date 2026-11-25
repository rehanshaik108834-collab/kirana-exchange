import { Inject, Injectable, Optional } from '@nestjs/common';
import { REDIS_CLIENT } from '@kirana/common';
import type Redis from 'ioredis';
import pino from 'pino';

export const GEO_SHOPS_KEY = 'geo:shops';
const EARTH_RADIUS_KM = 6371.0088;

export interface NearbyShopHit {
  shopId: string;
  distanceKm: number;
}

export interface ShopCoordinateRecord {
  shopId: string;
  lat: number;
  lng: number;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((EARTH_RADIUS_KM * c).toFixed(3));
}

@Injectable()
export class GeoService {
  private readonly logger = pino({ name: 'swap-geo-service' });

  constructor(@Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis) {}

  /** Upserts shop coordinates into Redis `geo:shops` (degrades gracefully if Redis is unavailable). */
  async upsertShopLocation(shopId: string, lat: number, lng: number): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.geoadd(GEO_SHOPS_KEY, lng, lat, shopId);
    } catch (err) {
      this.logger.warn(
        { shopId, err: (err as Error).message },
        'Redis GEOADD failed; swap-service will fall back to PostgreSQL Haversine search',
      );
    }
  }

  /**
   * Finds shops within `radiusKm` of `(lat, lng)` sorted by ascending distance.
   * Uses Redis 7 `GEOSEARCH ... WITHDIST ASC` as fast path, falling back seamlessly
   * to Haversine filtering over `fallbackShops` if Redis is down or unpopulated.
   */
  async findNearbyShops(
    lat: number,
    lng: number,
    radiusKm: number,
    fallbackShops: ShopCoordinateRecord[],
  ): Promise<NearbyShopHit[]> {
    if (this.redis) {
      try {
        const raw = (await this.redis.call(
          'GEOSEARCH',
          GEO_SHOPS_KEY,
          'FROMLONLAT',
          String(lng),
          String(lat),
          'BYRADIUS',
          String(radiusKm),
          'km',
          'WITHDIST',
          'ASC',
        )) as Array<[string, string]>;

        if (Array.isArray(raw) && raw.length > 0) {
          return raw.map(([member, dist]) => ({
            shopId: String(member),
            distanceKm: Number(Number(dist).toFixed(3)),
          }));
        }
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message },
          'Redis GEOSEARCH failed; falling back to PostgreSQL Haversine calculation',
        );
      }
    }

    return fallbackShops
      .map((shop) => ({
        shopId: shop.shopId,
        distanceKm: haversineKm(lat, lng, shop.lat, shop.lng),
      }))
      .filter((hit) => hit.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }
}

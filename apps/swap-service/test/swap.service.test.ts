import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DomainProblemException } from '@kirana/common';
import { describe, expect, it, vi } from 'vitest';
import { OutboxEvent } from '../src/entities/outbox-event.entity';
import { RiskListingDraft } from '../src/entities/risk-listing-draft.entity';
import { ShopGeoReadModel } from '../src/entities/shop-geo.entity';
import { SwapListing } from '../src/entities/swap-listing.entity';
import { SwapOffer } from '../src/entities/swap-offer.entity';
import { GeoService } from '../src/geo.service';
import { SwapService } from '../src/swap.service';

const BUYER_SHOP = '11111111-1111-4111-8111-111111111111';
const SELLER_TS_SHOP = '22222222-2222-4222-8222-222222222222';
const SELLER_AP_SHOP = '33333333-3333-4333-8333-333333333333';
const PRODUCT_ID = '44444444-4444-4444-8444-444444444444';
const BATCH_ID = '55555555-5555-4555-8555-555555555555';
const LISTING_ID = '66666666-6666-4666-8666-666666666666';
const OFFER_ID = '77777777-7777-4777-8777-777777777777';
const IDEM_KEY = '88888888-8888-4888-8888-888888888888';

describe('SwapService — listings, same-state GST boundary, anonymization & offers', () => {
  it('creates a listing atomically with rule-based suggestedPrice and swap.listing.created.v1 outbox', async () => {
    const savedOutbox: unknown[] = [];

    const listingRepo = { findOne: vi.fn().mockResolvedValue(null) };
    const geoRepo = {
      findOne: vi.fn().mockResolvedValue({ shopId: SELLER_TS_SHOP, state: 'Telangana' }),
    };

    const manager = {
      create: vi.fn((_cls, data) => ({ id: LISTING_ID, ...data })),
      save: vi.fn(async (cls, entity) => {
        if (cls === OutboxEvent) savedOutbox.push(entity);
        return entity;
      }),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
    };

    const dataSource: any = {
      getRepository: vi.fn((cls) => (cls === SwapListing ? listingRepo : geoRepo)),
      transaction: vi.fn(async (cb) => cb(manager)),
    };

    const service = new SwapService(dataSource, new GeoService());
    const created = await service.createListing(
      {
        batchId: BATCH_ID,
        productId: PRODUCT_ID,
        qty: 12,
        costPrice: 100,
        batchExpiryDate: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10),
      },
      { userId: 'u-1', role: 'shop_owner', shopId: SELLER_TS_SHOP },
      IDEM_KEY,
    );

    expect(created.state).toBe('Telangana');
    expect(Number(created.suggestedPrice)).toBe(85);
    expect(Number(created.price)).toBe(85);
    expect(savedOutbox).toHaveLength(1);
    expect((savedOutbox[0] as any).eventType).toBe('swap.listing.created.v1');
    expect(manager.update).toHaveBeenCalledWith(
      RiskListingDraft,
      { batchId: BATCH_ID, shopId: SELLER_TS_SHOP },
      { dismissed: true },
    );
  });

  it('enforces same-state GST boundary, anonymizes seller data, and runs well under 300ms', async () => {
    const buyerGeo: Partial<ShopGeoReadModel> = {
      shopId: BUYER_SHOP,
      lat: '17.412600',
      lng: '78.439800',
      state: 'Telangana',
      swapRadiusKm: '5.00',
      reputationScore: '98.00',
    };
    const sameStateSeller: Partial<ShopGeoReadModel> = {
      shopId: SELLER_TS_SHOP,
      lat: '17.420000',
      lng: '78.441000',
      state: 'Telangana',
      reputationScore: '95.00',
    };

    // Redis returns BOTH a cross-state shop 0.3km away AND a same-state shop 0.83km away
    const fakeRedis = {
      call: vi.fn().mockResolvedValue([
        [BUYER_SHOP, '0.000'],
        [SELLER_AP_SHOP, '0.300'],
        [SELLER_TS_SHOP, '0.830'],
      ]),
    };

    const openListings: Partial<SwapListing>[] = [
      {
        id: LISTING_ID,
        shopId: SELLER_TS_SHOP,
        productId: PRODUCT_ID,
        state: 'Telangana',
        qty: 10,
        costPrice: '80.00',
        price: '72.00',
        batchExpiryDate: '2026-06-01',
        status: 'OPEN',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      // Cross-state listing even if somehow returned by DB must be rejected
      {
        id: '99999999-9999-4999-8999-999999999999',
        shopId: SELLER_AP_SHOP,
        productId: PRODUCT_ID,
        state: 'Andhra Pradesh',
        qty: 10,
        costPrice: '70.00',
        price: '60.00',
        batchExpiryDate: '2026-06-01',
        status: 'OPEN',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    ];

    const geoRepo = {
      findOne: vi.fn().mockResolvedValue(buyerGeo),
      find: vi.fn().mockResolvedValue([buyerGeo, sameStateSeller]),
    };
    const listingRepo = {
      find: vi.fn().mockResolvedValue(openListings),
    };
    const dataSource: any = {
      getRepository: vi.fn((cls) => (cls === ShopGeoReadModel ? geoRepo : listingRepo)),
    };

    const service = new SwapService(dataSource, new GeoService(fakeRedis as any));

    const t0 = performance.now();
    const candidates = await service.searchCandidates(
      { productId: PRODUCT_ID, radiusKm: 5 },
      { userId: 'u-buyer', role: 'shop_owner', shopId: BUYER_SHOP },
    );
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(300);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].listingId).toBe(LISTING_ID);
    expect(candidates[0].state).toBe('Telangana');
    expect(candidates[0].distanceKm).toBe(0.83);
    expect(candidates[0].sellerReputationBand).toBe('HIGH');

    // Privacy invariant: seller identity and wholesale costPrice MUST NOT leak
    const serialized = JSON.stringify(candidates[0]);
    expect(serialized).not.toContain(SELLER_TS_SHOP);
    expect(serialized).not.toContain('costPrice');
    expect(serialized).not.toContain('sellerShopId');
    expect(serialized).not.toContain('shopId');
  });

  it('rejects self-offers, cross-state offers, and enforces 20/hr anti-spam rate limit', async () => {
    const listing: Partial<SwapListing> = {
      id: LISTING_ID,
      shopId: SELLER_TS_SHOP,
      productId: PRODUCT_ID,
      state: 'Telangana',
      qty: 10,
      status: 'OPEN',
      expiresAt: new Date(Date.now() + 86_400_000),
    };

    const offerRepo = { findOne: vi.fn().mockResolvedValue(null) };
    const listingRepo = { findOne: vi.fn().mockResolvedValue(listing) };
    const geoRepo = {
      findOne: vi.fn().mockResolvedValue({ shopId: BUYER_SHOP, state: 'Andhra Pradesh' }),
    };

    const dataSource: any = {
      getRepository: vi.fn((cls) => {
        if (cls === SwapOffer) return offerRepo;
        if (cls === SwapListing) return listingRepo;
        return geoRepo;
      }),
    };

    // 1. Anti-spam 429 check
    const throttledLimiter: any = {
      consumeSlidingWindow: vi.fn().mockResolvedValue({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 420,
      }),
    };
    const throttledService = new SwapService(dataSource, new GeoService(), throttledLimiter);
    await expect(
      throttledService.createOffer(
        { listingId: LISTING_ID, qty: 5, offeredPrice: 70 },
        { userId: 'u-b', role: 'shop_owner', shopId: BUYER_SHOP },
        IDEM_KEY,
      ),
    ).rejects.toThrow(DomainProblemException);

    // 2. Self-offer blocked
    const allowLimiter: any = {
      consumeSlidingWindow: vi.fn().mockResolvedValue({
        allowed: true,
        remaining: 19,
        retryAfterSeconds: 0,
      }),
    };
    const service = new SwapService(dataSource, new GeoService(), allowLimiter);
    await expect(
      service.createOffer(
        { listingId: LISTING_ID, qty: 5, offeredPrice: 70 },
        { userId: 'u-s', role: 'shop_owner', shopId: SELLER_TS_SHOP },
        IDEM_KEY,
      ),
    ).rejects.toThrow(BadRequestException);

    // 3. Cross-state offer blocked
    await expect(
      service.createOffer(
        { listingId: LISTING_ID, qty: 5, offeredPrice: 70 },
        { userId: 'u-b', role: 'shop_owner', shopId: BUYER_SHOP },
        IDEM_KEY,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('accepts an offer atomically, reserves listing, rejects competing offers, and queues OfferAccepted', async () => {
    const offer: Partial<SwapOffer> = {
      id: OFFER_ID,
      listingId: LISTING_ID,
      sellerShopId: SELLER_TS_SHOP,
      buyerShopId: BUYER_SHOP,
      qty: 6,
      offeredPrice: '72.00',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    const listing: Partial<SwapListing> = {
      id: LISTING_ID,
      shopId: SELLER_TS_SHOP,
      batchId: BATCH_ID,
      productId: PRODUCT_ID,
      state: 'Telangana',
      qty: 10,
      costPrice: '80.00',
      batchExpiryDate: '2026-06-01',
      status: 'OPEN',
      expiresAt: new Date(Date.now() + 86_400_000),
    };

    const queuedEvents: any[] = [];
    const manager = {
      findOne: vi.fn(async (cls) => (cls === SwapOffer ? offer : listing)),
      create: vi.fn((_cls, data) => data),
      save: vi.fn(async (cls, entity) => {
        if (cls === OutboxEvent) queuedEvents.push(entity);
        return entity;
      }),
      query: vi.fn().mockResolvedValue([]),
    };

    const dataSource: any = {
      transaction: vi.fn(async (cb) => cb(manager)),
    };

    const service = new SwapService(dataSource, new GeoService());
    const accepted = await service.acceptOffer(OFFER_ID, {
      userId: 'u-s',
      role: 'shop_owner',
      shopId: SELLER_TS_SHOP,
    });

    expect(accepted.status).toBe('ACCEPTED');
    expect(listing.status).toBe('RESERVED');
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'REJECTED'"), [
      LISTING_ID,
      OFFER_ID,
    ]);
    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0].eventType).toBe('swap.offer.accepted.v1');
    expect(queuedEvents[0].payload).toMatchObject({
      offerId: OFFER_ID,
      listingId: LISTING_ID,
      sellerShopId: SELLER_TS_SHOP,
      buyerShopId: BUYER_SHOP,
      batchId: BATCH_ID,
      productId: PRODUCT_ID,
      qty: 6,
      agreedPrice: 72,
      costPrice: 80,
      expiryDate: '2026-06-01',
    });
  });
});

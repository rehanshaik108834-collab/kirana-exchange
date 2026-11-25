import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  DomainProblemException,
  IdempotencyConflictProblem,
  RateLimiterService,
} from '@kirana/common';
import pino from 'pino';
import { DataSource, In } from 'typeorm';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import {
  CandidateSearchQueryDto,
  CounterOfferDto,
  CreateListingDto,
  CreateOfferDto,
  CreateShortageDto,
} from './dto/swap.dto';
import { OutboxEvent } from './entities/outbox-event.entity';
import { RiskListingDraft } from './entities/risk-listing-draft.entity';
import { ShopGeoReadModel } from './entities/shop-geo.entity';
import { ShortageRequest } from './entities/shortage-request.entity';
import { SwapListing } from './entities/swap-listing.entity';
import { SwapOffer } from './entities/swap-offer.entity';
import { GeoService } from './geo.service';
import { computeSuggestedPrice } from './pricing';

export interface SwapActor {
  userId: string;
  role: string;
  shopId?: string;
}

/**
 * Public candidate returned to prospective buyers.
 * PRIVACY INVARIANT: Never exposes sellerShopId, seller name/address, costPrice, or sales volume.
 */
export interface AnonymisedCandidate {
  listingId: string;
  productId: string;
  state: string;
  qty: number;
  price: number;
  batchExpiryDate: string;
  expiresAt: string;
  distanceKm: number;
  sellerReputationBand: 'HIGH' | 'STANDARD' | 'CAUTION';
}

export interface StateMatchingSnapshot {
  state: string;
  generatedAt: string;
  listings: Array<{
    listingId: string;
    sellerShopId: string;
    batchId: string;
    productId: string;
    qty: number;
    price: number;
    costPrice: number;
    batchExpiryDate: string;
    lat: number;
    lng: number;
    reputationScore: number;
  }>;
  shortages: Array<{
    shortageId: string;
    buyerShopId: string;
    productId: string;
    reorderQty: number;
    maxUnitPrice: number | null;
    lat: number;
    lng: number;
    swapRadiusKm: number;
    reputationScore: number;
  }>;
}

const DEFAULT_LISTING_TTL_HOURS = 72;
const DEFAULT_OFFER_TTL_HOURS = 24;
const OFFER_RATE_LIMIT_PER_HOUR = 20;
const OFFER_RATE_WINDOW_SECONDS = 3600;

function reputationBand(score: number): 'HIGH' | 'STANDARD' | 'CAUTION' {
  if (score >= 90) return 'HIGH';
  if (score >= 70) return 'STANDARD';
  return 'CAUTION';
}

@Injectable()
export class SwapService {
  private readonly logger = pino({ name: 'swap-service' });

  constructor(
    private readonly dataSource: DataSource,
    private readonly geoService: GeoService,
    @Optional() private readonly rateLimiter?: RateLimiterService,
  ) {}

  private normalizeCorrelationId(correlationId?: string): string {
    return correlationId && isUuid(correlationId) ? correlationId : uuidv4();
  }

  private assertShopId(actor: SwapActor): string {
    if (!actor.shopId || !isUuid(actor.shopId)) {
      throw new ForbiddenException('A linked shop profile is required for swap operations');
    }
    return actor.shopId;
  }

  private assertIdempotencyKey(key?: string): string {
    if (!key || !isUuid(key)) {
      throw new BadRequestException('Header Idempotency-Key must be a valid UUIDv4');
    }
    return key;
  }

  /** Creates a surplus listing with rule-based price suggestion + outbox `swap.listing.created.v1`. */
  async createListing(
    dto: CreateListingDto,
    actor: SwapActor,
    idempotencyKey?: string,
    correlationId?: string,
  ): Promise<SwapListing> {
    const shopId = this.assertShopId(actor);
    const validKey = this.assertIdempotencyKey(idempotencyKey);
    const validCorrelationId = this.normalizeCorrelationId(correlationId);

    const existing = await this.dataSource
      .getRepository(SwapListing)
      .findOne({ where: { shopId, idempotencyKey: validKey } });

    if (existing) {
      if (existing.batchId !== dto.batchId || existing.productId !== dto.productId) {
        throw IdempotencyConflictProblem(
          'Idempotency-Key was already used for a different surplus listing',
        );
      }
      return existing;
    }

    const shopGeo = await this.dataSource
      .getRepository(ShopGeoReadModel)
      .findOne({ where: { shopId } });

    const resolvedState = shopGeo?.state ?? dto.state;
    if (!resolvedState) {
      throw new BadRequestException(
        'Shop state is unavailable; register your shop location before listing surplus stock',
      );
    }

    const pricing = computeSuggestedPrice({
      costPrice: dto.costPrice,
      batchExpiryDate: dto.batchExpiryDate,
      daysOfCover: dto.daysOfCover,
    });
    const finalPrice =
      dto.price !== undefined ? Number(dto.price.toFixed(2)) : pricing.suggestedPrice;
    const ttlHours = dto.ttlHours ?? DEFAULT_LISTING_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    try {
      const saved = await this.dataSource.transaction(async (manager) => {
        const listing = manager.create(SwapListing, {
          shopId,
          batchId: dto.batchId,
          productId: dto.productId,
          state: resolvedState,
          qty: dto.qty,
          costPrice: dto.costPrice.toFixed(2),
          suggestedPrice: pricing.suggestedPrice.toFixed(2),
          price: finalPrice.toFixed(2),
          batchExpiryDate: dto.batchExpiryDate.slice(0, 10),
          status: 'OPEN',
          expiresAt,
          idempotencyKey: validKey,
        });

        const persisted = await manager.save(SwapListing, listing);

        await manager.save(
          OutboxEvent,
          manager.create(OutboxEvent, {
            aggregateType: 'swap_listing',
            aggregateId: persisted.id,
            eventType: 'swap.listing.created.v1',
            version: 1,
            correlationId: validCorrelationId,
            producer: 'swap-service',
            payload: {
              listingId: persisted.id,
              shopId: persisted.shopId,
              batchId: persisted.batchId,
              productId: persisted.productId,
              qty: persisted.qty,
              suggestedPrice: Number(persisted.suggestedPrice),
              price: Number(persisted.price),
              batchExpiryDate: persisted.batchExpiryDate,
              expiresAt: persisted.expiresAt.toISOString(),
              state: persisted.state,
            },
            publishedAt: null,
          }),
        );

        // Dismiss matching risk draft if this batch came from forecast.batch.at_risk.v1
        await manager.update(
          RiskListingDraft,
          { batchId: dto.batchId, shopId },
          { dismissed: true },
        );

        return persisted;
      });

      this.logger.info(
        { correlationId: validCorrelationId, listingId: saved.id, shopId, state: saved.state },
        'Surplus listing created and swap.listing.created.v1 queued',
      );
      return saved;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        throw new ConflictException(
          'An active surplus listing already exists for this batch or idempotency key',
        );
      }
      throw err;
    }
  }

  /** Lists all surplus listings owned by the authenticated shop. */
  async getMyListings(actor: SwapActor): Promise<SwapListing[]> {
    const shopId = this.assertShopId(actor);
    return this.dataSource.getRepository(SwapListing).find({
      where: { shopId },
      order: { createdAt: 'DESC' },
    });
  }

  /** Returns auto-suggested surplus listing drafts generated from `forecast.batch.at_risk.v1`. */
  async getRiskListingDrafts(actor: SwapActor): Promise<RiskListingDraft[]> {
    const shopId = this.assertShopId(actor);
    return this.dataSource.getRepository(RiskListingDraft).find({
      where: { shopId, dismissed: false },
      order: { updatedAt: 'DESC' },
    });
  }

  /** Cancels an OPEN listing owned by the seller. */
  async cancelListing(listingId: string, actor: SwapActor): Promise<SwapListing> {
    const shopId = this.assertShopId(actor);
    const repo = this.dataSource.getRepository(SwapListing);
    const listing = await repo.findOne({ where: { id: listingId } });

    if (!listing) {
      throw new NotFoundException(`Listing ${listingId} not found`);
    }
    if (listing.shopId !== shopId && actor.role !== 'admin') {
      throw new ForbiddenException('You can only cancel your own surplus listings');
    }
    if (listing.status !== 'OPEN') {
      throw new ConflictException(`Cannot cancel listing in status ${listing.status}`);
    }

    listing.status = 'CANCELLED';
    return repo.save(listing);
  }

  /** Creates or updates an OPEN shortage request for the buyer shop. */
  async createOrUpdateShortage(dto: CreateShortageDto, actor: SwapActor): Promise<ShortageRequest> {
    const shopId = this.assertShopId(actor);
    const shopGeo = await this.dataSource
      .getRepository(ShopGeoReadModel)
      .findOne({ where: { shopId } });

    const resolvedState = shopGeo?.state ?? dto.state;
    if (!resolvedState) {
      throw new BadRequestException(
        'Shop state is unavailable; register your shop location before posting a shortage request',
      );
    }

    const repo = this.dataSource.getRepository(ShortageRequest);
    const existing = await repo.findOne({
      where: { shopId, productId: dto.productId, status: 'OPEN' },
    });

    if (existing) {
      existing.reorderQty = dto.reorderQty;
      existing.maxUnitPrice =
        dto.maxUnitPrice !== undefined ? dto.maxUnitPrice.toFixed(2) : existing.maxUnitPrice;
      existing.state = resolvedState;
      return repo.save(existing);
    }

    const created = repo.create({
      shopId,
      productId: dto.productId,
      state: resolvedState,
      reorderQty: dto.reorderQty,
      maxUnitPrice: dto.maxUnitPrice !== undefined ? dto.maxUnitPrice.toFixed(2) : null,
      status: 'OPEN',
    });
    return repo.save(created);
  }

  /**
   * Searches nearby OPEN surplus listings for the buyer shop.
   *
   * INVARIANTS:
   * 1. Strict same-state GST boundary: only listings where `listing.state === buyerShop.state`.
   * 2. Excludes the buyer's own listings and expired listings.
   * 3. Strict seller anonymization: never returns sellerShopId, costPrice, or shop metadata.
   */
  async searchCandidates(
    query: CandidateSearchQueryDto,
    actor: SwapActor,
  ): Promise<AnonymisedCandidate[]> {
    const buyerShopId = this.assertShopId(actor);
    const geoRepo = this.dataSource.getRepository(ShopGeoReadModel);
    const buyerGeo = await geoRepo.findOne({ where: { shopId: buyerShopId } });

    if (!buyerGeo) {
      throw new NotFoundException(
        'Buyer shop geo profile not synced yet; ensure shop location is registered',
      );
    }

    const radiusKm = query.radiusKm ?? Number(buyerGeo.swapRadiusKm || 2.0);
    const limit = query.limit ?? 50;

    // Load all shops in the SAME state (used for both strict GST filtering and Redis fallback)
    const sameStateShops = await geoRepo.find({ where: { state: buyerGeo.state } });
    const sameStateById = new Map<string, ShopGeoReadModel>(
      sameStateShops.map((s) => [s.shopId, s]),
    );

    const nearbyHits = await this.geoService.findNearbyShops(
      Number(buyerGeo.lat),
      Number(buyerGeo.lng),
      radiusKm,
      sameStateShops.map((s) => ({
        shopId: s.shopId,
        lat: Number(s.lat),
        lng: Number(s.lng),
      })),
    );

    // Filter strictly to OTHER shops in the SAME state
    const distanceByShopId = new Map<string, number>();
    for (const hit of nearbyHits) {
      if (hit.shopId === buyerShopId) continue;
      if (!sameStateById.has(hit.shopId)) continue;
      distanceByShopId.set(hit.shopId, hit.distanceKm);
    }

    const candidateShopIds = [...distanceByShopId.keys()];
    if (candidateShopIds.length === 0) {
      return [];
    }

    const where: Record<string, unknown> = {
      status: 'OPEN',
      state: buyerGeo.state,
      shopId: In(candidateShopIds),
    };
    if (query.productId) {
      where.productId = query.productId;
    }

    const listings = await this.dataSource.getRepository(SwapListing).find({ where });
    const nowMs = Date.now();

    const anonymised: AnonymisedCandidate[] = [];
    for (const listing of listings) {
      // Defensive double-check on same-state & expiry invariants
      if (listing.shopId === buyerShopId) continue;
      if (listing.state !== buyerGeo.state) continue;
      if (listing.expiresAt.getTime() <= nowMs) continue;

      const distanceKm = distanceByShopId.get(listing.shopId);
      if (distanceKm === undefined) continue;

      const sellerGeo = sameStateById.get(listing.shopId);
      const repScore = sellerGeo ? Number(sellerGeo.reputationScore) : 100;

      anonymised.push({
        listingId: listing.id,
        productId: listing.productId,
        state: listing.state,
        qty: listing.qty,
        price: Number(listing.price),
        batchExpiryDate: listing.batchExpiryDate,
        expiresAt: listing.expiresAt.toISOString(),
        distanceKm,
        sellerReputationBand: reputationBand(repScore),
      });
    }

    return anonymised
      .sort((a, b) => a.distanceKm - b.distanceKm || a.price - b.price)
      .slice(0, limit);
  }

  /** Creates a buyer offer on an OPEN same-state listing with anti-spam sliding window rate limit. */
  async createOffer(
    dto: CreateOfferDto,
    actor: SwapActor,
    idempotencyKey?: string,
  ): Promise<SwapOffer> {
    const buyerShopId = this.assertShopId(actor);
    const validKey = this.assertIdempotencyKey(idempotencyKey);

    const existing = await this.dataSource
      .getRepository(SwapOffer)
      .findOne({ where: { buyerShopId, idempotencyKey: validKey } });

    if (existing) {
      if (existing.listingId !== dto.listingId) {
        throw IdempotencyConflictProblem(
          'Idempotency-Key was already used for an offer on a different listing',
        );
      }
      return existing;
    }

    // Anti-spam sliding window: 20 offers/hour per buyer shop
    if (this.rateLimiter) {
      try {
        const limitResult = await this.rateLimiter.consumeSlidingWindow(
          `rl:swap:offer:${buyerShopId}`,
          OFFER_RATE_LIMIT_PER_HOUR,
          OFFER_RATE_WINDOW_SECONDS,
        );
        if (!limitResult.allowed) {
          throw new DomainProblemException(
            'rate-limit-exceeded',
            'Too Many Requests',
            HttpStatus.TOO_MANY_REQUESTS,
            `Offer rate limit exceeded (max ${OFFER_RATE_LIMIT_PER_HOUR} offers/hour). Retry in ${limitResult.retryAfterSeconds}s.`,
            { retryAfterSeconds: limitResult.retryAfterSeconds },
          );
        }
      } catch (err) {
        if (err instanceof DomainProblemException) throw err;
        this.logger.warn(
          { buyerShopId, err: (err as Error).message },
          'Redis offer rate-limiter unavailable; proceeding with PostgreSQL guards',
        );
      }
    }

    const listing = await this.dataSource
      .getRepository(SwapListing)
      .findOne({ where: { id: dto.listingId } });

    if (!listing) {
      throw new NotFoundException(`Listing ${dto.listingId} not found`);
    }
    if (listing.status !== 'OPEN' || listing.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException('This surplus listing is no longer open for offers');
    }
    if (listing.shopId === buyerShopId) {
      throw new BadRequestException('You cannot submit a swap offer on your own listing');
    }
    if (dto.qty > listing.qty) {
      throw new BadRequestException(
        `Requested quantity (${dto.qty}) exceeds listing quantity (${listing.qty})`,
      );
    }

    // Strict same-state GST verification
    const buyerGeo = await this.dataSource
      .getRepository(ShopGeoReadModel)
      .findOne({ where: { shopId: buyerShopId } });

    if (!buyerGeo || buyerGeo.state !== listing.state) {
      throw new ForbiddenException(
        'Cross-state peer swaps are disabled; both shops must be in the same state',
      );
    }

    const ttlHours = dto.ttlHours ?? DEFAULT_OFFER_TTL_HOURS;
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);

    const offerRepo = this.dataSource.getRepository(SwapOffer);
    const offer = offerRepo.create({
      listingId: listing.id,
      sellerShopId: listing.shopId,
      buyerShopId,
      qty: dto.qty,
      offeredPrice: dto.offeredPrice.toFixed(2),
      status: 'PENDING',
      expiresAt,
      idempotencyKey: validKey,
    });

    return offerRepo.save(offer);
  }

  /** Lists offers where the authenticated shop is either the seller or the buyer. */
  async getMyOffers(actor: SwapActor): Promise<SwapOffer[]> {
    const shopId = this.assertShopId(actor);
    return this.dataSource.getRepository(SwapOffer).find({
      where: [{ sellerShopId: shopId }, { buyerShopId: shopId }],
      order: { createdAt: 'DESC' },
    });
  }

  /** Seller counters a PENDING offer with an updated unit price/qty. */
  async counterOffer(offerId: string, dto: CounterOfferDto, actor: SwapActor): Promise<SwapOffer> {
    const shopId = this.assertShopId(actor);
    const offerRepo = this.dataSource.getRepository(SwapOffer);
    const offer = await offerRepo.findOne({ where: { id: offerId } });

    if (!offer) {
      throw new NotFoundException(`Offer ${offerId} not found`);
    }
    if (offer.sellerShopId !== shopId && actor.role !== 'admin') {
      throw new ForbiddenException('Only the listing seller can counter a pending offer');
    }
    if (offer.status !== 'PENDING') {
      throw new ConflictException(`Cannot counter offer in status ${offer.status}`);
    }

    offer.offeredPrice = dto.offeredPrice.toFixed(2);
    if (dto.qty !== undefined) {
      offer.qty = dto.qty;
    }
    offer.status = 'COUNTERED';
    return offerRepo.save(offer);
  }

  /**
   * Accepts an offer atomically:
   * - Seller accepts PENDING offer; Buyer accepts COUNTERED offer.
   * - Locks listing (`pessimistic_write`), moves listing to `RESERVED`, offer to `ACCEPTED`.
   * - Rejects competing PENDING/COUNTERED offers on the same listing.
   * - Emits `swap.offer.accepted.v1` via outbox_events (triggers saga-orchestrator in Slice 9.4).
   */
  async acceptOffer(offerId: string, actor: SwapActor, correlationId?: string): Promise<SwapOffer> {
    const shopId = this.assertShopId(actor);
    const validCorrelationId = this.normalizeCorrelationId(correlationId);

    return this.dataSource.transaction(async (manager) => {
      const offer = await manager.findOne(SwapOffer, {
        where: { id: offerId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!offer) {
        throw new NotFoundException(`Offer ${offerId} not found`);
      }

      // Idempotent accept if already accepted by authorized participant
      if (offer.status === 'ACCEPTED') {
        if (
          offer.sellerShopId === shopId ||
          offer.buyerShopId === shopId ||
          actor.role === 'admin'
        ) {
          return offer;
        }
        throw new ForbiddenException('Not authorized to access this offer');
      }

      if (offer.status === 'PENDING' && offer.sellerShopId !== shopId && actor.role !== 'admin') {
        throw new ForbiddenException('Only the seller can accept a pending offer');
      }
      if (offer.status === 'COUNTERED' && offer.buyerShopId !== shopId && actor.role !== 'admin') {
        throw new ForbiddenException('Only the buyer can accept a counter-offer');
      }
      if (offer.status !== 'PENDING' && offer.status !== 'COUNTERED') {
        throw new ConflictException(
          `Offer ${offerId} cannot be accepted from status ${offer.status}`,
        );
      }
      if (offer.expiresAt.getTime() <= Date.now()) {
        offer.status = 'EXPIRED';
        await manager.save(SwapOffer, offer);
        throw new ConflictException('This offer has expired');
      }

      const listing = await manager.findOne(SwapListing, {
        where: { id: offer.listingId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!listing || listing.status !== 'OPEN') {
        throw new ConflictException('Listing is no longer available for acceptance');
      }

      listing.status = 'RESERVED';
      offer.status = 'ACCEPTED';

      await manager.save(SwapListing, listing);
      const savedOffer = await manager.save(SwapOffer, offer);

      // Reject competing open offers for the same listing
      await manager.query(
        `
        UPDATE swap_offers
        SET status = 'REJECTED', updated_at = NOW()
        WHERE listing_id = $1 AND id <> $2 AND status IN ('PENDING', 'COUNTERED')
        `,
        [listing.id, offer.id],
      );

      await manager.save(
        OutboxEvent,
        manager.create(OutboxEvent, {
          aggregateType: 'swap_offer',
          aggregateId: savedOffer.id,
          eventType: 'swap.offer.accepted.v1',
          version: 1,
          correlationId: validCorrelationId,
          producer: 'swap-service',
          payload: {
            offerId: savedOffer.id,
            listingId: listing.id,
            sellerShopId: savedOffer.sellerShopId,
            buyerShopId: savedOffer.buyerShopId,
            batchId: listing.batchId,
            productId: listing.productId,
            qty: savedOffer.qty,
            agreedPrice: Number(savedOffer.offeredPrice),
            costPrice: Number(listing.costPrice),
            expiryDate: listing.batchExpiryDate,
            state: listing.state,
          },
          publishedAt: null,
        }),
      );

      this.logger.info(
        {
          correlationId: validCorrelationId,
          offerId: savedOffer.id,
          listingId: listing.id,
        },
        'Offer accepted; listing RESERVED and swap.offer.accepted.v1 queued',
      );

      return savedOffer;
    });
  }

  /** Rejects a PENDING or COUNTERED offer by either participant. */
  async rejectOffer(offerId: string, actor: SwapActor): Promise<SwapOffer> {
    const shopId = this.assertShopId(actor);
    const repo = this.dataSource.getRepository(SwapOffer);
    const offer = await repo.findOne({ where: { id: offerId } });

    if (!offer) {
      throw new NotFoundException(`Offer ${offerId} not found`);
    }
    if (offer.sellerShopId !== shopId && offer.buyerShopId !== shopId && actor.role !== 'admin') {
      throw new ForbiddenException('Only offer participants can reject an offer');
    }
    if (offer.status !== 'PENDING' && offer.status !== 'COUNTERED') {
      throw new ConflictException(`Cannot reject offer in status ${offer.status}`);
    }

    offer.status = 'REJECTED';
    return repo.save(offer);
  }

  /**
   * Internal state-scoped matching snapshot for the Slice 9.2 Python scipy matching worker.
   * Respects ADR-002 (no cross-service SQL reads into swap_db).
   */
  async getMatchingSnapshot(state: string): Promise<StateMatchingSnapshot> {
    const [listings, shortages, shops] = await Promise.all([
      this.dataSource.getRepository(SwapListing).find({ where: { state, status: 'OPEN' } }),
      this.dataSource.getRepository(ShortageRequest).find({ where: { state, status: 'OPEN' } }),
      this.dataSource.getRepository(ShopGeoReadModel).find({ where: { state } }),
    ]);

    const shopMap = new Map(shops.map((s) => [s.shopId, s]));
    const nowMs = Date.now();

    return {
      state,
      generatedAt: new Date().toISOString(),
      listings: listings
        .filter((l) => l.expiresAt.getTime() > nowMs && shopMap.has(l.shopId))
        .map((l) => {
          const geo = shopMap.get(l.shopId)!;
          return {
            listingId: l.id,
            sellerShopId: l.shopId,
            batchId: l.batchId,
            productId: l.productId,
            qty: l.qty,
            price: Number(l.price),
            costPrice: Number(l.costPrice),
            batchExpiryDate: l.batchExpiryDate,
            lat: Number(geo.lat),
            lng: Number(geo.lng),
            reputationScore: Number(geo.reputationScore),
          };
        }),
      shortages: shortages
        .filter((r) => shopMap.has(r.shopId))
        .map((r) => {
          const geo = shopMap.get(r.shopId)!;
          return {
            shortageId: r.id,
            buyerShopId: r.shopId,
            productId: r.productId,
            reorderQty: r.reorderQty,
            maxUnitPrice: r.maxUnitPrice !== null ? Number(r.maxUnitPrice) : null,
            lat: Number(geo.lat),
            lng: Number(geo.lng),
            swapRadiusKm: Number(geo.swapRadiusKm),
            reputationScore: Number(geo.reputationScore),
          };
        }),
    };
  }
}

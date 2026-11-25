import { Injectable } from '@nestjs/common';
import type { EventSubscription, KiranaEventEnvelope } from '@kirana/common';
import pino from 'pino';
import type { EntityManager } from 'typeorm';
import { ShopGeoReadModel } from './entities/shop-geo.entity';
import { GeoService } from './geo.service';

export const SWAP_EVENTS_QUEUE = 'swap.domain.events';
export const SWAP_EVENTS_CONSUMER = 'swap-domain-consumer';

export const SWAP_EVENT_BINDING_KEYS = [
  'shop.created.v1',
  'shop.moved.v1',
  'forecast.batch.at_risk.v1',
  'forecast.shortage.detected.v1',
  'saga.swap.completed.v1',
  'saga.swap.cancelled.v1',
];

@Injectable()
export class SwapEventConsumer {
  private readonly logger = pino({ name: 'swap-event-consumer' });

  constructor(private readonly geoService: GeoService) {}

  getSubscription(): EventSubscription {
    return {
      queue: SWAP_EVENTS_QUEUE,
      bindingKeys: SWAP_EVENT_BINDING_KEYS,
      consumerName: SWAP_EVENTS_CONSUMER,
      handler: (envelope, manager) => this.handleEvent(envelope, manager),
    };
  }

  async handleEvent(
    envelope: KiranaEventEnvelope<Record<string, unknown>>,
    manager: EntityManager,
  ): Promise<void> {
    const payload = envelope.payload ?? {};

    switch (envelope.type) {
      case 'shop.created.v1':
      case 'shop.moved.v1': {
        const shopId = String(payload.shopId);
        const lat = Number(payload.lat);
        const lng = Number(payload.lng);
        const state = String(payload.state);
        const gstScheme = payload.gstScheme ? String(payload.gstScheme) : 'UNREGISTERED';
        const swapRadiusKm = payload.swapRadiusKm !== undefined ? Number(payload.swapRadiusKm) : 2;

        await manager.query(
          `
          INSERT INTO shop_geo_read_model
            (shop_id, lat, lng, state, gst_scheme, swap_radius_km, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (shop_id) DO UPDATE SET
            lat = EXCLUDED.lat,
            lng = EXCLUDED.lng,
            state = EXCLUDED.state,
            gst_scheme = COALESCE(NULLIF(EXCLUDED.gst_scheme, 'UNREGISTERED'), shop_geo_read_model.gst_scheme),
            updated_at = NOW()
          `,
          [shopId, lat.toFixed(6), lng.toFixed(6), state, gstScheme, swapRadiusKm.toFixed(2)],
        );

        await this.geoService.upsertShopLocation(shopId, lat, lng);
        this.logger.info(
          { correlationId: envelope.correlationId, shopId, state, eventType: envelope.type },
          'Synced shop geo read model and Redis geo:shops',
        );
        return;
      }

      case 'forecast.batch.at_risk.v1': {
        const batchId = String(payload.batchId);
        const shopId = String(payload.shopId);
        const productId = String(payload.productId);
        const riskType = String(payload.riskType || 'EXPIRY');
        const daysOfCover = Number(payload.daysOfCover ?? 0);
        const expectedUnsoldQty = Math.max(1, Number(payload.expectedUnsoldQty ?? 1));
        const recommendedAction = String(
          payload.recommendedAction ?? payload.suggestedAction ?? 'SWAP_TO_NEIGHBOUR',
        );

        await manager.query(
          `
          INSERT INTO risk_listing_drafts
            (batch_id, shop_id, product_id, risk_type, days_of_cover,
             expected_unsold_qty, recommended_action, dismissed, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NOW())
          ON CONFLICT (batch_id) DO UPDATE SET
            risk_type = EXCLUDED.risk_type,
            days_of_cover = EXCLUDED.days_of_cover,
            expected_unsold_qty = EXCLUDED.expected_unsold_qty,
            recommended_action = EXCLUDED.recommended_action,
            updated_at = NOW()
          `,
          [
            batchId,
            shopId,
            productId,
            riskType,
            daysOfCover.toFixed(2),
            expectedUnsoldQty,
            recommendedAction,
          ],
        );
        return;
      }

      case 'forecast.shortage.detected.v1': {
        const shopId = String(payload.shopId);
        const productId = String(payload.productId);
        const reorderQty = Math.max(1, Number(payload.reorderQty ?? 1));
        const maxUnitPrice =
          payload.maxUnitPrice !== undefined && payload.maxUnitPrice !== null
            ? Number(payload.maxUnitPrice).toFixed(2)
            : null;

        const shopGeo = await manager.findOne(ShopGeoReadModel, { where: { shopId } });
        const state = shopGeo?.state ?? (payload.state ? String(payload.state) : null);
        if (!state) {
          this.logger.warn(
            { correlationId: envelope.correlationId, shopId, productId },
            'Skipping shortage request: shop state not yet present in shop_geo_read_model',
          );
          return;
        }

        await manager.query(
          `
          INSERT INTO shortage_requests
            (shop_id, product_id, state, reorder_qty, max_unit_price, status, created_at)
          VALUES ($1, $2, $3, $4, $5, 'OPEN', NOW())
          ON CONFLICT (shop_id, product_id) WHERE status = 'OPEN' DO UPDATE SET
            reorder_qty = EXCLUDED.reorder_qty,
            max_unit_price = COALESCE(EXCLUDED.max_unit_price, shortage_requests.max_unit_price),
            state = EXCLUDED.state
          `,
          [shopId, productId, state, reorderQty, maxUnitPrice],
        );
        return;
      }

      case 'saga.swap.completed.v1': {
        const listingId = String(payload.listingId);
        await manager.query(
          `
          UPDATE swap_listings
          SET status = 'COMPLETED', updated_at = NOW()
          WHERE id = $1
          `,
          [listingId],
        );
        return;
      }

      case 'saga.swap.cancelled.v1': {
        const listingId = String(payload.listingId);
        await manager.query(
          `
          UPDATE swap_listings
          SET status = CASE WHEN expires_at > NOW() THEN 'OPEN' ELSE 'EXPIRED' END,
              updated_at = NOW()
          WHERE id = $1 AND status = 'RESERVED'
          `,
          [listingId],
        );
        return;
      }

      default:
        this.logger.debug({ eventType: envelope.type }, 'Ignoring unhandled event type');
    }
  }
}

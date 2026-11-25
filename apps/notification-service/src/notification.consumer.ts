import { Injectable } from '@nestjs/common';
import type { EventSubscription, KiranaEventEnvelope } from '@kirana/common';
import pino from 'pino';
import type { EntityManager } from 'typeorm';
import { NotificationService } from './notification.service';

export const NOTIFY_EVENTS_QUEUE = 'notify.domain.events';
export const NOTIFY_EVENTS_CONSUMER = 'notification-domain-consumer';

export const NOTIFY_BINDING_KEYS = [
  'forecast.batch.at_risk.v1',
  'forecast.shortage.detected.v1',
  'swap.match.found.v1',
  'swap.offer.accepted.v1',
  'saga.handover.ready.v1',
  'saga.swap.completed.v1',
  'saga.swap.cancelled.v1',
  'groupbuy.window.closed.v1',
];

@Injectable()
export class NotificationEventConsumer {
  private readonly logger = pino({ name: 'notification-event-consumer' });

  constructor(private readonly notificationService: NotificationService) {}

  getSubscription(): EventSubscription {
    return {
      queue: NOTIFY_EVENTS_QUEUE,
      bindingKeys: NOTIFY_BINDING_KEYS,
      consumerName: NOTIFY_EVENTS_CONSUMER,
      handler: (envelope, manager) => this.handleEvent(envelope, manager),
    };
  }

  async handleEvent(
    envelope: KiranaEventEnvelope<Record<string, unknown>>,
    manager: EntityManager,
  ): Promise<void> {
    const p = envelope.payload ?? {};

    switch (envelope.type) {
      case 'forecast.batch.at_risk.v1': {
        const shopId = String(p.shopId);
        const riskType = String(p.riskType || 'EXPIRY');
        const unsold = Number(p.expectedUnsoldQty ?? 0);
        await this.notificationService.dispatchAlert(
          {
            shopId,
            type: envelope.type,
            title: riskType === 'EXPIRY' ? 'Batch nearing expiry' : 'Slow-moving stock alert',
            body: `Batch ${String(p.batchId).slice(0, 8)} has ~${unsold} units at risk. Recommended: ${String(p.recommendedAction ?? p.suggestedAction ?? 'SWAP_TO_NEIGHBOUR')}.`,
            priority: 'BATCHABLE',
            data: p,
            correlationId: envelope.correlationId,
          },
          manager,
        );
        return;
      }

      case 'forecast.shortage.detected.v1': {
        const shopId = String(p.shopId);
        await this.notificationService.dispatchAlert(
          {
            shopId,
            type: envelope.type,
            title: 'Weekly stock shortage predicted',
            body: `Reorder ${Number(p.reorderQty ?? 0)} units for SKU ${String(p.productId).slice(0, 8)} to prevent stockout.`,
            priority: 'BATCHABLE',
            data: p,
            correlationId: envelope.correlationId,
          },
          manager,
        );
        return;
      }

      case 'swap.match.found.v1': {
        const candidateShopId = String(p.candidateShopId);
        await this.notificationService.dispatchAlert(
          {
            shopId: candidateShopId,
            type: envelope.type,
            title: 'Nearby surplus match found',
            body: `An anonymised shop ${Number(p.distanceKm ?? 0).toFixed(1)} km away listed matching stock at INR ${Number(p.offeredPrice ?? 0).toFixed(2)}/unit.`,
            priority: 'BATCHABLE',
            data: p,
            correlationId: envelope.correlationId,
          },
          manager,
        );
        return;
      }

      case 'swap.offer.accepted.v1': {
        const targets = [
          { shopId: String(p.sellerShopId), role: 'seller' },
          { shopId: String(p.buyerShopId), role: 'buyer' },
        ];
        for (const t of targets) {
          await this.notificationService.dispatchAlert(
            {
              shopId: t.shopId,
              type: envelope.type,
              title: 'Swap offer accepted',
              body: `Offer for ${Number(p.qty ?? 0)} units at INR ${Number(p.agreedPrice ?? 0).toFixed(2)}/unit was accepted. Reserving stock now.`,
              priority: 'URGENT',
              data: { ...p, role: t.role },
              correlationId: envelope.correlationId,
            },
            manager,
          );
        }
        return;
      }

      case 'saga.handover.ready.v1': {
        await this.notificationService.dispatchAlert(
          {
            shopId: String(p.sellerShopId),
            type: envelope.type,
            title: 'Swap handover PIN ready',
            body: `Stock is reserved. Share handover PIN ${String(p.handoverCode ?? '')} with the buyer at pickup.`,
            priority: 'URGENT',
            data: p,
            correlationId: envelope.correlationId,
          },
          manager,
        );
        await this.notificationService.dispatchAlert(
          {
            shopId: String(p.buyerShopId),
            type: envelope.type,
            title: 'Swap stock reserved — ready for pickup',
            body: 'Seller stock is reserved. Collect the items and confirm the 6-digit PIN from the seller.',
            priority: 'URGENT',
            data: {
              transactionId: p.transactionId,
              listingId: p.listingId,
              handoverExpiresAt: p.handoverExpiresAt,
            },
            correlationId: envelope.correlationId,
          },
          manager,
        );
        return;
      }

      case 'saga.swap.completed.v1': {
        for (const shopId of [String(p.sellerShopId), String(p.buyerShopId)]) {
          await this.notificationService.dispatchAlert(
            {
              shopId,
              type: envelope.type,
              title: 'Swap completed — invoice ready',
              body: `Swap transfer of ${Number(p.qty ?? 0)} units is complete. Your GST swap invoice PDF is ready to download.`,
              priority: 'URGENT',
              data: p,
              correlationId: envelope.correlationId,
            },
            manager,
          );
        }
        return;
      }

      case 'saga.swap.cancelled.v1': {
        for (const shopId of [String(p.sellerShopId), String(p.buyerShopId)]) {
          await this.notificationService.dispatchAlert(
            {
              shopId,
              type: envelope.type,
              title: 'Swap cancelled & stock released',
              body: `Swap transaction was cancelled (${String(p.reason ?? 'COMPENSATION')}). Any reserved stock has been released.`,
              priority: 'URGENT',
              data: p,
              correlationId: envelope.correlationId,
            },
            manager,
          );
        }
        return;
      }

      case 'groupbuy.window.closed.v1': {
        const outcome = String(p.outcome || 'ALLOCATING');
        const allocations = Array.isArray(p.allocations)
          ? (p.allocations as Array<{ shopId: string; landedCost?: number; qty?: number }>)
          : [];
        const uniqueShops = [...new Set(allocations.map((a) => String(a.shopId)))];

        for (const shopId of uniqueShops) {
          await this.notificationService.dispatchAlert(
            {
              shopId,
              type: envelope.type,
              title: `Group-buy window ${outcome.toLowerCase()}`,
              body: `Distributor ${String(p.distributorId ?? '')} window closed with status ${outcome}. Total pooled value: INR ${Number(p.totalValue ?? 0).toFixed(2)}.`,
              priority: 'URGENT',
              data: { windowId: p.windowId, outcome, totalValue: p.totalValue },
              correlationId: envelope.correlationId,
            },
            manager,
          );
        }
        return;
      }

      default:
        this.logger.debug({ eventType: envelope.type }, 'Ignoring unhandled notification event');
    }
  }
}

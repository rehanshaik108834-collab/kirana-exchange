import { Injectable } from '@nestjs/common';
import type { EventSubscription, KiranaEventEnvelope } from '@kirana/common';
import pino from 'pino';
import type { EntityManager } from 'typeorm';

export const SHOP_REPUTATION_QUEUE = 'shop.reputation.events';
export const SHOP_REPUTATION_CONSUMER = 'shop-reputation-consumer';

export const COMPLETED_BONUS_POINTS = 2.0;
export const BUYER_NOSHOW_PENALTY_POINTS = -10.0;

@Injectable()
export class ReputationEventConsumer {
  private readonly logger = pino({ name: 'shop-reputation-consumer' });

  getSubscription(): EventSubscription {
    return {
      queue: SHOP_REPUTATION_QUEUE,
      bindingKeys: ['saga.swap.completed.v1', 'saga.swap.cancelled.v1'],
      consumerName: SHOP_REPUTATION_CONSUMER,
      handler: (envelope, manager) => this.handleEvent(envelope, manager),
    };
  }

  private async adjustReputation(
    manager: EntityManager,
    shopId: string,
    delta: number,
  ): Promise<void> {
    await manager.query(
      `
      UPDATE shops
      SET reputation_score = LEAST(100.00, GREATEST(0.00, reputation_score + $1::numeric)),
          updated_at = NOW()
      WHERE id = $2
      `,
      [delta.toFixed(2), shopId],
    );
  }

  async handleEvent(
    envelope: KiranaEventEnvelope<Record<string, unknown>>,
    manager: EntityManager,
  ): Promise<void> {
    const payload = envelope.payload ?? {};

    if (envelope.type === 'saga.swap.completed.v1') {
      const sellerShopId = payload.sellerShopId ? String(payload.sellerShopId) : null;
      const buyerShopId = payload.buyerShopId ? String(payload.buyerShopId) : null;

      if (sellerShopId) {
        await this.adjustReputation(manager, sellerShopId, COMPLETED_BONUS_POINTS);
      }
      if (buyerShopId && buyerShopId !== sellerShopId) {
        await this.adjustReputation(manager, buyerShopId, COMPLETED_BONUS_POINTS);
      }

      this.logger.info(
        { correlationId: envelope.correlationId, sellerShopId, buyerShopId },
        'Applied +2.00 swap completion reputation bonus',
      );
      return;
    }

    if (envelope.type === 'saga.swap.cancelled.v1') {
      const reason = String(payload.reason ?? '');
      const buyerShopId = payload.buyerShopId ? String(payload.buyerShopId) : null;

      // Apply no-show reputation penalty strictly on buyer handover timeout
      if (buyerShopId && (reason === 'BUYER_TIMEOUT' || reason === 'NO_SHOW')) {
        await this.adjustReputation(manager, buyerShopId, BUYER_NOSHOW_PENALTY_POINTS);
        this.logger.info(
          { correlationId: envelope.correlationId, buyerShopId, reason },
          'Applied -10.00 buyer no-show reputation penalty',
        );
      }
    }
  }
}

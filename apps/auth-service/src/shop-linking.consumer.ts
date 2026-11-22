import type { EventSubscription } from '@kirana/common';
import pino from 'pino';

const logger = pino({ name: 'auth-shop-linking' });

interface ShopCreatedPayload {
  shopId: string;
  ownerId?: string;
}

/**
 * shop.created.v1 -> users.shop_id
 *
 * auth_db never reads shop_db (ADR-002); it learns the owner's shop from the event instead.
 *
 * How this works:
 * - The handler runs inside the same transaction as the processed_messages insert, so the link
 *   and its dedup record commit together. A redelivered event is skipped, and a crash before
 *   COMMIT leaves neither row behind.
 * - `shop_id IS NULL` makes the update idempotent at the data level too, and never overwrites an
 *   existing link.
 * - The user's next /auth/refresh re-reads users, so the new access token carries shopId.
 */
export const shopLinkingSubscription: EventSubscription<ShopCreatedPayload> = {
  queue: 'auth.shop-linking',
  bindingKeys: ['shop.created.v1'],
  consumerName: 'auth-shop-linking',
  handler: async (envelope, manager) => {
    const { shopId, ownerId } = envelope.payload;
    if (!ownerId || !shopId) {
      logger.warn(
        { correlationId: envelope.correlationId, messageId: envelope.id },
        'shop.created.v1 without ownerId/shopId; nothing to link',
      );
      return;
    }
    await manager.query(
      `UPDATE users SET shop_id = $1, updated_at = NOW() WHERE id = $2 AND shop_id IS NULL`,
      [shopId, ownerId],
    );
    logger.info(
      { correlationId: envelope.correlationId, shopId, userId: ownerId },
      'Linked user to shop',
    );
  },
};

import { Injectable } from '@nestjs/common';
import {
  KIRANA_SAGA_COMMANDS_EXCHANGE,
  type EventSubscription,
  type KiranaEventEnvelope,
} from '@kirana/common';
import pino from 'pino';
import type { EntityManager } from 'typeorm';
import { SagaInventoryService } from './saga-inventory.service';

export const INVENTORY_SAGA_COMMANDS_QUEUE = 'inventory.saga.commands';
export const INVENTORY_SAGA_CONSUMER = 'inventory-saga-consumer';

export const CMD_RESERVE_STOCK = 'inventory.cmd.reserve_stock.v1';
export const CMD_RELEASE_STOCK = 'inventory.cmd.release_stock.v1';
export const CMD_COMMIT_TRANSFER = 'inventory.cmd.commit_transfer.v1';

export const INVENTORY_SAGA_BINDING_KEYS = [
  CMD_RESERVE_STOCK,
  CMD_RELEASE_STOCK,
  CMD_COMMIT_TRANSFER,
];

@Injectable()
export class InventorySagaConsumer {
  private readonly logger = pino({ name: 'inventory-saga-consumer' });

  constructor(private readonly sagaInventory: SagaInventoryService) {}

  getSubscription(): EventSubscription {
    return {
      queue: INVENTORY_SAGA_COMMANDS_QUEUE,
      bindingKeys: INVENTORY_SAGA_BINDING_KEYS,
      sourceExchange: KIRANA_SAGA_COMMANDS_EXCHANGE,
      consumerName: INVENTORY_SAGA_CONSUMER,
      handler: (envelope, manager) => this.handleCommand(envelope, manager),
    };
  }

  async handleCommand(
    envelope: KiranaEventEnvelope<Record<string, unknown>>,
    manager: EntityManager,
  ): Promise<void> {
    const payload = envelope.payload ?? {};

    switch (envelope.type) {
      case CMD_RESERVE_STOCK:
      case 'ReserveStockCmd': {
        await this.sagaInventory.handleReserveStockCommand(
          {
            transactionId: String(payload.transactionId),
            batchId: String(payload.batchId),
            sellerShopId: String(payload.sellerShopId ?? payload.shopId),
            qty: Number(payload.qty),
            expectedVersion:
              payload.expectedVersion !== undefined ? Number(payload.expectedVersion) : undefined,
          },
          envelope.correlationId,
          manager,
        );
        return;
      }

      case CMD_RELEASE_STOCK:
      case 'ReleaseStockCmd': {
        await this.sagaInventory.handleReleaseStockCommand(
          {
            transactionId: String(payload.transactionId),
            batchId: String(payload.batchId),
            sellerShopId: String(payload.sellerShopId ?? payload.shopId),
            qty: Number(payload.qty),
          },
          envelope.correlationId,
          manager,
        );
        return;
      }

      case CMD_COMMIT_TRANSFER:
      case 'CommitTransferCmd': {
        await this.sagaInventory.handleCommitTransferCommand(
          {
            transactionId: String(payload.transactionId),
            sellerBatchId: String(payload.sellerBatchId ?? payload.batchId),
            sellerShopId: String(payload.sellerShopId),
            buyerShopId: String(payload.buyerShopId),
            productId: String(payload.productId),
            qty: Number(payload.qty),
            costPrice: payload.costPrice !== undefined ? Number(payload.costPrice) : undefined,
            expiryDate: payload.expiryDate ? String(payload.expiryDate) : undefined,
          },
          envelope.correlationId,
          manager,
        );
        return;
      }

      default:
        this.logger.warn(
          { type: envelope.type, correlationId: envelope.correlationId },
          'Ignoring unrecognized saga command type',
        );
    }
  }
}

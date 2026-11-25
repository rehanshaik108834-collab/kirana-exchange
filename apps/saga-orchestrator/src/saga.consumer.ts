import { Injectable } from '@nestjs/common';
import type { EventSubscription, KiranaEventEnvelope } from '@kirana/common';
import pino from 'pino';
import type { EntityManager } from 'typeorm';
import {
  EVT_OFFER_ACCEPTED,
  EVT_STOCK_RELEASED,
  EVT_STOCK_RESERVE_FAILED,
  EVT_STOCK_RESERVED,
  EVT_TIMEOUT_COMMIT,
  EVT_TIMEOUT_HANDOVER,
  EVT_TIMEOUT_RESERVE,
  EVT_TRANSFER_COMMITTED,
  EVT_TRANSFER_FAILED,
  SAGA_CONSUMER_NAME,
  SAGA_EVENT_BINDING_KEYS,
  SAGA_EVENTS_QUEUE,
} from './saga.constants';
import { type OfferAcceptedPayload, SagaService } from './saga.service';

@Injectable()
export class SagaEventConsumer {
  private readonly logger = pino({ name: 'saga-event-consumer' });

  constructor(private readonly sagaService: SagaService) {}

  getSubscription(): EventSubscription {
    return {
      queue: SAGA_EVENTS_QUEUE,
      bindingKeys: SAGA_EVENT_BINDING_KEYS,
      consumerName: SAGA_CONSUMER_NAME,
      handler: (envelope, manager) => this.handleEvent(envelope, manager),
    };
  }

  async handleEvent(
    envelope: KiranaEventEnvelope<Record<string, unknown>>,
    manager: EntityManager,
  ): Promise<void> {
    const payload = envelope.payload ?? {};

    switch (envelope.type) {
      case EVT_OFFER_ACCEPTED:
        await this.sagaService.startFromOfferAccepted(
          payload as unknown as OfferAcceptedPayload,
          envelope.correlationId,
          manager,
        );
        return;

      case EVT_STOCK_RESERVED:
        await this.sagaService.handleStockReserved(
          {
            transactionId: String(payload.transactionId),
            batchId: String(payload.batchId),
            reservedQty: Number(payload.reservedQty ?? 0),
          },
          envelope.correlationId,
          manager,
        );
        return;

      case EVT_STOCK_RESERVE_FAILED:
        await this.sagaService.handleStockReservationFailed(
          {
            transactionId: String(payload.transactionId),
            reason: payload.reason ? String(payload.reason) : undefined,
          },
          envelope.correlationId,
          manager,
        );
        return;

      case EVT_STOCK_RELEASED:
        await this.sagaService.handleStockReleased(
          {
            transactionId: String(payload.transactionId),
            releasedQty: Number(payload.releasedQty ?? 0),
          },
          envelope.correlationId,
          manager,
        );
        return;

      case EVT_TRANSFER_COMMITTED:
        await this.sagaService.handleTransferCommitted(
          {
            transactionId: String(payload.transactionId),
            buyerBatchId: payload.buyerBatchId ? String(payload.buyerBatchId) : undefined,
          },
          envelope.correlationId,
          manager,
        );
        return;

      case EVT_TRANSFER_FAILED:
        await this.sagaService.handleTransferFailed(
          {
            transactionId: String(payload.transactionId),
            reason: payload.reason ? String(payload.reason) : undefined,
          },
          envelope.correlationId,
          manager,
        );
        return;

      case EVT_TIMEOUT_RESERVE:
      case EVT_TIMEOUT_HANDOVER:
      case EVT_TIMEOUT_COMMIT:
        await this.sagaService.handleTimeout(
          envelope.type,
          { transactionId: String(payload.transactionId) },
          envelope.correlationId,
          manager,
        );
        return;

      default:
        this.logger.debug({ eventType: envelope.type }, 'Ignoring unhandled saga event');
    }
  }
}

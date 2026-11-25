import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { REDIS_CLIENT } from '@kirana/common';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import type Redis from 'ioredis';
import pino from 'pino';
import { DataSource, type EntityManager } from 'typeorm';
import { v4 as uuidv4, validate as isUuid } from 'uuid';
import { OutboxEvent } from './entities/outbox-event.entity';
import { SwapEvent } from './entities/swap-event.entity';
import {
  DEFAULT_TAX_DISCLAIMER,
  type SwapSagaState,
  SwapTransaction,
} from './entities/swap-transaction.entity';
import { GeneratedSwapInvoice, InvoiceService } from './invoice.service';
import {
  CMD_COMMIT_TRANSFER,
  CMD_RELEASE_STOCK,
  CMD_RESERVE_STOCK,
  EVT_HANDOVER_CONFIRMED,
  EVT_HANDOVER_READY,
  EVT_SWAP_CANCELLED,
  EVT_SWAP_COMPLETED,
  EVT_TIMEOUT_COMMIT,
  EVT_TIMEOUT_HANDOVER,
  EVT_TIMEOUT_RESERVE,
  HANDOVER_TIMEOUT_MS,
  PIN_CACHE_PREFIX,
  SSE_SWAP_CHANNEL_PREFIX,
} from './saga.constants';

export interface SagaActor {
  userId: string;
  role: string;
  shopId?: string;
}

export interface OfferAcceptedPayload {
  offerId: string;
  listingId: string;
  sellerShopId: string;
  buyerShopId: string;
  batchId: string;
  productId: string;
  qty: number;
  agreedPrice: number;
  costPrice?: number;
  expiryDate?: string;
  state?: string;
}

export interface SagaDetailResponse {
  transaction: SwapTransaction;
  events: SwapEvent[];
  /** Exposed transiently ONLY to the seller while AWAITING_HANDOVER (never stored plaintext in PG). */
  handoverCode?: string;
}

export function hashHandoverCode(transactionId: string, code: string): string {
  return createHash('sha256').update(`${transactionId}:${code}`).digest('hex');
}

export function verifyHandoverCode(
  transactionId: string,
  candidateCode: string,
  expectedHash: string,
): boolean {
  const actualHex = hashHandoverCode(transactionId, candidateCode);
  const actualBuf = Buffer.from(actualHex, 'hex');
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

function normalizeUuid(val?: string): string {
  return val && isUuid(val) ? val : uuidv4();
}

@Injectable()
export class SagaService {
  private readonly logger = pino({ name: 'saga-orchestrator' });

  constructor(
    private readonly dataSource: DataSource,
    private readonly invoiceService: InvoiceService,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  private async publishSseUpdate(tx: SwapTransaction, note?: string): Promise<void> {
    if (!this.redis) return;
    const message = JSON.stringify({
      transactionId: tx.id,
      listingId: tx.listingId,
      state: tx.state,
      version: tx.version,
      sellerConfirmedAt: tx.sellerConfirmedAt,
      buyerConfirmedAt: tx.buyerConfirmedAt,
      billRecordId: tx.billRecordId,
      cancelReason: tx.cancelReason,
      note: note ?? null,
      updatedAt: new Date().toISOString(),
    });
    try {
      await this.redis.publish(`${SSE_SWAP_CHANNEL_PREFIX}${tx.id}`, message);
    } catch (err) {
      this.logger.warn(
        { txId: tx.id, err: (err as Error).message },
        'Failed to publish Redis SSE swap update',
      );
    }
  }

  private async cacheEphemeralPin(txId: string, pin: string): Promise<void> {
    if (!this.redis) return;
    const ttlSec = Math.max(60, Math.ceil(HANDOVER_TIMEOUT_MS / 1000));
    try {
      await this.redis.set(`${PIN_CACHE_PREFIX}${txId}`, pin, 'EX', ttlSec);
    } catch (err) {
      this.logger.warn({ txId, err: (err as Error).message }, 'Failed to cache ephemeral PIN');
    }
  }

  private async clearEphemeralPin(txId: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(`${PIN_CACHE_PREFIX}${txId}`);
    } catch {
      // Best-effort cleanup
    }
  }

  private async appendAudit(
    manager: EntityManager,
    transactionId: string,
    step: string,
    status: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await manager.save(
      SwapEvent,
      manager.create(SwapEvent, {
        transactionId,
        step,
        status,
        payload,
      }),
    );
  }

  private async enqueueOutbox(
    manager: EntityManager,
    params: {
      aggregateId: string;
      eventType: string;
      correlationId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await manager.save(
      OutboxEvent,
      manager.create(OutboxEvent, {
        aggregateType: 'swap_transaction',
        aggregateId: params.aggregateId,
        eventType: params.eventType,
        version: 1,
        correlationId: params.correlationId,
        producer: 'saga-orchestrator',
        payload: params.payload,
        publishedAt: null,
      }),
    );
  }

  /**
   * Step 1: Consumes `swap.offer.accepted.v1`.
   * Persists INITIATED -> RESERVING_STOCK and atomically queues `ReserveStockCmd` + 30s timeout.
   */
  async startFromOfferAccepted(
    payload: OfferAcceptedPayload,
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SwapTransaction> {
    const validCorr = normalizeUuid(correlationId);

    const runInTx = async (manager: EntityManager): Promise<SwapTransaction> => {
      const existing = await manager.findOne(SwapTransaction, {
        where: { offerId: payload.offerId },
      });
      if (existing) {
        return existing;
      }

      const tx = manager.create(SwapTransaction, {
        offerId: payload.offerId,
        listingId: payload.listingId,
        sellerShopId: payload.sellerShopId,
        buyerShopId: payload.buyerShopId,
        batchId: payload.batchId,
        productId: payload.productId,
        shopState: payload.state ?? 'Unknown',
        qty: payload.qty,
        price: Number(payload.agreedPrice).toFixed(2),
        costPrice: Number(payload.costPrice ?? payload.agreedPrice).toFixed(2),
        expiryDate: (
          payload.expiryDate ?? new Date(Date.now() + 30 * 86_400_000).toISOString()
        ).slice(0, 10),
        state: 'RESERVING_STOCK',
        handoverCodeHash: null,
        handoverExpiresAt: null,
        sellerConfirmedAt: null,
        buyerConfirmedAt: null,
        billRecordId: null,
        taxDisclaimer: DEFAULT_TAX_DISCLAIMER,
        cancelReason: null,
        idempotencyKey: payload.offerId,
        version: 1,
      });

      const saved = await manager.save(SwapTransaction, tx);

      await this.appendAudit(manager, saved.id, 'INITIATED', 'OK', { offerId: payload.offerId });
      await this.appendAudit(manager, saved.id, 'RESERVING_STOCK', 'DISPATCHED', {
        batchId: saved.batchId,
        qty: saved.qty,
      });

      await this.enqueueOutbox(manager, {
        aggregateId: saved.id,
        eventType: CMD_RESERVE_STOCK,
        correlationId: validCorr,
        payload: {
          transactionId: saved.id,
          batchId: saved.batchId,
          sellerShopId: saved.sellerShopId,
          qty: saved.qty,
        },
      });

      await this.enqueueOutbox(manager, {
        aggregateId: saved.id,
        eventType: EVT_TIMEOUT_RESERVE,
        correlationId: validCorr,
        payload: { transactionId: saved.id, expectedState: 'RESERVING_STOCK' },
      });

      return saved;
    };

    const saved = existingManager
      ? await runInTx(existingManager)
      : await this.dataSource.transaction(runInTx);
    await this.publishSseUpdate(saved, 'Reserving seller stock');
    return saved;
  }

  /**
   * Step 2a: Consumes `inventory.stock.reserved.v1`.
   * Advances RESERVING_STOCK -> AWAITING_HANDOVER with salted SHA-256 PIN + 24h TTL timer.
   * SAFETY INVARIANT: If the saga already timed out / entered COMPENSATING before this reply
   * arrived, immediately re-emits `ReleaseStockCmd` so zero stock is ever leaked.
   */
  async handleStockReserved(
    payload: { transactionId: string; batchId: string; reservedQty: number },
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<{ tx: SwapTransaction | null; handoverCode?: string }> {
    const validCorr = normalizeUuid(correlationId);
    let generatedPin: string | undefined;

    const runInTx = async (manager: EntityManager): Promise<SwapTransaction | null> => {
      const tx = await manager.findOne(SwapTransaction, {
        where: { id: payload.transactionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!tx) return null;

      // Late arrival after timeout/cancellation -> compensate immediately to avoid stock leak
      if (tx.state === 'COMPENSATING' || tx.state === 'CANCELLED_COMPENSATED') {
        await this.appendAudit(manager, tx.id, 'LATE_STOCK_RESERVED', 'RELEASING', payload);
        await this.enqueueOutbox(manager, {
          aggregateId: tx.id,
          eventType: CMD_RELEASE_STOCK,
          correlationId: validCorr,
          payload: {
            transactionId: tx.id,
            batchId: tx.batchId,
            sellerShopId: tx.sellerShopId,
            qty: tx.qty,
          },
        });
        return tx;
      }

      if (tx.state !== 'RESERVING_STOCK') {
        return tx;
      }

      const pin = String(randomInt(100_000, 1_000_000));
      generatedPin = pin;
      const expiresAt = new Date(Date.now() + HANDOVER_TIMEOUT_MS);

      tx.state = 'AWAITING_HANDOVER';
      tx.handoverCodeHash = hashHandoverCode(tx.id, pin);
      tx.handoverExpiresAt = expiresAt;
      tx.version += 1;

      const updated = await manager.save(SwapTransaction, tx);

      await this.appendAudit(manager, updated.id, 'AWAITING_HANDOVER', 'STOCK_RESERVED', {
        batchId: payload.batchId,
        reservedQty: payload.reservedQty,
        handoverExpiresAt: expiresAt.toISOString(),
      });

      await this.enqueueOutbox(manager, {
        aggregateId: updated.id,
        eventType: EVT_HANDOVER_READY,
        correlationId: validCorr,
        payload: {
          transactionId: updated.id,
          listingId: updated.listingId,
          sellerShopId: updated.sellerShopId,
          buyerShopId: updated.buyerShopId,
          handoverCode: pin,
          handoverExpiresAt: expiresAt.toISOString(),
        },
      });

      await this.enqueueOutbox(manager, {
        aggregateId: updated.id,
        eventType: EVT_TIMEOUT_HANDOVER,
        correlationId: validCorr,
        payload: { transactionId: updated.id, expectedState: 'AWAITING_HANDOVER' },
      });

      return updated;
    };

    const updated = existingManager
      ? await runInTx(existingManager)
      : await this.dataSource.transaction(runInTx);

    if (updated && generatedPin) {
      await this.cacheEphemeralPin(updated.id, generatedPin);
      await this.publishSseUpdate(updated, 'Stock reserved — handover PIN ready');
    }
    return { tx: updated, handoverCode: generatedPin };
  }

  /**
   * Step 2b: Consumes `inventory.stock.reserve_failed.v1`.
   * Aborts cleanly to `FAILED_NO_STOCK` (no stock locked -> no release compensation needed).
   */
  async handleStockReservationFailed(
    payload: { transactionId: string; reason?: string },
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SwapTransaction | null> {
    const validCorr = normalizeUuid(correlationId);

    const runInTx = async (manager: EntityManager): Promise<SwapTransaction | null> => {
      const tx = await manager.findOne(SwapTransaction, {
        where: { id: payload.transactionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!tx || tx.state !== 'RESERVING_STOCK') return tx ?? null;

      tx.state = 'FAILED_NO_STOCK';
      tx.cancelReason = (payload.reason ?? 'INSUFFICIENT_QTY').slice(0, 32);
      tx.version += 1;

      const updated = await manager.save(SwapTransaction, tx);
      await this.appendAudit(manager, updated.id, 'FAILED_NO_STOCK', 'TERMINAL', {
        reason: updated.cancelReason,
      });

      await this.enqueueOutbox(manager, {
        aggregateId: updated.id,
        eventType: EVT_SWAP_CANCELLED,
        correlationId: validCorr,
        payload: {
          transactionId: updated.id,
          listingId: updated.listingId,
          sellerShopId: updated.sellerShopId,
          buyerShopId: updated.buyerShopId,
          reason: updated.cancelReason,
        },
      });

      return updated;
    };

    const updated = existingManager
      ? await runInTx(existingManager)
      : await this.dataSource.transaction(runInTx);
    if (updated) {
      await this.publishSseUpdate(updated, 'Stock reservation failed');
    }
    return updated;
  }

  /**
   * Step 3: Two-sided handover confirmation (`POST /v1/sagas/:id/confirm-handover`).
   * Validates 6-digit PIN against `handover_code_hash` via constant-time comparison.
   * When BOTH seller and buyer have confirmed, transitions to HANDOVER_CONFIRMED -> COMMITTING_TRANSFER
   * and atomically queues `CommitTransferCmd` + 60s commit timeout.
   */
  async confirmHandover(
    txId: string,
    handoverCode: string,
    actor: SagaActor,
    correlationId?: string,
  ): Promise<SwapTransaction> {
    if (!actor.shopId && actor.role !== 'admin') {
      throw new ForbiddenException('Linked shop required to confirm swap handover');
    }
    const validCorr = normalizeUuid(correlationId);
    let bothConfirmed = false;

    const updated = await this.dataSource.transaction(async (manager) => {
      const tx = await manager.findOne(SwapTransaction, {
        where: { id: txId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!tx) {
        throw new NotFoundException(`Swap transaction ${txId} not found`);
      }

      const isSeller = actor.shopId === tx.sellerShopId;
      const isBuyer = actor.shopId === tx.buyerShopId;
      if (!isSeller && !isBuyer) {
        throw new ForbiddenException('Only the seller or buyer shop can confirm handover');
      }

      if (tx.state !== 'AWAITING_HANDOVER') {
        throw new ConflictException(
          `Cannot confirm handover when transaction is in state ${tx.state}`,
        );
      }
      if (tx.handoverExpiresAt && tx.handoverExpiresAt.getTime() <= Date.now()) {
        throw new ConflictException('Handover window has expired');
      }
      if (!tx.handoverCodeHash || !verifyHandoverCode(tx.id, handoverCode, tx.handoverCodeHash)) {
        throw new BadRequestException('Invalid handover PIN code');
      }

      const now = new Date();
      if (isSeller && !tx.sellerConfirmedAt) {
        tx.sellerConfirmedAt = now;
        await this.appendAudit(manager, tx.id, 'SELLER_CONFIRMED', 'OK', {
          shopId: actor.shopId,
        });
      }
      if (isBuyer && !tx.buyerConfirmedAt) {
        tx.buyerConfirmedAt = now;
        await this.appendAudit(manager, tx.id, 'BUYER_CONFIRMED', 'OK', {
          shopId: actor.shopId,
        });
      }

      if (tx.sellerConfirmedAt && tx.buyerConfirmedAt) {
        bothConfirmed = true;
        tx.state = 'COMMITTING_TRANSFER';
        tx.version += 1;

        const saved = await manager.save(SwapTransaction, tx);

        await this.appendAudit(manager, saved.id, 'HANDOVER_CONFIRMED', 'OK', {
          sellerConfirmedAt: saved.sellerConfirmedAt?.toISOString(),
          buyerConfirmedAt: saved.buyerConfirmedAt?.toISOString(),
        });
        await this.appendAudit(manager, saved.id, 'COMMITTING_TRANSFER', 'DISPATCHED', {
          batchId: saved.batchId,
          qty: saved.qty,
        });

        await this.enqueueOutbox(manager, {
          aggregateId: saved.id,
          eventType: EVT_HANDOVER_CONFIRMED,
          correlationId: validCorr,
          payload: {
            transactionId: saved.id,
            sellerShopId: saved.sellerShopId,
            buyerShopId: saved.buyerShopId,
            batchId: saved.batchId,
            productId: saved.productId,
            qty: saved.qty,
            costPrice: Number(saved.costPrice),
            expiryDate: saved.expiryDate,
          },
        });

        await this.enqueueOutbox(manager, {
          aggregateId: saved.id,
          eventType: CMD_COMMIT_TRANSFER,
          correlationId: validCorr,
          payload: {
            transactionId: saved.id,
            sellerBatchId: saved.batchId,
            sellerShopId: saved.sellerShopId,
            buyerShopId: saved.buyerShopId,
            productId: saved.productId,
            qty: saved.qty,
            costPrice: Number(saved.costPrice),
            expiryDate: saved.expiryDate,
          },
        });

        await this.enqueueOutbox(manager, {
          aggregateId: saved.id,
          eventType: EVT_TIMEOUT_COMMIT,
          correlationId: validCorr,
          payload: { transactionId: saved.id, expectedState: 'COMMITTING_TRANSFER' },
        });

        return saved;
      }

      tx.version += 1;
      return manager.save(SwapTransaction, tx);
    });

    if (bothConfirmed) {
      await this.clearEphemeralPin(updated.id);
      await this.publishSseUpdate(updated, 'Both parties confirmed — committing stock transfer');
    } else {
      await this.publishSseUpdate(updated, 'One party confirmed handover PIN');
    }
    return updated;
  }

  /**
   * Step 4a: Consumes `inventory.transfer.committed.v1`.
   * Marks transaction `COMPLETED`, generates `billRecordId`, emits `saga.swap.completed.v1`.
   */
  async handleTransferCommitted(
    payload: { transactionId: string; buyerBatchId?: string },
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SwapTransaction | null> {
    const validCorr = normalizeUuid(correlationId);

    const runInTx = async (manager: EntityManager): Promise<SwapTransaction | null> => {
      const tx = await manager.findOne(SwapTransaction, {
        where: { id: payload.transactionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!tx || tx.state !== 'COMMITTING_TRANSFER') return tx ?? null;

      tx.state = 'COMPLETED';
      tx.billRecordId = tx.billRecordId ?? uuidv4();
      tx.version += 1;

      const updated = await manager.save(SwapTransaction, tx);
      await this.appendAudit(manager, updated.id, 'COMPLETED', 'TERMINAL', {
        billRecordId: updated.billRecordId,
        buyerBatchId: payload.buyerBatchId ?? null,
      });

      await this.enqueueOutbox(manager, {
        aggregateId: updated.id,
        eventType: EVT_SWAP_COMPLETED,
        correlationId: validCorr,
        payload: {
          transactionId: updated.id,
          listingId: updated.listingId,
          sellerShopId: updated.sellerShopId,
          buyerShopId: updated.buyerShopId,
          productId: updated.productId,
          qty: updated.qty,
          price: Number(updated.price),
          billRecordId: updated.billRecordId,
        },
      });

      return updated;
    };

    const updated = existingManager
      ? await runInTx(existingManager)
      : await this.dataSource.transaction(runInTx);
    if (updated) {
      await this.publishSseUpdate(updated, 'Swap completed and invoice ready');
    }
    return updated;
  }

  /**
   * Step 4b: Consumes `inventory.transfer.failed.v1` -> enters COMPENSATING and releases stock.
   */
  async handleTransferFailed(
    payload: { transactionId: string; reason?: string },
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SwapTransaction | null> {
    return this.enterCompensation(
      payload.transactionId,
      'COMMITTING_TRANSFER',
      (payload.reason ?? 'TRANSFER_FAILED').slice(0, 32),
      correlationId,
      existingManager,
    );
  }

  /**
   * Handles RabbitMQ TTL+DLX step timeouts (`saga.timeout.reserve.v1`, `saga.timeout.handover.v1`,
   * `saga.timeout.commit.v1`). Safely ignores stale timers if the saga already progressed.
   */
  async handleTimeout(
    timeoutType: string,
    payload: { transactionId: string },
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SwapTransaction | null> {
    const config: Record<string, { expected: SwapSagaState; reason: string }> = {
      [EVT_TIMEOUT_RESERVE]: { expected: 'RESERVING_STOCK', reason: 'RESERVE_TIMEOUT' },
      [EVT_TIMEOUT_HANDOVER]: { expected: 'AWAITING_HANDOVER', reason: 'BUYER_TIMEOUT' },
      [EVT_TIMEOUT_COMMIT]: { expected: 'COMMITTING_TRANSFER', reason: 'COMMIT_TIMEOUT' },
    };

    const rule = config[timeoutType];
    if (!rule) return null;

    return this.enterCompensation(
      payload.transactionId,
      rule.expected,
      rule.reason,
      correlationId,
      existingManager,
    );
  }

  /** Participant or admin cancels a swap prior to handover confirmation -> triggers compensation. */
  async cancelSwap(
    txId: string,
    actor: SagaActor,
    reason = 'USER_CANCEL',
    correlationId?: string,
  ): Promise<SwapTransaction> {
    const tx = await this.dataSource
      .getRepository(SwapTransaction)
      .findOne({ where: { id: txId } });
    if (!tx) {
      throw new NotFoundException(`Swap transaction ${txId} not found`);
    }
    if (
      actor.role !== 'admin' &&
      actor.shopId !== tx.sellerShopId &&
      actor.shopId !== tx.buyerShopId
    ) {
      throw new ForbiddenException('Only swap participants or an admin can cancel this swap');
    }
    if (tx.state !== 'RESERVING_STOCK' && tx.state !== 'AWAITING_HANDOVER') {
      throw new ConflictException(`Cannot cancel swap from state ${tx.state}`);
    }

    const updated = await this.enterCompensation(
      txId,
      tx.state,
      reason.slice(0, 32),
      correlationId,
    );
    return updated!;
  }

  private async enterCompensation(
    txId: string,
    expectedState: SwapSagaState,
    cancelReason: string,
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SwapTransaction | null> {
    const validCorr = normalizeUuid(correlationId);

    const runInTx = async (manager: EntityManager): Promise<SwapTransaction | null> => {
      const tx = await manager.findOne(SwapTransaction, {
        where: { id: txId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!tx || tx.state !== expectedState) {
        return tx ?? null;
      }

      tx.state = 'COMPENSATING';
      tx.cancelReason = cancelReason;
      tx.version += 1;

      const updated = await manager.save(SwapTransaction, tx);
      await this.appendAudit(manager, updated.id, 'COMPENSATING', 'DISPATCHED', {
        fromState: expectedState,
        reason: cancelReason,
      });

      await this.enqueueOutbox(manager, {
        aggregateId: updated.id,
        eventType: CMD_RELEASE_STOCK,
        correlationId: validCorr,
        payload: {
          transactionId: updated.id,
          batchId: updated.batchId,
          sellerShopId: updated.sellerShopId,
          qty: updated.qty,
        },
      });

      return updated;
    };

    const updated = existingManager
      ? await runInTx(existingManager)
      : await this.dataSource.transaction(runInTx);
    if (updated && updated.state === 'COMPENSATING') {
      await this.clearEphemeralPin(updated.id);
      await this.publishSseUpdate(updated, `Compensating swap (${cancelReason})`);
    }
    return updated;
  }

  /**
   * Final compensation step: consumes `inventory.stock.released.v1`.
   * Marks transaction `CANCELLED_COMPENSATED` and emits `saga.swap.cancelled.v1`.
   */
  async handleStockReleased(
    payload: { transactionId: string; releasedQty?: number },
    correlationId?: string,
    existingManager?: EntityManager,
  ): Promise<SwapTransaction | null> {
    const validCorr = normalizeUuid(correlationId);

    const runInTx = async (manager: EntityManager): Promise<SwapTransaction | null> => {
      const tx = await manager.findOne(SwapTransaction, {
        where: { id: payload.transactionId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!tx || tx.state !== 'COMPENSATING') return tx ?? null;

      tx.state = 'CANCELLED_COMPENSATED';
      tx.version += 1;

      const updated = await manager.save(SwapTransaction, tx);
      await this.appendAudit(manager, updated.id, 'CANCELLED_COMPENSATED', 'TERMINAL', {
        releasedQty: payload.releasedQty ?? 0,
        reason: updated.cancelReason,
      });

      await this.enqueueOutbox(manager, {
        aggregateId: updated.id,
        eventType: EVT_SWAP_CANCELLED,
        correlationId: validCorr,
        payload: {
          transactionId: updated.id,
          listingId: updated.listingId,
          sellerShopId: updated.sellerShopId,
          buyerShopId: updated.buyerShopId,
          reason: updated.cancelReason ?? 'COMPENSATION',
        },
      });

      return updated;
    };

    const updated = existingManager
      ? await runInTx(existingManager)
      : await this.dataSource.transaction(runInTx);
    if (updated) {
      await this.publishSseUpdate(updated, 'Swap cancelled and reserved stock released');
    }
    return updated;
  }

  async listMyTransactions(actor: SagaActor): Promise<SwapTransaction[]> {
    if (actor.role === 'admin') {
      return this.dataSource
        .getRepository(SwapTransaction)
        .find({ order: { createdAt: 'DESC' }, take: 100 });
    }
    if (!actor.shopId) {
      throw new ForbiddenException('Linked shop required to view swap transactions');
    }
    return this.dataSource.getRepository(SwapTransaction).find({
      where: [{ sellerShopId: actor.shopId }, { buyerShopId: actor.shopId }],
      order: { createdAt: 'DESC' },
    });
  }

  async getTransactionDetail(txId: string, actor: SagaActor): Promise<SagaDetailResponse> {
    const tx = await this.dataSource
      .getRepository(SwapTransaction)
      .findOne({ where: { id: txId } });
    if (!tx) {
      throw new NotFoundException(`Swap transaction ${txId} not found`);
    }
    if (
      actor.role !== 'admin' &&
      actor.shopId !== tx.sellerShopId &&
      actor.shopId !== tx.buyerShopId
    ) {
      throw new ForbiddenException('Not authorized to access this swap transaction');
    }

    const events = await this.dataSource.getRepository(SwapEvent).find({
      where: { transactionId: txId },
      order: { timestamp: 'ASC' },
    });

    let handoverCode: string | undefined;
    if (
      tx.state === 'AWAITING_HANDOVER' &&
      this.redis &&
      (actor.shopId === tx.sellerShopId || actor.role === 'admin')
    ) {
      try {
        const cached = await this.redis.get(`${PIN_CACHE_PREFIX}${tx.id}`);
        if (cached) handoverCode = cached;
      } catch {
        // Ignore Redis outage on optional PIN display
      }
    }

    return { transaction: tx, events, ...(handoverCode ? { handoverCode } : {}) };
  }

  async getInvoicePdf(txId: string, actor: SagaActor): Promise<GeneratedSwapInvoice> {
    const tx = await this.dataSource
      .getRepository(SwapTransaction)
      .findOne({ where: { id: txId } });
    if (!tx) {
      throw new NotFoundException(`Swap transaction ${txId} not found`);
    }
    if (
      actor.role !== 'admin' &&
      actor.shopId !== tx.sellerShopId &&
      actor.shopId !== tx.buyerShopId
    ) {
      throw new ForbiddenException('Only swap participants or an admin can download this invoice');
    }
    if (tx.state !== 'COMPLETED') {
      throw new ConflictException(
        `Swap invoice is available only after completion (current state: ${tx.state})`,
      );
    }

    return this.invoiceService.generateSwapInvoicePdf(tx);
  }
}

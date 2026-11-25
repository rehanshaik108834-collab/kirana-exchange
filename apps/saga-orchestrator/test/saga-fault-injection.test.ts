import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import {
  KIRANA_DLX_EXCHANGE,
  KIRANA_EVENTS_EXCHANGE,
  KIRANA_SAGA_COMMANDS_EXCHANGE,
} from '@kirana/common';
import { v4 as uuidv4 } from 'uuid';
import { describe, expect, it, vi } from 'vitest';
import { OutboxEvent } from '../src/entities/outbox-event.entity';
import { SwapEvent } from '../src/entities/swap-event.entity';
import { SwapTransaction } from '../src/entities/swap-transaction.entity';
import { InvoiceService } from '../src/invoice.service';
import { resolveOutboxTarget, SagaOutboxRelay } from '../src/saga-outbox.relay';
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
  TIMEOUT_QUEUE_COMMIT,
  TIMEOUT_QUEUE_HANDOVER,
  TIMEOUT_QUEUE_RESERVE,
} from '../src/saga.constants';
import { hashHandoverCode, SagaService } from '../src/saga.service';

function createInMemorySagaStore() {
  const txs = new Map<string, SwapTransaction>();
  const events: SwapEvent[] = [];
  const outbox: Array<OutboxEvent & { published_at?: Date | null }> = [];
  const redisStore = new Map<string, string>();
  const publishedSse: Array<{ channel: string; payload: any }> = [];

  const makeManager = () => ({
    findOne: async (cls: unknown, opts: { where: { id?: string; offerId?: string } }) => {
      if (cls !== SwapTransaction) return null;
      if (opts.where.id) return txs.get(opts.where.id) ?? null;
      if (opts.where.offerId) {
        return [...txs.values()].find((t) => t.offerId === opts.where.offerId) ?? null;
      }
      return null;
    },
    find: async (cls: unknown, opts: any = {}) => {
      if (cls === SwapEvent) {
        return events.filter((e) => e.transactionId === opts.where?.transactionId);
      }
      if (cls === SwapTransaction) {
        return [...txs.values()];
      }
      return [];
    },
    create: (_cls: unknown, data: Record<string, unknown>) => ({ ...data }),
    save: async (cls: unknown, entity: any) => {
      if (cls === SwapTransaction) {
        const id = entity.id || uuidv4();
        const saved = Object.assign(new SwapTransaction(), {
          ...entity,
          id,
          createdAt: entity.createdAt ?? new Date(),
          updatedAt: new Date(),
        });
        txs.set(id, saved);
        return saved;
      }
      if (cls === SwapEvent) {
        const ev = Object.assign(new SwapEvent(), {
          id: uuidv4(),
          timestamp: new Date(),
          ...entity,
        });
        events.push(ev);
        return ev;
      }
      if (cls === OutboxEvent) {
        const ob = Object.assign(new OutboxEvent(), {
          id: uuidv4(),
          occurredAt: new Date(),
          publishedAt: null,
          ...entity,
        });
        outbox.push(ob);
        return ob;
      }
      return entity;
    },
  });

  const dataSource: any = {
    getRepository: (cls: unknown) => {
      const m = makeManager();
      return {
        findOne: (opts: any) => m.findOne(cls, opts),
        find: (opts: any) => m.find(cls, opts),
      };
    },
    transaction: async (cb: (m: any) => Promise<any>) => cb(makeManager()),
  };

  const fakeRedis: any = {
    set: vi.fn(async (k: string, v: string) => {
      redisStore.set(k, v);
      return 'OK';
    }),
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
    del: vi.fn(async (k: string) => {
      redisStore.delete(k);
      return 1;
    }),
    publish: vi.fn(async (channel: string, raw: string) => {
      publishedSse.push({ channel, payload: JSON.parse(raw) });
      return 1;
    }),
  };

  return { dataSource, fakeRedis, txs, events, outbox, redisStore, publishedSse };
}

const baseOffer = () => ({
  offerId: uuidv4(),
  listingId: uuidv4(),
  sellerShopId: uuidv4(),
  buyerShopId: uuidv4(),
  batchId: uuidv4(),
  productId: uuidv4(),
  qty: 10,
  agreedPrice: 75.5,
  costPrice: 90,
  expiryDate: '2026-08-01',
  state: 'Telangana',
});

describe('Go/No-Go Gate #4 — Swap Saga State Machine & Kill-at-Every-Step Recovery', () => {
  it('HAPPY PATH: completes full swap saga with SHA-256 PIN check, SSE updates, and GST PDF invoice', async () => {
    const store = createInMemorySagaStore();
    const service = new SagaService(store.dataSource, new InvoiceService(), store.fakeRedis);
    const offer = baseOffer();

    // 1. OfferAccepted -> RESERVING_STOCK + ReserveStockCmd + 30s reserve timeout
    const tx1 = await service.startFromOfferAccepted(offer);
    expect(tx1.state).toBe('RESERVING_STOCK');
    expect(store.outbox.map((o) => o.eventType)).toEqual([CMD_RESERVE_STOCK, EVT_TIMEOUT_RESERVE]);

    // 2. StockReserved -> AWAITING_HANDOVER + hashed PIN (never plaintext in DB) + 24h timeout
    const { tx: tx2, handoverCode } = await service.handleStockReserved({
      transactionId: tx1.id,
      batchId: offer.batchId,
      reservedQty: offer.qty,
    });
    expect(tx2!.state).toBe('AWAITING_HANDOVER');
    expect(handoverCode).toMatch(/^\d{6}$/);
    expect(tx2!.handoverCodeHash).toBe(hashHandoverCode(tx1.id, handoverCode!));
    expect(tx2!.handoverCodeHash).not.toBe(handoverCode);
    expect(store.outbox.map((o) => o.eventType)).toContain(EVT_HANDOVER_READY);
    expect(store.outbox.map((o) => o.eventType)).toContain(EVT_TIMEOUT_HANDOVER);

    // Seller can view transient PIN via detail endpoint; buyer CANNOT
    const sellerView = await service.getTransactionDetail(tx1.id, {
      userId: 'u-s',
      role: 'shop_owner',
      shopId: offer.sellerShopId,
    });
    const buyerView = await service.getTransactionDetail(tx1.id, {
      userId: 'u-b',
      role: 'shop_owner',
      shopId: offer.buyerShopId,
    });
    expect(sellerView.handoverCode).toBe(handoverCode);
    expect(buyerView.handoverCode).toBeUndefined();

    // Wrong PIN rejected
    await expect(
      service.confirmHandover(tx1.id, '000000', {
        userId: 'u-s',
        role: 'shop_owner',
        shopId: offer.sellerShopId,
      }),
    ).rejects.toThrow(BadRequestException);

    // 3. Seller confirms PIN -> still AWAITING_HANDOVER
    const afterSeller = await service.confirmHandover(tx1.id, handoverCode!, {
      userId: 'u-s',
      role: 'shop_owner',
      shopId: offer.sellerShopId,
    });
    expect(afterSeller.state).toBe('AWAITING_HANDOVER');
    expect(afterSeller.sellerConfirmedAt).toBeTruthy();
    expect(afterSeller.buyerConfirmedAt).toBeNull();

    // Invoice blocked before completion
    await expect(
      service.getInvoicePdf(tx1.id, {
        userId: 'u-b',
        role: 'shop_owner',
        shopId: offer.buyerShopId,
      }),
    ).rejects.toThrow(ConflictException);

    // 4. Buyer confirms PIN -> COMMITTING_TRANSFER + HandoverConfirmed + CommitTransferCmd + 60s timeout
    const afterBuyer = await service.confirmHandover(tx1.id, handoverCode!, {
      userId: 'u-b',
      role: 'shop_owner',
      shopId: offer.buyerShopId,
    });
    expect(afterBuyer.state).toBe('COMMITTING_TRANSFER');
    expect(store.outbox.map((o) => o.eventType)).toContain(EVT_HANDOVER_CONFIRMED);
    expect(store.outbox.map((o) => o.eventType)).toContain(CMD_COMMIT_TRANSFER);
    expect(store.outbox.map((o) => o.eventType)).toContain(EVT_TIMEOUT_COMMIT);

    // 5. TransferCommitted -> COMPLETED + billRecordId + SwapCompleted
    const completed = await service.handleTransferCommitted({
      transactionId: tx1.id,
      buyerBatchId: uuidv4(),
    });
    expect(completed!.state).toBe('COMPLETED');
    expect(completed!.billRecordId).toBeTruthy();
    expect(store.outbox.map((o) => o.eventType)).toContain(EVT_SWAP_COMPLETED);

    // Stale handover timeout firing AFTER completion must be ignored cleanly
    const afterStaleTimer = await service.handleTimeout(EVT_TIMEOUT_HANDOVER, {
      transactionId: tx1.id,
    });
    expect(afterStaleTimer!.state).toBe('COMPLETED');

    // Non-participant denied invoice; buyer downloads valid PDF
    await expect(
      service.getInvoicePdf(tx1.id, {
        userId: 'u-other',
        role: 'shop_owner',
        shopId: uuidv4(),
      }),
    ).rejects.toThrow(ForbiddenException);

    const pdf = await service.getInvoicePdf(tx1.id, {
      userId: 'u-b',
      role: 'shop_owner',
      shopId: offer.buyerShopId,
    });
    expect(pdf.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(store.publishedSse.length).toBeGreaterThanOrEqual(4);
  });

  it('FAULT 1: duplicate OfferAccepted redelivery is idempotent & ReserveFailed ends in FAILED_NO_STOCK', async () => {
    const store = createInMemorySagaStore();
    const service = new SagaService(store.dataSource, new InvoiceService(), store.fakeRedis);
    const offer = baseOffer();

    const txA = await service.startFromOfferAccepted(offer);
    const txB = await service.startFromOfferAccepted(offer);
    expect(txB.id).toBe(txA.id);
    expect(store.outbox.filter((o) => o.eventType === CMD_RESERVE_STOCK)).toHaveLength(1);

    const failed = await service.handleStockReservationFailed({
      transactionId: txA.id,
      reason: 'INSUFFICIENT_QTY',
    });
    expect(failed!.state).toBe('FAILED_NO_STOCK');
    expect(store.outbox.filter((o) => o.eventType === CMD_RELEASE_STOCK)).toHaveLength(0);
    expect(store.outbox.filter((o) => o.eventType === EVT_SWAP_CANCELLED)).toHaveLength(1);
  });

  it('FAULT 2: reserve timeout + late StockReserved reply triggers safe release with ZERO leaked stock', async () => {
    const store = createInMemorySagaStore();
    const service = new SagaService(store.dataSource, new InvoiceService(), store.fakeRedis);
    const offer = baseOffer();

    const tx = await service.startFromOfferAccepted(offer);

    // 30s reserve timeout fires before inventory reply arrives
    const compensating = await service.handleTimeout(EVT_TIMEOUT_RESERVE, {
      transactionId: tx.id,
    });
    expect(compensating!.state).toBe('COMPENSATING');
    expect(compensating!.cancelReason).toBe('RESERVE_TIMEOUT');
    expect(store.outbox.filter((o) => o.eventType === CMD_RELEASE_STOCK)).toHaveLength(1);

    // Late StockReserved arrives AFTER timeout -> MUST NOT enter AWAITING_HANDOVER; re-emits ReleaseStockCmd
    const late = await service.handleStockReserved({
      transactionId: tx.id,
      batchId: offer.batchId,
      reservedQty: offer.qty,
    });
    expect(late.tx!.state).toBe('COMPENSATING');
    expect(late.handoverCode).toBeUndefined();
    expect(store.outbox.filter((o) => o.eventType === CMD_RELEASE_STOCK)).toHaveLength(2);

    // StockReleased arrives -> terminal CANCELLED_COMPENSATED + SwapCancelled
    const cancelled = await service.handleStockReleased({
      transactionId: tx.id,
      releasedQty: offer.qty,
    });
    expect(cancelled!.state).toBe('CANCELLED_COMPENSATED');
    expect(store.outbox.filter((o) => o.eventType === EVT_SWAP_CANCELLED)).toHaveLength(1);
  });

  it('FAULT 3: 24h buyer no-show timeout in AWAITING_HANDOVER compensates stock & emits BUYER_TIMEOUT', async () => {
    const store = createInMemorySagaStore();
    const service = new SagaService(store.dataSource, new InvoiceService(), store.fakeRedis);
    const offer = baseOffer();

    const tx = await service.startFromOfferAccepted(offer);
    await service.handleStockReserved({
      transactionId: tx.id,
      batchId: offer.batchId,
      reservedQty: offer.qty,
    });

    const comp = await service.handleTimeout(EVT_TIMEOUT_HANDOVER, { transactionId: tx.id });
    expect(comp!.state).toBe('COMPENSATING');
    expect(comp!.cancelReason).toBe('BUYER_TIMEOUT');

    const finalTx = await service.handleStockReleased({
      transactionId: tx.id,
      releasedQty: offer.qty,
    });
    expect(finalTx!.state).toBe('CANCELLED_COMPENSATED');
    const cancelEvent = store.outbox.find((o) => o.eventType === EVT_SWAP_CANCELLED);
    expect(cancelEvent?.payload.reason).toBe('BUYER_TIMEOUT');
  });

  it('FAULT 4: CommitTransfer failure compensates stock back to seller cleanly', async () => {
    const store = createInMemorySagaStore();
    const service = new SagaService(store.dataSource, new InvoiceService(), store.fakeRedis);
    const offer = baseOffer();

    const tx = await service.startFromOfferAccepted(offer);
    const { handoverCode } = await service.handleStockReserved({
      transactionId: tx.id,
      batchId: offer.batchId,
      reservedQty: offer.qty,
    });
    await service.confirmHandover(tx.id, handoverCode!, {
      userId: 'u-s',
      role: 'shop_owner',
      shopId: offer.sellerShopId,
    });
    await service.confirmHandover(tx.id, handoverCode!, {
      userId: 'u-b',
      role: 'shop_owner',
      shopId: offer.buyerShopId,
    });

    const comp = await service.handleTransferFailed({
      transactionId: tx.id,
      reason: 'TRANSFER_DB_ERROR',
    });
    expect(comp!.state).toBe('COMPENSATING');
    expect(store.outbox.filter((o) => o.eventType === CMD_RELEASE_STOCK)).toHaveLength(1);

    const done = await service.handleStockReleased({
      transactionId: tx.id,
      releasedQty: offer.qty,
    });
    expect(done!.state).toBe('CANCELLED_COMPENSATED');
  });

  it('FAULT 5: SagaOutboxRelay routes commands/timeouts/events correctly and recovers from mid-batch SIGKILL', async () => {
    // 1. Routing target matrix verification
    expect(resolveOutboxTarget(CMD_RESERVE_STOCK)).toEqual({
      exchange: KIRANA_SAGA_COMMANDS_EXCHANGE,
      routingKey: CMD_RESERVE_STOCK,
    });
    expect(resolveOutboxTarget(EVT_TIMEOUT_RESERVE)).toEqual({
      exchange: KIRANA_DLX_EXCHANGE,
      routingKey: TIMEOUT_QUEUE_RESERVE,
    });
    expect(resolveOutboxTarget(EVT_TIMEOUT_HANDOVER)).toEqual({
      exchange: KIRANA_DLX_EXCHANGE,
      routingKey: TIMEOUT_QUEUE_HANDOVER,
    });
    expect(resolveOutboxTarget(EVT_TIMEOUT_COMMIT)).toEqual({
      exchange: KIRANA_DLX_EXCHANGE,
      routingKey: TIMEOUT_QUEUE_COMMIT,
    });
    expect(resolveOutboxTarget(EVT_SWAP_COMPLETED)).toEqual({
      exchange: KIRANA_EVENTS_EXCHANGE,
      routingKey: EVT_SWAP_COMPLETED,
    });

    // 2. Mid-batch crash recovery
    const rows = [
      {
        id: uuidv4(),
        aggregate_type: 'swap_transaction',
        aggregate_id: uuidv4(),
        event_type: CMD_RESERVE_STOCK,
        version: 1,
        correlation_id: uuidv4(),
        producer: 'saga-orchestrator',
        payload: { transactionId: uuidv4() },
        occurred_at: new Date(),
        published_at: null as Date | null,
      },
      {
        id: uuidv4(),
        aggregate_type: 'swap_transaction',
        aggregate_id: uuidv4(),
        event_type: EVT_TIMEOUT_RESERVE,
        version: 1,
        correlation_id: uuidv4(),
        producer: 'saga-orchestrator',
        payload: { transactionId: uuidv4() },
        occurred_at: new Date(),
        published_at: null as Date | null,
      },
    ];

    const published: Array<{ exchange: string; routingKey: string; id: string }> = [];
    const confirmChannel: any = {
      publish: vi.fn((exchange: string, routingKey: string, _buf: Buffer, opts: any) => {
        published.push({ exchange, routingKey, id: opts.messageId });
        return true;
      }),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
    };

    const dataSource: any = {
      transaction: async (cb: (m: any) => Promise<any>) => {
        const snapshot = rows.map((r) => ({ ...r }));
        const manager = {
          query: async (sql: string, params: any[]) => {
            if (sql.includes('SELECT id')) {
              return snapshot.filter((r) => r.published_at === null);
            }
            if (sql.includes('UPDATE outbox_events')) {
              const ids = new Set<string>(params[0]);
              for (const r of snapshot) {
                if (ids.has(r.id)) r.published_at = new Date();
              }
              return [];
            }
            return [];
          },
        };
        const result = await cb(manager);
        // Commit only if callback did not throw
        rows.splice(0, rows.length, ...snapshot);
        return result;
      },
    };

    const relay = new SagaOutboxRelay(dataSource, confirmChannel);

    // Crash after 1st message -> transaction rolls back -> 0 rows marked published
    await expect(relay.relayNextBatch({ killAfterPublishCount: 1 })).rejects.toThrow(
      'SIMULATED_SAGA_RELAY_CRASH_MID_BATCH',
    );
    expect(rows.every((r) => r.published_at === null)).toBe(true);

    // Recovery run delivers both commands cleanly with 0 lost
    const count = await relay.relayNextBatch();
    expect(count).toBe(2);
    expect(rows.every((r) => r.published_at !== null)).toBe(true);
    expect(published.some((p) => p.exchange === KIRANA_SAGA_COMMANDS_EXCHANGE)).toBe(true);
    expect(published.some((p) => p.routingKey === TIMEOUT_QUEUE_RESERVE)).toBe(true);
  });
});

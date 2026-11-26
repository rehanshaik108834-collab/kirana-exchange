import { describe, expect, it, vi } from 'vitest';
import { replayDlqMessages } from '../src/messaging/dlq-replay';
import { IdempotentConsumerRunner } from '../src/messaging/idempotent-consumer';
import { OutboxRelay } from '../src/messaging/outbox-relay.service';
import { KIRANA_DLX_EXCHANGE } from '../src/messaging/rabbitmq.topology';

describe('Phase 11 Chaos Drills — RabbitMQ Outage, Retry-to-DLQ & Zero-Loss Recovery', () => {
  it('CHAOS DRILL 1 (RabbitMQ Down): OutboxRelay preserves all unpublished events across outage and delivers 100% upon recovery', async () => {
    const outboxRows = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        aggregate_type: 'inventory_batch',
        aggregate_id: 'aaaa1111-1111-4111-8111-111111111111',
        event_type: 'inventory.sale.recorded.v1',
        version: 1,
        correlation_id: 'cccc1111-1111-4111-8111-111111111111',
        producer: 'inventory-service',
        payload: { qty: 2 },
        occurred_at: new Date('2026-04-01T10:00:00Z'),
        published_at: null as Date | null,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        aggregate_type: 'inventory_batch',
        aggregate_id: 'aaaa2222-2222-4222-8222-222222222222',
        event_type: 'inventory.stock.updated.v1',
        version: 1,
        correlation_id: 'cccc2222-2222-4222-8222-222222222222',
        producer: 'inventory-service',
        payload: { qty: 18 },
        occurred_at: new Date('2026-04-01T10:00:01Z'),
        published_at: null as Date | null,
      },
    ];

    const dataSource: any = {
      transaction: async (cb: (m: any) => Promise<any>) => {
        const txCopy = outboxRows.map((r) => ({ ...r }));
        const manager = {
          query: async (sql: string, params: any[]) => {
            if (sql.includes('SELECT id')) {
              return txCopy.filter((r) => r.published_at === null);
            }
            if (sql.includes('UPDATE outbox_events')) {
              const ids = new Set<string>(params[0]);
              for (const row of txCopy) {
                if (ids.has(row.id)) row.published_at = new Date();
              }
              return [];
            }
            return [];
          },
        };
        const res = await cb(manager);
        outboxRows.splice(0, outboxRows.length, ...txCopy);
        return res;
      },
    };

    // Broker outage: waitForConfirms rejects (simulates RabbitMQ killed mid-publish)
    let brokerUp = false;
    const deliveredIds: string[] = [];
    const confirmChannel: any = {
      publish: vi.fn((_ex: string, _rk: string, _buf: Buffer, opts: any) => {
        if (brokerUp) deliveredIds.push(opts.messageId);
        return true;
      }),
      waitForConfirms: vi.fn(async () => {
        if (!brokerUp) throw new Error('ECONNRESET: RabbitMQ broker down');
      }),
    };

    const relay = new OutboxRelay(dataSource, confirmChannel);

    // During outage: transaction rolls back, ZERO rows marked published
    await expect(relay.relayNextBatch()).rejects.toThrow(/RabbitMQ broker down/);
    expect(outboxRows.every((r) => r.published_at === null)).toBe(true);
    expect(deliveredIds).toHaveLength(0);

    // Broker recovers: next tick publishes 100% of buffered events cleanly
    brokerUp = true;
    const publishedCount = await relay.relayNextBatch();
    expect(publishedCount).toBe(2);
    expect(outboxRows.every((r) => r.published_at !== null)).toBe(true);
    expect(deliveredIds).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
  });

  it('CHAOS DRILL 2 (Downstream Poison -> DLQ -> Replay): routes exhausted retries to DLQ, then replays with idempotent execution', async () => {
    const processedIds = new Set<string>();
    const sideEffects: string[] = [];
    const dlqMessages: any[] = [];
    let consumeCallback: ((msg: any) => Promise<void>) | null = null;

    const dataSource: any = {
      transaction: async (cb: (m: any) => Promise<any>) => {
        const snapshot = new Set(processedIds);
        const manager = {
          query: async (_sql: string, params: [string, string]) => {
            const key = `${params[0]}:${params[1]}`;
            if (snapshot.has(key)) return [];
            snapshot.add(key);
            return [{ message_id: params[0] }];
          },
        };
        const res = await cb(manager);
        processedIds.clear();
        for (const k of snapshot) processedIds.add(k);
        return res;
      },
    };

    const replayedToMain: any[] = [];
    const channel: any = {
      consume: vi.fn(async (_q: string, cb: (msg: any) => Promise<void>) => {
        consumeCallback = cb;
      }),
      publish: vi.fn((exchange: string, routingKey: string, content: Buffer, options: any) => {
        if (routingKey.endsWith('.dlq')) {
          dlqMessages.push({
            fields: { deliveryTag: dlqMessages.length + 1 },
            properties: options,
            content,
          });
        } else if (exchange === KIRANA_DLX_EXCHANGE && routingKey === 'notify.domain.events') {
          replayedToMain.push({
            fields: { deliveryTag: 99 },
            properties: options,
            content,
          });
        }
        return true;
      }),
      get: vi.fn(async () => (dlqMessages.length > 0 ? dlqMessages.shift() : false)),
      waitForConfirms: vi.fn().mockResolvedValue(undefined),
      ack: vi.fn(),
      nack: vi.fn(),
    };

    const runner = new IdempotentConsumerRunner(dataSource, channel, {
      retryDelaysMs: [10, 20],
    });

    let downstreamHealthy = false;
    await runner.registerConsumer('notify.domain.events', 'notify-consumer', async (env) => {
      if (!downstreamHealthy) {
        throw new Error('SMTP_AND_DB_UNAVAILABLE');
      }
      sideEffects.push(env.id);
    });

    const eventId = '33333333-3333-4333-8333-333333333333';
    const rawMsg = {
      properties: {
        messageId: eventId,
        correlationId: '44444444-4444-4444-8444-444444444444',
        contentType: 'application/json',
        headers: { 'x-retry-count': 2 }, // Final retry already exhausted
      },
      content: Buffer.from(
        JSON.stringify({
          id: eventId,
          type: 'saga.swap.completed.v1',
          version: 1,
          occurredAt: '2026-04-01T10:00:00Z',
          correlationId: '44444444-4444-4444-8444-444444444444',
          producer: 'saga-orchestrator',
          payload: { qty: 5 },
        }),
      ),
    };

    // 1. Failure after max retries -> parked in DLQ, transaction rolled back
    await consumeCallback!(rawMsg);
    expect(runner.getDlqCount()).toBe(1);
    expect(dlqMessages).toHaveLength(1);
    expect(sideEffects).toHaveLength(0);
    expect(processedIds.size).toBe(0);

    // 2. Downstream heals -> operator replays DLQ message back to main queue
    downstreamHealthy = true;
    const summary = await replayDlqMessages(channel, 'notify.domain.events.dlq');
    expect(summary.replayed).toBe(1);
    expect(replayedToMain).toHaveLength(1);

    // 3. Replayed message executes once; duplicate redelivery is deduplicated cleanly
    await consumeCallback!(replayedToMain[0]);
    await consumeCallback!(replayedToMain[0]);
    expect(sideEffects).toEqual([eventId]);
  });
});

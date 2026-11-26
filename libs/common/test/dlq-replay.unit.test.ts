import { describe, expect, it, vi } from 'vitest';
import {
  inspectDlqMessages,
  replayDlqMessages,
  resolveTargetQueueFromDlq,
} from '../src/messaging/dlq-replay';
import { KIRANA_DLX_EXCHANGE } from '../src/messaging/rabbitmq.topology';

function makeFakeQueueChannel(
  initialMessages: Array<{ id: string; type: string; reason: string }>,
) {
  const queue = initialMessages.map((m, idx) => ({
    fields: { deliveryTag: idx + 1 },
    properties: {
      messageId: m.id,
      correlationId: `corr-${idx + 1}`,
      contentType: 'application/json',
      headers: {
        'x-retry-count': 3,
        'x-death-reason': m.reason,
        'x-last-error': m.reason,
      },
    },
    content: Buffer.from(
      JSON.stringify({
        id: m.id,
        type: m.type,
        version: 1,
        occurredAt: '2026-04-01T00:00:00Z',
        correlationId: `corr-${idx + 1}`,
        producer: 'test',
        payload: { seq: idx + 1 },
      }),
    ),
  }));

  const published: Array<{ exchange: string; routingKey: string; options: any }> = [];
  const acked: number[] = [];
  const nacked: Array<{ tag: number; requeue: boolean }> = [];

  const channel: any = {
    get: vi.fn(async () => (queue.length > 0 ? queue.shift() : false)),
    publish: vi.fn((exchange: string, routingKey: string, _content: Buffer, options: any) => {
      published.push({ exchange, routingKey, options });
      return true;
    }),
    waitForConfirms: vi.fn().mockResolvedValue(undefined),
    ack: vi.fn((msg: any) => {
      acked.push(msg.fields.deliveryTag);
    }),
    nack: vi.fn((msg: any, _allUpTo: boolean, requeue: boolean) => {
      nacked.push({ tag: msg.fields.deliveryTag, requeue });
      if (requeue) queue.unshift(msg);
    }),
  };

  return { channel, queue, published, acked, nacked };
}

describe('DLQ Inspection & Replay Tool (Phase 11, Slice 2)', () => {
  it('refuses to run against non-.dlq live queues', async () => {
    const { channel } = makeFakeQueueChannel([]);
    expect(() => resolveTargetQueueFromDlq('saga.orchestrator.events')).toThrow(
      /must end with \.dlq/,
    );
    await expect(inspectDlqMessages(channel, 'saga.orchestrator.events')).rejects.toThrow(
      /must end with \.dlq/,
    );
  });

  it('inspects DLQ messages non-destructively and requeues every peeked message', async () => {
    const { channel, queue, nacked, acked } = makeFakeQueueChannel([
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'swap.offer.accepted.v1',
        reason: 'DB_TIMEOUT',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'inventory.stock.reserved.v1',
        reason: 'CONN_RESET',
      },
    ]);

    const inspected = await inspectDlqMessages(channel, 'saga.orchestrator.events.dlq', 10);

    expect(inspected).toHaveLength(2);
    expect(inspected[0].eventType).toBe('swap.offer.accepted.v1');
    expect(inspected[0].deathReason).toBe('DB_TIMEOUT');
    expect(inspected[0].retryCount).toBe(3);
    expect(acked).toHaveLength(0);
    expect(nacked).toHaveLength(2);
    expect(nacked.every((n) => n.requeue)).toBe(true);
    // Queue intact with original 2 messages preserved
    expect(queue).toHaveLength(2);
  });

  it('replays filtered DLQ messages back to main queue with reset headers while preserving unmatched ones', async () => {
    const targetId = '11111111-1111-4111-8111-111111111111';
    const keepId = '22222222-2222-4222-8222-222222222222';
    const { channel, queue, published, acked } = makeFakeQueueChannel([
      { id: targetId, type: 'swap.offer.accepted.v1', reason: 'TEMP_OUTAGE' },
      { id: keepId, type: 'saga.swap.completed.v1', reason: 'POISON_SCHEMA' },
    ]);

    const summary = await replayDlqMessages(channel, 'saga.orchestrator.events.dlq', {
      messageId: targetId,
      replayedBy: 'admin-ops',
    });

    expect(summary).toMatchObject({
      dlqQueue: 'saga.orchestrator.events.dlq',
      targetQueue: 'saga.orchestrator.events',
      dryRun: false,
      scanned: 2,
      replayed: 1,
      skipped: 1,
      replayedMessageIds: [targetId],
    });

    expect(published).toHaveLength(1);
    expect(published[0].exchange).toBe(KIRANA_DLX_EXCHANGE);
    expect(published[0].routingKey).toBe('saga.orchestrator.events');
    expect(published[0].options.headers['x-retry-count']).toBe(0);
    expect(published[0].options.headers['x-death-reason']).toBeUndefined();
    expect(published[0].options.headers['x-last-error']).toBeUndefined();
    expect(published[0].options.headers['x-replayed-by']).toBe('admin-ops');
    expect(published[0].options.headers['x-replayed-at']).toBeTruthy();

    expect(channel.waitForConfirms).toHaveBeenCalledTimes(1);
    expect(acked).toEqual([1]);
    // Unmatched message stays parked safely in the DLQ
    expect(queue).toHaveLength(1);
    expect(queue[0].properties.messageId).toBe(keepId);
  });

  it('supports dryRun without publishing or acking any messages', async () => {
    const { channel, queue, published, acked } = makeFakeQueueChannel([
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'swap.offer.accepted.v1',
        reason: 'TIMEOUT',
      },
    ]);

    const summary = await replayDlqMessages(channel, 'saga.orchestrator.events.dlq', {
      dryRun: true,
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.replayed).toBe(1);
    expect(published).toHaveLength(0);
    expect(acked).toHaveLength(0);
    expect(queue).toHaveLength(1);
  });
});

import type { Channel, ConfirmChannel, GetMessage } from 'amqplib';
import { KIRANA_DLX_EXCHANGE } from './rabbitmq.topology';

export const KNOWN_DLQ_QUEUES = [
  'auth.shop-linking.dlq',
  'forecast.sales.events.dlq',
  'swap.domain.events.dlq',
  'swap.matcher.listings.dlq',
  'inventory.saga.commands.dlq',
  'saga.orchestrator.events.dlq',
  'notify.domain.events.dlq',
  'shop.reputation.events.dlq',
  'analytics.cqrs.projections.dlq',
] as const;

export interface InspectedDlqMessage {
  deliveryTag: number;
  messageId: string | null;
  correlationId: string | null;
  eventType: string | null;
  retryCount: number;
  deathReason: string | null;
  lastError: string | null;
  payloadPreview: string;
}

export interface DlqReplayOptions {
  /** Maximum number of messages to pull from the DLQ in one pass (default: 50). */
  limit?: number;
  /** Optional target queue override; defaults to stripping `.dlq` from `dlqQueue`. */
  targetQueue?: string;
  /** Replay only messages matching this exact message/envelope UUID. */
  messageId?: string;
  /** Replay only messages matching this envelope `type`. */
  eventType?: string;
  /** Operator identifier stamped in `x-replayed-by` header. */
  replayedBy?: string;
  /** When true, inspects and counts matching messages without publishing or removing from DLQ. */
  dryRun?: boolean;
}

export interface DlqReplaySummary {
  dlqQueue: string;
  targetQueue: string;
  dryRun: boolean;
  scanned: number;
  replayed: number;
  skipped: number;
  replayedMessageIds: string[];
}

function assertDlqName(dlqQueue: string): void {
  if (!dlqQueue || !dlqQueue.endsWith('.dlq')) {
    throw new Error(
      `Refusing to operate on non-DLQ queue '${dlqQueue}': queue name must end with .dlq`,
    );
  }
}

export function resolveTargetQueueFromDlq(dlqQueue: string, override?: string): string {
  assertDlqName(dlqQueue);
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  const base = dlqQueue.slice(0, -'.dlq'.length);
  if (!base) {
    throw new Error(`Invalid DLQ queue name '${dlqQueue}'`);
  }
  return base;
}

function parseEnvelopeMeta(raw: Buffer): {
  id: string | null;
  type: string | null;
  correlationId: string | null;
  preview: string;
} {
  const text = raw.toString('utf8');
  const preview = text.length > 240 ? `${text.slice(0, 240)}...` : text;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      id: typeof parsed.id === 'string' ? parsed.id : null,
      type: typeof parsed.type === 'string' ? parsed.type : null,
      correlationId: typeof parsed.correlationId === 'string' ? parsed.correlationId : null,
      preview,
    };
  } catch {
    return { id: null, type: null, correlationId: null, preview };
  }
}

function toInspected(msg: GetMessage): InspectedDlqMessage {
  const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
  const meta = parseEnvelopeMeta(msg.content);

  return {
    deliveryTag: msg.fields.deliveryTag,
    messageId: meta.id ?? msg.properties.messageId ?? null,
    correlationId: meta.correlationId ?? msg.properties.correlationId ?? null,
    eventType: meta.type,
    retryCount: Number(headers['x-retry-count'] ?? 0),
    deathReason: headers['x-death-reason'] ? String(headers['x-death-reason']) : null,
    lastError: headers['x-last-error'] ? String(headers['x-last-error']) : null,
    payloadPreview: meta.preview,
  };
}

/**
 * Non-destructively peeks up to `limit` messages currently parked in a `.dlq` queue.
 * Every retrieved message is immediately requeued via `nack(msg, false, true)` so
 * inspection never drops or mutates dead-lettered messages.
 */
export async function inspectDlqMessages(
  channel: Channel,
  dlqQueue: string,
  limit = 20,
): Promise<InspectedDlqMessage[]> {
  assertDlqName(dlqQueue);
  const maxItems = Math.max(1, Math.min(500, limit));
  const fetched: GetMessage[] = [];

  try {
    for (let i = 0; i < maxItems; i++) {
      const msg = await channel.get(dlqQueue, { noAck: false });
      if (msg === false) break;
      fetched.push(msg);
    }
    return fetched.map(toInspected);
  } finally {
    // Requeue in reverse order to preserve FIFO head ordering as closely as possible
    for (let i = fetched.length - 1; i >= 0; i--) {
      channel.nack(fetched[i], false, true);
    }
  }
}

/**
 * Safely replays dead-lettered messages back into their owning consumer's main queue
 * via `kirana.dlx` with reset `x-retry-count: 0`, cleared failure headers, and replay
 * audit metadata (`x-replayed-at`, `x-replayed-by`).
 *
 * Unmatched messages (when filtered by `messageId` or `eventType`) and all messages
 * during `dryRun: true` are requeued cleanly back into the DLQ.
 */
export async function replayDlqMessages(
  channel: Channel | ConfirmChannel,
  dlqQueue: string,
  options: DlqReplayOptions = {},
): Promise<DlqReplaySummary> {
  const targetQueue = resolveTargetQueueFromDlq(dlqQueue, options.targetQueue);
  const maxItems = Math.max(1, Math.min(500, options.limit ?? 50));
  const dryRun = Boolean(options.dryRun);
  const replayedBy = options.replayedBy ?? 'dlq-cli';
  const replayedAt = new Date().toISOString();

  const fetched: GetMessage[] = [];
  for (let i = 0; i < maxItems; i++) {
    const msg = await channel.get(dlqQueue, { noAck: false });
    if (msg === false) break;
    fetched.push(msg);
  }

  const matched: GetMessage[] = [];
  const unmatched: GetMessage[] = [];
  const replayedMessageIds: string[] = [];

  for (const msg of fetched) {
    const inspected = toInspected(msg);
    const matchesId = !options.messageId || inspected.messageId === options.messageId;
    const matchesType = !options.eventType || inspected.eventType === options.eventType;

    if (matchesId && matchesType) {
      matched.push(msg);
      if (inspected.messageId) {
        replayedMessageIds.push(inspected.messageId);
      }
    } else {
      unmatched.push(msg);
    }
  }

  if (dryRun) {
    for (let i = fetched.length - 1; i >= 0; i--) {
      channel.nack(fetched[i], false, true);
    }
    return {
      dlqQueue,
      targetQueue,
      dryRun: true,
      scanned: fetched.length,
      replayed: matched.length,
      skipped: unmatched.length,
      replayedMessageIds,
    };
  }

  // Requeue unmatched messages right away
  for (let i = unmatched.length - 1; i >= 0; i--) {
    channel.nack(unmatched[i], false, true);
  }

  // Republish matched messages with reset retry counters and audit headers
  for (const msg of matched) {
    const prevHeaders = { ...((msg.properties.headers ?? {}) as Record<string, unknown>) };
    delete prevHeaders['x-death-reason'];
    delete prevHeaders['x-last-error'];

    const nextHeaders: Record<string, unknown> = {
      ...prevHeaders,
      'x-retry-count': 0,
      'x-replayed-at': replayedAt,
      'x-replayed-by': replayedBy,
      'x-replayed-from': dlqQueue,
    };

    channel.publish(KIRANA_DLX_EXCHANGE, targetQueue, msg.content, {
      persistent: true,
      messageId: msg.properties.messageId,
      correlationId: msg.properties.correlationId,
      contentType: msg.properties.contentType || 'application/json',
      headers: nextHeaders,
    });
  }

  if (
    matched.length > 0 &&
    'waitForConfirms' in channel &&
    typeof channel.waitForConfirms === 'function'
  ) {
    await channel.waitForConfirms();
  }

  for (const msg of matched) {
    channel.ack(msg);
  }

  return {
    dlqQueue,
    targetQueue,
    dryRun: false,
    scanned: fetched.length,
    replayed: matched.length,
    skipped: unmatched.length,
    replayedMessageIds,
  };
}

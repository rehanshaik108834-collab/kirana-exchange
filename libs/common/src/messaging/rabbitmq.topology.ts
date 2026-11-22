import type { Channel } from 'amqplib';

export const KIRANA_EVENTS_EXCHANGE = 'kirana.events';
export const KIRANA_SAGA_COMMANDS_EXCHANGE = 'kirana.saga.commands';
export const KIRANA_DLX_EXCHANGE = 'kirana.dlx';

export const RETRY_DELAYS_MS = [5_000, 30_000, 300_000] as const; // Attempt 1=5s, 2=30s, 3=300s
export const MAX_CONSUMER_RETRIES = 3;

export interface KiranaEventEnvelope<TPayload = Record<string, unknown>> {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  correlationId: string;
  producer: string;
  payload: TPayload;
}

export interface ConsumerQueueTopology {
  mainQueue: string;
  /** One retry queue per delay tier: `<queue>.retry.<attempt>` (attempt is 0-based). */
  retryQueues: string[];
  dlqQueue: string;
}

/** Name of the retry queue (and its routing key on `kirana.dlx`) for a 0-based retry attempt. */
export function retryQueueName(queueName: string, attempt: number): string {
  return `${queueName}.retry.${attempt}`;
}

/**
 * Asserts the durable exchanges (`kirana.events`, `kirana.saga.commands`, `kirana.dlx`)
 * and binds a consumer queue alongside its per-tier retry queues and `.dlq` queue.
 *
 * Why one retry queue per delay tier: RabbitMQ only expires messages at the head of a queue,
 * so mixing per-message TTLs (5s, 30s, 300s) in a single queue lets a 300s message block a
 * 5s message behind it. With a queue-level `x-message-ttl` every message in a queue shares the
 * same delay, so FIFO order equals expiry order and no head-of-line blocking can occur.
 */
export async function assertConsumerQueueTopology(
  channel: Channel,
  queueName: string,
  bindingKeys: string[],
  sourceExchange = KIRANA_EVENTS_EXCHANGE,
  retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<ConsumerQueueTopology> {
  const dlqQueue = `${queueName}.dlq`;

  await channel.assertExchange(KIRANA_EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(KIRANA_SAGA_COMMANDS_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(KIRANA_DLX_EXCHANGE, 'direct', { durable: true });

  // 1. Main durable consumer queue
  await channel.assertQueue(queueName, {
    durable: true,
  });

  for (const pattern of bindingKeys) {
    await channel.bindQueue(queueName, sourceExchange, pattern);
  }
  // Allow retry queue expiration via kirana.dlx to route back into the main queue
  await channel.bindQueue(queueName, KIRANA_DLX_EXCHANGE, queueName);

  // 2. Retry waiting rooms, one per delay tier: when the queue TTL expires, RabbitMQ
  // dead-letters the message back to `kirana.dlx` with routingKey = `queueName` (main queue).
  const retryQueues: string[] = [];
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    const retryQueue = retryQueueName(queueName, attempt);
    await channel.assertQueue(retryQueue, {
      durable: true,
      messageTtl: retryDelaysMs[attempt],
      deadLetterExchange: KIRANA_DLX_EXCHANGE,
      deadLetterRoutingKey: queueName,
    });
    await channel.bindQueue(retryQueue, KIRANA_DLX_EXCHANGE, retryQueue);
    retryQueues.push(retryQueue);
  }

  // 3. Permanent Dead-Letter Queue (after 3 failed attempts)
  await channel.assertQueue(dlqQueue, {
    durable: true,
  });
  await channel.bindQueue(dlqQueue, KIRANA_DLX_EXCHANGE, dlqQueue);

  return { mainQueue: queueName, retryQueues, dlqQueue };
}

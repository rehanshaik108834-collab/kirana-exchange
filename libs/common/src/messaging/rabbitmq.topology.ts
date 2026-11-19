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
  retryQueue: string;
  dlqQueue: string;
}

/**
 * Asserts the durable exchanges (`kirana.events`, `kirana.saga.commands`, `kirana.dlx`)
 * and binds a consumer queue alongside its `.retry` (TTL + DLX loop) and `.dlq` queues.
 */
export async function assertConsumerQueueTopology(
  channel: Channel,
  queueName: string,
  bindingKeys: string[],
  sourceExchange = KIRANA_EVENTS_EXCHANGE,
): Promise<ConsumerQueueTopology> {
  const retryQueue = `${queueName}.retry`;
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

  // 2. Retry waiting room: when per-message expiration (5s/30s/300s) expires,
  // RabbitMQ dead-letters the message back to `kirana.dlx` with routingKey = `queueName`
  await channel.assertQueue(retryQueue, {
    durable: true,
    deadLetterExchange: KIRANA_DLX_EXCHANGE,
    deadLetterRoutingKey: queueName,
  });
  await channel.bindQueue(retryQueue, KIRANA_DLX_EXCHANGE, retryQueue);

  // 3. Permanent Dead-Letter Queue (after 3 failed attempts)
  await channel.assertQueue(dlqQueue, {
    durable: true,
  });
  await channel.bindQueue(dlqQueue, KIRANA_DLX_EXCHANGE, dlqQueue);

  return { mainQueue: queueName, retryQueue, dlqQueue };
}

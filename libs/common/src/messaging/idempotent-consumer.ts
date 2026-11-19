import type { Channel, ConsumeMessage } from 'amqplib';
import pino from 'pino';
import type { DataSource, EntityManager } from 'typeorm';
import {
  KIRANA_DLX_EXCHANGE,
  MAX_CONSUMER_RETRIES,
  RETRY_DELAYS_MS,
  type KiranaEventEnvelope,
} from './rabbitmq.topology';

function extractReturningRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    if (Array.isArray(result[0])) {
      return result[0] as T[];
    }
    return result as T[];
  }
  return [];
}

export class IdempotentConsumerRunner {
  private readonly logger = pino({ name: 'idempotent-consumer' });
  private dlqMessagesTotal = 0;

  constructor(
    private readonly dataSource: DataSource,
    private readonly channel: Channel,
  ) {}

  getDlqCount(): number {
    return this.dlqMessagesTotal;
  }

  /**
   * Consumes messages from `queueName` with at-least-once safety:
   * INVARIANT:
   * 1. Parse KiranaEventEnvelope JSON.
   * 2. Inside `this.dataSource.transaction(async (manager) => ...)`:
   *    - Execute `INSERT INTO processed_messages (message_id, consumer_name, processed_at)
   *               VALUES ($1, $2, NOW()) ON CONFLICT (message_id, consumer_name) DO NOTHING
   *               RETURNING message_id`
   *    - If 0 rows returned -> duplicate delivery detected! Log and return early (caller ACKs).
   *    - Otherwise invoke `handler(envelope, manager)` inside the same transaction so the domain
   *      projection update and the `processed_messages` row commit atomically.
   * 3. On success: `channel.ack(msg)`.
   * 4. On failure: read `x-retry-count` header (default 0).
   *    - If `retryCount < MAX_CONSUMER_RETRIES` (3): publish to `KIRANA_DLX_EXCHANGE` with
   *      routingKey = `${queueName}.retry`, header `x-retry-count = retryCount + 1`, and
   *      per-message `expiration = String(RETRY_DELAYS_MS[retryCount])` (5000, 30000, 300000), then `ack(msg)`.
   *    - If `retryCount >= MAX_CONSUMER_RETRIES`: publish to `KIRANA_DLX_EXCHANGE` with
   *      routingKey = `${queueName}.dlq`, increment `this.dlqMessagesTotal`, log error, and `ack(msg)`.
   */
  async registerConsumer<TPayload = Record<string, unknown>>(
    queueName: string,
    consumerName: string,
    handler: (envelope: KiranaEventEnvelope<TPayload>, manager: EntityManager) => Promise<void>,
  ): Promise<void> {
    await this.channel.consume(queueName, async (msg: ConsumeMessage | null) => {
      if (!msg) {
        return;
      }

      let envelope: KiranaEventEnvelope<TPayload>;
      try {
        envelope = JSON.parse(msg.content.toString('utf8')) as KiranaEventEnvelope<TPayload>;
      } catch (parseErr) {
        this.logger.error({ err: (parseErr as Error).message }, 'Failed to parse message JSON');
        this.channel.publish(KIRANA_DLX_EXCHANGE, `${queueName}.dlq`, msg.content, {
          persistent: true,
          headers: { 'x-death-reason': 'INVALID_JSON' },
        });
        this.dlqMessagesTotal += 1;
        this.channel.ack(msg);
        return;
      }

      const messageId = envelope.id || msg.properties.messageId;

      try {
        await this.dataSource.transaction(async (manager) => {
          const rawResult = await manager.query(
            `
            INSERT INTO processed_messages (message_id, consumer_name, processed_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (message_id, consumer_name) DO NOTHING
            RETURNING message_id
            `,
            [messageId, consumerName],
          );

          const insertedRows = extractReturningRows<{ message_id: string }>(rawResult);

          if (insertedRows.length === 0) {
            this.logger.info(
              { messageId, consumerName },
              'Duplicate message delivery detected; skipped processing',
            );
            return;
          }

          await handler(envelope, manager);
        });

        this.channel.ack(msg);
      } catch (err) {
        const headers = (msg.properties.headers ?? {}) as Record<string, unknown>;
        const retryCount = Number(headers['x-retry-count'] || 0);

        if (retryCount < MAX_CONSUMER_RETRIES) {
          const nextRetry = retryCount + 1;
          const delayMs = RETRY_DELAYS_MS[retryCount] ?? 5000;

          this.logger.warn(
            {
              messageId,
              consumerName,
              retryCount: nextRetry,
              delayMs,
              err: (err as Error).message,
            },
            'Consumer handler failed; routing to retry queue with delay',
          );

          this.channel.publish(KIRANA_DLX_EXCHANGE, `${queueName}.retry`, msg.content, {
            persistent: true,
            messageId: msg.properties.messageId,
            correlationId: msg.properties.correlationId,
            contentType: msg.properties.contentType || 'application/json',
            expiration: String(delayMs),
            headers: {
              ...headers,
              'x-retry-count': nextRetry,
              'x-last-error': (err as Error).message,
            },
          });
        } else {
          this.logger.error(
            { messageId, consumerName, retryCount, err: (err as Error).message },
            'Consumer handler exceeded max retries; routing to DLQ',
          );

          this.channel.publish(KIRANA_DLX_EXCHANGE, `${queueName}.dlq`, msg.content, {
            persistent: true,
            messageId: msg.properties.messageId,
            correlationId: msg.properties.correlationId,
            contentType: msg.properties.contentType || 'application/json',
            headers: {
              ...headers,
              'x-retry-count': retryCount,
              'x-death-reason': (err as Error).message,
            },
          });
          this.dlqMessagesTotal += 1;
        }

        this.channel.ack(msg);
      }
    });
  }
}

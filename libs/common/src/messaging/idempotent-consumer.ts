import type { Channel, ConsumeMessage } from 'amqplib';
import pino from 'pino';
import type { DataSource, EntityManager } from 'typeorm';
import {
  KIRANA_DLX_EXCHANGE,
  RETRY_DELAYS_MS,
  retryQueueName,
  type KiranaEventEnvelope,
} from './rabbitmq.topology';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractReturningRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    if (Array.isArray(result[0])) {
      return result[0] as T[];
    }
    return result as T[];
  }
  return [];
}

export interface IdempotentConsumerOptions {
  /**
   * Delay before each retry attempt; its length is the max retry count.
   * Must match the `retryDelaysMs` passed to `assertConsumerQueueTopology` for the same queue.
   */
  retryDelaysMs?: readonly number[];
}

export class IdempotentConsumerRunner {
  private readonly logger = pino({ name: 'idempotent-consumer' });
  private readonly retryDelaysMs: readonly number[];
  private dlqMessagesTotal = 0;

  constructor(
    private readonly dataSource: DataSource,
    private readonly channel: Channel,
    options: IdempotentConsumerOptions = {},
  ) {
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

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
   *    - If `retryCount < retryDelaysMs.length` (default 3): publish to `KIRANA_DLX_EXCHANGE` with
   *      routingKey = `${queueName}.retry.${retryCount}` (a queue whose x-message-ttl is
   *      retryDelaysMs[retryCount]: 5s, 30s, 300s) and header `x-retry-count = retryCount + 1`,
   *      then `ack(msg)`. When the TTL expires RabbitMQ dead-letters it back to the main queue.
   *    - Otherwise: publish to `KIRANA_DLX_EXCHANGE` with routingKey = `${queueName}.dlq`,
   *      increment `this.dlqMessagesTotal`, log error, and `ack(msg)`.
   * Messages that can never succeed (invalid JSON, missing/non-UUID id) go straight to the DLQ.
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

      const messageId: unknown = envelope?.id || msg.properties.messageId;

      // Without a UUID id the processed_messages insert can never succeed, so retrying is futile.
      if (typeof messageId !== 'string' || !UUID_RE.test(messageId)) {
        const reason = messageId ? 'INVALID_MESSAGE_ID' : 'MISSING_MESSAGE_ID';
        this.logger.error({ consumerName, messageId, reason }, 'Unprocessable message id');
        this.channel.publish(KIRANA_DLX_EXCHANGE, `${queueName}.dlq`, msg.content, {
          persistent: true,
          correlationId: msg.properties.correlationId,
          contentType: msg.properties.contentType || 'application/json',
          headers: { ...(msg.properties.headers ?? {}), 'x-death-reason': reason },
        });
        this.dlqMessagesTotal += 1;
        this.channel.ack(msg);
        return;
      }

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

        if (retryCount < this.retryDelaysMs.length) {
          const nextRetry = retryCount + 1;
          const delayMs = this.retryDelaysMs[retryCount];

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

          // The tier queue's x-message-ttl applies the delay; no per-message expiration.
          const retryKey = retryQueueName(queueName, retryCount);
          this.channel.publish(KIRANA_DLX_EXCHANGE, retryKey, msg.content, {
            persistent: true,
            messageId: msg.properties.messageId,
            correlationId: msg.properties.correlationId,
            contentType: msg.properties.contentType || 'application/json',
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

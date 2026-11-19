import type { ConfirmChannel } from 'amqplib';
import pino from 'pino';
import type { DataSource } from 'typeorm';
import { KIRANA_EVENTS_EXCHANGE, type KiranaEventEnvelope } from './rabbitmq.topology';

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  version: number;
  correlation_id: string;
  producer: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
}

export interface OutboxRelayOptions {
  batchSize?: number;
  /**
   * Fault-injection hook for the Phase 5 Go/No-Go Gate test:
   * When set, throws an error after publishing `killAfterPublishCount` messages to RabbitMQ
   * BEFORE `published_at` is committed in PostgreSQL, simulating a hard SIGKILL mid-batch.
   */
  killAfterPublishCount?: number;
}

export class OutboxRelay {
  private readonly logger = pino({ name: 'outbox-relay' });

  constructor(
    private readonly dataSource: DataSource,
    private readonly confirmChannel: ConfirmChannel,
  ) {}

  /**
   * Polls one batch of unpublished outbox_events using FOR UPDATE SKIP LOCKED,
   * publishes each to `kirana.events` with publisher confirms, and updates `published_at = NOW()`.
   */
  async relayNextBatch(options: OutboxRelayOptions = {}): Promise<number> {
    const batchSize = options.batchSize ?? 50;

    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
        SELECT id, aggregate_type, aggregate_id, event_type, version, correlation_id, producer, payload, occurred_at
        FROM outbox_events
        WHERE published_at IS NULL
        ORDER BY occurred_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
        `,
        [batchSize],
      )) as OutboxRow[];

      if (rows.length === 0) {
        return 0;
      }

      const publishedIds: string[] = [];

      for (const row of rows) {
        const occurredAt =
          row.occurred_at instanceof Date
            ? row.occurred_at.toISOString()
            : new Date(row.occurred_at).toISOString();

        const payload =
          typeof row.payload === 'string'
            ? (JSON.parse(row.payload) as Record<string, unknown>)
            : row.payload;

        const envelope: KiranaEventEnvelope = {
          id: row.id,
          type: row.event_type,
          version: Number(row.version),
          occurredAt,
          correlationId: row.correlation_id,
          producer: row.producer,
          payload,
        };

        const content = Buffer.from(JSON.stringify(envelope));
        this.confirmChannel.publish(KIRANA_EVENTS_EXCHANGE, row.event_type, content, {
          persistent: true,
          messageId: row.id,
          correlationId: row.correlation_id,
          contentType: 'application/json',
        });

        publishedIds.push(row.id);

        if (
          options.killAfterPublishCount !== undefined &&
          publishedIds.length >= options.killAfterPublishCount
        ) {
          await this.confirmChannel.waitForConfirms();
          this.logger.warn(
            {
              publishedCount: publishedIds.length,
              killAfterPublishCount: options.killAfterPublishCount,
            },
            'Simulating outbox relay crash mid-batch after publisher confirms',
          );
          throw new Error('SIMULATED_RELAY_CRASH_MID_BATCH');
        }
      }

      await this.confirmChannel.waitForConfirms();

      await manager.query(
        `
        UPDATE outbox_events
        SET published_at = NOW()
        WHERE id = ANY($1::uuid[])
        `,
        [publishedIds],
      );

      this.logger.info({ count: publishedIds.length }, 'Outbox events published and marked');
      return publishedIds.length;
    });
  }
}

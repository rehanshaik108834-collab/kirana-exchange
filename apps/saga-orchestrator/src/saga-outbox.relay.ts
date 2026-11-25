import {
  KIRANA_DLX_EXCHANGE,
  KIRANA_EVENTS_EXCHANGE,
  KIRANA_SAGA_COMMANDS_EXCHANGE,
  type KiranaEventEnvelope,
  type OutboxRelayOptions,
  type OutboxRow,
} from '@kirana/common';
import { connect, type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';
import pino from 'pino';
import type { DataSource } from 'typeorm';
import {
  COMMIT_TIMEOUT_MS,
  EVT_TIMEOUT_COMMIT,
  EVT_TIMEOUT_HANDOVER,
  EVT_TIMEOUT_RESERVE,
  HANDOVER_TIMEOUT_MS,
  RESERVE_TIMEOUT_MS,
  SAGA_EVENTS_QUEUE,
  TIMEOUT_QUEUE_COMMIT,
  TIMEOUT_QUEUE_HANDOVER,
  TIMEOUT_QUEUE_RESERVE,
} from './saga.constants';

export interface OutboxPublishTarget {
  exchange: string;
  routingKey: string;
}

/**
 * Maps an outbox event_type to its exact RabbitMQ exchange and routing key:
 * - `inventory.cmd.*`   -> `kirana.saga.commands` (direct)
 * - `saga.timeout.*`    -> `kirana.dlx` -> dedicated per-tier TTL queue -> dead-letters back to `saga.orchestrator.events`
 * - `saga.*` (domain)   -> `kirana.events` (topic)
 */
export function resolveOutboxTarget(eventType: string): OutboxPublishTarget {
  if (eventType.startsWith('inventory.cmd.')) {
    return { exchange: KIRANA_SAGA_COMMANDS_EXCHANGE, routingKey: eventType };
  }
  if (eventType === EVT_TIMEOUT_RESERVE) {
    return { exchange: KIRANA_DLX_EXCHANGE, routingKey: TIMEOUT_QUEUE_RESERVE };
  }
  if (eventType === EVT_TIMEOUT_HANDOVER) {
    return { exchange: KIRANA_DLX_EXCHANGE, routingKey: TIMEOUT_QUEUE_HANDOVER };
  }
  if (eventType === EVT_TIMEOUT_COMMIT) {
    return { exchange: KIRANA_DLX_EXCHANGE, routingKey: TIMEOUT_QUEUE_COMMIT };
  }
  return { exchange: KIRANA_EVENTS_EXCHANGE, routingKey: eventType };
}

/**
 * Declares the 3 dedicated RabbitMQ TTL timeout waiting queues (no head-of-line blocking).
 * When a step timer expires, RabbitMQ dead-letters the timeout envelope back to `saga.orchestrator.events`.
 */
export async function assertSagaTimeoutTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(KIRANA_EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(KIRANA_SAGA_COMMANDS_EXCHANGE, 'direct', { durable: true });
  await channel.assertExchange(KIRANA_DLX_EXCHANGE, 'direct', { durable: true });

  const timers: Array<{ queue: string; ttlMs: number }> = [
    { queue: TIMEOUT_QUEUE_RESERVE, ttlMs: RESERVE_TIMEOUT_MS },
    { queue: TIMEOUT_QUEUE_HANDOVER, ttlMs: HANDOVER_TIMEOUT_MS },
    { queue: TIMEOUT_QUEUE_COMMIT, ttlMs: COMMIT_TIMEOUT_MS },
  ];

  for (const timer of timers) {
    await channel.assertQueue(timer.queue, {
      durable: true,
      messageTtl: timer.ttlMs,
      deadLetterExchange: KIRANA_DLX_EXCHANGE,
      deadLetterRoutingKey: SAGA_EVENTS_QUEUE,
    });
    await channel.bindQueue(timer.queue, KIRANA_DLX_EXCHANGE, timer.queue);
  }
}

export class SagaOutboxRelay {
  private readonly logger = pino({ name: 'saga-outbox-relay' });

  constructor(
    private readonly dataSource: DataSource,
    private readonly confirmChannel: ConfirmChannel,
  ) {}

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

        const target = resolveOutboxTarget(row.event_type);
        const content = Buffer.from(JSON.stringify(envelope));
        this.confirmChannel.publish(target.exchange, target.routingKey, content, {
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
          throw new Error('SIMULATED_SAGA_RELAY_CRASH_MID_BATCH');
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

      this.logger.info({ count: publishedIds.length }, 'Saga outbox batch relayed');
      return publishedIds.length;
    });
  }
}

export class SagaOutboxWorker {
  private readonly logger = pino({ name: 'saga-outbox-worker' });
  private connection: ChannelModel | null = null;
  private relay: SagaOutboxRelay | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  private backoffMs = 1000;

  constructor(
    private readonly dataSource: DataSource,
    private readonly amqpUrl: string,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight?.catch(() => undefined);
    await this.disconnect();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let nextDelay = 1500;
    try {
      const relay = await this.ensureRelay();
      const count = await relay.relayNextBatch({ batchSize: 50 });
      this.backoffMs = 1000;
      if (count > 0) nextDelay = 50;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'Saga outbox relay tick failed; retrying');
      await this.disconnect();
      nextDelay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    }
    this.schedule(nextDelay);
  }

  private async ensureRelay(): Promise<SagaOutboxRelay> {
    if (this.relay) return this.relay;

    const connection = await connect(this.amqpUrl);
    connection.on('error', (err: Error) => {
      this.logger.warn({ err: err.message }, 'Saga outbox AMQP error');
    });
    connection.on('close', () => {
      this.connection = null;
      this.relay = null;
    });

    const channel: ConfirmChannel = await connection.createConfirmChannel();
    await assertSagaTimeoutTopology(channel);

    this.connection = connection;
    this.relay = new SagaOutboxRelay(this.dataSource, channel);
    this.logger.info('Saga outbox relay connected with TTL timeout topology');
    return this.relay;
  }

  private async disconnect(): Promise<void> {
    const conn = this.connection;
    this.connection = null;
    this.relay = null;
    if (conn) {
      await conn.close().catch(() => undefined);
    }
  }
}

import { connect, type ChannelModel } from 'amqplib';
import pino from 'pino';
import type { DataSource, EntityManager } from 'typeorm';
import { IdempotentConsumerRunner } from './idempotent-consumer';
import {
  KIRANA_EVENTS_EXCHANGE,
  RETRY_DELAYS_MS,
  assertConsumerQueueTopology,
  type KiranaEventEnvelope,
} from './rabbitmq.topology';

export interface EventSubscription<TPayload = Record<string, unknown>> {
  /** Durable queue owned by this consumer, e.g. `auth.shop-linking`. */
  queue: string;
  /** Routing keys on `kirana.events`, e.g. `shop.created.v1`. */
  bindingKeys: string[];
  /** Stored in `processed_messages.consumer_name`. */
  consumerName: string;
  /** Runs inside the same DB transaction as the processed_messages dedup insert. */
  handler: (envelope: KiranaEventEnvelope<TPayload>, manager: EntityManager) => Promise<void>;
}

export interface RabbitConsumerWorkerOptions {
  amqpUrl: string;
  serviceName: string;
  // Heterogeneous payload types per subscription; each handler narrows its own envelope.
  subscriptions: EventSubscription<any>[];
  /** Max unacked messages per channel (backpressure). */
  prefetch?: number;
  retryDelaysMs?: readonly number[];
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Keeps a service's event subscriptions consuming through `IdempotentConsumerRunner`.
 *
 * - Never blocks startup. If RabbitMQ is down, messages wait durably in their queues and the
 *   worker reconnects with exponential backoff.
 * - At-least-once delivery plus `processed_messages` dedup gives exactly-once effects
 *   (Phase 5 gate tests G1, G6).
 */
export class RabbitConsumerWorker {
  private readonly logger = pino({ name: 'rabbit-consumer-worker' });
  private readonly opts: Required<RabbitConsumerWorkerOptions>;
  private connection: ChannelModel | null = null;
  private runner: IdempotentConsumerRunner | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private backoffMs: number;

  constructor(
    private readonly dataSource: DataSource,
    options: RabbitConsumerWorkerOptions,
  ) {
    this.opts = {
      prefetch: 20,
      retryDelaysMs: RETRY_DELAYS_MS,
      minBackoffMs: 1000,
      maxBackoffMs: 30_000,
      ...options,
    };
    this.backoffMs = this.opts.minBackoffMs;
  }

  isConnected(): boolean {
    return this.connection !== null;
  }

  getDlqCount(): number {
    return this.runner?.getDlqCount() ?? 0;
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleConnect(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const connection = this.connection;
    this.connection = null;
    this.runner = null;
    await connection?.close().catch(() => undefined);
  }

  private scheduleConnect(delayMs: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connectAndConsume();
    }, delayMs);
  }

  private async connectAndConsume(): Promise<void> {
    let connection: ChannelModel | null = null;
    try {
      connection = await connect(this.opts.amqpUrl);
      connection.on('error', (err: Error) => {
        this.logger.warn({ service: this.opts.serviceName, err: err.message }, 'AMQP error');
      });
      connection.on('close', () => {
        if (this.connection !== connection) return;
        this.connection = null;
        this.runner = null;
        this.logger.warn(
          { service: this.opts.serviceName, correlationId: 'event-consumer' },
          'AMQP connection closed; reconnecting',
        );
        this.scheduleConnect(this.backoffMs);
      });

      const channel = await connection.createChannel();
      await channel.prefetch(this.opts.prefetch);
      const runner = new IdempotentConsumerRunner(this.dataSource, channel, {
        retryDelaysMs: this.opts.retryDelaysMs,
      });
      for (const sub of this.opts.subscriptions) {
        await assertConsumerQueueTopology(
          channel,
          sub.queue,
          sub.bindingKeys,
          KIRANA_EVENTS_EXCHANGE,
          this.opts.retryDelaysMs,
        );
        await runner.registerConsumer(sub.queue, sub.consumerName, sub.handler);
      }

      if (this.stopped) {
        await connection.close().catch(() => undefined);
        return;
      }
      this.connection = connection;
      this.runner = runner;
      this.backoffMs = this.opts.minBackoffMs;
      this.logger.info(
        {
          service: this.opts.serviceName,
          queues: this.opts.subscriptions.map((s) => s.queue),
          correlationId: 'event-consumer',
        },
        'Event consumers connected',
      );
    } catch (err) {
      await connection?.close().catch(() => undefined);
      this.logger.warn(
        {
          service: this.opts.serviceName,
          err: (err as Error).message,
          retryInMs: this.backoffMs,
          correlationId: 'event-consumer',
        },
        'Event consumer connection failed; retrying',
      );
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
      this.scheduleConnect(delay);
    }
  }
}

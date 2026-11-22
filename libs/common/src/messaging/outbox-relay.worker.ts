import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import pino from 'pino';
import type { DataSource } from 'typeorm';
import { OutboxRelay } from './outbox-relay.service';
import { KIRANA_EVENTS_EXCHANGE } from './rabbitmq.topology';

export interface OutboxRelayWorkerOptions {
  /** e.g. amqp://user:pass@host:5672 */
  amqpUrl: string;
  /** Used in logs only. */
  serviceName: string;
  batchSize?: number;
  /** Poll delay after an empty batch. */
  idleIntervalMs?: number;
  /** Poll delay after a non-empty batch (drain quickly). */
  busyIntervalMs?: number;
  /** Reconnect backoff bounds after a broker or DB error. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Background loop that drains a service's `outbox_events` into `kirana.events` (ADR-003).
 *
 * - Never blocks service startup: if RabbitMQ is down, events stay safely in the outbox and the
 *   worker keeps reconnecting with exponential backoff.
 * - Safe with multiple service instances: `OutboxRelay` uses `FOR UPDATE SKIP LOCKED`
 *   (Phase 5 gate test G2).
 * - Nest calls `onApplicationBootstrap` / `onApplicationShutdown` on provider instances, so a
 *   service registers it with a factory provider and enables shutdown hooks.
 */
export class OutboxRelayWorker {
  private readonly logger = pino({ name: 'outbox-relay-worker' });
  private readonly opts: Required<OutboxRelayWorkerOptions>;
  private connection: ChannelModel | null = null;
  private relay: OutboxRelay | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = true;
  private backoffMs: number;
  private publishedTotal = 0;

  constructor(
    private readonly dataSource: DataSource,
    options: OutboxRelayWorkerOptions,
  ) {
    this.opts = {
      batchSize: 50,
      idleIntervalMs: 2000,
      busyIntervalMs: 50,
      minBackoffMs: 1000,
      maxBackoffMs: 30_000,
      ...options,
    };
    this.backoffMs = this.opts.minBackoffMs;
  }

  /** Total events this worker has published and marked (for health/metrics). */
  getPublishedTotal(): number {
    return this.publishedTotal;
  }

  isConnected(): boolean {
    return this.relay !== null;
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
    let nextDelay = this.opts.idleIntervalMs;
    try {
      const relay = await this.ensureRelay();
      const published = await relay.relayNextBatch({ batchSize: this.opts.batchSize });
      this.publishedTotal += published;
      this.backoffMs = this.opts.minBackoffMs;
      if (published > 0) nextDelay = this.opts.busyIntervalMs;
    } catch (err) {
      this.logger.warn(
        {
          service: this.opts.serviceName,
          err: (err as Error).message,
          retryInMs: this.backoffMs,
          correlationId: 'outbox-relay',
        },
        'Outbox relay tick failed; events stay in the outbox and will be retried',
      );
      await this.disconnect();
      nextDelay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
    }
    this.schedule(nextDelay);
  }

  private async ensureRelay(): Promise<OutboxRelay> {
    if (this.relay) return this.relay;

    const connection = await connect(this.opts.amqpUrl);
    connection.on('error', (err: Error) => {
      this.logger.warn({ service: this.opts.serviceName, err: err.message }, 'AMQP error');
    });
    connection.on('close', () => {
      // Forces a reconnect on the next tick.
      this.connection = null;
      this.relay = null;
    });

    const channel: ConfirmChannel = await connection.createConfirmChannel();
    // Publishing to a missing exchange would close the channel, so assert it up front.
    await channel.assertExchange(KIRANA_EVENTS_EXCHANGE, 'topic', { durable: true });

    this.connection = connection;
    this.relay = new OutboxRelay(this.dataSource, channel);
    this.logger.info(
      { service: this.opts.serviceName, correlationId: 'outbox-relay' },
      'Outbox relay connected to RabbitMQ',
    );
    return this.relay;
  }

  private async disconnect(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.relay = null;
    if (connection) {
      await connection.close().catch(() => undefined);
    }
  }
}

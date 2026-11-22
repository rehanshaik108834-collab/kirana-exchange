/**
 * Phase 5 Go/No-Go gate: OutboxRelay + IdempotentConsumerRunner against real
 * PostgreSQL and RabbitMQ (docker compose -f infra/docker-compose.yml up -d postgres rabbitmq).
 *
 * Every suite run creates a throwaway database and uniquely named queues, and drops them afterwards.
 * Side effects are recorded in `gate_effects` with an `applied_count` that increments on conflict,
 * so a duplicate consumer effect is visible as applied_count = 2 instead of being silently absorbed.
 */
import { randomUUID } from 'node:crypto';
import { connect, type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { DataSource, type EntityManager } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IdempotentConsumerRunner } from '../src/messaging/idempotent-consumer';
import { OutboxRelay } from '../src/messaging/outbox-relay.service';
import { OutboxRelayWorker } from '../src/messaging/outbox-relay.worker';
import {
  KIRANA_EVENTS_EXCHANGE,
  assertConsumerQueueTopology,
  type KiranaEventEnvelope,
} from '../src/messaging/rabbitmq.topology';

const PG = {
  host: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'kirana_admin',
  password: process.env.DB_PASSWORD ?? 'secretpassword',
};
const AMQP_URL = process.env.AMQP_URL ?? 'amqp://kirana_admin:secretpassword@127.0.0.1:5672';
const FAST_RETRY_DELAYS_MS = [200, 400, 800] as const;

let admin: DataSource;
let ds: DataSource;
let dbName: string;
const connections: ChannelModel[] = [];
const queuesToDelete: string[] = [];

async function newConnection(): Promise<ChannelModel> {
  const c = await connect(AMQP_URL);
  connections.push(c);
  return c;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const rows = (await ds.query(sql, params)) as Array<{ n: string | number }>;
  return Number(rows[0].n);
}

async function insertOutbox(routingKey: string, count: number): Promise<string[]> {
  const rows = (await ds.query(
    `
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, correlation_id, producer, payload)
    SELECT 'gate', gen_random_uuid(), $1, gen_random_uuid(), 'gate-test', jsonb_build_object('seq', g)
    FROM generate_series(1, $2::int) AS g
    RETURNING id
    `,
    [routingKey, count],
  )) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

async function drainRelay(relay: OutboxRelay, batchSize = 50): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await relay.relayNextBatch({ batchSize });
    if (n === 0) return total;
    total += n;
  }
}

const recordEffect = async (envelope: KiranaEventEnvelope, manager: EntityManager) => {
  await manager.query(
    `
    INSERT INTO gate_effects (message_id, applied_count) VALUES ($1, 1)
    ON CONFLICT (message_id) DO UPDATE SET applied_count = gate_effects.applied_count + 1
    `,
    [envelope.id],
  );
};

/** Per-test fixture: unique routing key, consumer topology, and a tap queue that records every delivery. */
async function setupFixture(retryDelaysMs?: readonly number[]) {
  const rid = randomUUID().slice(0, 8);
  const routingKey = `gate.${rid}.evt`;
  const queue = `gate.${rid}.consumer`;
  const tapQueue = `gate.${rid}.tap`;

  const conn = await newConnection();
  const consumerCh = await conn.createChannel();
  const topology = await assertConsumerQueueTopology(
    consumerCh,
    queue,
    [routingKey],
    KIRANA_EVENTS_EXCHANGE,
    ...(retryDelaysMs ? [retryDelaysMs] : []),
  );
  queuesToDelete.push(queue, topology.dlqQueue, ...retryQueueNames(topology), tapQueue);

  const tapCh = await conn.createChannel();
  await tapCh.assertQueue(tapQueue, { durable: false, autoDelete: false });
  await tapCh.bindQueue(tapQueue, KIRANA_EVENTS_EXCHANGE, routingKey);
  const tapped: string[] = [];
  await tapCh.consume(
    tapQueue,
    (msg: ConsumeMessage | null) => {
      if (!msg) return;
      try {
        tapped.push((JSON.parse(msg.content.toString()) as { id?: string }).id ?? '<no-id>');
      } catch {
        tapped.push('<invalid-json>');
      }
    },
    { noAck: true },
  );

  const runner = new IdempotentConsumerRunner(
    ds,
    consumerCh,
    ...(retryDelaysMs ? [{ retryDelaysMs }] : []),
  );
  return { rid, routingKey, queue, topology, consumerCh, runner, tapped, conn };
}

function retryQueueNames(topology: object): string[] {
  const t = topology as { retryQueue?: string; retryQueues?: string[] };
  return t.retryQueues ?? (t.retryQueue ? [t.retryQueue] : []);
}

beforeAll(async () => {
  admin = new DataSource({ type: 'postgres', ...PG, database: 'postgres' });
  await admin.initialize();
  dbName = `gate_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);

  ds = new DataSource({ type: 'postgres', ...PG, database: dbName, extra: { max: 20 } });
  await ds.initialize();
  await ds.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  // Same DDL as every service migration (outbox_events + processed_messages).
  await ds.query(`
    CREATE TABLE outbox_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      aggregate_type VARCHAR(64) NOT NULL,
      aggregate_id UUID NOT NULL,
      event_type VARCHAR(64) NOT NULL,
      version INT NOT NULL DEFAULT 1,
      correlation_id UUID NOT NULL,
      producer VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ NULL
    );
    CREATE INDEX idx_outbox_unpublished ON outbox_events (occurred_at ASC) WHERE published_at IS NULL;
    CREATE TABLE processed_messages (
      message_id UUID NOT NULL,
      consumer_name VARCHAR(64) NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, consumer_name)
    );
    CREATE TABLE gate_effects (
      message_id UUID PRIMARY KEY,
      applied_count INT NOT NULL
    );
  `);
});

beforeEach(async () => {
  await ds.query(`TRUNCATE outbox_events, processed_messages, gate_effects`);
});

afterEach(async () => {
  if (connections.length > 0) {
    const cleanup = await connections[0].createChannel().catch(() => null);
    for (const q of queuesToDelete.splice(0)) {
      await cleanup?.deleteQueue(q).catch(() => undefined);
    }
  }
  for (const c of connections.splice(0)) {
    await c.close().catch(() => undefined);
  }
});

afterAll(async () => {
  await ds?.destroy();
  await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin?.destroy();
});

describe('Phase 5 Go/No-Go gate: outbox relay + idempotent consumer', () => {
  it('G1: relay killed mid-batch -> 0 lost events, 0 duplicate consumer effects', async () => {
    const fx = await setupFixture();
    await fx.runner.registerConsumer(fx.queue, 'gate-consumer', recordEffect);
    const ids = await insertOutbox(fx.routingKey, 100);

    // Crash after 37 broker-confirmed publishes, before published_at commits.
    const crashing = new OutboxRelay(ds, await (await newConnection()).createConfirmChannel());
    await expect(
      crashing.relayNextBatch({ batchSize: 100, killAfterPublishCount: 37 }),
    ).rejects.toThrow('SIMULATED_RELAY_CRASH_MID_BATCH');
    expect(await scalar(`SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL`)).toBe(
      100,
    );

    // "Restarted" relay on a fresh connection drains everything.
    const restarted = new OutboxRelay(ds, await (await newConnection()).createConfirmChannel());
    expect(await drainRelay(restarted, 100)).toBe(100);

    await waitFor(async () => fx.tapped.length === 137, 20_000, '137 broker deliveries');
    await waitFor(
      async () => (await scalar(`SELECT COUNT(*) AS n FROM processed_messages`)) === 100,
      20_000,
      '100 processed messages',
    );
    await waitFor(
      async () => (await fx.consumerCh.checkQueue(fx.queue)).messageCount === 0,
      20_000,
      'consumer queue drained',
    );
    await new Promise((r) => setTimeout(r, 500)); // let any in-flight duplicate finish

    expect(new Set(fx.tapped).size).toBe(100); // every event delivered...
    expect([...new Set(fx.tapped)].sort()).toEqual([...ids].sort()); // ...and only these events
    expect(await scalar(`SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL`)).toBe(
      0,
    ); // 0 lost
    expect(await scalar(`SELECT COUNT(*) AS n FROM gate_effects`)).toBe(100);
    expect(await scalar(`SELECT COUNT(*) AS n FROM gate_effects WHERE applied_count <> 1`)).toBe(0); // 0 duplicate effects
    expect((await fx.consumerCh.checkQueue(fx.topology.dlqQueue)).messageCount).toBe(0);
    expect(fx.runner.getDlqCount()).toBe(0);
  });

  it('G2: two concurrent relays publish each event exactly once (FOR UPDATE SKIP LOCKED)', async () => {
    const fx = await setupFixture();
    await insertOutbox(fx.routingKey, 500);

    const relayA = new OutboxRelay(ds, await (await newConnection()).createConfirmChannel());
    const relayB = new OutboxRelay(ds, await (await newConnection()).createConfirmChannel());
    const [a, b] = await Promise.all([drainRelay(relayA, 50), drainRelay(relayB, 50)]);

    expect(a + b).toBe(500);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    await waitFor(async () => fx.tapped.length >= 500, 20_000, '500 deliveries');
    await new Promise((r) => setTimeout(r, 300));
    expect(fx.tapped.length).toBe(500);
    expect(new Set(fx.tapped).size).toBe(500);
  });

  it('G3: transient handler failure is retried and applied exactly once', async () => {
    const fx = await setupFixture(FAST_RETRY_DELAYS_MS);
    const attempts = new Map<string, number>();
    await fx.runner.registerConsumer<{ seq: number }>(
      fx.queue,
      'gate-consumer',
      async (env, manager) => {
        const n = (attempts.get(env.id) ?? 0) + 1;
        attempts.set(env.id, n);
        if (env.payload.seq <= 5 && n === 1) throw new Error('transient failure');
        await recordEffect(env, manager);
      },
    );
    await insertOutbox(fx.routingKey, 20);
    await drainRelay(new OutboxRelay(ds, await (await newConnection()).createConfirmChannel()));

    await waitFor(
      async () => (await scalar(`SELECT COUNT(*) AS n FROM gate_effects`)) === 20,
      20_000,
      '20 effects',
    );
    expect(await scalar(`SELECT COUNT(*) AS n FROM gate_effects WHERE applied_count <> 1`)).toBe(0);
    expect([...attempts.values()].filter((n) => n === 2)).toHaveLength(5);
    expect([...attempts.values()].filter((n) => n > 2)).toHaveLength(0);
    expect(fx.runner.getDlqCount()).toBe(0);
  });

  it('G4: permanently failing message lands in DLQ after 3 retries with no effect', async () => {
    const fx = await setupFixture(FAST_RETRY_DELAYS_MS);
    let calls = 0;
    await fx.runner.registerConsumer(fx.queue, 'gate-consumer', async () => {
      calls += 1;
      throw new Error('poison');
    });
    await insertOutbox(fx.routingKey, 1);
    await drainRelay(new OutboxRelay(ds, await (await newConnection()).createConfirmChannel()));

    await waitFor(
      async () => (await fx.consumerCh.checkQueue(fx.topology.dlqQueue)).messageCount === 1,
      20_000,
      'message in DLQ',
    );
    expect(calls).toBe(4); // first attempt + 3 retries
    expect(fx.runner.getDlqCount()).toBe(1);
    expect(await scalar(`SELECT COUNT(*) AS n FROM gate_effects`)).toBe(0);
    expect(await scalar(`SELECT COUNT(*) AS n FROM processed_messages`)).toBe(0);
    const dead = await fx.consumerCh.get(fx.topology.dlqQueue, { noAck: true });
    expect(dead && dead.properties.headers?.['x-retry-count']).toBe(3);
    expect(dead && dead.properties.headers?.['x-death-reason']).toBe('poison');
  });

  it('G5: malformed JSON goes straight to the DLQ', async () => {
    const fx = await setupFixture(FAST_RETRY_DELAYS_MS);
    let calls = 0;
    await fx.runner.registerConsumer(fx.queue, 'gate-consumer', async () => {
      calls += 1;
    });
    const pub = await (await newConnection()).createConfirmChannel();
    pub.publish(KIRANA_EVENTS_EXCHANGE, fx.routingKey, Buffer.from('{not json'), {
      persistent: true,
    });
    await pub.waitForConfirms();

    await waitFor(
      async () => (await fx.consumerCh.checkQueue(fx.topology.dlqQueue)).messageCount === 1,
      10_000,
      'invalid JSON in DLQ',
    );
    const dead = await fx.consumerCh.get(fx.topology.dlqQueue, { noAck: true });
    expect(dead && dead.properties.headers?.['x-death-reason']).toBe('INVALID_JSON');
    expect(calls).toBe(0);
  });

  it('G6: redelivery after a committed-but-unacked effect is skipped', async () => {
    const fx = await setupFixture();
    const [id] = await insertOutbox(fx.routingKey, 1);
    // Emulate "consumer committed processed_messages + effect, then crashed before ACK".
    await ds.query(
      `INSERT INTO processed_messages (message_id, consumer_name) VALUES ($1, 'gate-consumer')`,
      [id],
    );
    await ds.query(`INSERT INTO gate_effects (message_id, applied_count) VALUES ($1, 1)`, [id]);

    let handlerCalls = 0;
    await fx.runner.registerConsumer(fx.queue, 'gate-consumer', async (env, manager) => {
      handlerCalls += 1;
      await recordEffect(env, manager);
    });
    await drainRelay(new OutboxRelay(ds, await (await newConnection()).createConfirmChannel()));

    await waitFor(async () => fx.tapped.length === 1, 10_000, 'delivery');
    await waitFor(
      async () => (await fx.consumerCh.checkQueue(fx.queue)).messageCount === 0,
      10_000,
      'queue drained',
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(handlerCalls).toBe(0);
    expect(
      await scalar(`SELECT applied_count AS n FROM gate_effects WHERE message_id = $1`, [id]),
    ).toBe(1);
  });

  it('G7: a short retry is not blocked behind a longer retry (no head-of-line blocking)', async () => {
    const fx = await setupFixture([200, 3000, 200]);
    let aAttempts = 0;
    let bFailedAt = 0;
    let bSucceededAt = 0;
    await fx.runner.registerConsumer<{ tag: string }>(
      fx.queue,
      'gate-consumer',
      async (env, manager) => {
        if (env.payload.tag === 'A') {
          aAttempts += 1;
          if (aAttempts <= 2) throw new Error('A fails twice');
        } else if (bFailedAt === 0) {
          bFailedAt = Date.now();
          throw new Error('B fails once');
        } else {
          bSucceededAt = Date.now();
        }
        await recordEffect(env, manager);
      },
    );
    const pub = await (await newConnection()).createConfirmChannel();
    const publish = (tag: string) => {
      const envelope: KiranaEventEnvelope = {
        id: randomUUID(),
        type: fx.routingKey,
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        producer: 'gate-test',
        payload: { tag },
      };
      pub.publish(KIRANA_EVENTS_EXCHANGE, fx.routingKey, Buffer.from(JSON.stringify(envelope)), {
        persistent: true,
        messageId: envelope.id,
      });
    };

    publish('A');
    await pub.waitForConfirms();
    // Wait until A has failed twice, so it is now parked on the 3000 ms retry.
    await waitFor(async () => aAttempts === 2, 10_000, 'A second failure');
    publish('B');
    await pub.waitForConfirms();

    await waitFor(async () => bSucceededAt > 0, 10_000, 'B retried successfully');
    expect(bSucceededAt - bFailedAt).toBeLessThan(1500);
  });

  it('G8: a message without any id is dead-lettered immediately instead of burning retries', async () => {
    const fx = await setupFixture(FAST_RETRY_DELAYS_MS);
    let calls = 0;
    await fx.runner.registerConsumer(fx.queue, 'gate-consumer', async () => {
      calls += 1;
    });
    const pub = await (await newConnection()).createConfirmChannel();
    pub.publish(
      KIRANA_EVENTS_EXCHANGE,
      fx.routingKey,
      Buffer.from(JSON.stringify({ type: 'x', payload: {} })),
      { persistent: true },
    );
    await pub.waitForConfirms();

    await waitFor(
      async () => (await fx.consumerCh.checkQueue(fx.topology.dlqQueue)).messageCount === 1,
      10_000,
      'id-less message in DLQ',
    );
    const dead = await fx.consumerCh.get(fx.topology.dlqQueue, { noAck: true });
    expect(dead && dead.properties.headers?.['x-death-reason']).toBe('MISSING_MESSAGE_ID');
    expect(dead && dead.properties.headers?.['x-retry-count']).toBeUndefined();
    expect(calls).toBe(0);
  });
});

describe('Slice 3b: OutboxRelayWorker', () => {
  it('W1: a running worker publishes existing and newly written outbox rows', async () => {
    const fx = await setupFixture();
    await fx.runner.registerConsumer(fx.queue, 'gate-consumer', recordEffect);
    await insertOutbox(fx.routingKey, 30);

    const worker = new OutboxRelayWorker(ds, {
      amqpUrl: AMQP_URL,
      serviceName: 'gate-test',
      idleIntervalMs: 100,
    });
    worker.start();
    try {
      await waitFor(
        async () =>
          (await scalar(`SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL`)) ===
          0,
        15_000,
        'initial rows published',
      );
      await insertOutbox(fx.routingKey, 20); // written while the worker is running
      await waitFor(
        async () => (await scalar(`SELECT COUNT(*) AS n FROM gate_effects`)) === 50,
        15_000,
        '50 effects',
      );
      expect(worker.isConnected()).toBe(true);
      expect(worker.getPublishedTotal()).toBe(50);
      expect(fx.tapped.length).toBe(50);
      expect(await scalar(`SELECT COUNT(*) AS n FROM gate_effects WHERE applied_count <> 1`)).toBe(
        0,
      );
    } finally {
      await worker.stop();
    }
  });

  it('W2: broker unreachable -> no crash, events stay in the outbox, stop() resolves', async () => {
    await insertOutbox('gate.unreachable.evt', 5);
    const worker = new OutboxRelayWorker(ds, {
      amqpUrl: 'amqp://kirana_admin:secretpassword@127.0.0.1:5999', // nothing listens here
      serviceName: 'gate-test',
      minBackoffMs: 100,
      maxBackoffMs: 200,
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 800)); // several failed connection attempts
    expect(worker.isConnected()).toBe(false);
    expect(await scalar(`SELECT COUNT(*) AS n FROM outbox_events WHERE published_at IS NULL`)).toBe(
      5,
    );
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});

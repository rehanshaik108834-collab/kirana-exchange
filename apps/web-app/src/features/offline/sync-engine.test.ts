import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblemError } from '../../lib/api-client';
import { freshIndexedDb } from '../../test/fresh-indexeddb';
import { enqueue, listEntries, type StoredEntry } from './queue';
import { type SyncDeps, SyncEngine } from './sync-engine';

const owner = { userId: 'u1', shopId: 's1' };
const problem = (status: number, slug = 'x') =>
  new ApiProblemError({
    status,
    type: `https://kirana-exchange.local/errors/${slug}`,
    title: slug,
    detail: `${slug} detail`,
    body: { slug },
  });

async function queueSale(batchId: string, key: string, expectedVersion = 1) {
  return enqueue(
    {
      kind: 'sale',
      payload: { shopId: 's1', batchId, qty: 1, expectedVersion, soldAt: '2026-11-22T10:00:00Z' },
    },
    owner,
    key,
  );
}

function engine(overrides: Partial<SyncDeps> = {}) {
  const timers: Array<() => void> = [];
  const deps: SyncDeps = {
    send: vi.fn(async () => ({ batch: { id: 'b' } })),
    getOwner: () => owner,
    isOnline: () => true,
    onSynced: vi.fn(),
    backoffMs: [10],
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
    ...overrides,
  };
  return { engine: new SyncEngine(deps), deps, timers };
}

const sentKeys = (send: SyncDeps['send']) =>
  (send as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as StoredEntry).idempotencyKey);

beforeEach(freshIndexedDb);

describe('SyncEngine (client-side outbox drain)', () => {
  it('sends entries FIFO with their own keys, removes them, and reports idle', async () => {
    await queueSale('b1', 'k1');
    await queueSale('b2', 'k2');
    await queueSale('b1', 'k3', 2);
    const { engine: e, deps } = engine();
    await e.requestSync();
    expect(sentKeys(deps.send)).toEqual(['k1', 'k2', 'k3']);
    expect(await listEntries(owner)).toHaveLength(0);
    expect(deps.onSynced).toHaveBeenCalledTimes(3);
    expect(e.state).toBe('idle');
  });

  it('sync triggered twice (and more) concurrently sends each entry exactly once', async () => {
    for (let i = 0; i < 20; i++) await queueSale('b1', `k${i}`, i + 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = vi.fn(async () => {
      await gate; // hold the first run open while more triggers arrive
      return { batch: { id: 'b1' } };
    });
    const { engine: e } = engine({ send });
    const runs = [e.requestSync(), e.requestSync(), e.requestSync()];
    release();
    await Promise.all(runs);
    await e.requestSync(); // the coalesced follow-up run finds nothing left
    expect(sentKeys(send)).toEqual(Array.from({ length: 20 }, (_, i) => `k${i}`));
    expect(await listEntries(owner)).toHaveLength(0);
  });

  it('network failure stops the run, keeps the queue, and schedules a retry', async () => {
    await queueSale('b1', 'k1');
    await queueSale('b1', 'k2', 2);
    const send = vi.fn().mockRejectedValueOnce(problem(0));
    const { engine: e, timers } = engine({ send });
    await e.requestSync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(e.state).toBe('offline');
    expect((await listEntries(owner)).map((x) => x.status)).toEqual(['pending', 'pending']);
    expect(timers).toHaveLength(1);
  });

  it('5xx / 429 wait and retry without marking a conflict', async () => {
    await queueSale('b1', 'k1');
    const send = vi.fn().mockRejectedValueOnce(problem(503, 'service-unavailable'));
    const { engine: e, timers } = engine({ send });
    await e.requestSync();
    expect(e.state).toBe('waiting');
    expect((await listEntries(owner))[0].status).toBe('pending');
    expect(timers).toHaveLength(1);
  });

  it('a version conflict needs attention; later sales on that batch are blocked, others continue', async () => {
    await queueSale('b1', 'k1', 1);
    await queueSale('b1', 'k2', 2);
    await queueSale('b2', 'k3', 7);
    const send = vi.fn(async (entry: StoredEntry) => {
      if (entry.idempotencyKey === 'k1') throw problem(409, 'version-conflict');
      return { batch: { id: 'b2' } };
    });
    const { engine: e } = engine({ send });
    await e.requestSync();

    expect(sentKeys(send)).toEqual(['k1', 'k3']); // k2 never sent
    const left = await listEntries(owner);
    expect(left.map((x) => [x.idempotencyKey, x.status])).toEqual([
      ['k1', 'conflict'],
      ['k2', 'blocked'],
    ]);
    expect(left[0].lastError).toMatchObject({
      type: 'https://kirana-exchange.local/errors/version-conflict',
      body: { slug: 'version-conflict' },
    });
  });

  it('401 after a failed refresh keeps the queue until the user signs in again', async () => {
    await queueSale('b1', 'k1');
    const { engine: e } = engine({ send: vi.fn().mockRejectedValue(problem(401)) });
    await e.requestSync();
    expect(e.state).toBe('signed-out');
    expect(await listEntries(owner)).toHaveLength(1);
  });

  it('does nothing while offline or without a signed-in shop', async () => {
    await queueSale('b1', 'k1');
    const offline = engine({ isOnline: () => false });
    await offline.engine.requestSync();
    expect(offline.deps.send).not.toHaveBeenCalled();
    expect(offline.engine.state).toBe('offline');

    const signedOut = engine({ getOwner: () => null });
    await signedOut.engine.requestSync();
    expect(signedOut.deps.send).not.toHaveBeenCalled();
    expect(signedOut.engine.state).toBe('signed-out');
  });

  it('only syncs entries that belong to the signed-in user and shop', async () => {
    await queueSale('b1', 'mine');
    await enqueue(
      {
        kind: 'sale',
        payload: {
          shopId: 's2',
          batchId: 'x',
          qty: 1,
          expectedVersion: 1,
          soldAt: '2026-11-22T10:00:00Z',
        },
      },
      { userId: 'u2', shopId: 's2' },
      'theirs',
    );
    const { engine: e, deps } = engine();
    await e.requestSync();
    expect(sentKeys(deps.send)).toEqual(['mine']);
  });
});

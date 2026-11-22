import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '../../lib/api-client';
import { freshIndexedDb } from '../../test/fresh-indexeddb';
import { enqueue, listEntries, type StoredEntry, updateEntry } from './queue';
import {
  conflictKind,
  countOnCurrentStock,
  countReducedQty,
  describeConflict,
  discardEntry,
  rebaseBatchSales,
} from './resolve';
import { syncEngine } from './runtime';

const TYPE = 'https://kirana-exchange.local/errors/';
const owner = { userId: 'u1', shopId: 's1' };

function fakeJwt(payload: object): string {
  const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`;
}

async function sale(batchId: string, key: string, expectedVersion: number, qty = 1) {
  return enqueue(
    {
      kind: 'sale',
      payload: { shopId: 's1', batchId, qty, expectedVersion, soldAt: '2026-11-22T10:00:00Z' },
      display: { productName: 'Parle-G 50g' },
    },
    owner,
    key,
  );
}

beforeEach(async () => {
  await freshIndexedDb();
  localStorage.setItem('accessToken', fakeJwt({ sub: 'u1', role: 'shop_owner', shopId: 's1' }));
  vi.spyOn(syncEngine, 'requestSync').mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('conflict wording (US-14)', () => {
  it('explains version conflicts and insufficient stock in plain language', () => {
    const base = {
      kind: 'sale',
      display: { productName: 'Parle-G 50g' },
      payload: { qty: 2, batchId: 'b1' },
    } as unknown as StoredEntry;
    const version = { ...base, lastError: { type: `${TYPE}version-conflict`, detail: 'x' } };
    expect(conflictKind(version)).toBe('version-conflict');
    expect(describeConflict(version).message).toMatch(/changed on another phone/);
    expect(describeConflict(version).message).not.toMatch(/version|409|conflict/i);

    const short = {
      ...base,
      lastError: {
        type: `${TYPE}insufficient-unreserved-stock`,
        detail: 'x',
        body: { available: 1 },
      },
    };
    expect(describeConflict(short)).toMatchObject({ kind: 'insufficient-stock', available: 1 });
    expect(describeConflict(short).message).toMatch(/Only 1 can be sold now/);
  });
});

describe('rebaseBatchSales', () => {
  it('re-chains every unsent sale of the batch onto the current version, FIFO, and unblocks them', () => {
    const entries = [
      {
        seq: 1,
        kind: 'sale',
        payload: { batchId: 'b1', qty: 1, expectedVersion: 3 },
        status: 'conflict',
      },
      {
        seq: 2,
        kind: 'sale',
        payload: { batchId: 'b2', qty: 1, expectedVersion: 9 },
        status: 'pending',
      },
      {
        seq: 3,
        kind: 'sale',
        payload: { batchId: 'b1', qty: 2, expectedVersion: 4 },
        status: 'blocked',
      },
    ] as unknown as StoredEntry[];
    const patches = rebaseBatchSales(entries, 'b1', 7, new Map([[3, { qty: 1 }]]));
    expect(
      patches.map((p) => [
        p.seq,
        p.patch.status,
        p.patch.payload as { expectedVersion: number; qty: number },
      ]),
    ).toEqual([
      [1, 'pending', expect.objectContaining({ expectedVersion: 7, qty: 1 })],
      [3, 'pending', expect.objectContaining({ expectedVersion: 8, qty: 1 })],
    ]);
  });
});

describe('resolution actions', () => {
  beforeEach(() => {
    vi.spyOn(apiClient, 'get').mockResolvedValue({
      data: [{ id: 'b1', shopId: 's1', version: 12, qty: 5, reservedQty: 0 }],
    } as never);
  });

  it('count on current stock: same key, rebased on the server version, conflict cleared', async () => {
    const first = await sale('b1', 'k1', 3);
    await sale('b1', 'k2', 4);
    await updateEntry(first.seq!, {
      status: 'conflict',
      lastError: { type: `${TYPE}version-conflict`, detail: 'x' },
    });

    await countOnCurrentStock((await listEntries(owner))[0]);

    const after = await listEntries(owner);
    expect(
      after.map((e) => [
        e.idempotencyKey,
        e.status,
        e.kind === 'sale' && e.payload.expectedVersion,
      ]),
    ).toEqual([
      ['k1', 'pending', 12],
      ['k2', 'pending', 13],
    ]);
    expect(after[0].lastError).toBeUndefined();
    expect(syncEngine.requestSync).toHaveBeenCalled();
  });

  it('count a reduced quantity when only part of the stock is left', async () => {
    const e = await sale('b1', 'k1', 3, 4);
    await countReducedQty({ ...e, status: 'conflict' }, 2);
    const [after] = await listEntries(owner);
    expect(after.kind === 'sale' && [after.payload.qty, after.payload.expectedVersion]).toEqual([
      2, 12,
    ]);
  });

  it('discard removes the entry and rebases the sales queued behind it', async () => {
    const first = await sale('b1', 'k1', 3);
    await sale('b1', 'k2', 4);
    await discardEntry(first);
    const after = await listEntries(owner);
    expect(
      after.map((e) => [e.idempotencyKey, e.kind === 'sale' && e.payload.expectedVersion]),
    ).toEqual([['k2', 12]]);
  });
});

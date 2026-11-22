import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshIndexedDb } from '../test/fresh-indexeddb';
import { getDb } from './db';
import {
  isPersistedKey,
  MAX_PERSISTED_AGE_MS,
  restorePersistedQueries,
  startPersistingQueries,
} from './query-persistence';

beforeEach(freshIndexedDb);

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('query persistence', () => {
  it('allow-lists only stock, own shop, and product names', () => {
    expect(isPersistedKey(['inventory', 'batches', 's1'])).toBe(true);
    expect(isPersistedKey(['shops', 'me'])).toBe(true);
    expect(isPersistedKey(['catalog', 'by-ids', ['p1']])).toBe(true);
    expect(isPersistedKey(['catalog', 'search', 'parle'])).toBe(false);
  });

  it('persists server-fetched data and restores it into a new client (offline reload)', async () => {
    const first = new QueryClient();
    startPersistingQueries(first);
    await first.fetchQuery({
      queryKey: ['inventory', 'batches', 's1'],
      queryFn: async () => [{ id: 'b1', qty: 7 }],
    });
    await first.fetchQuery({ queryKey: ['catalog', 'search', 'x'], queryFn: async () => ['nope'] });
    await flush();

    const second = new QueryClient();
    expect(await restorePersistedQueries(second)).toBe(1);
    expect(second.getQueryData(['inventory', 'batches', 's1'])).toEqual([{ id: 'b1', qty: 7 }]);
    expect(second.getQueryData(['catalog', 'search', 'x'])).toBeUndefined();
  });

  it('never persists optimistic/manual cache writes', async () => {
    const client = new QueryClient();
    startPersistingQueries(client);
    client.setQueryData(['inventory', 'batches', 's1'], [{ id: 'b1', qty: 6 }]); // optimistic
    await flush();
    expect(await (await getDb()).count('query_cache')).toBe(0);
  });

  it('drops snapshots older than the maximum age', async () => {
    const db = await getDb();
    await db.put('query_cache', {
      hash: 'old',
      queryKey: ['shops', 'me'],
      data: { id: 's1' },
      dataUpdatedAt: Date.now() - MAX_PERSISTED_AGE_MS - 1,
    });
    const client = new QueryClient();
    expect(await restorePersistedQueries(client)).toBe(0);
    expect(await db.count('query_cache')).toBe(0);
  });
});

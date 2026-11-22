import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { getDb } from './db';

/** Only these server snapshots are kept on the device (data minimisation). */
const PERSISTED_PREFIXES: ReadonlyArray<readonly string[]> = [
  ['inventory', 'batches'],
  ['shops', 'me'],
  ['catalog', 'by-ids'],
];
export const MAX_PERSISTED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isPersistedKey(queryKey: QueryKey): boolean {
  return PERSISTED_PREFIXES.some((prefix) => prefix.every((part, i) => queryKey[i] === part));
}

/** Restore saved snapshots before the first render so an offline reload shows the last known stock. */
export async function restorePersistedQueries(
  queryClient: QueryClient,
  now = Date.now(),
): Promise<number> {
  const db = await getDb();
  let restored = 0;
  for (const entry of await db.getAll('query_cache')) {
    if (now - entry.dataUpdatedAt > MAX_PERSISTED_AGE_MS || !isPersistedKey(entry.queryKey)) {
      await db.delete('query_cache', entry.hash);
      continue;
    }
    queryClient.setQueryData(entry.queryKey, entry.data, { updatedAt: entry.dataUpdatedAt });
    restored += 1;
  }
  return restored;
}

/**
 * Persist server-fetched results for allow-listed queries.
 * Manual cache writes (optimistic updates via setQueryData) are deliberately NOT persisted:
 * an unconfirmed local change must never survive a restart as if the server had accepted it.
 */
export function startPersistingQueries(queryClient: QueryClient): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual) return;
    const { queryKey, queryHash, state } = event.query;
    if (!isPersistedKey(queryKey)) return;
    void getDb()
      .then((db) =>
        db.put('query_cache', {
          hash: queryHash,
          queryKey: queryKey as unknown[],
          data: state.data,
          dataUpdatedAt: state.dataUpdatedAt,
        }),
      )
      .catch(() => undefined); // storage full / private mode: app still works online
  });
}

import { useEffect, useState, useSyncExternalStore } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { apiClient } from '../../lib/api-client';
import { queryClient } from '../../lib/query-client';
import { currentClaims } from '../../lib/session';
import { batchesKey, type InventoryBatch } from '../inventory/hooks';
import { enqueue, listEntries, type StoredEntry, subscribeQueue } from './queue';
import { SyncEngine, type SyncOwner, type SyncState } from './sync-engine';

export function currentOwner(): SyncOwner | null {
  const claims = currentClaims();
  return claims?.shopId ? { userId: claims.sub, shopId: claims.shopId } : null;
}

async function send(entry: StoredEntry): Promise<unknown> {
  const headers = { 'Idempotency-Key': entry.idempotencyKey };
  const path = entry.kind === 'sale' ? '/inventory/sales' : '/inventory/batches';
  const { data } = await apiClient.post(path, entry.payload, { headers });
  return data;
}

function onSynced(entry: StoredEntry, response: unknown): void {
  const key = batchesKey(entry.shopId);
  if (entry.kind === 'sale') {
    const batch = (response as { batch: InventoryBatch }).batch;
    // Confirmed server state (not optimistic): safe to show and to persist on the next fetch.
    queryClient.setQueryData<InventoryBatch[]>(key, (batches) =>
      batches?.map((b) => (b.id === batch.id ? batch : b)),
    );
  }
  void queryClient.invalidateQueries({ queryKey: key });
}

const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;

export const syncEngine = new SyncEngine({
  send,
  getOwner: currentOwner,
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  onSynced,
  // DOM typings say Promise<Promise<T>>; promises flatten at runtime, so this is Promise<T>.
  lock: locks
    ? <T>(name: string, fn: () => Promise<T>) => locks.request(name, fn) as unknown as Promise<T>
    : undefined,
});

/** Sync triggers: app start, reconnect, tab becoming visible, and every 30 s. */
export function useSyncTriggers(): void {
  useEffect(() => {
    void syncEngine.requestSync();
    const onOnline = () => void syncEngine.requestSync();
    const onOffline = () => void syncEngine.requestSync(); // flips the chip to "Offline"
    const onVisible = () => document.visibilityState === 'visible' && void syncEngine.requestSync();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(() => void syncEngine.requestSync(), 30_000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(interval);
    };
  }, []);
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(
    (cb) => {
      syncEngine.events.addEventListener('state', cb);
      return () => syncEngine.events.removeEventListener('state', cb);
    },
    () => syncEngine.state,
  );
}

/** Live view of the current shop's queue (this tab and other tabs). */
export function useQueueEntries(): StoredEntry[] {
  const [entries, setEntries] = useState<StoredEntry[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      const owner = currentOwner();
      if (!owner) return setEntries([]);
      void listEntries(owner).then((list) => alive && setEntries(list));
    };
    load();
    const unsubscribe = subscribeQueue(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return entries;
}

/** Commit a sale to the device first, then try to sync it right away. */
export async function enqueueSale(
  batch: { id: string; shopId: string; version: number },
  productName: string,
  qty = 1,
): Promise<void> {
  const owner = currentOwner();
  if (!owner) throw new Error('Not signed in to a shop');
  await enqueue(
    {
      kind: 'sale',
      payload: {
        shopId: batch.shopId,
        batchId: batch.id,
        qty,
        expectedVersion: batch.version, // projected version: chains offline sales
        soldAt: new Date().toISOString(),
      },
      display: { productName },
    },
    owner,
    uuidv4(),
  );
  void syncEngine.requestSync();
}

export async function enqueueBatch(
  payload: {
    shopId: string;
    productId: string;
    batchCode: string;
    qty: number;
    costPrice: number;
    expiryDate: string;
  },
  productName: string,
  idempotencyKey: string,
): Promise<void> {
  const owner = currentOwner();
  if (!owner) throw new Error('Not signed in to a shop');
  try {
    await enqueue({ kind: 'batch', payload, display: { productName } }, owner, idempotencyKey);
  } catch (err) {
    // Same Idempotency-Key already queued (double submit): it is the same entry, not an error.
    if (!(err instanceof DOMException && err.name === 'ConstraintError')) throw err;
  }
  void syncEngine.requestSync();
}

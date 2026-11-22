import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

/**
 * Browser IndexedDB for the offline-capable PWA (phase-1 §1: `offline_mutation_queue`, `catalog_cache`).
 * Everything here is private shop data and is wiped on sign-out (`clearLocalData`).
 */

export type QueueStatus = 'pending' | 'conflict' | 'blocked';

export interface SaleQueuePayload {
  shopId: string;
  batchId: string;
  qty: number;
  expectedVersion: number;
  soldAt: string;
}

export interface BatchQueuePayload {
  shopId: string;
  productId: string;
  batchCode: string;
  qty: number;
  costPrice: number;
  expiryDate: string;
}

interface QueueEntryBase {
  /** Auto-increment primary key = FIFO order, even for taps in the same millisecond. */
  seq?: number;
  idempotencyKey: string;
  userId: string;
  shopId: string;
  status: QueueStatus;
  attempts: number;
  lastError?: { type: string; detail: string; body?: Record<string, unknown> };
  createdAt: number;
  updatedAt: number;
}

export type QueueEntry =
  | (QueueEntryBase & { kind: 'sale'; payload: SaleQueuePayload })
  | (QueueEntryBase & { kind: 'batch'; payload: BatchQueuePayload });

export interface CachedProduct {
  id: string;
  ean: string;
  name: string;
  brand: string;
  packSize: string;
  category: string;
  mrp: string;
  gstRate: string;
  shelfLifeDays: number;
  isActive: boolean;
  /** For eviction of the least recently seen products. */
  lastSeenAt: number;
}

export interface PersistedQuery {
  hash: string;
  queryKey: unknown[];
  data: unknown;
  dataUpdatedAt: number;
}

interface KiranaDB extends DBSchema {
  offline_mutation_queue: {
    key: number;
    value: QueueEntry;
    indexes: { by_idempotency_key: string; by_shop: string };
  };
  catalog_cache: {
    key: string;
    value: CachedProduct;
    indexes: { by_ean: string; by_last_seen: number };
  };
  query_cache: {
    key: string;
    value: PersistedQuery;
  };
}

export const DB_NAME = 'kirana-exchange';
const DB_VERSION = 1;
export const CATALOG_CACHE_LIMIT = 2000;

let dbPromise: Promise<IDBPDatabase<KiranaDB>> | null = null;

export function getDb(): Promise<IDBPDatabase<KiranaDB>> {
  if (!dbPromise) {
    dbPromise = openDB<KiranaDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const queue = db.createObjectStore('offline_mutation_queue', {
          keyPath: 'seq',
          autoIncrement: true,
        });
        queue.createIndex('by_idempotency_key', 'idempotencyKey', { unique: true });
        queue.createIndex('by_shop', 'shopId');

        const catalog = db.createObjectStore('catalog_cache', { keyPath: 'id' });
        catalog.createIndex('by_ean', 'ean');
        catalog.createIndex('by_last_seen', 'lastSeenAt');

        db.createObjectStore('query_cache', { keyPath: 'hash' });
      },
    });
  }
  return dbPromise;
}

/** Tests only: drop the cached connection so a fresh fake IndexedDB can be used. */
export async function closeDbForTests(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
}

/** Privacy (US-05): remove every locally stored record for the signed-in shop. */
export async function clearLocalData(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(
    ['offline_mutation_queue', 'catalog_cache', 'query_cache'],
    'readwrite',
  );
  await Promise.all([
    tx.objectStore('offline_mutation_queue').clear(),
    tx.objectStore('catalog_cache').clear(),
    tx.objectStore('query_cache').clear(),
    tx.done,
  ]);
}

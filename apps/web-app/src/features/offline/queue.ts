import {
  type BatchQueuePayload,
  getDb,
  type QueueEntry,
  type SaleQueuePayload,
} from '../../lib/db';

/**
 * offline_mutation_queue: every write is committed here first (client-side outbox, mirrors ADR-003),
 * then drained by the sync engine with the entry's own Idempotency-Key.
 */

export interface EntryDisplay {
  /** Shown in the stock list and the conflict screen; never sent to the server. */
  productName?: string;
}

export type NewQueueEntry =
  | { kind: 'sale'; payload: SaleQueuePayload; display?: EntryDisplay }
  | { kind: 'batch'; payload: BatchQueuePayload; display?: EntryDisplay };

export type StoredEntry = QueueEntry & { display?: EntryDisplay };

const CHANNEL = 'kirana-offline-queue';
const localEvents = new EventTarget();
let channel: BroadcastChannel | null = null;

function broadcast(): void {
  localEvents.dispatchEvent(new Event('change'));
  try {
    channel ??= new BroadcastChannel(CHANNEL);
    channel.postMessage('change');
  } catch {
    // BroadcastChannel unavailable: other tabs refresh on their next sync tick.
  }
}

/** Notified on any queue change in this tab or another tab. Returns an unsubscribe function. */
export function subscribeQueue(listener: () => void): () => void {
  localEvents.addEventListener('change', listener);
  let remote: BroadcastChannel | null = null;
  try {
    remote = new BroadcastChannel(CHANNEL);
    remote.onmessage = () => listener();
  } catch {
    remote = null;
  }
  return () => {
    localEvents.removeEventListener('change', listener);
    remote?.close();
  };
}

export async function enqueue(
  entry: NewQueueEntry,
  owner: { userId: string; shopId: string },
  idempotencyKey: string,
  now = Date.now(),
): Promise<StoredEntry> {
  const db = await getDb();
  const record = {
    ...entry,
    idempotencyKey,
    userId: owner.userId,
    shopId: owner.shopId,
    status: 'pending' as const,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  } as StoredEntry;
  const seq = await db.add('offline_mutation_queue', record);
  broadcast();
  return { ...record, seq };
}

/** Entries for one shop and user in FIFO order (auto-increment seq). */
export async function listEntries(owner: {
  userId: string;
  shopId: string;
}): Promise<StoredEntry[]> {
  const db = await getDb();
  const all = (await db.getAllFromIndex(
    'offline_mutation_queue',
    'by_shop',
    owner.shopId,
  )) as StoredEntry[];
  return all.filter((e) => e.userId === owner.userId).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export async function updateEntry(seq: number, patch: Partial<StoredEntry>, now = Date.now()) {
  const db = await getDb();
  const tx = db.transaction('offline_mutation_queue', 'readwrite');
  const current = await tx.store.get(seq);
  if (current) await tx.store.put({ ...current, ...patch, seq, updatedAt: now } as QueueEntry);
  await tx.done;
  broadcast();
}

export async function removeEntry(seq: number): Promise<void> {
  const db = await getDb();
  await db.delete('offline_mutation_queue', seq);
  broadcast();
}

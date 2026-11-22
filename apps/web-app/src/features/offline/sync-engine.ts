import { ApiProblemError } from '../../lib/api-client';
import { listEntries, removeEntry, type StoredEntry, updateEntry } from './queue';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'waiting' | 'signed-out';

export interface SyncOwner {
  userId: string;
  shopId: string;
}

export interface SyncDeps {
  /** POST the entry with its Idempotency-Key; resolves with the server body or throws ApiProblemError. */
  send: (entry: StoredEntry) => Promise<unknown>;
  getOwner: () => SyncOwner | null;
  isOnline: () => boolean;
  /** Called after the server accepted an entry (update caches). */
  onSynced: (entry: StoredEntry, response: unknown) => void;
  /** Cross-tab mutual exclusion (Web Locks). Omit to run unlocked (single tab / tests). */
  lock?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  backoffMs?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_BACKOFF_MS = [2000, 5000, 15000, 30000] as const;

/**
 * Drains offline_mutation_queue to the API, FIFO, each entry with its own Idempotency-Key.
 *
 * How exactly-once holds:
 * 1. Single-flight in this tab: requests during a run collapse into one follow-up run.
 * 2. Single-flight across tabs: the Web Locks API serialises runs, and a later run re-reads the
 *    queue, so entries already sent and removed are not seen again.
 * 3. Even if an entry is sent twice (crash after the server committed, before removal), the server's
 *    two-tier idempotency returns the original result, so the effect happens once.
 *
 * Failure handling:
 * - network / 5xx / 429: stop, keep everything, retry with backoff (2 s, 5 s, 15 s, 30 s).
 * - 401 (refresh already failed): stop and keep the queue until the user signs in again.
 * - other 4xx (version conflict, insufficient stock, validation): mark `conflict` for the user.
 *   Later sales on the same batch become `blocked`, because their expectedVersion was chained from
 *   the conflicted one. Entries for other batches keep syncing.
 */
export class SyncEngine {
  private running: Promise<void> | null = null;
  private rerun = false;
  private retryTimer: unknown = null;
  private backoffIndex = 0;
  private stateValue: SyncState = 'idle';
  readonly events = new EventTarget();

  constructor(private readonly deps: SyncDeps) {}

  get state(): SyncState {
    return this.stateValue;
  }

  private setState(next: SyncState): void {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.events.dispatchEvent(new Event('state'));
  }

  /** Safe to call any number of times; concurrent calls share one run plus at most one follow-up. */
  requestSync(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = this.runExclusive().finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        void this.requestSync();
      }
    });
    return this.running;
  }

  private runExclusive(): Promise<void> {
    const lock = this.deps.lock;
    return lock ? lock('kirana-offline-sync', () => this.drain()) : this.drain();
  }

  private scheduleRetry(): void {
    const backoff = this.deps.backoffMs ?? DEFAULT_BACKOFF_MS;
    const delay = backoff[Math.min(this.backoffIndex, backoff.length - 1)];
    this.backoffIndex += 1;
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = this.deps.clearTimer ?? ((h) => clearTimeout(h as number));
    if (this.retryTimer !== null) clearTimer(this.retryTimer);
    this.retryTimer = setTimer(() => {
      this.retryTimer = null;
      void this.requestSync();
    }, delay);
  }

  private async drain(): Promise<void> {
    const owner = this.deps.getOwner();
    if (!owner) {
      this.setState('signed-out');
      return;
    }
    if (!this.deps.isOnline()) {
      this.setState('offline');
      return;
    }

    const entries = await listEntries(owner);
    if (entries.length === 0) {
      this.backoffIndex = 0;
      this.setState('idle');
      return;
    }
    this.setState('syncing');

    const blockedBatches = new Set<string>();
    for (const entry of entries) {
      const seq = entry.seq!;
      const batchId = entry.kind === 'sale' ? entry.payload.batchId : null;

      if (entry.status === 'conflict') {
        if (batchId) blockedBatches.add(batchId);
        continue;
      }
      if (batchId && blockedBatches.has(batchId)) {
        if (entry.status !== 'blocked') await updateEntry(seq, { status: 'blocked' });
        continue;
      }

      try {
        const response = await this.deps.send(entry);
        await removeEntry(seq);
        this.deps.onSynced(entry, response);
      } catch (err) {
        const status = err instanceof ApiProblemError ? err.status : 0;
        if (status === 0 || status === 429 || status >= 500) {
          this.setState(status === 0 ? 'offline' : 'waiting');
          this.scheduleRetry();
          return;
        }
        if (status === 401) {
          this.setState('signed-out');
          return;
        }
        // Definitive rejection: the server wrote nothing, so the user decides (conflict screen).
        const problem = err as ApiProblemError;
        await updateEntry(seq, {
          status: 'conflict',
          attempts: entry.attempts + 1,
          lastError: { type: problem.type, detail: problem.detail, body: problem.body },
        });
        if (batchId) blockedBatches.add(batchId);
      }
    }

    this.backoffIndex = 0;
    this.setState('idle');
  }
}

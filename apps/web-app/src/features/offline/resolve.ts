import { apiClient } from '../../lib/api-client';
import type { InventoryBatch } from '../inventory/hooks';
import { listEntries, removeEntry, type StoredEntry, updateEntry } from './queue';
import { currentOwner, syncEngine } from './runtime';

const TYPE_BASE = 'https://kirana-exchange.local/errors/';

export type ConflictKind = 'version-conflict' | 'insufficient-stock' | 'other';

export interface ConflictView {
  kind: ConflictKind;
  title: string;
  message: string;
  /** Only for sales: how many can be sold right now (from the server's problem response). */
  available?: number;
}

export function conflictKind(entry: StoredEntry): ConflictKind {
  const slug = entry.lastError?.type.replace(TYPE_BASE, '');
  if (entry.kind === 'sale' && slug === 'version-conflict') return 'version-conflict';
  if (entry.kind === 'sale' && slug === 'insufficient-unreserved-stock')
    return 'insufficient-stock';
  return 'other';
}

/** Plain-language explanation for a non-technical shopkeeper (US-14): no codes, no jargon. */
export function describeConflict(entry: StoredEntry): ConflictView {
  const name = entry.display?.productName ?? 'this item';
  const kind = conflictKind(entry);
  if (entry.kind === 'sale' && kind === 'version-conflict') {
    return {
      kind,
      title: `Sale of ${entry.payload.qty} × ${name}`,
      message:
        'The stock of this item changed on another phone while yours was offline, so this sale is not counted yet.',
    };
  }
  if (entry.kind === 'sale' && kind === 'insufficient-stock') {
    const available = Number(entry.lastError?.body?.available ?? 0);
    return {
      kind,
      title: `Sale of ${entry.payload.qty} × ${name}`,
      message:
        available > 0
          ? `Only ${available} can be sold now (the rest was sold or reserved), so this sale is not counted yet.`
          : 'There is no stock left to sell for this batch, so this sale is not counted.',
      available,
    };
  }
  if (entry.kind === 'batch') {
    return {
      kind,
      title: `New batch ${entry.payload.batchCode} of ${name}`,
      message: `This batch could not be saved: ${entry.lastError?.detail ?? 'unknown problem'}. Discard it and add it again with the correct details.`,
    };
  }
  return {
    kind,
    title: `Sale of ${entry.payload.qty} × ${name}`,
    message: `This sale could not be saved: ${entry.lastError?.detail ?? 'unknown problem'}.`,
  };
}

/**
 * Re-chains the unsent sales of one batch onto the server's current version, in FIFO order.
 * After a conflict every later sale on that batch carries a stale expectedVersion (it was chained
 * from the rejected one), so all of them must be rebased together: current, current+1, ...
 * Pure: returns the patches to apply.
 */
export function rebaseBatchSales(
  entries: StoredEntry[],
  batchId: string,
  currentVersion: number,
  overrides: Map<number, { qty: number }> = new Map(),
): Array<{ seq: number; patch: Partial<StoredEntry> }> {
  let version = currentVersion;
  const patches: Array<{ seq: number; patch: Partial<StoredEntry> }> = [];
  for (const entry of entries) {
    if (entry.kind !== 'sale' || entry.payload.batchId !== batchId) continue;
    const qty = overrides.get(entry.seq!)?.qty ?? entry.payload.qty;
    patches.push({
      seq: entry.seq!,
      patch: {
        status: 'pending',
        lastError: undefined,
        payload: { ...entry.payload, qty, expectedVersion: version },
      } as Partial<StoredEntry>,
    });
    version += 1;
  }
  return patches;
}

async function fetchCurrentBatch(shopId: string, batchId: string): Promise<InventoryBatch | null> {
  const { data } = await apiClient.get<InventoryBatch[]>('/inventory/batches', {
    params: { shopId },
  });
  return data.find((b) => b.id === batchId) ?? null;
}

async function rebaseAndSync(batchId: string, overrides?: Map<number, { qty: number }>) {
  const owner = currentOwner();
  if (!owner) throw new Error('Not signed in to a shop');
  const batch = await fetchCurrentBatch(owner.shopId, batchId); // needs a connection
  const entries = await listEntries(owner);
  if (!batch) {
    // The batch no longer exists: its sales can never be counted.
    for (const e of entries) {
      if (e.kind === 'sale' && e.payload.batchId === batchId) await removeEntry(e.seq!);
    }
    return;
  }
  for (const { seq, patch } of rebaseBatchSales(entries, batchId, batch.version, overrides)) {
    await updateEntry(seq, patch);
  }
  void syncEngine.requestSync();
}

/** "Count this sale on the current stock": same Idempotency-Key, current expectedVersion. */
export async function countOnCurrentStock(entry: StoredEntry): Promise<void> {
  if (entry.kind !== 'sale') throw new Error('Only sales can be re-counted');
  await rebaseAndSync(entry.payload.batchId);
}

/** "Count N instead": reduce the sale to what can be sold now, then re-count. */
export async function countReducedQty(entry: StoredEntry, qty: number): Promise<void> {
  if (entry.kind !== 'sale' || qty < 1) throw new Error('Invalid reduced quantity');
  await rebaseAndSync(entry.payload.batchId, new Map([[entry.seq!, { qty }]]));
}

/** "Discard": drop the entry; later sales on the same batch are rebased so they can sync. */
export async function discardEntry(entry: StoredEntry): Promise<void> {
  await removeEntry(entry.seq!);
  if (entry.kind === 'sale') {
    const owner = currentOwner();
    const rest = owner ? await listEntries(owner) : [];
    const stillQueued = rest.some(
      (e) => e.kind === 'sale' && e.payload.batchId === entry.payload.batchId,
    );
    if (stillQueued) await rebaseAndSync(entry.payload.batchId);
  }
  void syncEngine.requestSync();
}

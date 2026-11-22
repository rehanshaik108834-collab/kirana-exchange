import type { InventoryBatch } from '../inventory/hooks';
import type { StoredEntry } from './queue';

export interface ProjectedBatch extends InventoryBatch {
  /** Unsent sales for this batch (pending or blocked behind a conflict). */
  unsentSales: number;
  /** True for a batch added offline that the server has not created yet (no real id). */
  pendingSync: boolean;
  /** A queued entry for this batch needs the user's decision (conflict screen). */
  needsAttention: boolean;
  productName?: string;
}

export const LOCAL_BATCH_PREFIX = 'local:';

/**
 * Last server snapshot ⊕ unsent queue entries → what the shopkeeper should see.
 *
 * How this works:
 * - Each unsent sale subtracts its qty and bumps the projected version by 1, exactly what the
 *   server's conditional UPDATE will do. So the NEXT sale is queued with
 *   expectedVersion = projected version (offline version chaining).
 * - Conflicted entries are NOT subtracted (the server rejected them); the batch is flagged instead.
 * - Batches added offline appear with a `local:` id, flagged pendingSync. They cannot be sold until
 *   synced, because the server assigns the real batch id.
 */
export function projectBatches(server: InventoryBatch[], entries: StoredEntry[]): ProjectedBatch[] {
  const projected = new Map<string, ProjectedBatch>(
    server.map((b) => [b.id, { ...b, unsentSales: 0, pendingSync: false, needsAttention: false }]),
  );

  for (const entry of entries) {
    if (entry.kind === 'sale') {
      const batch = projected.get(entry.payload.batchId);
      if (!batch) continue; // batch no longer visible (e.g. sold out and filtered by the server)
      if (entry.status === 'conflict') {
        batch.needsAttention = true;
        continue;
      }
      batch.qty -= entry.payload.qty;
      batch.version += 1;
      batch.unsentSales += entry.payload.qty;
    } else {
      const id = `${LOCAL_BATCH_PREFIX}${entry.idempotencyKey}`;
      projected.set(id, {
        id,
        shopId: entry.payload.shopId,
        productId: entry.payload.productId,
        batchCode: entry.payload.batchCode,
        qty: entry.payload.qty,
        reservedQty: 0,
        costPrice: entry.payload.costPrice.toFixed(2),
        expiryDate: entry.payload.expiryDate,
        daysOfCover: null,
        version: 0,
        unsentSales: 0,
        pendingSync: true,
        needsAttention: entry.status === 'conflict',
        productName: entry.display?.productName,
      });
    }
  }
  return [...projected.values()];
}

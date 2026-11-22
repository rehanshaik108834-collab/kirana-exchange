import { describe, expect, it } from 'vitest';
import type { InventoryBatch } from '../inventory/hooks';
import { LOCAL_BATCH_PREFIX, projectBatches } from './project';
import type { StoredEntry } from './queue';

const server: InventoryBatch[] = [
  {
    id: 'b1',
    shopId: 's1',
    productId: 'p1',
    batchCode: 'B1',
    qty: 10,
    reservedQty: 2,
    costPrice: '5.00',
    expiryDate: '2027-01-01',
    daysOfCover: null,
    version: 4,
  },
];

let seq = 0;
const sale = (batchId: string, status: StoredEntry['status'] = 'pending'): StoredEntry => ({
  seq: ++seq,
  kind: 'sale',
  idempotencyKey: `k${seq}`,
  userId: 'u1',
  shopId: 's1',
  status,
  attempts: 0,
  createdAt: seq,
  updatedAt: seq,
  payload: { shopId: 's1', batchId, qty: 1, expectedVersion: 0, soldAt: '2026-11-22T10:00:00Z' },
});

describe('projectBatches (server snapshot ⊕ offline queue)', () => {
  it('subtracts unsent sales and bumps the version once per sale (offline version chaining)', () => {
    const [b] = projectBatches(server, [sale('b1'), sale('b1', 'blocked')]);
    expect(b).toMatchObject({ qty: 8, version: 6, unsentSales: 2, needsAttention: false });
    expect(server[0]).toMatchObject({ qty: 10, version: 4 }); // input not mutated
  });

  it('does not subtract conflicted sales, but flags the batch', () => {
    const [b] = projectBatches(server, [sale('b1', 'conflict')]);
    expect(b).toMatchObject({ qty: 10, version: 4, unsentSales: 0, needsAttention: true });
  });

  it('shows a batch added offline as pendingSync with a local id', () => {
    const entry: StoredEntry = {
      seq: 99,
      kind: 'batch',
      idempotencyKey: 'new-key',
      userId: 'u1',
      shopId: 's1',
      status: 'pending',
      attempts: 0,
      createdAt: 1,
      updatedAt: 1,
      payload: {
        shopId: 's1',
        productId: 'p9',
        batchCode: 'B9',
        qty: 12,
        costPrice: 3.5,
        expiryDate: '2027-02-02',
      },
      display: { productName: 'Toor Dal 1kg' },
    };
    const local = projectBatches(server, [entry]).find((b) => b.pendingSync)!;
    expect(local).toMatchObject({
      id: `${LOCAL_BATCH_PREFIX}new-key`,
      qty: 12,
      costPrice: '3.50',
      productName: 'Toor Dal 1kg',
      pendingSync: true,
    });
  });

  it('ignores sales for batches that are no longer in the snapshot', () => {
    expect(projectBatches(server, [sale('gone')])).toHaveLength(1);
  });
});

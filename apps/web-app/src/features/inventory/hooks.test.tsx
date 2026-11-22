import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblemError, apiClient } from '../../lib/api-client';
import { batchesKey, type InventoryBatch, newSaleInput, useRecordSale } from './hooks';

const batch: InventoryBatch = {
  id: 'b1',
  shopId: 's1',
  productId: 'p1',
  batchCode: 'B1',
  qty: 5,
  reservedQty: 0,
  costPrice: '10.00',
  expiryDate: '2027-03-15',
  daysOfCover: null,
  version: 3,
};

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  queryClient.setQueryData(batchesKey('s1'), [batch]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useRecordSale('s1'), { wrapper });
  return { queryClient, result };
}

const cached = (qc: QueryClient) => qc.getQueryData<InventoryBatch[]>(batchesKey('s1'))![0];

describe('useRecordSale (single-tap sale, optimistic)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('decrements immediately, sends expectedVersion + the given Idempotency-Key, then applies the server batch', async () => {
    let resolve!: (v: unknown) => void;
    const post = vi
      .spyOn(apiClient, 'post')
      .mockReturnValue(new Promise((r) => (resolve = r)) as never);
    const { queryClient, result } = setup();
    const input = newSaleInput(batch);

    act(() => result.current.mutate(input));
    await waitFor(() => expect(cached(queryClient).qty).toBe(4)); // optimistic

    expect(post).toHaveBeenCalledWith(
      '/inventory/sales',
      { shopId: 's1', batchId: 'b1', qty: 1, expectedVersion: 3 },
      { headers: { 'Idempotency-Key': input.idempotencyKey } },
    );

    resolve({ data: { batch: { ...batch, qty: 4, version: 4 } } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(cached(queryClient)).toMatchObject({ qty: 4, version: 4 });
  });

  it('rolls back and refetches on a version conflict', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue(
      new ApiProblemError({
        status: 409,
        type: 'https://kirana-exchange.local/errors/version-conflict',
        title: 'Optimistic Concurrency Conflict',
        detail: 'Batch version changed',
      }),
    );
    const { queryClient, result } = setup();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => result.current.mutate(newSaleInput(batch)));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(cached(queryClient)).toMatchObject({ qty: 5, version: 3 }); // restored
    expect(invalidate).toHaveBeenCalledWith({ queryKey: batchesKey('s1') });
  });

  it('a retry after a network failure reuses the same Idempotency-Key', async () => {
    const post = vi
      .spyOn(apiClient, 'post')
      .mockRejectedValueOnce(
        new ApiProblemError({ status: 0, type: '/errors/network', title: '', detail: '' }),
      )
      .mockResolvedValueOnce({ data: { batch: { ...batch, qty: 4, version: 4 } } } as never);
    const { result } = setup();
    const input = newSaleInput(batch);

    act(() => result.current.mutate(input));
    await waitFor(() => expect(result.current.isError).toBe(true));
    act(() => result.current.mutate(input)); // the UI "Retry" button passes the same input
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const keys = post.mock.calls.map(
      (c) => (c[2] as { headers: Record<string, string> }).headers['Idempotency-Key'],
    );
    expect(keys).toEqual([input.idempotencyKey, input.idempotencyKey]);
  });
});

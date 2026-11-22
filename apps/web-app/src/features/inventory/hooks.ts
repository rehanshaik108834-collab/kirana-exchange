import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { apiClient, ApiProblemError } from '../../lib/api-client';
import { problemKind } from '../../lib/problems';

export interface InventoryBatch {
  id: string;
  shopId: string;
  productId: string;
  batchCode: string;
  qty: number;
  reservedQty: number;
  costPrice: string;
  expiryDate: string;
  daysOfCover: string | null;
  version: number;
}

export interface AddBatchInput {
  shopId: string;
  productId: string;
  batchCode: string;
  qty: number;
  costPrice: number;
  expiryDate: string;
  idempotencyKey: string;
}

export interface SaleInput {
  shopId: string;
  batchId: string;
  qty: number;
  expectedVersion: number;
  /** Generated once per tap and reused by Retry, so a lost response never double-sells. */
  idempotencyKey: string;
}

export const batchesKey = (shopId: string) => ['inventory', 'batches', shopId] as const;

export function useBatches(shopId: string | null) {
  return useQuery<InventoryBatch[], ApiProblemError>({
    queryKey: batchesKey(shopId ?? 'none'),
    enabled: Boolean(shopId),
    queryFn: async ({ signal }) => {
      const { data } = await apiClient.get<InventoryBatch[]>('/inventory/batches', {
        params: { shopId },
        signal,
      });
      return data;
    },
  });
}

export function useAddBatch() {
  const queryClient = useQueryClient();
  return useMutation<InventoryBatch, ApiProblemError, AddBatchInput>({
    mutationFn: async ({ idempotencyKey, ...body }) => {
      const { data } = await apiClient.post<InventoryBatch>('/inventory/batches', body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      return data;
    },
    onSuccess: (batch) => {
      void queryClient.invalidateQueries({ queryKey: batchesKey(batch.shopId) });
    },
  });
}

export function newSaleInput(batch: InventoryBatch, qty = 1): SaleInput {
  return {
    shopId: batch.shopId,
    batchId: batch.id,
    qty,
    expectedVersion: batch.version,
    idempotencyKey: uuidv4(),
  };
}

/**
 * Single-tap sale (US-09) with an optimistic update.
 *
 * How this works:
 * - onMutate decrements qty and bumps version locally so the tap feels instant.
 * - The server is authoritative: its conditional UPDATE checks `version` and unreserved stock.
 * - On success the server's batch replaces the optimistic one. On any error the snapshot is
 *   restored, and a version conflict or insufficient stock refetches the real state.
 */
export function useRecordSale(shopId: string) {
  const queryClient = useQueryClient();
  const key = batchesKey(shopId);
  return useMutation<
    { batch: InventoryBatch },
    ApiProblemError,
    SaleInput,
    { previous?: InventoryBatch[] }
  >({
    mutationFn: async ({ idempotencyKey, ...body }) => {
      const { data } = await apiClient.post<{ batch: InventoryBatch }>('/inventory/sales', body, {
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      return data;
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<InventoryBatch[]>(key);
      queryClient.setQueryData<InventoryBatch[]>(key, (batches) =>
        batches?.map((b) =>
          b.id === input.batchId ? { ...b, qty: b.qty - input.qty, version: b.version + 1 } : b,
        ),
      );
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      const kind = problemKind(error);
      if (kind === 'version-conflict' || kind === 'insufficient-unreserved-stock') {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onSuccess: ({ batch }) => {
      queryClient.setQueryData<InventoryBatch[]>(key, (batches) =>
        batches?.map((b) => (b.id === batch.id ? batch : b)),
      );
    },
  });
}

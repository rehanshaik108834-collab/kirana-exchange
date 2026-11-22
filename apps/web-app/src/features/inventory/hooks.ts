import { useQuery } from '@tanstack/react-query';
import { apiClient, ApiProblemError } from '../../lib/api-client';

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

export const batchesKey = (shopId: string) => ['inventory', 'batches', shopId] as const;

/**
 * Last server snapshot of the shop's batches. Writes (sales, new batches) never touch this cache
 * optimistically: they go through the offline queue, and the screen shows
 * projectBatches(snapshot, queue) (features/offline/project.ts).
 */
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

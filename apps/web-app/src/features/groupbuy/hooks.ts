import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { apiClient, ApiProblemError } from '../../lib/api-client';

export type GroupBuyWindowStatus = 'OPEN' | 'EXTENDED' | 'ALLOCATING' | 'COMPLETED' | 'CANCELLED';

export interface ProductTierSchedule {
  productId: string;
  baseUnitPrice: number;
  tiers: Array<{ minQty: number; unitPrice: number }>;
}

export interface GroupBuyWindow {
  id: string;
  distributorId: string;
  state: string;
  cutoffAt: string;
  minOrderValue: string;
  deliveryFee: string;
  priceTiers: ProductTierSchedule[];
  extendedOnce: boolean;
  status: GroupBuyWindowStatus;
  createdAt: string;
}

export interface GroupBuyCommitment {
  id: string;
  windowId: string;
  shopId: string;
  productId: string;
  qty: number;
  updatedAt: string;
}

export interface GroupBuyAllocation {
  id: string;
  orderId: string;
  windowId: string;
  shopId: string;
  productId: string;
  qty: number;
  unitTierPrice: string;
  deliveryShare: string;
  landedCost: string;
  status: 'ALLOCATED' | 'DELIVERED' | 'CANCELLED';
  createdAt: string;
}

export interface WindowDetailResponse {
  window: GroupBuyWindow;
  pooledQtyByProduct: Record<string, number>;
  unitTierPriceByProduct: Record<string, number>;
  currentTotalValue: number;
  progressPct: number;
  participatingShops: number;
  myCommitments: GroupBuyCommitment[];
  allocations: GroupBuyAllocation[];
}

export function useGroupBuyWindows(enabled: boolean) {
  return useQuery<GroupBuyWindow[], ApiProblemError>({
    queryKey: ['groupbuy', 'windows'],
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<GroupBuyWindow[]>('/groupbuy/windows', { signal })).data,
  });
}

export function useGroupBuyWindowDetail(windowId: string | null) {
  return useQuery<WindowDetailResponse, ApiProblemError>({
    queryKey: ['groupbuy', 'window', windowId],
    enabled: Boolean(windowId),
    staleTime: 15_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<WindowDetailResponse>(`/groupbuy/windows/${windowId}`, { signal })).data,
  });
}

export function useMyGroupBuyAllocations(enabled: boolean) {
  return useQuery<GroupBuyAllocation[], ApiProblemError>({
    queryKey: ['groupbuy', 'allocations', 'mine'],
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<GroupBuyAllocation[]>('/groupbuy/allocations/mine', { signal })).data,
  });
}

export function useUpsertCommitment() {
  const qc = useQueryClient();
  return useMutation<
    GroupBuyCommitment,
    ApiProblemError,
    { windowId: string; productId: string; qty: number; shopState?: string }
  >({
    mutationFn: async ({ windowId, ...body }) =>
      (
        await apiClient.put<GroupBuyCommitment>(`/groupbuy/windows/${windowId}/commitments`, body, {
          headers: { 'Idempotency-Key': uuidv4() },
        })
      ).data,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['groupbuy', 'window', vars.windowId] });
      void qc.invalidateQueries({ queryKey: ['groupbuy', 'windows'] });
    },
  });
}

export function useRemoveCommitment() {
  const qc = useQueryClient();
  return useMutation<
    { removed: boolean },
    ApiProblemError,
    { windowId: string; productId: string }
  >({
    mutationFn: async ({ windowId, productId }) =>
      (
        await apiClient.delete<{ removed: boolean }>(
          `/groupbuy/windows/${windowId}/commitments/${productId}`,
        )
      ).data,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['groupbuy', 'window', vars.windowId] });
    },
  });
}

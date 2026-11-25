import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, ApiProblemError } from '../../lib/api-client';

export interface ShopMapPoint {
  shopId: string;
  name: string;
  lat: number;
  lng: number;
  state: string;
  reputationScore: number;
  activeListingsCount: number;
  updatedAt: string | null;
}

export interface NetworkMapResponse {
  totalShops: number;
  totalActiveListings: number;
  byState: Record<string, number>;
  shops: ShopMapPoint[];
}

export interface DailyNetworkMetric {
  date: string;
  deadStockValueReduced: number;
  stockoutsAvoided: number;
  cashReleased: number;
  swapsCompleted: number;
  swapsFailed: number;
  groupbuySavings: number;
}

export interface NetworkMetricsResponse {
  days: number;
  totals: {
    deadStockValueReduced: number;
    stockoutsAvoided: number;
    cashReleased: number;
    swapsCompleted: number;
    swapsFailed: number;
    groupbuySavings: number;
  };
  daily: DailyNetworkMetric[];
}

export interface SimulationRunRow {
  id: string;
  configHash: string;
  seed: number;
  shopCount: number;
  exchangeEnabled: boolean;
  acceptanceRate: number;
  radiusKm: number;
  metricsSummary: Record<string, number>;
  createdAt: string | null;
}

export interface PairedExperimentResult {
  config_hash: string;
  seed: number;
  shop_count: number;
  days: number;
  acceptance_rate: number;
  radius_km: number;
  without_exchange: Record<string, number>;
  with_exchange: Record<string, number>;
  deltas: {
    deadStockReductionPct: number;
    stockoutReductionPct: number;
    cashReleasedInr: number;
    groupbuySavingsInr: number;
    swapsCompleted: number;
  };
}

export interface DisputeRecord {
  id: string;
  transactionId: string;
  reporterShopId: string;
  accusedShopId: string;
  reason: string;
  status: 'OPEN' | 'RESOLVED' | 'DISMISSED';
  createdAt: string;
}

export function useNetworkMap(enabled: boolean) {
  return useQuery<NetworkMapResponse, ApiProblemError>({
    queryKey: ['analytics', 'map'],
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<NetworkMapResponse>('/analytics/map', { signal })).data,
  });
}

export function useNetworkMetrics(enabled: boolean, days = 30) {
  return useQuery<NetworkMetricsResponse, ApiProblemError>({
    queryKey: ['analytics', 'metrics', days],
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<NetworkMetricsResponse>('/analytics/metrics', {
          params: { days },
          signal,
        })
      ).data,
  });
}

export function useSimulations(enabled: boolean) {
  return useQuery<SimulationRunRow[], ApiProblemError>({
    queryKey: ['analytics', 'simulations'],
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<SimulationRunRow[]>('/analytics/simulations', { signal })).data,
  });
}

export function useRunPairedSimulation() {
  const qc = useQueryClient();
  return useMutation<
    PairedExperimentResult,
    ApiProblemError,
    { seed: number; shop_count: number; acceptance_rate: number; radius_km: number; days: number }
  >({
    mutationFn: async (body) =>
      (await apiClient.post<PairedExperimentResult>('/analytics/simulations/run', body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['analytics', 'simulations'] });
    },
  });
}

export function useOpenDisputes(enabled: boolean) {
  return useQuery<DisputeRecord[], ApiProblemError>({
    queryKey: ['shops', 'disputes', 'OPEN'],
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<DisputeRecord[]>('/shops/disputes', {
          params: { status: 'OPEN' },
          signal,
        })
      ).data,
  });
}

export function useResolveDispute() {
  const qc = useQueryClient();
  return useMutation<
    DisputeRecord,
    ApiProblemError,
    {
      id: string;
      status: 'RESOLVED' | 'DISMISSED';
      resolutionNotes: string;
      penaltyPoints?: number;
    }
  >({
    mutationFn: async ({ id, ...body }) =>
      (await apiClient.patch<DisputeRecord>(`/shops/disputes/${id}/resolve`, body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['shops', 'disputes'] });
    },
  });
}

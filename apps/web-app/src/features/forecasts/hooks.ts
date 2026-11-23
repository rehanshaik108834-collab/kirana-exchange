import { useQuery } from '@tanstack/react-query';
import { apiClient, ApiProblemError } from '../../lib/api-client';

export type DemandClass = 'SMOOTH' | 'ERRATIC' | 'INTERMITTENT' | 'LUMPY';
export type RiskType = 'DEAD_STOCK' | 'EXPIRY';
export type RecommendedAction = 'SWAP_TO_NEIGHBOUR' | 'BUNDLE_DISCOUNT' | 'RETURN_TO_DISTRIBUTOR';

export interface ForecastOrderItem {
  productId: string;
  forecastDate: string;
  horizonDays: number;
  predictedQty: number;
  lowerBound: number;
  upperBound: number;
  demandClass: DemandClass | string;
  modelUsed: string;
  reorderQty: number;
  availableQty: number;
}

export interface ForecastRiskItem {
  batchId: string;
  productId: string;
  riskType: RiskType;
  daysOfCover: number;
  expectedUnsoldQty: number;
  recommendedAction: RecommendedAction;
  availableQty: number;
  expiryDate: string | null;
  flaggedAt: string | null;
}

export interface AccuracyPoint {
  date: string;
  actualQty: number;
  predictedQty: number;
}

export interface ShopForecastResponse {
  shopId: string;
  generatedAt: string;
  forecastDate: string | null;
  modelUsed: string;
  fallbackActive: boolean;
  summary: {
    orderThisCount: number;
    clearThisCount: number;
    totalReorderUnits: number;
    totalAtRiskUnits: number;
  };
  orderThis: ForecastOrderItem[];
  clearThis: ForecastRiskItem[];
  accuracySeries: AccuracyPoint[];
}

export function useShopForecasts(shopId: string | null) {
  return useQuery<ShopForecastResponse, ApiProblemError>({
    queryKey: ['forecasts', 'shop', shopId],
    enabled: Boolean(shopId),
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<ShopForecastResponse>(`/forecasts/shops/${shopId}`, { signal })).data,
  });
}

/** Computes Weighted Absolute Percentage Error (%) across predicted-vs-actual points. */
export function computeSeriesWapePct(points: AccuracyPoint[]): number | null {
  if (points.length === 0) return null;
  let totalActual = 0;
  let totalAbsError = 0;
  for (const pt of points) {
    totalActual += pt.actualQty;
    totalAbsError += Math.abs(pt.actualQty - pt.predictedQty);
  }
  if (totalActual <= 0) return null;
  return Math.round((totalAbsError / totalActual) * 1000) / 10;
}

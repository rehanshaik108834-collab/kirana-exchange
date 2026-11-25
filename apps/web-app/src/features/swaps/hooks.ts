import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { apiClient, ApiProblemError } from '../../lib/api-client';

export type SwapListingStatus = 'OPEN' | 'RESERVED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';
export type SwapOfferStatus = 'PENDING' | 'COUNTERED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
export type SwapSagaState =
  | 'INITIATED'
  | 'RESERVING_STOCK'
  | 'AWAITING_HANDOVER'
  | 'HANDOVER_CONFIRMED'
  | 'COMMITTING_TRANSFER'
  | 'COMPENSATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'FAILED_NO_STOCK'
  | 'CANCELLED_COMPENSATED';

export interface AnonymisedCandidate {
  listingId: string;
  productId: string;
  state: string;
  qty: number;
  price: number;
  batchExpiryDate: string;
  expiresAt: string;
  distanceKm: number;
  sellerReputationBand: 'HIGH' | 'STANDARD' | 'CAUTION';
}

export interface SwapListing {
  id: string;
  shopId: string;
  batchId: string;
  productId: string;
  state: string;
  qty: number;
  costPrice: string;
  suggestedPrice: string;
  price: string;
  batchExpiryDate: string;
  status: SwapListingStatus;
  expiresAt: string;
  createdAt: string;
}

export interface RiskListingDraft {
  batchId: string;
  shopId: string;
  productId: string;
  riskType: 'EXPIRY' | 'DEAD_STOCK' | string;
  daysOfCover: string;
  expectedUnsoldQty: number;
  recommendedAction: string;
  dismissed: boolean;
}

export interface SwapOffer {
  id: string;
  listingId: string;
  sellerShopId: string;
  buyerShopId: string;
  qty: number;
  offeredPrice: string;
  status: SwapOfferStatus;
  expiresAt: string;
  createdAt: string;
}

export interface SwapTransaction {
  id: string;
  offerId: string;
  listingId: string;
  sellerShopId: string;
  buyerShopId: string;
  batchId: string;
  productId: string;
  shopState: string;
  qty: number;
  price: string;
  costPrice: string;
  expiryDate: string;
  state: SwapSagaState;
  handoverExpiresAt: string | null;
  sellerConfirmedAt: string | null;
  buyerConfirmedAt: string | null;
  billRecordId: string | null;
  cancelReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SwapEventLog {
  id: string;
  transactionId: string;
  step: string;
  status: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface SagaDetailResponse {
  transaction: SwapTransaction;
  events: SwapEventLog[];
  handoverCode?: string;
}

export function useSwapCandidates(enabled: boolean, radiusKm = 5) {
  return useQuery<AnonymisedCandidate[], ApiProblemError>({
    queryKey: ['swaps', 'candidates', radiusKm],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      (
        await apiClient.get<AnonymisedCandidate[]>('/swaps/candidates', {
          params: { radiusKm },
          signal,
        })
      ).data,
  });
}

export function useMyListings(enabled: boolean) {
  return useQuery<SwapListing[], ApiProblemError>({
    queryKey: ['swaps', 'listings', 'mine'],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<SwapListing[]>('/swaps/listings/mine', { signal })).data,
  });
}

export function useRiskDrafts(enabled: boolean) {
  return useQuery<RiskListingDraft[], ApiProblemError>({
    queryKey: ['swaps', 'listings', 'drafts'],
    enabled,
    staleTime: 60_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<RiskListingDraft[]>('/swaps/listings/drafts', { signal })).data,
  });
}

export function useMyOffers(enabled: boolean) {
  return useQuery<SwapOffer[], ApiProblemError>({
    queryKey: ['swaps', 'offers'],
    enabled,
    staleTime: 30_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<SwapOffer[]>('/swaps/offers', { signal })).data,
  });
}

export function useMySagas(enabled: boolean) {
  return useQuery<SwapTransaction[], ApiProblemError>({
    queryKey: ['sagas', 'mine'],
    enabled,
    staleTime: 15_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<SwapTransaction[]>('/sagas/mine', { signal })).data,
  });
}

export function useSagaDetail(txId: string | null) {
  return useQuery<SagaDetailResponse, ApiProblemError>({
    queryKey: ['sagas', 'detail', txId],
    enabled: Boolean(txId),
    staleTime: 10_000,
    queryFn: async ({ signal }) =>
      (await apiClient.get<SagaDetailResponse>(`/sagas/${txId}`, { signal })).data,
  });
}

export function useCreateListing() {
  const qc = useQueryClient();
  return useMutation<
    SwapListing,
    ApiProblemError,
    {
      batchId: string;
      productId: string;
      qty: number;
      costPrice: number;
      price?: number;
      batchExpiryDate: string;
      daysOfCover?: number;
    }
  >({
    mutationFn: async (payload) =>
      (
        await apiClient.post<SwapListing>('/swaps/listings', payload, {
          headers: { 'Idempotency-Key': uuidv4() },
        })
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['swaps', 'listings'] });
    },
  });
}

export function useCreateOffer() {
  const qc = useQueryClient();
  return useMutation<
    SwapOffer,
    ApiProblemError,
    { listingId: string; qty: number; offeredPrice: number }
  >({
    mutationFn: async (payload) =>
      (
        await apiClient.post<SwapOffer>('/swaps/offers', payload, {
          headers: { 'Idempotency-Key': uuidv4() },
        })
      ).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['swaps', 'offers'] });
    },
  });
}

export function useAcceptOffer() {
  const qc = useQueryClient();
  return useMutation<SwapOffer, ApiProblemError, string>({
    mutationFn: async (offerId) =>
      (await apiClient.post<SwapOffer>(`/swaps/offers/${offerId}/accept`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['swaps'] });
      void qc.invalidateQueries({ queryKey: ['sagas'] });
    },
  });
}

export function useRejectOffer() {
  const qc = useQueryClient();
  return useMutation<SwapOffer, ApiProblemError, string>({
    mutationFn: async (offerId) =>
      (await apiClient.post<SwapOffer>(`/swaps/offers/${offerId}/reject`)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['swaps', 'offers'] });
    },
  });
}

export function useConfirmHandover() {
  const qc = useQueryClient();
  return useMutation<SwapTransaction, ApiProblemError, { txId: string; handoverCode: string }>({
    mutationFn: async ({ txId, handoverCode }) =>
      (await apiClient.post<SwapTransaction>(`/sagas/${txId}/confirm-handover`, { handoverCode }))
        .data,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['sagas', 'mine'] });
      void qc.invalidateQueries({ queryKey: ['sagas', 'detail', vars.txId] });
    },
  });
}

export function useCancelSaga() {
  const qc = useQueryClient();
  return useMutation<SwapTransaction, ApiProblemError, string>({
    mutationFn: async (txId) =>
      (await apiClient.post<SwapTransaction>(`/sagas/${txId}/cancel`, { reason: 'USER_CANCEL' }))
        .data,
    onSuccess: (_data, txId) => {
      void qc.invalidateQueries({ queryKey: ['sagas', 'mine'] });
      void qc.invalidateQueries({ queryKey: ['sagas', 'detail', txId] });
    },
  });
}

export async function downloadSwapInvoicePdf(txId: string): Promise<void> {
  const response = await apiClient.get<Blob>(`/sagas/${txId}/invoice.pdf`, {
    responseType: 'blob',
  });
  const invoiceNo =
    (response.headers?.['x-invoice-number'] as string | undefined) ||
    `KX-SWAP-${txId.slice(0, 8).toUpperCase()}`;
  const blob =
    response.data instanceof Blob
      ? response.data
      : new Blob([response.data], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${invoiceNo}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Subscribes to live Redis Pub/Sub SSE updates (`GET /v1/sagas/:id/stream`) using
 * authenticated fetch streaming so JWTs are never exposed in query parameters.
 */
export function useSagaLiveStream(txId: string | null, onStatusEvent: () => void) {
  useEffect(() => {
    if (!txId || typeof window === 'undefined' || typeof fetch !== 'function') return;
    const token = localStorage.getItem('accessToken');
    if (!token) return;

    const controller = new AbortController();
    const baseUrl = apiClient.defaults.baseURL || 'http://localhost:3001/v1';

    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/sagas/${txId}/stream`, {
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (!res.ok || !reader) return;

        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          if (frames.some((frame) => frame.includes('data:'))) {
            onStatusEvent();
          }
        }
      } catch {
        // Silently degrade when aborted or offline; manual refresh/polling still works.
      }
    })();

    return () => {
      controller.abort();
    };
  }, [txId, onStatusEvent]);
}

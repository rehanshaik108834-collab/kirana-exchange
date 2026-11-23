import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopForecastResponse } from './hooks';

const mocks = vi.hoisted(() => ({
  shopId: '11111111-1111-1111-1111-111111111111' as string | null,
  apiGet: vi.fn(),
  productMap: new Map<string, { id: string; name: string }>([
    ['prod-1', { id: 'prod-1', name: 'Parle-G Gold 250g' }],
    ['prod-2', { id: 'prod-2', name: 'Aashirvaad Atta 5kg' }],
  ]),
}));

vi.mock('../../lib/session', () => ({
  currentClaims: () =>
    mocks.shopId ? { sub: 'owner-1', role: 'shop_owner', shopId: mocks.shopId } : null,
}));

vi.mock('../../lib/api-client', () => ({
  apiClient: { get: mocks.apiGet },
  ApiProblemError: class ApiProblemError extends Error {
    detail: string;
    constructor(detail: string) {
      super(detail);
      this.detail = detail;
    }
  },
}));

vi.mock('../catalog/hooks', () => ({
  useProductsByIds: () => ({ data: mocks.productMap, isLoading: false }),
}));

import { ApiProblemError } from '../../lib/api-client';
import { ForecastPage } from './ForecastPage';

const samplePayload = (overrides: Partial<ShopForecastResponse> = {}): ShopForecastResponse => ({
  shopId: '11111111-1111-1111-1111-111111111111',
  generatedAt: '2026-04-01T06:00:00Z',
  forecastDate: '2026-04-01',
  modelUsed: 'adaptive_ensemble',
  fallbackActive: false,
  summary: {
    orderThisCount: 1,
    clearThisCount: 2,
    totalReorderUnits: 18,
    totalAtRiskUnits: 25,
  },
  orderThis: [
    {
      productId: 'prod-1',
      forecastDate: '2026-04-01',
      horizonDays: 7,
      predictedQty: 28,
      lowerBound: 22,
      upperBound: 34,
      demandClass: 'SMOOTH',
      modelUsed: 'adaptive_ensemble',
      reorderQty: 18,
      availableQty: 12,
    },
  ],
  clearThis: [
    {
      batchId: 'batch-1',
      productId: 'prod-2',
      riskType: 'EXPIRY',
      daysOfCover: 64.5,
      expectedUnsoldQty: 20,
      recommendedAction: 'SWAP_TO_NEIGHBOUR',
      availableQty: 30,
      expiryDate: '2026-04-20',
      flaggedAt: '2026-04-01T06:00:00Z',
    },
    {
      batchId: 'batch-2',
      productId: 'prod-2',
      riskType: 'DEAD_STOCK',
      daysOfCover: 999.99,
      expectedUnsoldQty: 5,
      recommendedAction: 'BUNDLE_DISCOUNT',
      availableQty: 5,
      expiryDate: '2026-04-05',
      flaggedAt: '2026-04-01T06:00:00Z',
    },
  ],
  accuracySeries: [
    { date: '2026-03-29', actualQty: 20, predictedQty: 18 },
    { date: '2026-03-30', actualQty: 30, predictedQty: 32 },
  ],
  ...overrides,
});

function renderForecastPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ForecastPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ForecastPage (Phase 8, Slice 5)', () => {
  beforeEach(() => {
    mocks.shopId = '11111111-1111-1111-1111-111111111111';
    mocks.apiGet.mockReset();
  });

  it('renders Order-This cards, Clear-This risk/action badges, and WAPE accuracy section', async () => {
    mocks.apiGet.mockResolvedValue({ data: samplePayload() });
    renderForecastPage();

    expect(await screen.findByText('Parle-G Gold 250g')).toBeTruthy();
    expect(screen.getByText('+18')).toBeTruthy();
    expect(screen.getByText('Steady seller')).toBeTruthy();

    expect(screen.getByText('Expiry risk')).toBeTruthy();
    expect(screen.getByText('Slow / dead stock')).toBeTruthy();
    expect(screen.getByText('Recommended: Swap with nearby shop')).toBeTruthy();
    expect(screen.getByText('Recommended: Offer quick bundle discount')).toBeTruthy();
    expect(screen.getByText('999+')).toBeTruthy();

    // WAPE = (|20-18| + |30-32|) / (20 + 30) = 4 / 50 = 8.0%
    expect(screen.getByText('Error (WAPE): 8.0%')).toBeTruthy();
    expect(screen.queryByText(/moving average fallback/i)).toBeNull();
  });

  it('displays fallback banner when model_used is fallback', async () => {
    mocks.apiGet.mockResolvedValue({
      data: samplePayload({ modelUsed: 'fallback', fallbackActive: true }),
    });
    renderForecastPage();

    expect(await screen.findByText(/14-day moving average fallback/i)).toBeTruthy();
  });

  it('filters between Order-This and Clear-This sections via tabs', async () => {
    mocks.apiGet.mockResolvedValue({ data: samplePayload() });
    renderForecastPage();
    await screen.findByText('Order this week');

    fireEvent.click(screen.getByRole('tab', { name: 'Order this (1)' }));
    expect(screen.getByText('Order this week')).toBeTruthy();
    expect(screen.queryByText('Clear these batches')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Clear this (2)' }));
    expect(screen.getByText('Clear these batches')).toBeTruthy();
    expect(screen.queryByText('Order this week')).toBeNull();
  });

  it('renders clean empty states when no forecasts or risks exist yet', async () => {
    mocks.apiGet.mockResolvedValue({
      data: samplePayload({
        summary: {
          orderThisCount: 0,
          clearThisCount: 0,
          totalReorderUnits: 0,
          totalAtRiskUnits: 0,
        },
        orderThis: [],
        clearThis: [],
        accuracySeries: [],
      }),
    });
    renderForecastPage();

    expect(await screen.findByText(/No weekly demand forecasts are ready yet/i)).toBeTruthy();
    expect(screen.getByText(/no batches are flagged/i)).toBeTruthy();
    expect(screen.getByText(/Accuracy chart will appear/i)).toBeTruthy();
  });

  it('displays RFC 9457 error detail if forecast API fails', async () => {
    mocks.apiGet.mockRejectedValue(
      new (ApiProblemError as unknown as new (detail: string) => Error)(
        'Forecast service is temporarily unavailable',
      ),
    );
    renderForecastPage();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Forecast service is temporarily unavailable');
  });
});

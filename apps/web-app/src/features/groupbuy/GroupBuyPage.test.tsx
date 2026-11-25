import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const PROD_ID = '22222222-2222-4222-8222-222222222222';
const WIN_ID = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('../../lib/session', () => ({
  currentClaims: () => ({ sub: 'u-1', role: 'shop_owner', shopId: SHOP_ID }),
}));

vi.mock('../../lib/api-client', () => ({
  apiClient: {
    get: mocks.apiGet,
    put: mocks.apiPut,
    delete: mocks.apiDelete,
  },
  ApiProblemError: class ApiProblemError extends Error {},
}));

vi.mock('../catalog/hooks', () => ({
  useProductsByIds: () => ({
    data: new Map([[PROD_ID, { id: PROD_ID, name: 'Fortune Sunflower Oil 1L' }]]),
    isLoading: false,
  }),
}));

import { GroupBuyPage } from './GroupBuyPage';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <GroupBuyPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('GroupBuyPage (Phase 10, Slice 4)', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset();
    mocks.apiPut.mockReset();
    mocks.apiDelete.mockReset();

    const sampleWin = {
      id: WIN_ID,
      distributorId: 'dist-hyd-01',
      state: 'Telangana',
      cutoffAt: '2026-04-05T18:00:00Z',
      minOrderValue: '10000.00',
      deliveryFee: '300.00',
      priceTiers: [
        {
          productId: PROD_ID,
          baseUnitPrice: 150,
          tiers: [{ minQty: 30, unitPrice: 135 }],
        },
      ],
      extendedOnce: false,
      status: 'OPEN',
      createdAt: '2026-04-01T00:00:00Z',
    };

    mocks.apiGet.mockImplementation(async (url: string) => {
      if (url === '/groupbuy/windows') return { data: [sampleWin] };
      if (url === `/groupbuy/windows/${WIN_ID}`) {
        return {
          data: {
            window: sampleWin,
            pooledQtyByProduct: { [PROD_ID]: 35 },
            unitTierPriceByProduct: { [PROD_ID]: 135 },
            currentTotalValue: 4725,
            progressPct: 47,
            participatingShops: 3,
            myCommitments: [],
            allocations: [],
          },
        };
      }
      if (url === '/groupbuy/allocations/mine') {
        return {
          data: [
            {
              id: 'alloc-1',
              orderId: 'ord-1',
              windowId: WIN_ID,
              shopId: SHOP_ID,
              productId: PROD_ID,
              qty: 20,
              unitTierPrice: '135.00',
              deliveryShare: '100.00',
              landedCost: '140.00',
              status: 'ALLOCATED',
              createdAt: '2026-04-02T00:00:00Z',
            },
          ],
        };
      }
      return { data: [] };
    });

    mocks.apiPut.mockResolvedValue({ data: { id: 'c-1', qty: 10 } });
  });

  it('displays buying windows, commits quantity with Idempotency-Key, and lists allocations', async () => {
    renderPage();

    expect(await screen.findByText('dist-hyd-01 · Telangana')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View tiers & commit' }));

    expect(await screen.findByText('Fortune Sunflower Oil 1L')).toBeTruthy();
    expect(screen.getByText('3 shops joined')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save commitment' }));
    await waitFor(() => {
      expect(mocks.apiPut).toHaveBeenCalledWith(
        `/groupbuy/windows/${WIN_ID}/commitments`,
        { productId: PROD_ID, qty: 10, shopState: 'Telangana' },
        expect.objectContaining({
          headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
        }),
      );
    });
    expect(await screen.findByText('Commitment saved to the buying window.')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /My allocations/i }));
    expect(await screen.findByText(/Landed ₹140\.00\/unit/)).toBeTruthy();
  });
});

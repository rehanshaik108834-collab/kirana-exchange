import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SHOP_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SHOP_ID = '22222222-2222-4222-8222-222222222222';
const PROD_ID = '33333333-3333-4333-8333-333333333333';
const BATCH_ID = '44444444-4444-4444-8444-444444444444';
const LISTING_ID = '55555555-5555-4555-8555-555555555555';
const OFFER_ID = '66666666-6666-4666-8666-666666666666';
const TX_ACTIVE = '77777777-7777-4777-8777-777777777777';
const TX_DONE = '88888888-8888-4888-8888-888888888888';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  batches: [] as any[],
}));

vi.mock('../../lib/session', () => ({
  currentClaims: () => ({ sub: 'u-1', role: 'shop_owner', shopId: SHOP_ID }),
}));

vi.mock('../../lib/api-client', () => ({
  apiClient: {
    defaults: { baseURL: 'http://localhost:3001/v1' },
    get: mocks.apiGet,
    post: mocks.apiPost,
  },
  ApiProblemError: class ApiProblemError extends Error {
    detail: string;
    constructor(detail: string) {
      super(detail);
      this.detail = detail;
    }
  },
}));

vi.mock('../catalog/hooks', () => ({
  useProductsByIds: () => ({
    data: new Map([[PROD_ID, { id: PROD_ID, name: 'Tata Salt 1kg' }]]),
    isLoading: false,
  }),
}));

vi.mock('../inventory/hooks', () => ({
  useBatches: () => ({ data: mocks.batches, isLoading: false }),
}));

import { SwapsPage } from './SwapsPage';

function renderSwapsPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SwapsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SwapsPage (Phase 9, Slice 5)', () => {
  beforeEach(() => {
    mocks.apiGet.mockReset();
    mocks.apiPost.mockReset();
    mocks.batches = [
      {
        id: BATCH_ID,
        productId: PROD_ID,
        batchCode: 'B-01',
        qty: 20,
        reservedQty: 0,
        costPrice: '22.00',
        expiryDate: '2026-05-10',
        daysOfCover: '55.00',
      },
    ];

    mocks.apiGet.mockImplementation(async (url: string) => {
      if (url === '/swaps/candidates') {
        return {
          data: [
            {
              listingId: LISTING_ID,
              productId: PROD_ID,
              state: 'Telangana',
              qty: 12,
              price: 19.5,
              batchExpiryDate: '2026-05-15',
              expiresAt: '2026-04-05T00:00:00Z',
              distanceKm: 1.4,
              sellerReputationBand: 'HIGH',
            },
          ],
        };
      }
      if (url === '/swaps/listings/mine') return { data: [] };
      if (url === '/swaps/listings/drafts') {
        return {
          data: [
            {
              batchId: BATCH_ID,
              shopId: SHOP_ID,
              productId: PROD_ID,
              riskType: 'EXPIRY',
              daysOfCover: '55.00',
              expectedUnsoldQty: 10,
              recommendedAction: 'SWAP_TO_NEIGHBOUR',
              dismissed: false,
            },
          ],
        };
      }
      if (url === '/swaps/offers') {
        return {
          data: [
            {
              id: OFFER_ID,
              listingId: LISTING_ID,
              sellerShopId: SHOP_ID,
              buyerShopId: OTHER_SHOP_ID,
              qty: 8,
              offeredPrice: '19.50',
              status: 'PENDING',
              expiresAt: '2026-04-04T00:00:00Z',
              createdAt: '2026-04-01T00:00:00Z',
            },
          ],
        };
      }
      if (url === '/sagas/mine') {
        return {
          data: [
            {
              id: TX_ACTIVE,
              offerId: OFFER_ID,
              listingId: LISTING_ID,
              sellerShopId: SHOP_ID,
              buyerShopId: OTHER_SHOP_ID,
              batchId: BATCH_ID,
              productId: PROD_ID,
              shopState: 'Telangana',
              qty: 8,
              price: '19.50',
              costPrice: '22.00',
              expiryDate: '2026-05-10',
              state: 'AWAITING_HANDOVER',
              handoverExpiresAt: '2026-04-03T00:00:00Z',
              sellerConfirmedAt: null,
              buyerConfirmedAt: null,
              billRecordId: null,
              cancelReason: null,
              version: 2,
              createdAt: '2026-04-01T00:00:00Z',
              updatedAt: '2026-04-01T00:05:00Z',
            },
            {
              id: TX_DONE,
              offerId: '99999999-9999-4999-8999-999999999999',
              listingId: LISTING_ID,
              sellerShopId: OTHER_SHOP_ID,
              buyerShopId: SHOP_ID,
              batchId: BATCH_ID,
              productId: PROD_ID,
              shopState: 'Telangana',
              qty: 6,
              price: '18.00',
              costPrice: '22.00',
              expiryDate: '2026-05-10',
              state: 'COMPLETED',
              handoverExpiresAt: null,
              sellerConfirmedAt: '2026-04-01T01:00:00Z',
              buyerConfirmedAt: '2026-04-01T01:01:00Z',
              billRecordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              cancelReason: null,
              version: 4,
              createdAt: '2026-04-01T00:00:00Z',
              updatedAt: '2026-04-01T01:05:00Z',
            },
          ],
        };
      }
      if (url === `/sagas/${TX_ACTIVE}`) {
        return {
          data: {
            transaction: {
              id: TX_ACTIVE,
              sellerShopId: SHOP_ID,
              buyerShopId: OTHER_SHOP_ID,
              productId: PROD_ID,
              qty: 8,
              price: '19.50',
              state: 'AWAITING_HANDOVER',
              sellerConfirmedAt: null,
              buyerConfirmedAt: null,
            },
            events: [],
            handoverCode: '482910',
          },
        };
      }
      if (url === `/sagas/${TX_DONE}`) {
        return {
          data: {
            transaction: {
              id: TX_DONE,
              sellerShopId: OTHER_SHOP_ID,
              buyerShopId: SHOP_ID,
              productId: PROD_ID,
              qty: 6,
              price: '18.00',
              state: 'COMPLETED',
              billRecordId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
            events: [],
          },
        };
      }
      if (url === `/sagas/${TX_DONE}/invoice.pdf`) {
        return {
          data: new Blob(['%PDF-1.3'], { type: 'application/pdf' }),
          headers: { 'x-invoice-number': 'KX-SWAP-AAAAAAAAAA' },
        };
      }
      return { data: [] };
    });

    mocks.apiPost.mockResolvedValue({ data: {} });
  });

  it('renders anonymised nearby candidates and submits an offer with Idempotency-Key', async () => {
    renderSwapsPage();

    expect(await screen.findByText('Tata Salt 1kg')).toBeTruthy();
    expect(screen.getByText('1.4 km away · Telangana')).toBeTruthy();
    expect(screen.getByText('Trusted peer')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Make offer' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send offer' }));

    await waitFor(() => {
      expect(mocks.apiPost).toHaveBeenCalledWith(
        '/swaps/offers',
        { listingId: LISTING_ID, qty: 12, offeredPrice: 19.5 },
        expect.objectContaining({
          headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
        }),
      );
    });
    expect(await screen.findByText('Offer sent to the seller shop.')).toBeTruthy();
  });

  it('lists a surplus batch from risk alert drafts on My surplus tab', async () => {
    renderSwapsPage();
    await screen.findByText('Tata Salt 1kg');

    fireEvent.click(screen.getByRole('tab', { name: /My surplus/i }));
    expect(await screen.findByText('Suggested from risk alerts')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'List suggested qty' }));
    await waitFor(() => {
      expect(mocks.apiPost).toHaveBeenCalledWith(
        '/swaps/listings',
        expect.objectContaining({ batchId: BATCH_ID, productId: PROD_ID, qty: 10 }),
        expect.objectContaining({
          headers: expect.objectContaining({ 'Idempotency-Key': expect.any(String) }),
        }),
      );
    });
  });

  it('accepts incoming offers, displays seller PIN, confirms handover, and downloads GST invoice PDF', async () => {
    const createObjUrl = vi.fn(() => 'blob:invoice-test');
    const revokeObjUrl = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: createObjUrl, revokeObjectURL: revokeObjUrl });

    renderSwapsPage();
    await screen.findByText('Tata Salt 1kg');

    fireEvent.click(screen.getByRole('tab', { name: /Offers & swaps/i }));
    expect(await screen.findByText('Incoming buyer offer')).toBeTruthy();

    // Accept pending offer
    fireEvent.click(screen.getByRole('button', { name: 'Accept offer' }));
    await waitFor(() => {
      expect(mocks.apiPost).toHaveBeenCalledWith(`/swaps/offers/${OFFER_ID}/accept`);
    });

    // Open active saga tracker -> displays seller's 6-digit PIN and confirms it
    const trackerButtons = screen.getAllByRole('button', { name: 'Open handover tracker' });
    fireEvent.click(trackerButtons[0]);

    expect(await screen.findByText('482910')).toBeTruthy();
    const pinInput = screen.getByPlaceholderText('123456');
    fireEvent.change(pinInput, { target: { value: '482910' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm handover' }));

    await waitFor(() => {
      expect(mocks.apiPost).toHaveBeenCalledWith(`/sagas/${TX_ACTIVE}/confirm-handover`, {
        handoverCode: '482910',
      });
    });

    // Open completed saga -> downloads GST PDF invoice
    fireEvent.click(trackerButtons[1]);
    const dlBtn = await screen.findByRole('button', { name: 'Download GST swap invoice (PDF)' });
    fireEvent.click(dlBtn);

    await waitFor(() => {
      expect(mocks.apiGet).toHaveBeenCalledWith(`/sagas/${TX_DONE}/invoice.pdf`, {
        responseType: 'blob',
      });
    });

    vi.unstubAllGlobals();
  });
});

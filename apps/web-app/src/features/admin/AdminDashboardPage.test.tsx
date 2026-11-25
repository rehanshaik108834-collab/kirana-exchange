import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'admin',
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="leaflet-map">{children}</div>,
  TileLayer: () => null,
  CircleMarker: ({ children }: any) => <div data-testid="map-marker">{children}</div>,
  Popup: ({ children }: any) => <div>{children}</div>,
}));

vi.mock('../../lib/session', () => ({
  currentClaims: () => ({ sub: 'adm-1', role: mocks.role, shopId: null }),
}));

vi.mock('../../lib/api-client', () => ({
  apiClient: {
    get: mocks.apiGet,
    post: mocks.apiPost,
    patch: mocks.apiPatch,
  },
  ApiProblemError: class ApiProblemError extends Error {},
}));

import { AdminDashboardPage } from './AdminDashboardPage';

function renderAdmin() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AdminDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AdminDashboardPage (Phase 10, Slice 4)', () => {
  beforeEach(() => {
    mocks.role = 'admin';
    mocks.apiGet.mockReset();
    mocks.apiPost.mockReset();
    mocks.apiPatch.mockReset();

    mocks.apiGet.mockImplementation(async (url: string) => {
      if (url === '/analytics/map') {
        return {
          data: {
            totalShops: 2,
            totalActiveListings: 5,
            byState: { Telangana: 2 },
            shops: [
              {
                shopId: 'shop-1',
                name: 'Sri Balaji Kirana',
                lat: 17.385,
                lng: 78.486,
                state: 'Telangana',
                reputationScore: 98,
                activeListingsCount: 3,
                updatedAt: '2026-04-01T00:00:00Z',
              },
            ],
          },
        };
      }
      if (url === '/analytics/metrics') {
        return {
          data: {
            days: 30,
            totals: {
              deadStockValueReduced: 4500,
              stockoutsAvoided: 42,
              cashReleased: 4200,
              swapsCompleted: 6,
              swapsFailed: 1,
              groupbuySavings: 1850,
            },
            daily: [
              {
                date: '2026-04-01',
                deadStockValueReduced: 4500,
                stockoutsAvoided: 42,
                cashReleased: 4200,
                swapsCompleted: 6,
                swapsFailed: 1,
                groupbuySavings: 1850,
              },
            ],
          },
        };
      }
      if (url === '/analytics/simulations') return { data: [{ id: 's-1' }, { id: 's-2' }] };
      if (url === '/shops/disputes') {
        return {
          data: [
            {
              id: 'disp-1',
              transactionId: '11111111-1111-4111-8111-111111111111',
              reporterShopId: 'shop-1',
              accusedShopId: 'shop-2',
              reason: 'Damaged cartons delivered',
              status: 'OPEN',
              createdAt: '2026-04-01T00:00:00Z',
            },
          ],
        };
      }
      return { data: [] };
    });

    mocks.apiPost.mockResolvedValue({
      data: {
        config_hash: 'abc',
        seed: 42,
        shop_count: 12,
        days: 60,
        acceptance_rate: 0.5,
        radius_km: 5,
        without_exchange: {},
        with_exchange: {},
        deltas: {
          deadStockReductionPct: 24.5,
          stockoutReductionPct: 18.2,
          cashReleasedInr: 12500,
          groupbuySavingsInr: 4800,
          swapsCompleted: 14,
        },
      },
    });
    mocks.apiPatch.mockResolvedValue({ data: { id: 'disp-1', status: 'RESOLVED' } });
  });

  it('renders CQRS KPIs, Leaflet shop map, paired simulation runner, and resolves disputes', async () => {
    renderAdmin();

    expect(await screen.findByText('Sri Balaji Kirana')).toBeTruthy();
    expect(screen.getByTestId('leaflet-map')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('2 saved runs')).toBeTruthy();

    // Run paired experiment
    fireEvent.click(screen.getByRole('button', { name: 'Run paired experiment' }));
    expect(await screen.findByText('Dead stock: -24.5%')).toBeTruthy();
    expect(screen.getByText('Stockouts: -18.2%')).toBeTruthy();

    // Resolve open dispute
    fireEvent.click(screen.getByRole('button', { name: 'Resolve (-5 rep)' }));
    await waitFor(() => {
      expect(mocks.apiPatch).toHaveBeenCalledWith(
        '/shops/disputes/disp-1/resolve',
        expect.objectContaining({ status: 'RESOLVED', penaltyPoints: 5 }),
      );
    });
    expect(await screen.findByText('Dispute updated and recorded in audit log.')).toBeTruthy();
  });

  it('blocks non-admin users from seeing dashboard controls', () => {
    mocks.role = 'shop_owner';
    renderAdmin();
    expect(screen.getByText('Admin access is required to view this dashboard.')).toBeTruthy();
  });
});

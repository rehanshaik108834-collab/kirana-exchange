import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProblemError, apiClient } from '../../lib/api-client';
import { freshIndexedDb } from '../../test/fresh-indexeddb';
import { rememberProducts } from './catalog-cache';
import { type Product, useCatalogSearch } from './hooks';

const parle: Product = {
  id: 'p1',
  ean: '8901051000020',
  name: 'Parle-G Gluco Biscuits 100g',
  brand: 'Parle',
  packSize: '100g',
  category: 'Biscuits',
  mrp: '10.00',
  gstRate: '18.00',
  shelfLifeDays: 180,
  isActive: true,
};

function renderSearch(q: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useCatalogSearch(q), { wrapper }).result;
}

beforeEach(async () => {
  await freshIndexedDb();
  await rememberProducts([parle]);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useCatalogSearch offline fallback', () => {
  it('answers from the on-device cache when the browser is offline (no request)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const get = vi.spyOn(apiClient, 'get');
    const result = renderSearch('parle');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ products: [parle], fromCache: true });
    expect(get).not.toHaveBeenCalled();
  });

  it('falls back to the cache on a network error', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(
      new ApiProblemError({ status: 0, type: '/errors/network', title: '', detail: '' }),
    );
    const result = renderSearch('8901051000020');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.fromCache).toBe(true);
    expect(result.current.data?.products[0].id).toBe('p1');
  });

  it('surfaces real server errors instead of hiding them behind the cache', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(
      new ApiProblemError({ status: 500, type: '/errors/internal-error', title: '', detail: 'x' }),
    );
    const result = renderSearch('parle');
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

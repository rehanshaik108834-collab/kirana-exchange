import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient, ApiProblemError } from '../../lib/api-client';
import { getDb } from '../../lib/db';
import { rememberProducts, searchCachedProducts } from './catalog-cache';

export interface Product {
  id: string;
  ean: string;
  name: string;
  brand: string;
  packSize: string;
  category: string;
  mrp: string;
  gstRate: string;
  shelfLifeDays: number;
  isActive: boolean;
}

export interface CatalogSearchResult {
  products: Product[];
  /** True when results came from the on-device catalog cache (offline). */
  fromCache: boolean;
}

const EAN_RE = /^\d{8,14}$/;

export function isEan(query: string): boolean {
  return EAN_RE.test(query.trim());
}

const isNetworkError = (err: unknown) => err instanceof ApiProblemError && err.status === 0;

async function searchOnline(q: string, signal?: AbortSignal): Promise<Product[]> {
  if (isEan(q)) {
    try {
      const { data } = await apiClient.get<Product>(`/catalog/products/ean/${q}`, { signal });
      return [data];
    } catch (err) {
      if (err instanceof ApiProblemError && err.status === 404) return [];
      throw err;
    }
  }
  const { data } = await apiClient.get<Product[]>('/catalog/products/search', {
    params: { q, limit: 20 },
    signal,
  });
  return data;
}

/**
 * Catalog search (US-06): an 8–14 digit query is an exact barcode (EAN) lookup, anything else is a
 * trigram name/brand search. Offline (or on a network error) it searches the on-device
 * catalog_cache of products this shop has already seen.
 */
export function useCatalogSearch(query: string) {
  const q = query.trim();
  return useQuery<CatalogSearchResult, ApiProblemError>({
    queryKey: ['catalog', 'search', q],
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    networkMode: 'always', // run while offline so the cache fallback can answer
    queryFn: async ({ signal }) => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { products: await searchCachedProducts(q), fromCache: true };
      }
      try {
        const products = await searchOnline(q, signal);
        void rememberProducts(products).catch(() => undefined);
        return { products, fromCache: false };
      } catch (err) {
        if (isNetworkError(err)) {
          return { products: await searchCachedProducts(q), fromCache: true };
        }
        throw err;
      }
    },
  });
}

/** Product names for the inventory list in one request (max 100 ids per call); cache fallback offline. */
export function useProductsByIds(ids: string[]) {
  const unique = [...new Set(ids)].sort();
  return useQuery<Map<string, Product>, ApiProblemError>({
    queryKey: ['catalog', 'by-ids', unique],
    enabled: unique.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const map = new Map<string, Product>();
      try {
        for (let i = 0; i < unique.length; i += 100) {
          const chunk = unique.slice(i, i + 100);
          const { data } = await apiClient.get<Product[]>('/catalog/products/by-ids', {
            params: { ids: chunk.join(',') },
            signal,
          });
          for (const p of data) map.set(p.id, p);
        }
        void rememberProducts([...map.values()]).catch(() => undefined);
      } catch (err) {
        if (!isNetworkError(err)) throw err;
        const db = await getDb();
        for (const id of unique) {
          const cached = await db.get('catalog_cache', id);
          if (cached) map.set(id, cached);
        }
      }
      return map;
    },
  });
}

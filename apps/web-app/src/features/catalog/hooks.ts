import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { apiClient, ApiProblemError } from '../../lib/api-client';

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

const EAN_RE = /^\d{8,14}$/;

export function isEan(query: string): boolean {
  return EAN_RE.test(query.trim());
}

/**
 * Catalog search (US-06): an 8–14 digit query is treated as a barcode (exact EAN lookup);
 * anything else runs the trigram name/brand search. A missing barcode returns [] rather than an error.
 */
export function useCatalogSearch(query: string) {
  const q = query.trim();
  return useQuery<Product[], ApiProblemError>({
    queryKey: ['catalog', 'search', q],
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
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
    },
  });
}

/** Product names for the inventory list in one request (max 100 ids per call). */
export function useProductsByIds(ids: string[]) {
  const unique = [...new Set(ids)].sort();
  return useQuery<Map<string, Product>, ApiProblemError>({
    queryKey: ['catalog', 'by-ids', unique],
    enabled: unique.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const map = new Map<string, Product>();
      for (let i = 0; i < unique.length; i += 100) {
        const chunk = unique.slice(i, i + 100);
        const { data } = await apiClient.get<Product[]>('/catalog/products/by-ids', {
          params: { ids: chunk.join(',') },
          signal,
        });
        for (const p of data) map.set(p.id, p);
      }
      return map;
    },
  });
}

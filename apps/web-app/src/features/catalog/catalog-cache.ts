import { CATALOG_CACHE_LIMIT, type CachedProduct, getDb } from '../../lib/db';
import type { Product } from './hooks';

/** Remember products the shop has seen (search results, stock list) for offline lookup. */
export async function rememberProducts(products: Product[], now = Date.now()): Promise<void> {
  if (products.length === 0) return;
  const db = await getDb();
  const tx = db.transaction('catalog_cache', 'readwrite');
  for (const p of products) {
    void tx.store.put({ ...p, lastSeenAt: now });
  }
  await tx.done;
  await evictOldest();
}

async function evictOldest(): Promise<void> {
  const db = await getDb();
  const count = await db.count('catalog_cache');
  if (count <= CATALOG_CACHE_LIMIT) return;
  const tx = db.transaction('catalog_cache', 'readwrite');
  let toDelete = count - CATALOG_CACHE_LIMIT;
  let cursor = await tx.store.index('by_last_seen').openCursor();
  while (cursor && toDelete > 0) {
    await cursor.delete();
    toDelete -= 1;
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Offline catalog search: exact EAN match, or every query word found in name/brand.
 * Most recently seen products rank first (the shop's own stock is seen most often).
 */
export async function searchCachedProducts(query: string, limit = 20): Promise<Product[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const db = await getDb();
  if (/^\d{8,14}$/.test(q)) {
    return (await db.getAllFromIndex('catalog_cache', 'by_ean', q)).map(toProduct);
  }
  const words = q.split(/\s+/).filter(Boolean);
  const all = await db.getAll('catalog_cache');
  return all
    .filter((p) => {
      const haystack = `${p.name} ${p.brand}`.toLowerCase();
      return words.every((w) => haystack.includes(w));
    })
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, limit)
    .map(toProduct);
}

function toProduct({ lastSeenAt: _lastSeenAt, ...product }: CachedProduct): Product {
  return product;
}

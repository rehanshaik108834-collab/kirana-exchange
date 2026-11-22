import { beforeEach, describe, expect, it } from 'vitest';
import { CATALOG_CACHE_LIMIT, clearLocalData, getDb } from '../../lib/db';
import { freshIndexedDb } from '../../test/fresh-indexeddb';
import { rememberProducts, searchCachedProducts } from './catalog-cache';
import type { Product } from './hooks';

const product = (id: string, name: string, ean: string, brand = 'Parle'): Product => ({
  id,
  ean,
  name,
  brand,
  packSize: '100g',
  category: 'Biscuits',
  mrp: '10.00',
  gstRate: '18.00',
  shelfLifeDays: 180,
  isActive: true,
});

beforeEach(freshIndexedDb);

describe('catalog_cache (offline catalog search)', () => {
  it('finds by exact EAN and by every query word in name/brand, newest first', async () => {
    await rememberProducts([product('p1', 'Parle-G Gluco Biscuits 100g', '8901051000020')], 1000);
    await rememberProducts([product('p2', 'Parle Hide & Seek 100g', '8901051000105')], 2000);
    await rememberProducts([product('p3', 'Toor Dal 1kg', '8901051099999', 'Tata')], 3000);

    expect((await searchCachedProducts('8901051000020')).map((p) => p.id)).toEqual(['p1']);
    expect((await searchCachedProducts('parle 100g')).map((p) => p.id)).toEqual(['p2', 'p1']);
    expect((await searchCachedProducts('tata dal')).map((p) => p.id)).toEqual(['p3']);
    expect(await searchCachedProducts('maggi')).toEqual([]);
    // lastSeenAt is internal and never leaks into results
    expect(Object.keys((await searchCachedProducts('toor'))[0])).not.toContain('lastSeenAt');
  });

  it('evicts the least recently seen products beyond the limit', async () => {
    const many = Array.from({ length: CATALOG_CACHE_LIMIT }, (_, i) =>
      product(`old-${i}`, `Item ${i}`, String(8_900_000_000_000 + i)),
    );
    await rememberProducts(many, 1000);
    await rememberProducts([product('new', 'Fresh Item', '8901000000001')], 2000);

    const db = await getDb();
    expect(await db.count('catalog_cache')).toBe(CATALOG_CACHE_LIMIT);
    expect(await db.get('catalog_cache', 'new')).toBeDefined();
  });

  it('clearLocalData wipes cached products (sign-out privacy)', async () => {
    await rememberProducts([product('p1', 'Parle-G', '8901051000020')]);
    await clearLocalData();
    expect(await searchCachedProducts('parle')).toEqual([]);
  });
});

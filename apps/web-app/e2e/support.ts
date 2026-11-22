import { randomUUID } from 'node:crypto';
import { type Page, expect } from '@playwright/test';
import pg from 'pg';

export const API = 'http://127.0.0.1:3001/v1';

/** Read-only assertions against inventory_db (same dev credentials as the services). */
export async function inventoryDb<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'kirana_admin',
    password: process.env.DB_PASSWORD ?? 'secretpassword',
    database: 'inventory_db',
  });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

export const chip = (page: Page) => page.locator('header [role="status"]');
export const sellButton = (page: Page) => page.getByRole('button', { name: /^Sell 1 / });

/** Registers a new owner through the UI and creates their shop; ends on /inventory. */
export async function onboardShop(page: Page, shopName: string): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Register Shop Owner' }).click();
  await page.fill('#email', `e2e-${randomUUID().slice(0, 8)}@kirana.test`);
  await page.fill('#password', 'correct-horse-battery');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.waitForURL('**/shop-setup');
  await page.fill('#shopName', shopName);
  await page.fill('#address', '1 Test Road, Hyderabad');
  await page.getByRole('button', { name: 'Save Shop Profile' }).click();
  await page.waitForURL('**/inventory', { timeout: 30_000 });
}

/** Adds a batch via the catalog search and waits until it has synced (Sell 1 enabled). */
export async function addBatch(page: Page, query: string, qty: number, cost = 4): Promise<void> {
  await page.getByRole('link', { name: 'Add stock' }).first().click();
  await page.getByRole('combobox').fill(query);
  await page.getByRole('option').first().click();
  await page.fill('#qty', String(qty));
  await page.fill('#cost', String(cost));
  await page.getByRole('button', { name: 'Save batch' }).click();
  await page.waitForURL('**/inventory');
  await expect(sellButton(page).first()).toBeVisible();
  await expect(chip(page)).toHaveText(/All saved/);
}

export async function session(page: Page): Promise<{ shopId: string; token: string }> {
  return page.evaluate(() => {
    const token = localStorage.getItem('accessToken') ?? '';
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return { token, shopId: JSON.parse(atob(b64)).shopId as string };
  });
}

/** Counts rows in each IndexedDB store of the app's database. */
export async function idbCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(
    () =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const req = indexedDB.open('kirana-exchange');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const stores = ['offline_mutation_queue', 'catalog_cache', 'query_cache'];
          const tx = req.result.transaction(stores);
          const out: Record<string, number> = {};
          let pending = stores.length;
          for (const s of stores) {
            const c = tx.objectStore(s).count();
            c.onsuccess = () => {
              out[s] = c.result;
              if (--pending === 0) {
                req.result.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );
}

/** Taps Sell 1 while offline and waits for the on-device confirmation. */
export async function sellOffline(page: Page, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await sellButton(page).first().click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Saved on this phone' }).first(),
    ).toBeVisible();
    await expect(sellButton(page).first()).toBeEnabled();
  }
}

/** Collects uncaught page errors; assert empty at the end of a test. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

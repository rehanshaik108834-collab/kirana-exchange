import { expect, test } from '@playwright/test';
import {
  addBatch,
  chip,
  idbCounts,
  inventoryDb,
  onboardShop,
  sellButton,
  sellOffline,
  session,
  trackErrors,
} from './support';

test('PWA: service worker, manifest, offline shell and deep link', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForURL('**/login');
  expect(
    await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).active)),
  ).toBe(true);
  await page.reload();
  expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  const manifest = await page.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? '';
    const m = await (await fetch(href)).json();
    return {
      display: m.display as string,
      icons: (m.icons as { sizes: string; purpose?: string }[]).map(
        (i) => `${i.sizes}${i.purpose ? `:${i.purpose}` : ''}`,
      ),
    };
  });
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons).toEqual(
    expect.arrayContaining(['192x192', '512x512', '512x512:maskable']),
  );

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign In' }).first()).toBeVisible();
  await page.goto('/shop-setup'); // offline deep link → SPA fallback → guard
  await expect(page).toHaveURL(/\/login$/);
});

test('offline reload shows saved stock; offline catalog search uses the device cache', async ({
  page,
  context,
}) => {
  const errors = trackErrors(page);
  await onboardShop(page, 'Offline Kirana');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await addBatch(page, 'parle g', 6);
  await page.waitForTimeout(500); // let the persister write the snapshot

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText(/Offline — showing stock saved at/)).toBeVisible();
  const card = page.locator('li').filter({ hasText: 'Can sell' }).first();
  await expect(card).toContainText(/parle/i);
  await expect(card).toContainText('6');
  await expect(page.getByText('Network Error')).toHaveCount(0);

  await page.getByRole('link', { name: 'Add stock' }).first().click();
  await page.getByRole('combobox').fill('parle');
  await expect(page.getByText(/Offline: showing products saved on this phone/)).toBeVisible();
  expect(await page.getByRole('option').count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('US-13: 20 offline sales in two tabs sync exactly once', async ({ page, context }) => {
  const errors = trackErrors(page);
  await onboardShop(page, 'Sync Kirana');
  await addBatch(page, 'parle g', 30);
  const { shopId } = await session(page);
  const [before] = await inventoryDb<{ id: string; qty: number; version: number }>(
    'SELECT id, qty, version FROM inventory_batches WHERE shop_id = $1',
    [shopId],
  );

  const page2 = await context.newPage();
  await page2.goto('/inventory');
  await expect(sellButton(page2)).toBeVisible();

  await context.setOffline(true);
  const offlineStart = Date.now();
  await expect(chip(page)).toHaveText(/Offline/);
  await sellOffline(page, 20);
  const offlineEnd = Date.now();
  await expect(chip(page)).toHaveText('Offline · 20 waiting');
  await expect(chip(page2)).toHaveText(/20 waiting/); // BroadcastChannel
  const card = page.locator('li').filter({ hasText: 'Can sell' }).first();
  await expect(card).toContainText('20 sales not synced yet');
  const countSales = async () =>
    (
      await inventoryDb<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM sales_events WHERE shop_id = $1',
        [shopId],
      )
    )[0].n;
  expect(await countSales()).toBe(0);

  // Reconnect and fire every sync trigger, twice, from both tabs at once.
  await context.setOffline(false);
  const fire = () => {
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  };
  await Promise.all([page.evaluate(fire), page2.evaluate(fire)]);
  await expect(chip(page)).toHaveText(/All saved/, { timeout: 60_000 });
  await expect(chip(page2)).toHaveText(/All saved/, { timeout: 60_000 });
  await page.waitForTimeout(1500); // let any (incorrect) duplicate land before counting

  const sales = await inventoryDb<{ sold_at: Date }>(
    'SELECT sold_at FROM sales_events WHERE shop_id = $1',
    [shopId],
  );
  const [after] = await inventoryDb<{ qty: number; version: number }>(
    'SELECT qty, version FROM inventory_batches WHERE id = $1',
    [before.id],
  );
  expect(sales).toHaveLength(20);
  expect(after.qty).toBe(before.qty - 20);
  expect(after.version).toBe(before.version + 20);
  for (const s of sales) {
    const t = new Date(s.sold_at).getTime();
    expect(t).toBeGreaterThanOrEqual(offlineStart - 1000); // device tap time, not sync time
    expect(t).toBeLessThanOrEqual(offlineEnd + 1000);
  }
  expect((await idbCounts(page)).offline_mutation_queue).toBe(0);
  await expect(card).not.toContainText('not synced');
  expect(errors).toEqual([]);
});

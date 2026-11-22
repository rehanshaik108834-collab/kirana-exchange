import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  API,
  addBatch,
  chip,
  inventoryDb,
  onboardShop,
  sellButton,
  sellOffline,
  session,
  trackErrors,
} from './support';

test('US-14: a real conflict is explained and both fixes work', async ({ page, context }) => {
  const errors = trackErrors(page);
  await onboardShop(page, 'Conflict Kirana');
  await addBatch(page, 'parle g', 10);
  const { shopId, token } = await session(page);

  const batch = async () =>
    (
      await inventoryDb<{ id: string; qty: number; version: number }>(
        'SELECT id, qty, version FROM inventory_batches WHERE shop_id = $1',
        [shopId],
      )
    )[0];
  const salesCount = async () =>
    (
      await inventoryDb<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM sales_events WHERE shop_id = $1',
        [shopId],
      )
    )[0].n;
  /** Another phone of the same shop sells 1 directly through the API. */
  const otherDeviceSells = async () => {
    const b = await batch();
    const res = await fetch(`${API}/inventory/sales`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ shopId, batchId: b.id, qty: 1, expectedVersion: b.version }),
    });
    expect(res.status).toBe(201);
  };
  const reconnect = async () => {
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
  };

  // A: version conflict → "Count this sale on the current stock"
  await context.setOffline(true);
  await sellOffline(page, 2);
  await otherDeviceSells();
  await reconnect();
  await expect(chip(page)).toHaveText('1 needs attention', { timeout: 30_000 });
  expect(await salesCount()).toBe(1);
  await chip(page).click();
  await page.waitForURL('**/sync-issues');
  const issue = page.locator('li').first();
  await expect(issue).toContainText('changed on another phone');
  await expect(issue).not.toContainText(/409|version/i);
  await expect(page.locator('section')).toContainText('1 more sale is waiting behind them.');
  await page.getByRole('button', { name: 'Count this sale on the current stock' }).click();
  await expect(page.getByText('Nothing needs your attention.')).toBeVisible({ timeout: 30_000 });
  await expect(chip(page)).toHaveText(/All saved/, { timeout: 30_000 });
  expect(await salesCount()).toBe(3);
  expect((await batch()).qty).toBe(7);

  // B: conflict → Discard (two-step)
  await page.getByRole('link', { name: 'Stock', exact: true }).click();
  await expect(sellButton(page)).toBeVisible();
  await context.setOffline(true);
  await sellOffline(page, 1);
  await otherDeviceSells();
  await reconnect();
  await expect(chip(page)).toHaveText('1 needs attention', { timeout: 30_000 });
  await page.getByRole('link', { name: /needs attention — fix it/ }).click();
  await page.waitForURL('**/sync-issues');
  await page.getByRole('button', { name: 'Discard this entry' }).click();
  await page.getByRole('button', { name: 'Yes, discard' }).click();
  await expect(page.getByText('Nothing needs your attention.')).toBeVisible({ timeout: 30_000 });
  await expect(chip(page)).toHaveText(/All saved/, { timeout: 30_000 });
  expect(await salesCount()).toBe(4);
  expect((await batch()).qty).toBe(6);
  expect(errors).toEqual([]);
});

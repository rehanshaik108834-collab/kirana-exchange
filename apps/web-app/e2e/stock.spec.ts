import { expect, test } from '@playwright/test';
import { addBatch, chip, idbCounts, onboardShop, sellButton, trackErrors } from './support';

test('owner onboarding → add stock (stepper) → Sell 1 → sign out wipes the device', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/inventory');
  await expect(page).toHaveURL(/\/login$/); // guard

  await onboardShop(page, 'Ramesh Kirana');
  await expect(page.locator('header')).toContainText('Ramesh Kirana');

  // Add stock with the − / + stepper instead of typing.
  await page.getByRole('link', { name: 'Add stock' }).first().click();
  await page.getByRole('combobox').fill('parle g');
  await page.getByRole('option').first().click();
  await expect(page.locator('#expiry')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/); // from shelf life
  const plus = page.getByRole('button', { name: 'Increase quantity' });
  for (let i = 0; i < 6; i++) await plus.click();
  await page.getByRole('button', { name: 'Decrease quantity' }).click();
  await expect(page.locator('#qty')).toHaveValue('5');
  await page.fill('#cost', '4.5');
  await page.getByRole('button', { name: 'Save batch' }).click();
  await page.waitForURL('**/inventory');

  const card = page.locator('li').filter({ hasText: 'Can sell' }).first();
  await expect(card).toContainText(/parle/i);
  await expect(card).toContainText('₹4.50');
  await expect(sellButton(page)).toBeEnabled();
  await expect(chip(page)).toHaveText(/All saved/);

  await sellButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: '4 left to sell' })).toBeVisible();

  // Nothing pending → signs out immediately and leaves no shop data behind (US-05).
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/login');
  expect(await page.evaluate(() => localStorage.getItem('accessToken'))).toBeNull();
  expect(Object.values(await idbCounts(page)).every((n) => n === 0)).toBe(true);
  expect(errors).toEqual([]);
});

test('sign-out asks first when sales are not synced yet', async ({ page, context }) => {
  await onboardShop(page, 'Careful Kirana');
  await addBatch(page, 'parle g', 5);

  await context.setOffline(true);
  await sellButton(page).click();
  await expect(chip(page)).toHaveText(/Offline · 1 waiting/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('1 entry is not saved to your shop yet.');
  await page.getByRole('button', { name: 'Stay signed in' }).click();
  await expect(dialog).toBeHidden();
  expect((await idbCounts(page)).offline_mutation_queue).toBe(1); // kept

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('button', { name: 'Sign out anyway' }).click();
  await page.waitForURL('**/login');
  expect(Object.values(await idbCounts(page)).every((n) => n === 0)).toBe(true);
});

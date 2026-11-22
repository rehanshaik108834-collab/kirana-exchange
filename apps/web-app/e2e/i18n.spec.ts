import { expect, test } from '@playwright/test';
import hi from '../src/i18n/locales/hi.json' with { type: 'json' };
import te from '../src/i18n/locales/te.json' with { type: 'json' };
import { onboardShop, sellButton } from './support';

test('language switch: Telugu and Hindi render, persist and set <html lang>', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: 'తెలుగు' }).click();
  await expect(page.getByRole('button', { name: te.auth.registerTab })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'te');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'te');

  // Back to English for the shared onboarding helper, then switch from the app header.
  await page.getByRole('button', { name: 'English' }).click();
  await onboardShop(page, 'Bhasha Kirana');
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.getByRole('heading', { name: hi.inventory.title })).toBeVisible();
  await expect(page.getByRole('link', { name: hi.nav.addStock }).first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');

  await page.getByRole('button', { name: 'తెలుగు' }).click();
  await expect(page.getByRole('heading', { name: te.inventory.title })).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'My stock' })).toBeVisible();
  await expect(sellButton(page)).toHaveCount(0); // empty shop, English again
});

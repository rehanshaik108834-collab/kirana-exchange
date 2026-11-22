import { expect, test } from '@playwright/test';
import { onboardShop } from './support';

// Runs in the `camera` project: Edge's fake camera shows a real EAN-13 image (global-setup).
test('ZXing decodes a camera barcode and finds the product; camera is released', async ({
  page,
}) => {
  const ean = process.env.E2E_SCAN_EAN ?? '';
  expect(ean).toMatch(/^\d{13}$/);
  await onboardShop(page, 'Scan Kirana');
  await page.getByRole('link', { name: 'Add stock' }).first().click();

  await page.getByRole('button', { name: 'Scan barcode with camera' }).click();
  await expect(page.getByRole('dialog', { name: 'Scan a barcode' })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 30_000 }); // closes on detection
  await expect(page.getByRole('combobox')).toHaveValue(ean);
  await expect(page.getByRole('option').first()).toContainText(ean);

  const live = await page.evaluate(() =>
    [...document.querySelectorAll('video')].some((v) =>
      (v.srcObject as MediaStream | null)?.getTracks().some((t) => t.readyState === 'live'),
    ),
  );
  expect(live).toBe(false);
});

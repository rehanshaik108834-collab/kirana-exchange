import fs from 'node:fs';
import path from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';
import { API } from './support';
import { CAMERA_FRAME } from './paths';

// Standard EAN-13 encoding tables.
const L = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];
const G = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
];
const R = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
];
const PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

function ean13Svg(code: string): string {
  const d = code.split('').map(Number);
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (PARITY[d[0]][i - 1] === 'L' ? L : G)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[d[i]];
  bits += '101';
  const m = 4; // module width: 95 modules + quiet zones fit a 640 px frame
  const quiet = 12 * m;
  const bars = [...bits]
    .map((b, i) =>
      b === '1' ? `<rect x="${quiet + i * m}" y="60" width="${m}" height="300" fill="#000"/>` : '',
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bits.length * m + 2 * quiet}" height="480"><rect width="100%" height="100%" fill="#fff"/>${bars}</svg>`;
}

/**
 * Renders a real catalog product's EAN-13 as the fake camera frame used by scan.spec.ts,
 * and records which EAN it shows.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const channel = (config.projects[0].use.channel as string | undefined) ?? 'msedge';
  const reg = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `scan-${Date.now()}@kirana.test`,
      password: 'correct-horse-battery',
    }),
  }).then((r) => r.json() as Promise<{ accessToken: string }>);
  const [product] = await fetch(`${API}/catalog/products/search?q=parle-g&limit=1`, {
    headers: { authorization: `Bearer ${reg.accessToken}` },
  }).then((r) => r.json() as Promise<{ ean: string; name: string }[]>);

  fs.mkdirSync(path.dirname(CAMERA_FRAME), { recursive: true });
  const browser = await chromium.launch({ channel });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  await page.setContent(
    `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:480px;background:#fff">${ean13Svg(product.ean)}</body>`,
  );
  fs.writeFileSync(CAMERA_FRAME, await page.screenshot({ type: 'jpeg', quality: 95 }));
  await browser.close();
  process.env.E2E_SCAN_EAN = product.ean;
}

import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { CAMERA_FRAME, WEB_APP_DIR } from './e2e/paths';

/**
 * Browser E2E for the PWA against the real stack.
 *
 * Prerequisites: Docker infra up (postgres/redis/rabbitmq), `pnpm -r build` (services' dist/ and
 * this app's dist/). Playwright starts the five services and `vite preview` on :5173 (the only
 * origin the gateway allows by CORS), or reuses ones already running.
 *
 * Uses the installed Edge by default (no browser download); set PW_CHANNEL=chrome to use Chrome.
 */
const channel = process.env.PW_CHANNEL ?? 'msedge';
const apps = path.resolve(WEB_APP_DIR, '..');

const service = (dir: string, port: number, healthPath: string) => ({
  command: 'node dist/main.js',
  cwd: path.join(apps, dir),
  url: `http://127.0.0.1:${port}${healthPath}`,
  env: { PORT: String(port) },
  reuseExistingServer: true,
  timeout: 180_000,
  stdout: 'ignore' as const,
  stderr: 'pipe' as const,
});

export default defineConfig({
  testDir: './e2e',
  // One shared backend and real DB assertions per shop: run serially for deterministic timing.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://localhost:5173',
    channel,
    viewport: { width: 390, height: 844 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'app', testIgnore: /scan\.spec\.ts/ },
    {
      name: 'camera',
      testMatch: /scan\.spec\.ts/,
      use: {
        permissions: ['camera'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-video-capture=${CAMERA_FRAME}`,
          ],
        },
      },
    },
  ],
  webServer: [
    service('auth-service', 3002, '/v1/auth/health'),
    service('shop-service', 3003, '/v1/shops/health'),
    service('catalog-service', 3004, '/health'),
    service('inventory-service', 3005, '/health'),
    service('api-gateway', 3001, '/health'),
    {
      command: 'pnpm exec vite preview --port 5173 --strictPort',
      cwd: WEB_APP_DIR,
      url: 'http://localhost:5173/',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});

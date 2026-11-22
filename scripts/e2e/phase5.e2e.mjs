#!/usr/bin/env node
/**
 * Phase 5 end-to-end checks through the real api-gateway.
 *
 * Prerequisites:
 *   docker compose -f infra/docker-compose.yml up -d postgres redis rabbitmq
 *   pnpm -r build
 * Run:
 *   pnpm e2e:phase5
 *
 * Starts gateway + auth + shop + catalog + inventory from their dist/ builds, runs the checks,
 * prints a PASS/FAIL table and stops the services. Exit code 1 if any check fails.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GW = 'http://127.0.0.1:3001/v1';
const SERVICES = [
  ['auth-service', 3002, 'http://127.0.0.1:3002/v1/auth/health'],
  ['shop-service', 3003, 'http://127.0.0.1:3003/v1/shops/health'],
  ['catalog-service', 3004, 'http://127.0.0.1:3004/health'],
  ['inventory-service', 3005, 'http://127.0.0.1:3005/health'],
  ['api-gateway', 3001, 'http://127.0.0.1:3001/health'],
];
const PROBLEM = 'https://kirana-exchange.local/errors/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = [];
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function startService(name, port) {
  const p = spawn(process.execPath, ['dist/main.js'], {
    cwd: path.join(repo, 'apps', name),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.name = name;
  p.logs = [];
  p.stdout.on('data', (d) => p.logs.push(d.toString()));
  p.stderr.on('data', (d) => p.logs.push(d.toString()));
  procs.push(p);
}

async function waitHealthy(url, timeoutMs = 45_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`Service not healthy: ${url}`);
}

/** HTTP call through the gateway; retries once on 429 honouring Retry-After. */
async function call(method, route, { token, body, idem, headers = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GW}${route}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idem ? { 'idempotency-key': idem } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt === 0) {
      const wait = Number(res.headers.get('retry-after') || 1);
      await sleep(wait * 1000 + 200);
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
}

function claims(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

async function registerUser(role) {
  const email = `e2e-${role}-${randomUUID().slice(0, 8)}@kirana.test`;
  const res = await call('POST', '/auth/register', {
    body: { email, password: 'correct-horse-battery', role },
  });
  return { email, ...res.body, status: res.status };
}

async function createAdmin() {
  const email = `e2e-admin-${randomUUID().slice(0, 8)}@kirana.test`;
  const password = 'admin-password-e2e-123';
  await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['dist/scripts/create-admin.js'], {
      cwd: path.join(repo, 'apps', 'auth-service'),
      env: { ...process.env, ADMIN_EMAIL: email, ADMIN_PASSWORD: password },
      stdio: 'ignore',
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`create-admin ${code}`))));
  });
  const res = await call('POST', '/auth/login', { body: { email, password } });
  return res.body;
}

/** Create a shop for `owner`, then refresh until the token carries the linked shopId. */
async function onboardShop(owner, name) {
  const shopRes = await call('POST', '/shops', {
    token: owner.accessToken,
    body: {
      name,
      address: '12-4-88 Banjara Hills, Hyderabad',
      lat: 17.412627,
      lng: 78.448288,
      state: 'Telangana',
      gstScheme: 'COMPOSITION',
    },
  });
  let tokens = { accessToken: owner.accessToken, refreshToken: owner.refreshToken };
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    const r = await call('POST', '/auth/refresh', { body: { refreshToken: tokens.refreshToken } });
    if (r.status !== 200) break;
    tokens = r.body;
    if (claims(tokens.accessToken).shopId) break;
    await sleep(400);
  }
  return { shopRes, tokens, shopId: claims(tokens.accessToken).shopId };
}

async function main() {
  for (const [name, port] of SERVICES) startService(name, port);
  for (const [, , url] of SERVICES) await waitHealthy(url);
  console.log('All services healthy.\n');

  // ---- auth: registration hardening ----
  const adminReg = await call('POST', '/auth/register', {
    body: {
      email: `e2e-x-${randomUUID().slice(0, 6)}@kirana.test`,
      password: 'correct-horse-battery',
      role: 'admin',
    },
  });
  check(
    'Self-registration as admin is rejected',
    adminReg.status === 400,
    `status ${adminReg.status}`,
  );
  const shopIdReg = await call('POST', '/auth/register', {
    body: {
      email: `e2e-y-${randomUUID().slice(0, 6)}@kirana.test`,
      password: 'correct-horse-battery',
      shopId: randomUUID(),
    },
  });
  check(
    'Self-registration with a shopId is rejected',
    shopIdReg.status === 400,
    `status ${shopIdReg.status}`,
  );
  check(
    'Validation errors use the catalogue type',
    adminReg.body?.type === `${PROBLEM}validation-failed` && adminReg.body?.correlationId,
    adminReg.body?.type,
  );

  // ---- shop onboarding + event-driven shopId linking ----
  const ownerA = await registerUser('shop_owner');
  check('Owner A registers', ownerA.status === 201 && claims(ownerA.accessToken).shopId === null);
  const a = await onboardShop(ownerA, 'E2E Kirana A');
  check('Owner A creates a shop', a.shopRes.status === 201, `status ${a.shopRes.status}`);
  check('Shop ownerId comes from the JWT, not the body', a.shopRes.body?.ownerId === ownerA.userId);
  check(
    'shop.created.v1 -> auth links users.shop_id (refreshed token carries shopId)',
    a.shopId === a.shopRes.body?.id,
    `shopId ${a.shopId}`,
  );
  const me = await call('GET', '/shops/me', { token: a.tokens.accessToken });
  check('GET /shops/me returns the caller shop', me.status === 200 && me.body?.id === a.shopId);

  const ownerB = await registerUser('shop_owner');
  const b = await onboardShop(ownerB, 'E2E Kirana B');
  check('Owner B onboards a separate shop', b.shopId && b.shopId !== a.shopId);
  const otherShop = await call('GET', `/shops/${a.shopId}`, { token: b.tokens.accessToken });
  check(
    "Owner B cannot read shop A's profile",
    otherShop.status === 403,
    `status ${otherShop.status}`,
  );
  const moveOther = await call('PATCH', `/shops/${a.shopId}/location`, {
    token: b.tokens.accessToken,
    body: { lat: 17.4, lng: 78.4, state: 'Telangana' },
  });
  check("Owner B cannot move shop A's pin", moveOther.status === 403, `status ${moveOther.status}`);

  const staff = await registerUser('shop_staff');
  const staffShop = await call('POST', '/shops', {
    token: staff.accessToken,
    body: {
      name: 'Staff Shop',
      address: '1 Main Road',
      lat: 17,
      lng: 78,
      state: 'Telangana',
      gstScheme: 'REGULAR',
    },
  });
  check('shop_staff cannot create a shop', staffShop.status === 403, `status ${staffShop.status}`);

  // ---- catalog: admin creates a product, by-ids lookup ----
  const admin = await createAdmin();
  check(
    'create-admin script + admin login',
    Boolean(admin?.accessToken) && claims(admin.accessToken).role === 'admin',
  );
  const ean = `890${Date.now()}`.slice(0, 13);
  const product = await call('POST', '/catalog/products', {
    token: admin.accessToken,
    body: {
      ean,
      name: 'E2E Toor Dal 1kg',
      brand: 'E2E Foods',
      packSize: '1kg',
      category: 'Pulses',
      mrp: 165,
      gstRate: 5,
    },
  });
  check('Admin creates a catalog product', product.status === 201, `status ${product.status}`);
  const ownerProduct = await call('POST', '/catalog/products', {
    token: a.tokens.accessToken,
    body: {
      ean: `${ean.slice(0, 12)}9`,
      name: 'Nope',
      brand: 'x',
      packSize: '1',
      category: 'xx',
      mrp: 1,
      gstRate: 5,
    },
  });
  check(
    'Shop owner cannot mutate the catalog',
    ownerProduct.status === 403,
    `status ${ownerProduct.status}`,
  );
  const byIds = await call(
    'GET',
    `/catalog/products/by-ids?ids=${product.body.id},${randomUUID()}`,
    {
      token: a.tokens.accessToken,
    },
  );
  check(
    'GET /catalog/products/by-ids returns known ids only',
    byIds.status === 200 && byIds.body.length === 1 && byIds.body[0].id === product.body.id,
  );

  // ---- inventory: idempotency, date fix, problem types, ownership ----
  const idem = randomUUID();
  const batchBody = {
    shopId: a.shopId,
    productId: product.body.id,
    batchCode: `E2E-${Date.now()}`,
    qty: 10,
    costPrice: 140.5,
    expiryDate: '2027-03-15',
  };
  const batch1 = await call('POST', '/inventory/batches', {
    token: a.tokens.accessToken,
    body: batchBody,
    idem,
  });
  const batch2 = await call('POST', '/inventory/batches', {
    token: a.tokens.accessToken,
    body: batchBody,
    idem,
  });
  check('Add batch succeeds', batch1.status === 201, `status ${batch1.status}`);
  check('Same Idempotency-Key returns the same batch', batch2.body?.id === batch1.body?.id);
  const batch = batch1.body;

  const stale = await call('POST', '/inventory/sales', {
    token: a.tokens.accessToken,
    idem: randomUUID(),
    body: { shopId: a.shopId, batchId: batch.id, qty: 1, expectedVersion: batch.version + 5 },
  });
  check(
    'Stale version -> 409 version-conflict',
    stale.status === 409 && stale.body?.type === `${PROBLEM}version-conflict`,
    stale.body?.type,
  );
  const sale = await call('POST', '/inventory/sales', {
    token: a.tokens.accessToken,
    idem: randomUUID(),
    body: { shopId: a.shopId, batchId: batch.id, qty: 2, expectedVersion: batch.version },
  });
  check(
    'Sale succeeds and bumps version',
    sale.status === 201 && sale.body.batch.version === batch.version + 1,
  );
  check(
    'Expiry date preserved after sale (DATE off-by-one fixed)',
    sale.body?.batch?.expiryDate === '2027-03-15',
    sale.body?.batch?.expiryDate,
  );
  const oversell = await call('POST', '/inventory/sales', {
    token: a.tokens.accessToken,
    idem: randomUUID(),
    body: {
      shopId: a.shopId,
      batchId: batch.id,
      qty: 50,
      expectedVersion: sale.body.batch.version,
    },
  });
  check(
    'Oversell -> 409 insufficient-unreserved-stock',
    oversell.status === 409 &&
      oversell.body?.type === `${PROBLEM}insufficient-unreserved-stock` &&
      oversell.body?.available === 8,
    oversell.body?.type,
  );
  const listed = await call('GET', `/inventory/batches?shopId=${a.shopId}`, {
    token: a.tokens.accessToken,
  });
  check(
    'List batches shows qty 8 and the correct expiry',
    listed.status === 200 &&
      listed.body[0]?.qty === 8 &&
      listed.body[0]?.expiryDate === '2027-03-15',
  );

  // ---- Phase 6.3: offline sales keep their device time (bounded soldAt) ----
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const offlineKey = randomUUID();
  const offlineSaleBody = {
    shopId: a.shopId,
    batchId: batch.id,
    qty: 1,
    expectedVersion: sale.body.batch.version,
    soldAt: twoHoursAgo,
  };
  const offlineSale = await call('POST', '/inventory/sales', {
    token: a.tokens.accessToken,
    idem: offlineKey,
    body: offlineSaleBody,
  });
  check(
    'Offline sale keeps the device soldAt',
    offlineSale.status === 201 &&
      new Date(offlineSale.body.sale.soldAt).toISOString() === twoHoursAgo,
    offlineSale.body?.sale?.soldAt,
  );
  const offlineReplay = await call('POST', '/inventory/sales', {
    token: a.tokens.accessToken,
    idem: offlineKey,
    body: offlineSaleBody,
  });
  check(
    'Replaying the queued sale returns the same sale (exactly once)',
    offlineReplay.status === 201 && offlineReplay.body?.sale?.id === offlineSale.body?.sale?.id,
  );
  const tooOld = await call('POST', '/inventory/sales', {
    token: a.tokens.accessToken,
    idem: randomUUID(),
    body: {
      ...offlineSaleBody,
      expectedVersion: offlineSale.body.batch.version,
      soldAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  check('soldAt older than 7 days -> 400', tooOld.status === 400, `status ${tooOld.status}`);
  const future = await call('POST', '/inventory/sales', {
    token: a.tokens.accessToken,
    idem: randomUUID(),
    body: {
      ...offlineSaleBody,
      expectedVersion: offlineSale.body.batch.version,
      soldAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
  });
  check('soldAt in the future -> 400', future.status === 400, `status ${future.status}`);

  const crossRead = await call('GET', `/inventory/batches?shopId=${a.shopId}`, {
    token: b.tokens.accessToken,
  });
  check(
    "Owner B cannot read shop A's inventory",
    crossRead.status === 403,
    `status ${crossRead.status}`,
  );
  const unlinked = await registerUser('shop_owner');
  const unlinkedRead = await call('GET', `/inventory/batches?shopId=${a.shopId}`, {
    token: unlinked.accessToken,
  });
  check(
    'User without a linked shop is denied (ownership bypass closed)',
    unlinkedRead.status === 403,
    `status ${unlinkedRead.status}`,
  );
  const adminRead = await call('GET', `/inventory/batches?shopId=${a.shopId}`, {
    token: admin.accessToken,
  });
  check('Admin can read any shop inventory', adminRead.status === 200);

  const missing = await call('GET', `/inventory/batches?shopId=${a.shopId}`, {});
  check(
    'No token -> 401 unauthorized problem',
    missing.status === 401 && missing.body?.type === `${PROBLEM}unauthorized`,
  );
}

main()
  .catch((err) => {
    check('E2E run completed without crashing', false, err.message);
    for (const p of procs) {
      console.error(`--- ${p.name} (last logs) ---\n${p.logs.join('').slice(-1500)}`);
    }
  })
  .finally(async () => {
    for (const p of procs) p.kill('SIGTERM');
    await sleep(800);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    process.exit(failed.length === 0 ? 0 : 1);
  });

import { ForbiddenException } from '@nestjs/common';
import { verifyInternalSignature } from '@kirana/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayProxyController } from '../src/proxy.controller';
import { UpstreamClientService } from '../src/resilience/upstream-client.service';

describe('OWASP Top 10 & API Security Authorization Suite (Phase 11, Slice 3)', () => {
  const clients: UpstreamClientService[] = [];

  afterEach(() => {
    while (clients.length > 0) clients.pop()?.shutdown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function makeController() {
    const client = new UpstreamClientService({ maxGetRetries: 0 });
    clients.push(client);
    return new GatewayProxyController(client);
  }

  const fakeRes = () =>
    ({
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    }) as any;

  it.each([
    '/v1/swaps/internal/matching-snapshot?state=Telangana',
    '/v1/swaps/INTERNAL/matching-snapshot?state=Telangana',
    '/v1/swaps/%69nternal/matching-snapshot?state=Telangana',
    '/v1/swaps/candidates/../../swaps/internal/matching-snapshot',
    '/v1/inventory/%2e%2e/shops/me',
  ])('blocks internal-endpoint bypass and path traversal attempt: %s', async (maliciousUrl) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const controller = makeController();
    const req: any = {
      method: 'GET',
      originalUrl: maliciousUrl,
      headers: {},
      user: { sub: 'u-1', role: 'shop_owner', shopId: 'shop-1' },
    };

    const call = maliciousUrl.startsWith('/v1/swaps')
      ? controller.proxySwaps(req, fakeRes())
      : controller.proxyInventory(req, fakeRes());

    await expect(call).rejects.toThrow(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prevents privilege escalation on admin-only catalog, forecast, and analytics routes', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const controller = makeController();

    const nonAdminUser = { sub: 'u-1', role: 'shop_owner', shopId: 'shop-1' };

    await expect(
      controller.proxyCatalog(
        {
          method: 'POST',
          originalUrl: '/v1/catalog/products',
          headers: {},
          user: nonAdminUser,
        } as any,
        fakeRes(),
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      controller.proxyForecasts(
        {
          method: 'POST',
          originalUrl: '/v1/forecasts/run-batch',
          headers: {},
          user: nonAdminUser,
        } as any,
        fakeRes(),
      ),
    ).rejects.toThrow(ForbiddenException);

    await expect(
      controller.proxyAnalytics(
        {
          method: 'GET',
          originalUrl: '/v1/analytics/metrics',
          headers: {},
          user: nonAdminUser,
        } as any,
        fakeRes(),
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips attacker-supplied identity & internal headers and signs verified JWT claims', async () => {
    let outboundHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        outboundHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const controller = makeController();
    await controller.proxyInventory(
      {
        method: 'GET',
        originalUrl: '/v1/inventory/batches?shopId=shop-victim',
        headers: {
          'x-user-id': 'admin-spoof',
          'x-user-role': 'admin',
          'x-shop-id': 'shop-victim',
          'x-internal-service': 'swap-matcher',
          'x-internal-signature': '0000',
        },
        user: { sub: 'attacker-1', role: 'shop_owner', shopId: 'shop-attacker' },
      } as any,
      fakeRes(),
    );

    expect(outboundHeaders['x-user-id']).toBe('attacker-1');
    expect(outboundHeaders['x-user-role']).toBe('shop_owner');
    expect(outboundHeaders['x-shop-id']).toBe('shop-attacker');
    expect(outboundHeaders['x-internal-service']).toBe('api-gateway');
    expect(
      verifyInternalSignature(outboundHeaders, 'GET', '/v1/inventory/batches?shopId=shop-victim')
        .valid,
    ).toBe(true);
  });
});

import { ServiceUnavailableException } from '@nestjs/common';
import { verifyInternalSignature } from '@kirana/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecurityHeadersMiddleware } from '../src/middleware/security-headers.middleware';
import { GatewayProxyController } from '../src/proxy.controller';
import { UpstreamClientService } from '../src/resilience/upstream-client.service';

describe('Phase 11, Slice 1 — Circuit Breakers, Retries, Internal Auth & Security Headers', () => {
  const activeClients: UpstreamClientService[] = [];

  afterEach(() => {
    while (activeClients.length > 0) {
      activeClients.pop()?.shutdown();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries transient 503/network failures on idempotent GET and succeeds upon recovery', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) {
        return new Response('upstream overloaded', { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new UpstreamClientService({
      maxGetRetries: 2,
      retryBaseDelayMs: 5,
      volumeThreshold: 10,
    });
    activeClients.push(client);

    const res = await client.execute('catalog', 'http://127.0.0.1:3004/v1/catalog/search', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    expect(attempts).toBe(3);
  });

  it('never retries non-idempotent POST requests on failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new UpstreamClientService({
      maxGetRetries: 2,
      retryBaseDelayMs: 5,
      volumeThreshold: 10,
    });
    activeClients.push(client);

    await expect(
      client.execute('inventory', 'http://127.0.0.1:3005/v1/inventory/sales', {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens circuit breaker after repeated upstream outages, fails fast without calling fetch, and isolates other services', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(':3006')) {
        throw new Error('ECONNREFUSED');
      }
      return new Response('{"healthy":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new UpstreamClientService({
      maxGetRetries: 0,
      volumeThreshold: 3,
      errorThresholdPercentage: 50,
      resetTimeoutMs: 60_000,
    });
    activeClients.push(client);

    // 3 failures trip the 'forecast' breaker
    for (let i = 0; i < 3; i++) {
      await expect(
        client.execute('forecast', 'http://127.0.0.1:3006/v1/forecasts/shops/s1', {
          method: 'GET',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    }

    expect(client.isOpen('forecast')).toBe(true);
    expect(client.getBreakerStates().forecast).toBe('open');

    const callsBeforeFailFast = fetchMock.mock.calls.length;

    // Next call fails fast with circuit-open 503 WITHOUT calling fetch
    await expect(
      client.execute('forecast', 'http://127.0.0.1:3006/v1/forecasts/shops/s1', {
        method: 'GET',
      }),
    ).rejects.toThrow(/circuit open/i);
    expect(fetchMock.mock.calls.length).toBe(callsBeforeFailFast);

    // Unrelated service ('catalog') remains completely isolated and healthy
    const ok = await client.execute('catalog', 'http://127.0.0.1:3004/v1/catalog/search', {
      method: 'GET',
    });
    expect(ok.status).toBe(200);
    expect(client.getBreakerStates().catalog).toBe('closed');
  });

  it('does NOT trip the circuit breaker on 4xx client errors', async () => {
    const fetchMock = vi.fn(async () => new Response('{"detail":"conflict"}', { status: 409 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new UpstreamClientService({
      maxGetRetries: 0,
      volumeThreshold: 2,
      errorThresholdPercentage: 50,
    });
    activeClients.push(client);

    for (let i = 0; i < 5; i++) {
      const res = await client.execute('inventory', 'http://127.0.0.1:3005/v1/inventory/sales', {
        method: 'POST',
      });
      expect(res.status).toBe(409);
    }
    expect(client.isOpen('inventory')).toBe(false);
  });

  it('attaches valid HMAC-SHA256 internal auth headers on proxied requests', async () => {
    let forwardedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      forwardedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ id: 'shop-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new UpstreamClientService({ maxGetRetries: 0 });
    activeClients.push(client);
    const controller = new GatewayProxyController(client);

    const res: any = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/shops/me',
      headers: {
        'x-correlation-id': 'corr-1',
        // Attacker attempt to spoof headers in raw client request (must be ignored/overwritten)
        'x-user-role': 'admin',
        'x-internal-signature': 'forged',
      },
      user: { sub: 'owner-42', role: 'shop_owner', shopId: 'shop-42' },
    };

    await controller.proxyShops(req, res);

    expect(forwardedHeaders['x-user-role']).toBe('shop_owner');
    expect(forwardedHeaders['x-internal-service']).toBe('api-gateway');
    const verified = verifyInternalSignature(forwardedHeaders, 'GET', '/v1/shops/me');
    expect(verified).toEqual({ valid: true, caller: 'api-gateway' });
  });

  it('SecurityHeadersMiddleware sets OWASP headers and HSTS under HTTPS', () => {
    const middleware = new SecurityHeadersMiddleware();
    const headers: Record<string, string> = {};
    const res: any = { setHeader: (k: string, v: string) => (headers[k] = v) };
    const next = vi.fn();

    middleware.use({ headers: { 'x-forwarded-proto': 'https' } } as any, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Content-Security-Policy']).toContain("default-src 'none'");
    expect(headers['Strict-Transport-Security']).toContain('max-age=31536000');
  });
});

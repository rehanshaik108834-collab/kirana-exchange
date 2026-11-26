import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../src/guards/jwt-auth.guard';
import { GatewayProxyController } from '../src/proxy.controller';
import { UpstreamClientService } from '../src/resilience/upstream-client.service';

const jwt = new JwtService({ secret: 'chaos-test-secret', signOptions: { expiresIn: '15m' } });

function httpContext(headers: Record<string, string>) {
  const request: Record<string, any> = { headers, ip: '10.0.0.1' };
  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    } as any,
  };
}

describe('Phase 11 Chaos Drills — Redis Outage & Downstream Service Kill/Recovery', () => {
  const activeClients: UpstreamClientService[] = [];

  afterEach(() => {
    delete process.env.DENYLIST_FAIL_OPEN;
    while (activeClients.length > 0) {
      activeClients.pop()?.shutdown();
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('CHAOS DRILL 3 (Redis Killed): JwtAuthGuard fails closed with 503 by default, and supports DENYLIST_FAIL_OPEN=true', async () => {
    const validToken = await jwt.signAsync({
      sub: 'owner-1',
      jti: 'jti-chaos-1',
      role: 'shop_owner',
      shopId: 'shop-1',
    });

    const brokenRedis = {
      exists: vi.fn().mockRejectedValue(new Error('ECONNREFUSED: Redis down')),
    };

    const guard = new JwtAuthGuard(jwt, brokenRedis as any);

    // Default strict posture: returns clean 503 ServiceUnavailableException (never 500 crash)
    await expect(
      guard.canActivate(httpContext({ authorization: `Bearer ${validToken}` }).context),
    ).rejects.toThrow(ServiceUnavailableException);

    // Documented degraded continuity posture: DENYLIST_FAIL_OPEN=true allows valid unexpired JWTs
    process.env.DENYLIST_FAIL_OPEN = 'true';
    const ctx = httpContext({ authorization: `Bearer ${validToken}` });
    await expect(guard.canActivate(ctx.context)).resolves.toBe(true);
    expect(ctx.request.user?.sub).toBe('owner-1');
  });

  it('CHAOS DRILL 4 (Service Killed & Restarted): breaker opens -> fails fast on SSE & REST -> auto-heals to closed', async () => {
    let swapServiceUp = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(':3007') && !swapServiceUp) {
        throw new Error('ECONNREFUSED: swap-service killed');
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new UpstreamClientService({
      maxGetRetries: 0,
      volumeThreshold: 2,
      errorThresholdPercentage: 50,
      resetTimeoutMs: 60,
    });
    activeClients.push(client);
    const controller = new GatewayProxyController(client);

    // 1. Kill swap-service -> 2 failed calls trip breaker to OPEN
    for (let i = 0; i < 2; i++) {
      await expect(
        client.execute('swap', 'http://127.0.0.1:3007/v1/swaps/candidates', { method: 'GET' }),
      ).rejects.toThrow(ServiceUnavailableException);
    }
    expect(client.getBreakerStates().swap).toBe('open');

    // 2. SSE requests targeting an open breaker fail fast with 503 instead of hanging
    const res: any = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), send: vi.fn() };
    await expect(
      controller.proxySwaps(
        {
          method: 'GET',
          originalUrl: '/v1/swaps/candidates',
          headers: { accept: 'text/event-stream' },
          user: { sub: 'u-1', role: 'shop_owner', shopId: 's-1' },
        } as any,
        res,
      ),
    ).rejects.toThrow(/circuit open/i);

    // 3. Restart swap-service and wait past resetTimeoutMs -> halfOpen probe succeeds -> breaker CLOSES
    swapServiceUp = true;
    await new Promise((r) => setTimeout(r, 85));

    const recovered = await client.execute('swap', 'http://127.0.0.1:3007/v1/swaps/candidates', {
      method: 'GET',
    });
    expect(recovered.status).toBe(200);
    expect(client.getBreakerStates().swap).toBe('closed');
  });
});

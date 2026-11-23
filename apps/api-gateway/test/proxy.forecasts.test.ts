import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayProxyController } from '../src/proxy.controller';

function makeMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = '';
  const res = {
    setHeader: vi.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    send: vi.fn((payload: string) => {
      body = payload;
      return res;
    }),
  };
  return { res, getState: () => ({ statusCode, body, headers }) };
}

describe('GatewayProxyController — /v1/forecasts proxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('forwards GET /v1/forecasts/shops/:id with trusted JWT identity headers and X-Cache', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ shopId: 'shop-1', modelUsed: 'fallback' }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-cache': 'HIT',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new GatewayProxyController();
    const { res, getState } = makeMockRes();
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/forecasts/shops/shop-1',
      headers: { 'x-correlation-id': 'corr-123' },
      user: { sub: 'user-1', role: 'owner', shopId: 'shop-1' },
    };

    await controller.proxyForecasts(req, res as any);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3006/v1/forecasts/shops/shop-1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-correlation-id': 'corr-123',
          'x-user-id': 'user-1',
          'x-user-role': 'owner',
          'x-shop-id': 'shop-1',
        }),
      }),
    );
    expect(getState().statusCode).toBe(200);
    expect(getState().headers['x-cache']).toBe('HIT');
  });

  it('blocks non-admin POST /v1/forecasts/run-batch with 403 ForbiddenException', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const controller = new GatewayProxyController();
    const { res } = makeMockRes();
    const req: any = {
      method: 'POST',
      originalUrl: '/v1/forecasts/run-batch',
      headers: {},
      user: { sub: 'user-1', role: 'owner', shopId: 'shop-1' },
      body: {},
    };

    await expect(controller.proxyForecasts(req, res as any)).rejects.toThrow(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards admin POST /v1/forecasts/run-batch to forecast-service', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ shopsProcessed: 5 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new GatewayProxyController();
    const { res, getState } = makeMockRes();
    const req: any = {
      method: 'POST',
      originalUrl: '/v1/forecasts/run-batch',
      headers: {},
      user: { sub: 'admin-1', role: 'admin' },
      body: { asOfDate: '2026-04-01' },
    };

    await controller.proxyForecasts(req, res as any);
    expect(getState().statusCode).toBe(200);
    expect(JSON.parse(getState().body).shopsProcessed).toBe(5);
  });

  it('throws 503 ServiceUnavailableException when forecast-service is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const controller = new GatewayProxyController();
    const { res } = makeMockRes();
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/forecasts/shops/shop-1',
      headers: {},
      user: { sub: 'user-1', role: 'owner', shopId: 'shop-1' },
    };

    await expect(controller.proxyForecasts(req, res as any)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});

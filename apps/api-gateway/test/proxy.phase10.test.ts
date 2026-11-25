import { ForbiddenException } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayProxyController } from '../src/proxy.controller';

function makeMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body: unknown = '';
  const res = Object.assign(new PassThrough(), {
    setHeader: vi.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    }),
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    send: vi.fn((payload: unknown) => {
      body = payload;
      return res;
    }),
    flushHeaders: vi.fn(),
  });
  return { res, getState: () => ({ statusCode, body, headers }) };
}

describe('GatewayProxyController — Phase 10 (/v1/groupbuy, /v1/notifications, /v1/analytics)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('forwards /v1/groupbuy/windows to groupbuy-service (3009) with verified JWT identity headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 'win-1', status: 'OPEN' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new GatewayProxyController();
    const { res, getState } = makeMockRes();
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/groupbuy/windows?state=Telangana',
      headers: { 'x-correlation-id': 'corr-gb-1' },
      user: { sub: 'u-1', role: 'shop_owner', shopId: 'shop-1' },
    };

    await controller.proxyGroupBuy(req, res as any);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3009/v1/groupbuy/windows?state=Telangana',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-user-id': 'u-1',
          'x-user-role': 'shop_owner',
          'x-shop-id': 'shop-1',
        }),
      }),
    );
    expect(getState().statusCode).toBe(200);
  });

  it('streams /v1/notifications/stream SSE from notification-service (3010) without buffering', async () => {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: notification.snapshot\ndata: {"unreadCount":3}\n\n'),
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      ),
    );

    const controller = new GatewayProxyController();
    const { res, getState } = makeMockRes();
    const chunks: string[] = [];
    const done = new Promise<void>((resolve) => {
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk).toString('utf8')));
      res.on('end', () => resolve());
    });

    const req: any = {
      method: 'GET',
      originalUrl: '/v1/notifications/stream',
      headers: { accept: 'text/event-stream' },
      user: { sub: 'u-1', role: 'shop_owner', shopId: 'shop-1' },
    };

    await controller.proxyNotifications(req, res as any);
    await done;

    expect(getState().headers['cache-control']).toBe('no-cache');
    expect(chunks.join('')).toContain('"unreadCount":3');
  });

  it('blocks non-admin calls to /v1/analytics/* and forwards admin calls to analytics-simulator (3011)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ totalShops: 10, shops: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new GatewayProxyController();
    const { res } = makeMockRes();

    await expect(
      controller.proxyAnalytics(
        {
          method: 'GET',
          originalUrl: '/v1/analytics/map',
          headers: {},
          user: { sub: 'u-1', role: 'shop_owner', shopId: 'shop-1' },
        } as any,
        res as any,
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();

    const adminRes = makeMockRes();
    await controller.proxyAnalytics(
      {
        method: 'GET',
        originalUrl: '/v1/analytics/map',
        headers: { 'x-correlation-id': 'corr-adm-1' },
        user: { sub: 'adm-1', role: 'admin', shopId: null },
      } as any,
      adminRes.res as any,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3011/v1/analytics/map',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-user-role': 'admin' }),
      }),
    );
    expect(adminRes.getState().statusCode).toBe(200);
  });
});

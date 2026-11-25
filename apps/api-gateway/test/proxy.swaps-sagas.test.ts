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

describe('GatewayProxyController — /v1/swaps & /v1/sagas proxy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('forwards /v1/swaps/candidates to swap-service (3007) with JWT identity headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ listingId: 'l-1', distanceKm: 1.2 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new GatewayProxyController();
    const { res, getState } = makeMockRes();
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/swaps/candidates?radiusKm=5',
      headers: { 'x-correlation-id': 'corr-swap-1' },
      user: { sub: 'u-1', role: 'shop_owner', shopId: 'shop-1' },
    };

    await controller.proxySwaps(req, res as any);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3007/v1/swaps/candidates?radiusKm=5',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'x-correlation-id': 'corr-swap-1',
          'x-user-id': 'u-1',
          'x-user-role': 'shop_owner',
          'x-shop-id': 'shop-1',
        }),
      }),
    );
    expect(getState().statusCode).toBe(200);
  });

  it('blocks external calls to /v1/swaps/internal/* with 403 ForbiddenException', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const controller = new GatewayProxyController();
    const { res } = makeMockRes();
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/swaps/internal/matching-snapshot?state=Telangana',
      headers: {},
      user: { sub: 'u-1', role: 'shop_owner', shopId: 'shop-1' },
    };

    await expect(controller.proxySwaps(req, res as any)).rejects.toThrow(ForbiddenException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards GST invoice PDF as binary Buffer preserving Content-Disposition and X-Invoice-Number', async () => {
    const pdfBytes = Buffer.from('%PDF-1.3 binary-payload-test', 'ascii');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(pdfBytes, {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="KX-SWAP-1234567890.pdf"',
          'x-invoice-number': 'KX-SWAP-1234567890',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new GatewayProxyController();
    const { res, getState } = makeMockRes();
    const req: any = {
      method: 'GET',
      originalUrl: '/v1/sagas/tx-1/invoice.pdf',
      headers: {},
      user: { sub: 'u-1', role: 'shop_owner', shopId: 'shop-1' },
    };

    await controller.proxySagas(req, res as any);

    const state = getState();
    expect(state.statusCode).toBe(200);
    expect(Buffer.isBuffer(state.body)).toBe(true);
    expect((state.body as Buffer).toString('ascii')).toBe('%PDF-1.3 binary-payload-test');
    expect(state.headers['content-type']).toBe('application/pdf');
    expect(state.headers['x-invoice-number']).toBe('KX-SWAP-1234567890');
  });

  it('streams text/event-stream responses from saga-orchestrator without buffering', async () => {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: saga.status\ndata: {"state":"AWAITING_HANDOVER"}\n\n'),
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
      originalUrl: '/v1/sagas/tx-1/stream',
      headers: { accept: 'text/event-stream' },
      user: { sub: 'u-1', role: 'shop_owner', shopId: 'shop-1' },
    };

    await controller.proxySagas(req, res as any);
    await done;

    expect(getState().headers['cache-control']).toBe('no-cache');
    expect(getState().headers['x-accel-buffering']).toBe('no');
    expect(chunks.join('')).toContain('AWAITING_HANDOVER');
  });
});

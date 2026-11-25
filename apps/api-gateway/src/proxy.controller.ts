import {
  All,
  Controller,
  ForbiddenException,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AccessTokenPayload, JwtAuthGuard } from './guards/jwt-auth.guard';

type AuthenticatedRequest = Request & { user?: AccessTokenPayload };

@Controller('v1')
export class GatewayProxyController {
  private readonly authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:3002';
  private readonly shopServiceUrl = process.env.SHOP_SERVICE_URL || 'http://127.0.0.1:3003';
  private readonly catalogServiceUrl = process.env.CATALOG_SERVICE_URL || 'http://127.0.0.1:3004';
  private readonly inventoryServiceUrl =
    process.env.INVENTORY_SERVICE_URL || 'http://127.0.0.1:3005';
  private readonly forecastServiceUrl = process.env.FORECAST_SERVICE_URL || 'http://127.0.0.1:3006';
  private readonly swapServiceUrl = process.env.SWAP_SERVICE_URL || 'http://127.0.0.1:3007';
  private readonly sagaOrchestratorUrl =
    process.env.SAGA_ORCHESTRATOR_URL || 'http://127.0.0.1:3008';

  private async forward(
    targetBaseUrl: string,
    req: AuthenticatedRequest,
    res: Response,
  ): Promise<void> {
    const targetUrl = `${targetBaseUrl}${req.originalUrl}`;
    const headers: Record<string, string> = {};

    const correlationId = req.headers['x-correlation-id'];
    if (typeof correlationId === 'string') {
      headers['x-correlation-id'] = correlationId;
    }

    if (typeof req.headers.authorization === 'string') {
      headers.authorization = req.headers.authorization;
    }

    if (typeof req.headers['idempotency-key'] === 'string') {
      headers['idempotency-key'] = req.headers['idempotency-key'];
    }

    if (typeof req.headers.accept === 'string') {
      headers.accept = req.headers.accept;
    }

    // Inject trusted identity headers strictly from verified JWT payload (never client-supplied)
    if (req.user) {
      headers['x-user-id'] = req.user.sub;
      headers['x-user-role'] = req.user.role;
      if (req.user.shopId) {
        headers['x-shop-id'] = req.user.shopId;
      }
    }

    const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase()) && req.body !== undefined;
    if (hasBody) {
      headers['content-type'] = 'application/json';
    }

    const abortController = new AbortController();
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body) : undefined,
        signal: abortController.signal,
      });
    } catch {
      throw new ServiceUnavailableException('Downstream service is currently unavailable');
    }

    const contentType = upstream.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }

    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) {
      res.setHeader('Retry-After', retryAfter);
    }

    const cacheStatus = upstream.headers.get('x-cache');
    if (cacheStatus) {
      res.setHeader('X-Cache', cacheStatus);
    }

    const contentDisposition = upstream.headers.get('content-disposition');
    if (contentDisposition) {
      res.setHeader('Content-Disposition', contentDisposition);
    }

    const invoiceNumber = upstream.headers.get('x-invoice-number');
    if (invoiceNumber) {
      res.setHeader('X-Invoice-Number', invoiceNumber);
    }

    // Stream Server-Sent Events without buffering
    if (contentType?.includes('text/event-stream') && upstream.body) {
      res.status(upstream.status);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const nodeStream = Readable.fromWeb(upstream.body as unknown as WebReadableStream);
      const cleanup = () => {
        abortController.abort();
        nodeStream.destroy();
      };
      req.on?.('close', cleanup);
      nodeStream.on('error', () => {
        if (!res.writableEnded) res.end();
      });
      nodeStream.pipe(res);
      return;
    }

    // Preserve binary responses (e.g., GST Swap Invoice PDFs) without UTF-8 corruption
    if (
      contentType?.includes('application/pdf') ||
      contentType?.includes('application/octet-stream')
    ) {
      const arrayBuf = await upstream.arrayBuffer();
      res.status(upstream.status).send(Buffer.from(arrayBuf));
      return;
    }

    const text = await upstream.text();
    res.status(upstream.status).send(text);
  }

  @All(['auth', 'auth/*path'])
  async proxyAuth(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    return this.forward(this.authServiceUrl, req, res);
  }

  @UseGuards(JwtAuthGuard)
  @All(['shops', 'shops/*path'])
  async proxyShops(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    return this.forward(this.shopServiceUrl, req, res);
  }

  @UseGuards(JwtAuthGuard)
  @All(['catalog', 'catalog/*path'])
  async proxyCatalog(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const method = req.method.toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';

    if (!isRead && req.user?.role !== 'admin') {
      throw new ForbiddenException('Admin role required for catalog mutations');
    }

    return this.forward(this.catalogServiceUrl, req, res);
  }

  @UseGuards(JwtAuthGuard)
  @All(['inventory', 'inventory/*path'])
  async proxyInventory(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    return this.forward(this.inventoryServiceUrl, req, res);
  }

  @UseGuards(JwtAuthGuard)
  @All(['forecasts', 'forecasts/*path'])
  async proxyForecasts(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const method = req.method.toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';

    if (!isRead && req.user?.role !== 'admin') {
      throw new ForbiddenException('Admin role required for forecast batch operations');
    }

    return this.forward(this.forecastServiceUrl, req, res);
  }

  @UseGuards(JwtAuthGuard)
  @All(['swaps', 'swaps/*path'])
  async proxySwaps(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    if (req.originalUrl.includes('/internal/')) {
      throw new ForbiddenException('Internal matching endpoints are not exposed via gateway');
    }
    return this.forward(this.swapServiceUrl, req, res);
  }

  @UseGuards(JwtAuthGuard)
  @All(['sagas', 'sagas/*path'])
  async proxySagas(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    return this.forward(this.sagaOrchestratorUrl, req, res);
  }
}

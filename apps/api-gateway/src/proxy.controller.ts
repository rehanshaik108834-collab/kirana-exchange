import { All, Controller, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('v1')
export class GatewayProxyController {
  private readonly authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://127.0.0.1:3002';
  private readonly shopServiceUrl = process.env.SHOP_SERVICE_URL || 'http://127.0.0.1:3003';

  private async forward(targetBaseUrl: string, req: Request, res: Response): Promise<void> {
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

    const hasBody = !['GET', 'HEAD'].includes(req.method.toUpperCase()) && req.body !== undefined;
    if (hasBody) {
      headers['content-type'] = 'application/json';
    }

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body) : undefined,
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

    const text = await upstream.text();
    res.status(upstream.status).send(text);
  }

  @All(['auth', 'auth/*path'])
  async proxyAuth(@Req() req: Request, @Res() res: Response) {
    return this.forward(this.authServiceUrl, req, res);
  }

  @UseGuards(JwtAuthGuard)
  @All(['shops', 'shops/*path'])
  async proxyShops(@Req() req: Request, @Res() res: Response) {
    return this.forward(this.shopServiceUrl, req, res);
  }
}

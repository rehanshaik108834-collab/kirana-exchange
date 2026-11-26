import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Enforces OWASP HTTP security headers across all API Gateway responses.
 */
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

    const forwardedProto = req.headers['x-forwarded-proto'];
    const isHttps =
      process.env.NODE_ENV === 'production' ||
      forwardedProto === 'https' ||
      (Array.isArray(forwardedProto) && forwardedProto.includes('https'));

    if (isHttps) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  }
}

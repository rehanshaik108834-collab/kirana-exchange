import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { RateLimiterService } from '@kirana/common';
import { Request, Response } from 'express';

@Injectable()
export class GlobalIpRateLimitGuard implements CanActivate {
  private readonly ratePerMinute = 100;
  private readonly burstCapacity = 30;

  constructor(private readonly rateLimiter: RateLimiterService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const ip = request.ip || request.socket.remoteAddress || 'unknown';
    const result = await this.rateLimiter.consumeTokenBucket(
      `rl:ip:${ip}`,
      this.ratePerMinute,
      this.burstCapacity,
    );

    response.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new HttpException(
        {
          message: 'Global IP rate limit exceeded',
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}

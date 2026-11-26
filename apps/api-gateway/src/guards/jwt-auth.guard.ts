import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { REDIS_CLIENT } from '@kirana/common';
import { Request } from 'express';
import Redis from 'ioredis';
import pino from 'pino';

export interface AccessTokenPayload {
  sub: string;
  jti: string;
  role: 'shop_owner' | 'shop_staff' | 'admin';
  shopId: string | null;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = pino({ name: 'gateway-jwt-guard' });

  constructor(
    private readonly jwtService: JwtService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AccessTokenPayload }>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Bearer token');
    }

    const token = authHeader.slice('Bearer '.length).trim();

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    if (payload.jti) {
      let revoked = 0;
      try {
        revoked = await this.redis.exists(`auth:denylist:${payload.jti}`);
      } catch (err) {
        if (process.env.DENYLIST_FAIL_OPEN === 'true') {
          this.logger.warn(
            { jti: payload.jti, err: (err as Error).message },
            'Redis denylist unavailable; allowing valid unexpired JWT (DENYLIST_FAIL_OPEN=true)',
          );
        } else {
          this.logger.error(
            { jti: payload.jti, err: (err as Error).message },
            'Redis denylist unavailable; failing closed with 503',
          );
          throw new ServiceUnavailableException(
            'Authentication revocation check temporarily unavailable',
          );
        }
      }
      if (revoked === 1) {
        throw new UnauthorizedException('Access token has been revoked');
      }
    }

    request.user = payload;
    return true;
  }
}

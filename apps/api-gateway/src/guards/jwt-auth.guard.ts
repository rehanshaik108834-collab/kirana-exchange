import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { REDIS_CLIENT } from '@kirana/common';
import { Request } from 'express';
import Redis from 'ioredis';

export interface AccessTokenPayload {
  sub: string;
  jti: string;
  role: 'shop_owner' | 'shop_staff' | 'admin';
  shopId: string | null;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
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
      const revoked = await this.redis.exists(`auth:denylist:${payload.jti}`);
      if (revoked === 1) {
        throw new UnauthorizedException('Access token has been revoked');
      }
    }

    request.user = payload;
    return true;
  }
}

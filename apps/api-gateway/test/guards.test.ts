import 'reflect-metadata';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../src/guards/jwt-auth.guard';
import { GlobalIpRateLimitGuard } from '../src/guards/rate-limit.guard';

const jwt = new JwtService({ secret: 'unit-test-secret', signOptions: { expiresIn: '15m' } });

function httpContext(headers: Record<string, string>, ip = '10.0.0.1') {
  const request: Record<string, any> = { headers, ip, socket: { remoteAddress: ip } };
  const responseHeaders: Record<string, string> = {};
  const response = { setHeader: (k: string, v: string) => (responseHeaders[k] = v) };
  const context = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as any;
  return { context, request, responseHeaders };
}

describe('JwtAuthGuard', () => {
  const guardWith = (denylisted: string[] = []) => {
    const redis = { exists: vi.fn(async (k: string) => (denylisted.includes(k) ? 1 : 0)) };
    return { guard: new JwtAuthGuard(jwt, redis as any), redis };
  };
  const token = (claims: Record<string, unknown> = {}) =>
    jwt.signAsync({ sub: 'user-1', jti: 'jti-1', role: 'shop_owner', shopId: 'shop-1', ...claims });

  it.each([{}, { authorization: 'Basic abc' }, { authorization: 'bearer x' }])(
    'rejects a missing or malformed header %o',
    async (headers) => {
      const { guard } = guardWith();
      await expect(guard.canActivate(httpContext(headers).context)).rejects.toThrow(
        'Missing or malformed Bearer token',
      );
    },
  );

  it('rejects a token signed with another secret', async () => {
    const forged = await new JwtService({ secret: 'attacker' }).signAsync({ sub: 'x', jti: 'j' });
    const { guard } = guardWith();
    await expect(
      guard.canActivate(httpContext({ authorization: `Bearer ${forged}` }).context),
    ).rejects.toThrow('Invalid or expired access token');
  });

  it('rejects an expired token', async () => {
    const expired = await new JwtService({ secret: 'unit-test-secret' }).signAsync({
      sub: 'user-1',
      jti: 'jti-1',
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const { guard } = guardWith();
    await expect(
      guard.canActivate(httpContext({ authorization: `Bearer ${expired}` }).context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a denylisted (logged-out) token by jti', async () => {
    const { guard, redis } = guardWith(['auth:denylist:jti-1']);
    await expect(
      guard.canActivate(httpContext({ authorization: `Bearer ${await token()}` }).context),
    ).rejects.toThrow('Access token has been revoked');
    expect(redis.exists).toHaveBeenCalledWith('auth:denylist:jti-1');
  });

  it('accepts a valid token and attaches the verified claims to the request', async () => {
    const { guard } = guardWith();
    const { context, request } = httpContext({ authorization: `Bearer ${await token()}` });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toMatchObject({
      sub: 'user-1',
      jti: 'jti-1',
      role: 'shop_owner',
      shopId: 'shop-1',
    });
  });
});

describe('GlobalIpRateLimitGuard', () => {
  const limiterReturning = (result: {
    allowed: boolean;
    remaining: number;
    retryAfterSeconds: number;
  }) => ({ consumeTokenBucket: vi.fn(async () => result) });

  it('allows within budget, keyed per IP (100/min, burst 30), and reports remaining', async () => {
    const limiter = limiterReturning({ allowed: true, remaining: 29, retryAfterSeconds: 0 });
    const { context, responseHeaders } = httpContext({}, '203.0.113.7');
    await expect(new GlobalIpRateLimitGuard(limiter as any).canActivate(context)).resolves.toBe(
      true,
    );
    expect(limiter.consumeTokenBucket).toHaveBeenCalledWith('rl:ip:203.0.113.7', 100, 30);
    expect(responseHeaders['X-RateLimit-Remaining']).toBe('29');
    expect(responseHeaders['Retry-After']).toBeUndefined();
  });

  it('returns 429 with Retry-After when the bucket is empty', async () => {
    const limiter = limiterReturning({ allowed: false, remaining: 0, retryAfterSeconds: 4 });
    const { context, responseHeaders } = httpContext({});
    const err = await new GlobalIpRateLimitGuard(limiter as any)
      .canActivate(context)
      .catch((e: HttpException) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    expect(responseHeaders['Retry-After']).toBe('4');
    expect(responseHeaders['X-RateLimit-Remaining']).toBe('0');
  });

  it('falls back to the socket address when request.ip is missing', async () => {
    const limiter = limiterReturning({ allowed: true, remaining: 1, retryAfterSeconds: 0 });
    const { context, request } = httpContext({});
    request.ip = undefined;
    request.socket.remoteAddress = '198.51.100.2';
    await new GlobalIpRateLimitGuard(limiter as any).canActivate(context);
    expect(limiter.consumeTokenBucket).toHaveBeenCalledWith('rl:ip:198.51.100.2', 100, 30);
  });
});

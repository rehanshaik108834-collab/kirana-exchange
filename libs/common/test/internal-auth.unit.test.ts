import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  InternalAuthGuard,
  signInternalHeaders,
  verifyInternalSignature,
} from '../src/security/internal-auth';

const TEST_SECRET = 'phase11-unit-test-hmac-secret';

function mockExecutionContext(req: {
  method: string;
  originalUrl: string;
  headers: Record<string, string>;
}) {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as any;
}

describe('Signed Internal Service Tokens (HMAC-SHA256)', () => {
  it('signs and verifies gateway identity headers accurately', () => {
    const now = 1_760_000_000;
    const signed = signInternalHeaders(
      {
        service: 'api-gateway',
        method: 'POST',
        path: '/v1/swaps/offers',
        userId: 'user-1',
        userRole: 'shop_owner',
        shopId: 'shop-1',
        timestampSeconds: now,
      },
      TEST_SECRET,
    );

    const result = verifyInternalSignature(
      {
        ...signed,
        'x-user-id': 'user-1',
        'x-user-role': 'shop_owner',
        'x-shop-id': 'shop-1',
      },
      'POST',
      '/v1/swaps/offers',
      { secret: TEST_SECRET, nowSeconds: now + 5 },
    );

    expect(result).toEqual({ valid: true, caller: 'api-gateway' });
  });

  it('rejects tampered role, shopId, path, method, or wrong secret', () => {
    const now = 1_760_000_000;
    const signed = signInternalHeaders(
      {
        service: 'api-gateway',
        method: 'GET',
        path: '/v1/inventory/batches?shopId=shop-1',
        userId: 'user-1',
        userRole: 'shop_owner',
        shopId: 'shop-1',
        timestampSeconds: now,
      },
      TEST_SECRET,
    );

    const baseHeaders = {
      ...signed,
      'x-user-id': 'user-1',
      'x-user-role': 'shop_owner',
      'x-shop-id': 'shop-1',
    };

    // Role escalation attempt
    expect(
      verifyInternalSignature(
        { ...baseHeaders, 'x-user-role': 'admin' },
        'GET',
        '/v1/inventory/batches?shopId=shop-1',
        { secret: TEST_SECRET, nowSeconds: now },
      ).valid,
    ).toBe(false);

    // Cross-shop IDOR header swap attempt
    expect(
      verifyInternalSignature(
        { ...baseHeaders, 'x-shop-id': 'shop-victim' },
        'GET',
        '/v1/inventory/batches?shopId=shop-1',
        { secret: TEST_SECRET, nowSeconds: now },
      ).valid,
    ).toBe(false);

    // Path/query tampering attempt
    expect(
      verifyInternalSignature(baseHeaders, 'GET', '/v1/inventory/batches?shopId=shop-victim', {
        secret: TEST_SECRET,
        nowSeconds: now,
      }).valid,
    ).toBe(false);

    // Wrong secret
    expect(
      verifyInternalSignature(baseHeaders, 'GET', '/v1/inventory/batches?shopId=shop-1', {
        secret: 'wrong-secret',
        nowSeconds: now,
      }).valid,
    ).toBe(false);
  });

  it('rejects expired/replayed signatures outside the 60s skew window', () => {
    const now = 1_760_000_000;
    const signed = signInternalHeaders(
      {
        service: 'api-gateway',
        method: 'GET',
        path: '/v1/shops/me',
        userId: 'user-1',
        userRole: 'shop_owner',
        timestampSeconds: now - 120,
      },
      TEST_SECRET,
    );

    const res = verifyInternalSignature(
      { ...signed, 'x-user-id': 'user-1', 'x-user-role': 'shop_owner' },
      'GET',
      '/v1/shops/me',
      { secret: TEST_SECRET, nowSeconds: now, maxSkewSeconds: 60 },
    );

    expect(res.valid).toBe(false);
    expect(res.reason).toBe('TIMESTAMP_OUT_OF_WINDOW');
  });

  it('InternalAuthGuard enforces strict mode, bypasses /health, and blocks forged signatures even when non-enforced', () => {
    const strictGuard = new InternalAuthGuard({
      enforce: true,
      secret: TEST_SECRET,
      allowedServices: ['api-gateway'],
    });

    // /health always allowed
    expect(
      strictGuard.canActivate(
        mockExecutionContext({ method: 'GET', originalUrl: '/health', headers: {} }),
      ),
    ).toBe(true);

    // Unsigned request rejected in strict mode
    expect(() =>
      strictGuard.canActivate(
        mockExecutionContext({ method: 'GET', originalUrl: '/v1/shops/me', headers: {} }),
      ),
    ).toThrow(ForbiddenException);

    // Valid signed request allowed
    const signed = signInternalHeaders(
      {
        service: 'api-gateway',
        method: 'GET',
        path: '/v1/shops/me',
        userId: 'u-1',
        userRole: 'shop_owner',
      },
      TEST_SECRET,
    );
    expect(
      strictGuard.canActivate(
        mockExecutionContext({
          method: 'GET',
          originalUrl: '/v1/shops/me',
          headers: { ...signed, 'x-user-id': 'u-1', 'x-user-role': 'shop_owner' },
        }),
      ),
    ).toBe(true);

    // Permissive dev mode still rejects a forged signature header
    const devGuard = new InternalAuthGuard({ enforce: false, secret: TEST_SECRET });
    expect(() =>
      devGuard.canActivate(
        mockExecutionContext({
          method: 'GET',
          originalUrl: '/v1/shops/me',
          headers: {
            'x-internal-service': 'api-gateway',
            'x-internal-timestamp': String(Math.floor(Date.now() / 1000)),
            'x-internal-signature': 'deadbeef'.repeat(8),
          },
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});

import 'reflect-metadata';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService } from '../src/auth.service';
import { RefreshToken } from '../src/entities/refresh-token.entity';
import { User } from '../src/entities/user.entity';

/**
 * Unit tests with in-memory fakes: no Postgres, Redis or RabbitMQ needed.
 * - `users` / `tokens` arrays stand in for the tables.
 * - `transaction()` runs the callback, then pushes 'commit' to `events`, so tests can assert
 *   that writes happened inside the transaction and BEFORE an exception reached the caller.
 * - The rate limiter is a real sliding-window counter (max N per key), not a stub.
 */
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
type Row = Record<string, any>;

function makeHarness() {
  const users: Row[] = [];
  const tokens: Row[] = [];
  const events: string[] = [];
  let seq = 0;
  const tableOf = (entity: unknown) => (entity === User ? users : tokens);
  const matches = (row: Row, where: Row) => Object.entries(where).every(([k, v]) => row[k] === v);

  const manager = {
    create: (_e: unknown, obj: Row) => ({ ...obj }),
    save: vi.fn(async (entity: unknown, obj: Row) => {
      const table = tableOf(entity);
      if (
        entity === User &&
        table.some(
          (u) => (obj.email && u.email === obj.email) || (obj.phone && u.phone === obj.phone),
        )
      ) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      const row = { id: `id-${++seq}`, ...obj };
      table.push(row);
      events.push(`save:${entity === User ? 'user' : 'token'}`);
      return row;
    }),
    update: vi.fn(async (entity: unknown, where: Row, patch: Row) => {
      tableOf(entity)
        .filter((r) => matches(r, where))
        .forEach((r) => Object.assign(r, patch));
      events.push(`update:${entity === User ? 'user' : 'token'}:${Object.keys(where).join(',')}`);
    }),
    findOne: vi.fn(async (entity: unknown, opts: { where: Row }) => {
      return tableOf(entity).find((r) => matches(r, opts.where)) ?? null;
    }),
  };

  const dataSource = {
    transaction: vi.fn(async (...args: unknown[]) => {
      const fn = args[args.length - 1] as (m: typeof manager) => Promise<unknown>;
      const isolation = args.length === 2 ? (args[0] as string) : 'DEFAULT';
      events.push(`begin:${isolation}`);
      const result = await fn(manager);
      events.push('commit');
      return result;
    }),
    getRepository: () => ({
      findOne: (opts: { where: Row }) => manager.findOne(User, opts),
      update: (where: Row, patch: Row) => manager.update(User, where, patch),
    }),
  };

  const windows = new Map<string, number>();
  const rateLimiter = {
    consumeSlidingWindow: vi.fn(async (key: string, max: number) => {
      const n = (windows.get(key) ?? 0) + 1;
      windows.set(key, n);
      return { allowed: n <= max, remaining: Math.max(0, max - n), retryAfterSeconds: 900 };
    }),
    resetKey: vi.fn(async (key: string) => {
      windows.delete(key);
    }),
  };
  const redis = { set: vi.fn(async () => 'OK') };
  const jwt = new JwtService({ secret: 'unit-test-secret', signOptions: { expiresIn: '15m' } });
  const service = new AuthService(dataSource as any, jwt, rateLimiter as any, redis as any);
  return { service, users, tokens, events, rateLimiter, redis, jwt, dataSource, windows };
}

let h: ReturnType<typeof makeHarness>;
beforeEach(() => {
  h = makeHarness();
});

const register = (email = 'ramesh@example.com', password = 'correct-horse') =>
  h.service.register({ email, password });

describe('register', () => {
  it('requires a phone or an email', async () => {
    await expect(h.service.register({ password: 'longenough' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('stores an Argon2id hash, a hashed refresh token and returns a signed access token', async () => {
    const out = await register();
    const [user] = h.users;
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(user.passwordHash, 'correct-horse')).toBe(true);
    expect(user.role).toBe('shop_owner');
    expect(h.tokens).toHaveLength(1);
    expect(h.tokens[0].tokenHash).toBe(sha(out.refreshToken)); // plaintext never stored
    expect(h.tokens[0].revoked).toBe(false);
    const payload = await h.jwt.verifyAsync(out.accessToken);
    expect(payload).toMatchObject({ sub: user.id, role: 'shop_owner', shopId: null });
    expect(payload.jti).toBeTruthy();
  });

  it('maps a unique violation (23505) to 409 Conflict', async () => {
    await register();
    await expect(register()).rejects.toMatchObject({ status: 409 });
  });

  it('rethrows other database errors unchanged', async () => {
    h.dataSource.transaction.mockRejectedValueOnce(new Error('connection lost'));
    await expect(register()).rejects.toThrow('connection lost');
  });
});

describe('login and brute-force lockout', () => {
  it('requires a phone or an email', async () => {
    await expect(h.service.login({ password: 'x' }, '1.1.1.1')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('succeeds, resets failed attempts and the lockout window, and issues a new token family', async () => {
    await register();
    h.users[0].failedAttempts = 3;
    await expect(
      h.service.login({ email: 'ramesh@example.com', password: 'nope' }, '1.1.1.1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(h.users[0].failedAttempts).toBe(4);

    const out = await h.service.login(
      { email: 'ramesh@example.com', password: 'correct-horse' },
      '1.1.1.1',
    );
    expect(h.users[0]).toMatchObject({ failedAttempts: 0, lockedUntil: null });
    expect(h.rateLimiter.resetKey).toHaveBeenCalledWith('auth:lockout:ramesh@example.com:1.1.1.1');
    expect(h.tokens).toHaveLength(2);
    expect(h.tokens[1].familyId).not.toBe(h.tokens[0].familyId);
    expect(h.tokens[1].tokenHash).toBe(sha(out.refreshToken));
  });

  it('5 failed attempts lock the account; the 6th returns 429 with retryAfterSeconds', async () => {
    await register();
    for (let i = 0; i < 5; i++) {
      await expect(
        h.service.login({ email: 'ramesh@example.com', password: 'wrong' }, '1.1.1.1'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(h.users[0].failedAttempts).toBe(5);
    expect(h.users[0].lockedUntil).toBeInstanceOf(Date);

    // Even the correct password is refused while locked.
    const err = await h.service
      .login({ email: 'ramesh@example.com', password: 'correct-horse' }, '1.1.1.1')
      .catch((e: HttpException) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    const body = (err as HttpException).getResponse() as { retryAfterSeconds: number };
    expect(body.retryAfterSeconds).toBeGreaterThan(800);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it('unknown identifiers are limited per identifier+IP: the 6th attempt returns 429', async () => {
    const attempt = () =>
      h.service.login({ phone: '+919999999999', password: 'guess' }, '2.2.2.2').catch((e) => e);
    for (let i = 0; i < 5; i++) {
      expect((await attempt()).getStatus()).toBe(401);
    }
    const sixth = await attempt();
    expect(sixth.getStatus()).toBe(429);
    expect(sixth.getResponse().retryAfterSeconds).toBe(900);
    expect(h.rateLimiter.consumeSlidingWindow).toHaveBeenLastCalledWith(
      'auth:lockout:+919999999999:2.2.2.2',
      5,
      900,
    );
  });
});

describe('rotateRefreshToken', () => {
  it('rotates inside a SERIALIZABLE transaction: same family, old token revoked and linked', async () => {
    const { refreshToken } = await register();
    const old = h.tokens[0];
    const out = await h.service.rotateRefreshToken(refreshToken);

    expect(h.events).toContain('begin:SERIALIZABLE');
    expect(h.tokens).toHaveLength(2);
    const fresh = h.tokens[1];
    expect(fresh.familyId).toBe(old.familyId);
    expect(fresh.tokenHash).toBe(sha(out.refreshToken));
    expect(old).toMatchObject({ revoked: true, replacedById: fresh.id });
    expect((await h.jwt.verifyAsync(out.accessToken)).sub).toBe(h.users[0].id);
  });

  it('carries the latest shopId into the new access token', async () => {
    const { refreshToken } = await register();
    h.users[0].shopId = 'shop-123';
    const out = await h.service.rotateRefreshToken(refreshToken);
    expect((await h.jwt.verifyAsync(out.accessToken)).shopId).toBe('shop-123');
  });

  it('rejects an unknown token', async () => {
    await expect(h.service.rotateRefreshToken('not-a-real-token')).rejects.toThrow(
      'Invalid refresh token',
    );
  });

  it('rejects a token whose user no longer exists', async () => {
    const { refreshToken } = await register();
    h.users.length = 0;
    await expect(h.service.rotateRefreshToken(refreshToken)).rejects.toThrow(
      'Invalid refresh token',
    );
  });

  it('rejects and revokes an expired token', async () => {
    const { refreshToken } = await register();
    h.tokens[0].expiresAt = new Date(Date.now() - 1000);
    await expect(h.service.rotateRefreshToken(refreshToken)).rejects.toThrow(
      'Refresh token expired',
    );
    expect(h.tokens[0].revoked).toBe(true);
    expect(h.tokens).toHaveLength(1); // no replacement issued
  });

  it('replay: revokes the whole family and COMMITS before throwing 401', async () => {
    const { refreshToken: first } = await register();
    const { refreshToken: second } = await h.service.rotateRefreshToken(first);
    await h.service.rotateRefreshToken(second); // family now has 3 tokens, the last one live
    expect(h.tokens.filter((t) => !t.revoked)).toHaveLength(1);
    h.events.length = 0;

    const err = await h.service.rotateRefreshToken(first).catch((e) => {
      h.events.push('thrown');
      return e;
    });

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect(err.message).toMatch(/reuse detected/);
    expect(h.tokens.every((t) => t.revoked)).toBe(true);
    expect(h.events).toEqual([
      'begin:SERIALIZABLE',
      'update:token:familyId', // family-wide revocation...
      'commit', // ...committed...
      'thrown', // ...before the caller sees the error
    ]);
  });
});

describe('logout', () => {
  it('denylists the access token jti for its remaining lifetime and revokes the refresh family', async () => {
    const { accessToken, refreshToken } = await register();
    await h.service.rotateRefreshToken(refreshToken); // a second token in the same family
    const latest = h.tokens[1];
    const { jti, exp } = await h.jwt.verifyAsync(accessToken);

    await h.service.logout(accessToken, refreshToken);

    expect(h.redis.set).toHaveBeenCalledTimes(1);
    const [key, value, mode, ttl] = h.redis.set.mock.calls[0] as unknown as [
      string,
      string,
      string,
      number,
    ];
    expect([key, value, mode]).toEqual([`auth:denylist:${jti}`, '1', 'EX']);
    const expected = exp - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThanOrEqual(expected - 2);
    expect(ttl).toBeLessThanOrEqual(expected);
    expect(latest.revoked).toBe(true);
    expect(h.tokens.every((t) => t.revoked)).toBe(true);
  });

  it('ignores an invalid access token and an unknown refresh token', async () => {
    await h.service.logout('garbage.jwt.token', 'unknown-refresh');
    await h.service.logout(undefined, undefined);
    expect(h.redis.set).not.toHaveBeenCalled();
  });
});

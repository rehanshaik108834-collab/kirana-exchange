import { afterEach, describe, expect, it } from 'vitest';
import { decodeClaims, homePath } from './session';

function fakeJwt(payload: object): string {
  // Real JWTs base64url-encode the UTF-8 bytes of the JSON payload.
  const b64url = (s: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

afterEach(() => localStorage.clear());

describe('session claims (routing only; never trusted for authorisation)', () => {
  it('decodes base64url payloads, including non-ASCII characters', () => {
    const claims = decodeClaims(
      fakeJwt({ sub: 'u1', role: 'shop_owner', shopId: 's1', note: 'కిరాణా ✓' }),
    );
    expect(claims).toMatchObject({ sub: 'u1', role: 'shop_owner', shopId: 's1' });
  });

  it('rejects malformed tokens', () => {
    expect(decodeClaims('not-a-jwt')).toBeNull();
    expect(decodeClaims('a.%%%.c')).toBeNull();
    expect(decodeClaims(null)).toBeNull();
  });

  it('routes to login, shop setup, or stock', () => {
    expect(homePath()).toBe('/login');
    localStorage.setItem('accessToken', fakeJwt({ sub: 'u1', role: 'shop_owner', shopId: null }));
    expect(homePath()).toBe('/shop-setup');
    localStorage.setItem('accessToken', fakeJwt({ sub: 'u1', role: 'shop_owner', shopId: 's1' }));
    expect(homePath()).toBe('/inventory');
  });
});

import { apiClient, refreshSession } from './api-client';
import { clearLocalData } from './db';

export interface SessionClaims {
  sub: string;
  role: 'shop_owner' | 'shop_staff' | 'admin';
  shopId: string | null;
  exp?: number;
}

/**
 * Decodes the access-token payload for routing decisions only (which page to show).
 * It is NOT verified here; every API call is authorised server-side by the gateway + services.
 */
export function decodeClaims(token: string | null | undefined): SessionClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const claims = JSON.parse(json) as SessionClaims;
    return typeof claims.sub === 'string' ? claims : null;
  } catch {
    return null;
  }
}

export function currentClaims(): SessionClaims | null {
  return decodeClaims(localStorage.getItem('accessToken'));
}

/** Server-side logout (denylists the access token, revokes the refresh family), then clears local state. */
export async function signOut(): Promise<void> {
  const refreshToken = localStorage.getItem('refreshToken');
  try {
    await apiClient.post('/auth/logout', refreshToken ? { refreshToken } : {});
  } catch {
    // Already expired or offline: local sign-out still proceeds.
  }
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('userId');
  localStorage.removeItem('userRole');
  // Privacy (US-05): no shop data stays on the device after sign-out.
  await clearLocalData().catch(() => undefined);
}

/**
 * After POST /shops, auth-service links users.shop_id asynchronously (shop.created.v1 consumer).
 * Refresh the session until the new access token carries shopId; returns null on timeout.
 */
export async function waitForLinkedShop(timeoutMs = 10_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 300;
  while (Date.now() < deadline) {
    const shopId = decodeClaims(await refreshSession())?.shopId;
    if (shopId) return shopId;
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 2, 2000);
  }
  return null;
}

/** Where a user should land: login, shop setup (no linked shop yet), or the stock screen. */
export function homePath(): '/login' | '/shop-setup' | '/inventory' {
  const claims = currentClaims();
  if (!claims) return '/login';
  return claims.shopId ? '/inventory' : '/shop-setup';
}

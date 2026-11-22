import type { ApiProblemError } from './api-client';

const TYPE_BASE = 'https://kirana-exchange.local/errors/';

export type ProblemKind =
  | 'version-conflict'
  | 'insufficient-unreserved-stock'
  | 'idempotency-conflict'
  | 'network'
  | 'other';

export function problemKind(error: ApiProblemError | null | undefined): ProblemKind {
  if (!error) return 'other';
  if (error.status === 0) return 'network';
  const slug = error.type.startsWith(TYPE_BASE) ? error.type.slice(TYPE_BASE.length) : error.type;
  if (
    slug === 'version-conflict' ||
    slug === 'insufficient-unreserved-stock' ||
    slug === 'idempotency-conflict'
  ) {
    return slug;
  }
  return 'other';
}

/** Plain-language message for a failed single-tap sale (persona: non-technical shopkeeper). */
export function saleErrorMessage(error: ApiProblemError): string {
  switch (problemKind(error)) {
    case 'version-conflict':
      return 'Stock changed on another device. The list is refreshed — tap Sell again.';
    case 'insufficient-unreserved-stock': {
      const available = error.body?.available;
      return typeof available === 'number'
        ? `Only ${available} can be sold now (the rest is reserved or sold).`
        : 'Not enough stock left to sell.';
    }
    case 'network':
      return 'No connection — the sale was not confirmed. Tap Retry; it will not be counted twice.';
    default:
      return error.detail || 'Could not record the sale. Please try again.';
  }
}

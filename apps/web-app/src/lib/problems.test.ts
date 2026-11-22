import { describe, expect, it } from 'vitest';
import { ApiProblemError } from './api-client';
import { problemKind, saleErrorMessage } from './problems';

const problem = (slug: string, status = 409, body: Record<string, unknown> = {}) =>
  new ApiProblemError({
    status,
    type: `https://kirana-exchange.local/errors/${slug}`,
    title: 'x',
    detail: `server detail for ${slug}`,
    body,
  });

describe('problem mapping', () => {
  it('classifies catalogue problem types and network failures', () => {
    expect(problemKind(problem('version-conflict'))).toBe('version-conflict');
    expect(problemKind(problem('insufficient-unreserved-stock'))).toBe(
      'insufficient-unreserved-stock',
    );
    expect(problemKind(problem('idempotency-conflict'))).toBe('idempotency-conflict');
    expect(problemKind(problem('forbidden', 403))).toBe('other');
    expect(
      problemKind(
        new ApiProblemError({ status: 0, type: '/errors/network', title: '', detail: '' }),
      ),
    ).toBe('network');
  });

  it('gives plain-language sale messages', () => {
    expect(saleErrorMessage(problem('version-conflict'))).toMatch(/another device/);
    expect(
      saleErrorMessage(problem('insufficient-unreserved-stock', 409, { available: 3 })),
    ).toMatch(/Only 3 can be sold/);
    expect(
      saleErrorMessage(new ApiProblemError({ status: 0, type: '', title: '', detail: '' })),
    ).toMatch(/not be counted twice/);
    expect(saleErrorMessage(problem('forbidden', 403))).toBe('server detail for forbidden');
  });
});

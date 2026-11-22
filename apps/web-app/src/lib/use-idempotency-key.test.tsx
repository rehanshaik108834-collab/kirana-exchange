import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useIdempotencyKey } from './use-idempotency-key';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('useIdempotencyKey', () => {
  it('keeps the same key across re-renders (retries reuse it)', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const first = result.current.key;
    expect(first).toMatch(UUID_V4);
    rerender();
    rerender();
    expect(result.current.key).toBe(first);
  });

  it('issues a new key only on rotate()', () => {
    const { result } = renderHook(() => useIdempotencyKey());
    const first = result.current.key;
    act(() => result.current.rotate());
    expect(result.current.key).toMatch(UUID_V4);
    expect(result.current.key).not.toBe(first);
  });
});

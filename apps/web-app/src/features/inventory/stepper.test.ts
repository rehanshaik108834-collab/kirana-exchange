import { describe, expect, it } from 'vitest';
import { stepQty } from './AddBatchPage';

describe('stepQty', () => {
  it('starts from 1 when empty or invalid', () => {
    expect(stepQty('', 1)).toBe('1');
    expect(stepQty('abc', 1)).toBe('1');
    expect(stepQty('', -1)).toBe('1');
  });

  it('adds and subtracts whole units', () => {
    expect(stepQty('5', 1)).toBe('6');
    expect(stepQty('5', -1)).toBe('4');
    expect(stepQty('2.7', 1)).toBe('3');
  });

  it('never goes below 1', () => {
    expect(stepQty('1', -1)).toBe('1');
    expect(stepQty('-4', -1)).toBe('1');
  });
});

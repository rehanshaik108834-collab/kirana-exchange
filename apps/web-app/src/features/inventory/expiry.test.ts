import { describe, expect, it } from 'vitest';
import { addDaysIso, daysUntil, expiryStatus } from './expiry';

const today = new Date(2026, 10, 22, 18, 45); // 22 Nov 2026, evening local time

describe('expiry badges (US-11)', () => {
  it('counts whole calendar days regardless of time of day', () => {
    expect(daysUntil('2026-11-22', today)).toBe(0);
    expect(daysUntil('2026-11-23', today)).toBe(1);
    expect(daysUntil('2026-11-21', today)).toBe(-1);
    expect(daysUntil('2026-12-22', today)).toBe(30); // crosses a month boundary
  });

  it.each([
    ['2026-11-21', 'expired', 'Expired'],
    ['2026-11-22', 'critical', 'Expires today'],
    ['2026-11-29', 'critical', 'Expires in 7d'],
    ['2026-11-30', 'warning', 'Expires in 8d'],
    ['2026-12-22', 'warning', 'Expires in 30d'],
    ['2026-12-23', 'ok', '31d left'],
  ])('%s -> %s', (date, level, label) => {
    expect(expiryStatus(date, today)).toMatchObject({ level, label });
  });

  it('builds default expiry dates in local time (no UTC day shift)', () => {
    expect(addDaysIso(0, today)).toBe('2026-11-22');
    expect(addDaysIso(180, today)).toBe('2027-05-21');
  });
});

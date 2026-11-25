import { describe, expect, it } from 'vitest';
import { computeSuggestedPrice } from '../src/pricing';

describe('computeSuggestedPrice', () => {
  const asOf = new Date('2026-04-01T00:00:00Z');

  it('applies 20% markdown when batch expires in <= 7 days', () => {
    const res = computeSuggestedPrice({
      costPrice: 100,
      batchExpiryDate: '2026-04-06',
      asOfDate: asOf,
    });
    expect(res.discountPct).toBe(20);
    expect(res.suggestedPrice).toBe(80);
    expect(res.daysToExpiry).toBe(5);
  });

  it('applies 15% markdown for 8-15 days and 10% for 16-30 days', () => {
    expect(
      computeSuggestedPrice({
        costPrice: 50,
        batchExpiryDate: '2026-04-12',
        asOfDate: asOf,
      }).suggestedPrice,
    ).toBe(42.5);

    expect(
      computeSuggestedPrice({
        costPrice: 50,
        batchExpiryDate: '2026-04-25',
        asOfDate: asOf,
      }).suggestedPrice,
    ).toBe(45);
  });

  it('applies 8% dead-stock markdown when shelf life > 60d and daysOfCover > 45', () => {
    const res = computeSuggestedPrice({
      costPrice: 100,
      batchExpiryDate: '2026-09-01',
      asOfDate: asOf,
      daysOfCover: 62,
    });
    expect(res.discountPct).toBe(8);
    expect(res.suggestedPrice).toBe(92);
  });

  it('never returns zero or negative suggestedPrice for micro-cost items', () => {
    const res = computeSuggestedPrice({
      costPrice: 0.01,
      batchExpiryDate: '2026-04-02',
      asOfDate: asOf,
    });
    expect(res.suggestedPrice).toBeGreaterThanOrEqual(0.01);
  });
});

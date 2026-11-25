import { describe, expect, it } from 'vitest';
import {
  computeWindowAllocations,
  resolveUnitTierPrice,
  windowAdvisoryLockKey,
  type ProductTierSchedule,
} from '../src/pricing';

const PROD_ATTA = '11111111-1111-4111-8111-111111111111';
const PROD_OIL = '22222222-2222-4222-8222-222222222222';

describe('GroupBuy Pricing & Landed-Cost Calculator', () => {
  const schedules: ProductTierSchedule[] = [
    {
      productId: PROD_ATTA,
      baseUnitPrice: 250,
      tiers: [
        { minQty: 20, unitPrice: 230 },
        { minQty: 50, unitPrice: 210 },
      ],
    },
    {
      productId: PROD_OIL,
      baseUnitPrice: 150,
      tiers: [
        { minQty: 30, unitPrice: 135 },
        { minQty: 100, unitPrice: 120 },
      ],
    },
  ];

  it('selects the deepest eligible volume tier or falls back to baseUnitPrice', () => {
    expect(resolveUnitTierPrice(schedules[0], 10)).toBe(250);
    expect(resolveUnitTierPrice(schedules[0], 20)).toBe(230);
    expect(resolveUnitTierPrice(schedules[0], 65)).toBe(210);
  });

  it('matches hand-calculated proportional delivery shares and per-unit landed costs', () => {
    // Pooled PROD_ATTA = 30 + 20 = 50 -> tier unit price = INR 210 (base INR 250)
    // Shop A: 30 * 210 = 6300 (60% of 10500) -> delivery share = 60% of 500 = 300.00 -> landed = 210 + 300/30 = 220.00
    // Shop B: 20 * 210 = 4200 (40% of 10500) -> delivery share = 40% of 500 = 200.00 -> landed = 210 + 200/20 = 220.00
    const res = computeWindowAllocations(
      [
        { shopId: 'shop-a', productId: PROD_ATTA, qty: 30 },
        { shopId: 'shop-b', productId: PROD_ATTA, qty: 20 },
      ],
      schedules,
      500,
    );

    expect(res.totalOrderValue).toBe(10500);
    expect(res.totalDeliveryFee).toBe(500);
    // Base total = 50 * 250 = 12500; total payable = 11000 -> total savings = 1500
    expect(res.totalSavings).toBe(1500);

    const a = res.allocations.find((x) => x.shopId === 'shop-a')!;
    const b = res.allocations.find((x) => x.shopId === 'shop-b')!;
    expect(a.unitTierPrice).toBe(210);
    expect(a.deliveryShare).toBe(300);
    expect(a.landedCost).toBe(220);
    expect(a.totalPayable).toBe(6600);
    expect(a.savingsVsBase).toBe(900);

    expect(b.deliveryShare).toBe(200);
    expect(b.landedCost).toBe(220);
    expect(b.totalPayable).toBe(4400);
    expect(b.savingsVsBase).toBe(600);
  });

  it('conserves delivery_fee to the exact paise across uneven 3-way splits', () => {
    const res = computeWindowAllocations(
      [
        { shopId: 's1', productId: PROD_OIL, qty: 10 },
        { shopId: 's2', productId: PROD_OIL, qty: 10 },
        { shopId: 's3', productId: PROD_OIL, qty: 10 },
      ],
      schedules,
      100, // 100 / 3 = 33.33, 33.33, 33.34
    );

    const totalDelivery = Number(
      res.allocations.reduce((acc, a) => acc + a.deliveryShare, 0).toFixed(2),
    );
    expect(totalDelivery).toBe(100);
    expect(res.allocations.every((a) => a.unitTierPrice === 135)).toBe(true);
  });

  it('produces deterministic signed 32-bit advisory lock key pairs', () => {
    const [k1, k2] = windowAdvisoryLockKey('11111111-1111-4111-8111-111111111111');
    const [k1b, k2b] = windowAdvisoryLockKey('11111111-1111-4111-8111-111111111111');
    expect(k1).toBe(k1b);
    expect(k2).toBe(k2b);
    expect(Number.isInteger(k1)).toBe(true);
    expect(Number.isInteger(k2)).toBe(true);
  });
});

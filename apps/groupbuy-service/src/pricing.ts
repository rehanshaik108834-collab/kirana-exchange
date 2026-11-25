import { createHash } from 'node:crypto';

export interface PriceTier {
  minQty: number;
  unitPrice: number;
}

export interface ProductTierSchedule {
  productId: string;
  baseUnitPrice: number;
  tiers: PriceTier[];
}

export interface CommitmentInput {
  shopId: string;
  productId: string;
  qty: number;
}

export interface ComputedAllocation {
  shopId: string;
  productId: string;
  qty: number;
  baseUnitPrice: number;
  unitTierPrice: number;
  lineSubtotal: number;
  /** Proportional share of window delivery_fee assigned to this commitment (total INR). */
  deliveryShare: number;
  /** Per-unit landed cost = unitTierPrice + (deliveryShare / qty), rounded to 2 decimals. */
  landedCost: number;
  /** Total payable for this commitment = lineSubtotal + deliveryShare. */
  totalPayable: number;
  /** Positive INR savings versus buying at distributor baseUnitPrice. */
  savingsVsBase: number;
}

export interface WindowPricingResult {
  pooledQtyByProduct: Record<string, number>;
  unitTierPriceByProduct: Record<string, number>;
  totalOrderValue: number;
  totalDeliveryFee: number;
  totalSavings: number;
  allocations: ComputedAllocation[];
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Derives two deterministic signed 32-bit integers from a window UUID for
 * PostgreSQL's `pg_try_advisory_xact_lock(int, int)` without JS bigint precision issues.
 */
export function windowAdvisoryLockKey(windowId: string): [number, number] {
  const digest = createHash('sha256').update(`groupbuy:close:${windowId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Picks the deepest discount tier whose `minQty <= pooledQty`, falling back to `baseUnitPrice`.
 */
export function resolveUnitTierPrice(schedule: ProductTierSchedule, pooledQty: number): number {
  const eligible = [...(schedule.tiers ?? [])]
    .filter((t) => pooledQty >= t.minQty)
    .sort((a, b) => b.minQty - a.minQty || a.unitPrice - b.unitPrice);

  if (eligible.length > 0) {
    return round2(eligible[0].unitPrice);
  }
  return round2(schedule.baseUnitPrice);
}

/**
 * Computes tiered unit prices, exact paise-conserving proportional delivery shares,
 * and per-unit landed costs for every commitment in a group-buy window.
 */
export function computeWindowAllocations(
  commitments: CommitmentInput[],
  schedules: ProductTierSchedule[],
  deliveryFeeRaw: number,
): WindowPricingResult {
  const deliveryFee = round2(Math.max(0, Number(deliveryFeeRaw || 0)));
  const scheduleByProduct = new Map<string, ProductTierSchedule>(
    schedules.map((s) => [s.productId, s]),
  );

  const pooledQtyByProduct: Record<string, number> = {};
  for (const c of commitments) {
    pooledQtyByProduct[c.productId] = (pooledQtyByProduct[c.productId] ?? 0) + c.qty;
  }

  const unitTierPriceByProduct: Record<string, number> = {};
  for (const schedule of schedules) {
    const pooled = pooledQtyByProduct[schedule.productId] ?? 0;
    unitTierPriceByProduct[schedule.productId] = resolveUnitTierPrice(schedule, pooled);
  }

  if (commitments.length === 0) {
    return {
      pooledQtyByProduct,
      unitTierPriceByProduct,
      totalOrderValue: 0,
      totalDeliveryFee: deliveryFee,
      totalSavings: 0,
      allocations: [],
    };
  }

  const preliminary = commitments.map((c) => {
    const schedule = scheduleByProduct.get(c.productId);
    if (!schedule) {
      throw new Error(`Product ${c.productId} is not configured in window price_tiers`);
    }
    const unitTierPrice = unitTierPriceByProduct[c.productId];
    const lineSubtotal = round2(unitTierPrice * c.qty);
    return {
      shopId: c.shopId,
      productId: c.productId,
      qty: c.qty,
      baseUnitPrice: round2(schedule.baseUnitPrice),
      unitTierPrice,
      lineSubtotal,
    };
  });

  const totalOrderValue = round2(preliminary.reduce((sum, item) => sum + item.lineSubtotal, 0));

  // Distribute deliveryFee proportionally to lineSubtotal with exact paise conservation
  const deliveryShares = preliminary.map((item) =>
    deliveryFee > 0 && totalOrderValue > 0
      ? round2((deliveryFee * item.lineSubtotal) / totalOrderValue)
      : 0,
  );

  if (deliveryFee > 0 && totalOrderValue > 0 && deliveryShares.length > 0) {
    const sumShares = round2(deliveryShares.reduce((acc, s) => acc + s, 0));
    const residual = round2(deliveryFee - sumShares);
    if (residual !== 0) {
      let largestIdx = 0;
      for (let i = 1; i < preliminary.length; i++) {
        if (preliminary[i].lineSubtotal > preliminary[largestIdx].lineSubtotal) {
          largestIdx = i;
        }
      }
      deliveryShares[largestIdx] = round2(Math.max(0, deliveryShares[largestIdx] + residual));
    }
  }

  const allocations: ComputedAllocation[] = preliminary.map((item, idx) => {
    const deliveryShare = deliveryShares[idx];
    const totalPayable = round2(item.lineSubtotal + deliveryShare);
    const landedCost = round2(item.unitTierPrice + deliveryShare / item.qty);
    const baseTotal = round2(item.baseUnitPrice * item.qty);
    const savingsVsBase = round2(Math.max(0, baseTotal - totalPayable));

    return {
      shopId: item.shopId,
      productId: item.productId,
      qty: item.qty,
      baseUnitPrice: item.baseUnitPrice,
      unitTierPrice: item.unitTierPrice,
      lineSubtotal: item.lineSubtotal,
      deliveryShare,
      landedCost,
      totalPayable,
      savingsVsBase,
    };
  });

  const totalSavings = round2(allocations.reduce((sum, a) => sum + a.savingsVsBase, 0));

  return {
    pooledQtyByProduct,
    unitTierPriceByProduct,
    totalOrderValue,
    totalDeliveryFee: deliveryFee,
    totalSavings,
    allocations,
  };
}

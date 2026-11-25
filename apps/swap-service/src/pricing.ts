/**
 * Rule-based surplus markdown pricing calculator for Kirana Exchange.
 *
 * Computes a fair peer-to-peer transfer price below wholesale cost_price based
 * on expiry urgency and dead-stock stagnation (daysOfCover), ensuring sellers
 * recover working capital while buyers receive an attractive margin.
 */

export interface PriceSuggestionInput {
  costPrice: number;
  batchExpiryDate: Date | string;
  asOfDate?: Date;
  daysOfCover?: number | null;
}

export interface PriceSuggestionResult {
  suggestedPrice: number;
  discountPct: number;
  daysToExpiry: number;
  rationale: string;
}

const MS_PER_DAY = 86_400_000;

export function computeSuggestedPrice(input: PriceSuggestionInput): PriceSuggestionResult {
  const cost = Math.max(0.01, Number(input.costPrice));
  const now = input.asOfDate ?? new Date();
  const expiry =
    input.batchExpiryDate instanceof Date ? input.batchExpiryDate : new Date(input.batchExpiryDate);

  const utcNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const utcExpiry = Date.UTC(expiry.getUTCFullYear(), expiry.getUTCMonth(), expiry.getUTCDate());
  const daysToExpiry = Math.floor((utcExpiry - utcNow) / MS_PER_DAY);

  let discountPct: number;
  let rationale: string;

  if (daysToExpiry <= 7) {
    discountPct = 20;
    rationale = 'Urgent expiry (<= 7 days): 20% markdown off wholesale cost';
  } else if (daysToExpiry <= 15) {
    discountPct = 15;
    rationale = 'Near expiry (8–15 days): 15% markdown off wholesale cost';
  } else if (daysToExpiry <= 30) {
    discountPct = 10;
    rationale = 'Short shelf life (16–30 days): 10% markdown off wholesale cost';
  } else if (daysToExpiry <= 60) {
    discountPct = 5;
    rationale = 'Moderate shelf life (31–60 days): 5% markdown off wholesale cost';
  } else if ((input.daysOfCover ?? 0) > 45) {
    discountPct = 8;
    rationale = 'Slow-moving dead stock (> 45 days of cover): 8% markdown off wholesale cost';
  } else {
    discountPct = 3;
    rationale = 'Standard peer surplus: 3% markdown off wholesale cost';
  }

  // Clamp discount strictly within [3%, 40%] and guarantee a positive 2-decimal floor
  const boundedDiscount = Math.min(40, Math.max(3, discountPct));
  const rawPrice = cost * (1 - boundedDiscount / 100);
  const suggestedPrice = Math.max(0.01, Number(rawPrice.toFixed(2)));

  return {
    suggestedPrice,
    discountPct: boundedDiscount,
    daysToExpiry,
    rationale,
  };
}

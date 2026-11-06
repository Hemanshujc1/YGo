/**
 * Cap platform-funded promotion on requote (ORD-4, D-5).
 * Platform-funded promotion value never exceeds what the platform earns on the order before promotion:
 * budget = max(0, contribution before promotion).
 */
export function platformPromotionCap(contributionBeforePromotion: number): number {
  return Math.max(0, contributionBeforePromotion);
}


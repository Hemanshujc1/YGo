/** One whole-pack line of a counter bill: the unit price in rupees with at most two decimals, and a pack count. */
export type CounterBillLineAmount = { unitPrice: string; count: number };

function paise(amount: string): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/**
 * A counter bill's total (BIL-9): the one money calculation made on a phone. It runs in integer paise as
 * BigInt (ADR-0007) and returns rupees with two decimals, such as "199.00": the lines' sum, catalog and typed
 * alike, less the discount (#53). It is null when the discount is more than the sum. The server checks it in SQL.
 */
export function counterBillTotal(lines: readonly CounterBillLineAmount[], discount = "0"): string | null {
  const total = lines.reduce((sum, line) => sum + paise(line.unitPrice) * BigInt(line.count), 0n) - paise(discount);
  if (total < 0n) return null;
  return `${total / 100n}.${(total % 100n).toString().padStart(2, "0")}`;
}

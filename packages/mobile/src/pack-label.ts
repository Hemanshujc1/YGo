import type { OrderLine } from "@ygo/contracts";
import { formatNumber } from "@ygo/format";

export type UnitWords = { g: string; kg: string; ml: string; l: string; pc: string; pcs: string };

/** "500 g", "1 kg", "6 pcs": a pack size in the app's own unit words. */
export function packLabel(quantity: string, baseUnit: OrderLine["baseUnit"], units: UnitWords): string {
  const amount = Number(quantity);
  if (baseUnit === "each") return `${formatNumber(amount)} ${amount === 1 ? units.pc : units.pcs}`;
  if (amount < 1) return `${formatNumber(Math.round(amount * 1000))} ${baseUnit === "kg" ? units.g : units.ml}`;
  return `${formatNumber(amount)} ${baseUnit === "kg" ? units.kg : units.l}`;
}

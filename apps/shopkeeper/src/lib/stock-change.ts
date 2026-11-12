import { StockChangePayload, type StockChangeReason } from "@ygo/contracts";
import { trimDecimal } from "@ygo/format";

/**
 * The change a shop typed on the Stock screen (S11, #67), or null when it is not one the server would accept. Damaged and expired always take
 * stock away; the other reasons add unless `away`; "counted" sends the total.
 */
export function buildStockChange(packId: string, reason: StockChangeReason, away: boolean, typed: string, baseUnit: "each" | "kg" | "l"): StockChangePayload | null {
  const amount = trimDecimal(typed.trim());
  // The sign is the reason's and the choice's, never typed; a counted pack takes whole numbers only, as the server checks.
  if (!/^\d+(\.\d+)?$/.test(amount) || (baseUnit === "each" && !/^\d+$/.test(amount))) return null;
  const negative = reason === "damaged" || reason === "expired" || away;
  const checked = StockChangePayload.safeParse(reason === "counted" ? { packId, reason, total: amount } : { packId, reason, quantity: negative ? `-${amount}` : amount });
  return checked.success ? checked.data : null;
}

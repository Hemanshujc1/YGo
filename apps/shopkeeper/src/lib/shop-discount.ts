import { ShopDiscountBody, type ShopDiscountRule } from "@ygo/contracts";
import { formatNumber, trimDecimal } from "@ygo/format";

/** What S34's fields hold while the Owner types: text, as typed, until Save. */
export type DiscountForm = { form: "percentage" | "flat"; percentage: string; cap: string; amount: string; minimumOrder: string; active: boolean };

export const emptyDiscount: DiscountForm = { form: "percentage", percentage: "", cap: "", amount: "", minimumOrder: "", active: true };

/**
 * The saved rule as form text, amounts without trailing zeros. A paused rule shows as on: lowering it and saving turns it back on, as its
 * banner says. While discounts are not `available` (#571) every rule shows as off, the only state a save can take.
 */
export function toForm(rule: ShopDiscountRule | null, available = true): DiscountForm {
  if (!rule) return { ...emptyDiscount, active: available };
  return {
    form: rule.form, percentage: trimDecimal(rule.percentage ?? ""), cap: trimDecimal(rule.cap ?? ""), amount: trimDecimal(rule.amount ?? ""),
    minimumOrder: trimDecimal(rule.minimumOrder ?? ""), active: available && rule.status !== "off",
  };
}

/** The request for a form, or the fields that break the contract's rules (the server's own schema, #63). */
export function toBody(form: DiscountForm): { ok: true; body: ShopDiscountBody } | { ok: false; fields: string[] } {
  const checked = ShopDiscountBody.safeParse(form.form === "percentage"
    ? { form: "percentage", percentage: form.percentage.trim(), cap: form.cap.trim() || null, active: form.active }
    : { form: "flat", amount: form.amount.trim(), minimumOrder: form.minimumOrder.trim(), active: form.active });
  if (checked.success) return { ok: true, body: checked.data };
  const fields = [...new Set(checked.error.issues.map((issue) => String(issue.path[0] ?? "")).filter((field) => field && field !== "form" && field !== "active"))];
  return { ok: false, fields };
}

/**
 * The worst case the server will hold to the maximum, shown as the Owner types: the percentage, or the amount over the minimum order.
 * A flat one rounds up to the hundredth, so it never shows within a maximum the server's exact check refuses (200 over 999.99 is 20.01).
 */
export function worstPercent(form: DiscountForm): string | null {
  if (form.form === "percentage") return Number(form.percentage) > 0 ? trimDecimal(form.percentage) : null;
  const amount = Number(form.amount), minimum = Number(form.minimumOrder);
  return amount > 0 && minimum > 0 ? formatNumber(Math.ceil((amount * 10000) / minimum - 1e-9) / 100) : null;
}

import { ShopDiscountBody, type ShopDiscountRule } from "@ygo/contracts";
import { trimDecimal } from "@ygo/format";

/** What S34's fields hold while the Owner types: text, as typed, until Save. */
export type DiscountForm = { form: "percentage" | "flat"; percentage: string; cap: string; amount: string; minimumOrder: string; active: boolean };

export const emptyDiscount: DiscountForm = { form: "percentage", percentage: "", cap: "", amount: "", minimumOrder: "", active: true };

/** The saved rule as form text, amounts without trailing zeros; a paused rule shows as off until the Owner turns it on again. */
export function toForm(rule: ShopDiscountRule | null): DiscountForm {
  if (!rule) return emptyDiscount;
  return {
    form: rule.form, percentage: trimDecimal(rule.percentage ?? ""), cap: trimDecimal(rule.cap ?? ""), amount: trimDecimal(rule.amount ?? ""),
    minimumOrder: trimDecimal(rule.minimumOrder ?? ""), active: rule.status === "active",
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

/** The worst case the server will hold to the maximum, shown as the Owner types: the percentage, or the amount over the minimum order. */
export function worstPercent(form: DiscountForm): string | null {
  if (form.form === "percentage") return Number(form.percentage) > 0 ? trimDecimal(form.percentage) : null;
  const amount = Number(form.amount), minimum = Number(form.minimumOrder);
  return amount > 0 && minimum > 0 ? trimDecimal(((amount * 100) / minimum).toFixed(2)) : null;
}

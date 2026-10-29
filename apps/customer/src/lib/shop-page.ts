import type { ShopPagePack, ShopPageProduct, ShopPageResponse } from "@ygo/contracts";
import { formatNumber } from "@ygo/format";
import { strings } from "../strings";

/** A pack's size: grams or millilitres below 1 kg or 1 L, as the quantity stepper shows them (design system). */
export function packLabel(quantity: string, baseUnit: ShopPageProduct["baseUnit"]): string {
  const units = strings.shop.units;
  const amount = Number(quantity);
  if (baseUnit === "each") return `${formatNumber(amount)} ${amount === 1 ? units.pc : units.pcs}`;
  if (amount < 1) return `${formatNumber(Math.round(amount * 1000))} ${baseUnit === "kg" ? units.g : units.ml}`;
  return `${formatNumber(amount)} ${baseUnit === "kg" ? units.kg : units.l}`;
}

/** "10% off" for a whole percent of at least 1; a smaller cut shows only the struck MRP (owner's answer 3 on #370). */
export function offLabel(pack: Pick<ShopPagePack, "discountPercent">): string | null {
  return pack.discountPercent ? strings.shop.off(pack.discountPercent) : null;
}

/** C05's SectionList sections: one per top category, its products as the rows, both in the server's order (#370). */
export function shopSections(groups: ShopPageResponse["groups"]): Array<{ key: string; title: string; data: ShopPageProduct[] }> {
  return groups.map((group) => ({ key: group.category, title: group.category, data: group.products }));
}

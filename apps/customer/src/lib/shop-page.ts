import type { ShopHoursRange, ShopPagePack, ShopPageProduct, ShopPageResponse } from "@ygo/contracts";
import { formatDayTime, formatMinuteOfDay, formatNumber } from "@ygo/format";
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

const hoursWords = strings.shop.hours;

/** "9:00 AM – 1:00 PM, 4:00 PM – 9:00 PM", or "Open 24 hours"; a close at or before the open ends the next day (#371). */
function rangesText(ranges: readonly ShopHoursRange[]): string {
  return ranges.map(({ opens, closes }) => opens === closes ? hoursWords.allDay : `${formatMinuteOfDay(opens)} – ${formatMinuteOfDay(closes)}`).join(", ");
}

/**
 * C05's hours line from what the server decided (owner's answers 10 on #371 and 1–2 on #381):
 * "Open today, …" inside one of today's ranges, "Open now · until …" when open otherwise,
 * "Open 24 hours" for a shop that never closes, and "Closed now · opens …".
 */
export function hoursLine(shop: ShopPageResponse["shop"], now: number): string {
  const when = (at: string) => formatDayTime(at, now, strings.feed.tomorrow);
  if (!shop.open) return shop.opensAt ? hoursWords.closedNow(when(shop.opensAt)) : hoursWords.closed;
  if (!shop.closesAt) return hoursWords.allDay;
  const today = shop.hours.filter((range) => range.weekday === shop.today);
  // Minutes past midnight in India; a range running past midnight covers the rest of today.
  const minute = (Math.floor(now / 60_000) + 330) % 1440;
  const inToday = today.some(({ opens, closes }) => closes > opens ? minute >= opens && minute < closes : minute >= opens);
  return inToday ? hoursWords.openToday(rangesText(today)) : hoursWords.openUntil(when(shop.closesAt));
}

/** The week behind the line, Monday first: each day's ranges or "Closed", today marked (owner's answer 3 on #381). */
export function weekRows(hours: readonly ShopHoursRange[], today: number): Array<{ day: string; text: string; today: boolean }> {
  return hoursWords.days.map((day, index) => {
    const ranges = hours.filter((range) => range.weekday === index + 1);
    return { day, text: ranges.length ? rangesText(ranges) : hoursWords.closed, today: index + 1 === today };
  });
}

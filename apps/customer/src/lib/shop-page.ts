import type { PartPack, ShopHoursRange, ShopPagePack, ShopPageProduct, ShopPageResponse } from "@ygo/contracts";
import { formatDayTime, formatMinuteOfDay, formatNumber } from "@ygo/format";
import { packLabel as sharedPackLabel } from "@ygo/mobile/pack-label";
import { strings } from "../strings";
import { money } from "./money";

/** A pack's size: grams or millilitres below 1 kg or 1 L, as the quantity stepper shows them (design system). */
export const packLabel = (quantity: string, baseUnit: ShopPageProduct["baseUnit"]): string => sharedPackLabel(quantity, baseUnit, strings.shop.units);

/** "Only 400 g left · ₹16": what is left of a pack, on C05 and C07 (owner's answer 5 on #377). */
export function partLabel(part: PartPack, baseUnit: ShopPageProduct["baseUnit"]): string {
  return strings.shop.partLeft(packLabel(part.quantity, baseUnit), money(part.price));
}

/** "7.69% off", "10% off" with no trailing zeros; a cut that rounds to 0.00% shows only the struck MRP (owners' answers on #411). */
export function offLabel(pack: Pick<ShopPagePack, "discountPercent">): string | null {
  const percent = Number(pack.discountPercent);
  return percent > 0 ? strings.shop.off(formatNumber(percent)) : null;
}

/** C05's SectionList sections: one per top category, its products as the rows, both in the server's order (#370). */
export function shopSections(groups: ShopPageResponse["groups"]): Array<{ key: string; title: string; data: ShopPageProduct[] }> {
  return groups.map((group) => ({ key: group.category, title: group.category, data: group.products }));
}

const hoursWords = strings.shop.hours;

/**
 * "9:00 AM – 1:00 PM, 4:00 PM – 9:00 PM"; a close at or before the open ends the next day (#371).
 * A 24-hour range reads "All day" from 12:00 AM, else "24 hours from 9:00 AM".
 */
function rangesText(ranges: readonly ShopHoursRange[]): string {
  return ranges.map(({ opens, closes }) => opens !== closes
    ? `${formatMinuteOfDay(opens)} – ${formatMinuteOfDay(closes)}`
    : opens === 0 ? hoursWords.wholeDay : hoursWords.dayFrom(formatMinuteOfDay(opens))).join(", ");
}

/**
 * C05's hours line from what the server decided (owner's answers 10 on #371 and 1–2 on #381):
 * "Open today, …" inside one of today's ranges ("Open all day today" for a whole day),
 * "Open now · until …" when open otherwise, "Open 24 hours" only for a shop that never
 * closes all week, and "Closed now · opens …".
 */
export function hoursLine(shop: ShopPageResponse["shop"], now: number): string {
  const when = (at: string) => formatDayTime(at, now, strings.feed.tomorrow);
  if (!shop.open) return shop.opensAt ? (shop.holiday ? hoursWords.closedHoliday : hoursWords.closedNow)(when(shop.opensAt)) : hoursWords.closed;
  if (!shop.closesAt) return hoursWords.allDay;
  // Open on a holiday is the Owner's switch, so today's hours don't apply (#382).
  const today = shop.holidays.includes(shop.today) ? [] : shop.hours.filter((range) => range.weekday === shop.today);
  // Minutes past midnight in India; a range running past midnight covers the rest of today.
  const minute = (Math.floor(now / 60_000) + 330) % 1440;
  const inToday = today.some(({ opens, closes }) => closes > opens ? minute >= opens && minute < closes : minute >= opens);
  if (!inToday) return hoursWords.openUntil(when(shop.closesAt));
  // "Open 24 hours" is kept for a shop that never closes; one whole day reads on its own.
  const [only] = today;
  return today.length === 1 && only?.opens === 0 && only.closes === 0 ? hoursWords.allDayToday : hoursWords.openToday(rangesText(today));
}

/**
 * The week behind the line, Monday first: each day's ranges or "Closed",
 * today marked (owner's answer 3 on #381). A day of the coming 7 that is a
 * holiday reads "Holiday" (owner's answer 11 on #382).
 */
export function weekRows(hours: readonly ShopHoursRange[], today: number, holidays: readonly number[]): Array<{ day: string; text: string; today: boolean }> {
  return hoursWords.days.map((day, index) => {
    const ranges = hours.filter((range) => range.weekday === index + 1);
    const text = holidays.includes(index + 1) ? hoursWords.holiday : ranges.length ? rangesText(ranges) : hoursWords.closed;
    return { day, text, today: index + 1 === today };
  });
}

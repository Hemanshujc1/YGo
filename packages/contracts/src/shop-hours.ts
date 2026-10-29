import { z } from "zod";

// Weekly opening hours (S32's hours, #371). Owner's answers 3, 4 and 20 on #371 (2026-10-29).

export const MINUTES_PER_DAY = 1440;
/** Times move in 30-minute steps. */
export const HOURS_STEP_MINUTES = 30;
export const MAX_RANGES_PER_DAY = 3;

/** Minutes past midnight in India: 0 is 12:00 AM, 1410 is 11:30 PM. */
export const DayMinute = z.number().int().min(0).max(MINUTES_PER_DAY - HOURS_STEP_MINUTES).multipleOf(HOURS_STEP_MINUTES);
/** 1 is Monday, 7 is Sunday. */
export const Weekday = z.number().int().min(1).max(7);
export type Weekday = z.infer<typeof Weekday>;

/**
 * One opening, listed under the day it opens. A close at or before the open
 * ends the next day, so 10:00 PM – 2:00 AM runs past midnight and
 * 12:00 AM – 12:00 AM is 24 hours.
 */
export const ShopHoursRange = z.strictObject({ weekday: Weekday, opens: DayMinute, closes: DayMinute });
export type ShopHoursRange = z.infer<typeof ShopHoursRange>;

/** How long a range stays open, in minutes. */
export function rangeLength({ opens, closes }: Pick<ShopHoursRange, "opens" | "closes">): number {
  return closes > opens ? closes - opens : closes + MINUTES_PER_DAY - opens;
}

/**
 * The opening day of each range that runs into the next range of the week,
 * Sunday wrapping into Monday. Ranges may touch (1:00 PM – 5:00 PM after
 * 9:00 AM – 1:00 PM) but not overlap. The form and the server both use it.
 */
export function overlappingDays(ranges: readonly ShopHoursRange[]): Weekday[] {
  const week = MINUTES_PER_DAY * 7;
  const sorted = ranges
    .map((range) => ({ weekday: range.weekday, start: (range.weekday - 1) * MINUTES_PER_DAY + range.opens, length: rangeLength(range) }))
    .sort((a, b) => a.start - b.start);
  const days = new Set<Weekday>();
  sorted.forEach((range, index) => {
    // Sorted by start, an overlap anywhere shows between neighbours; the last range's neighbour is next week's first.
    const next = sorted[(index + 1) % sorted.length];
    if (!next || sorted.length < 2) return;
    const nextStart = next.start + (index + 1 === sorted.length ? week : 0);
    if (range.start + range.length > nextStart) days.add(range.weekday);
  });
  return [...days].sort();
}

/** `PUT /v1/me/shop-hours`: the whole week. A day with no range is closed; a week needs one open range. */
export const ShopHours = z.strictObject({ ranges: z.array(ShopHoursRange).min(1).max(MAX_RANGES_PER_DAY * 7) })
  .refine(({ ranges }) => [1, 2, 3, 4, 5, 6, 7].every((day) => ranges.filter((range) => range.weekday === day).length <= MAX_RANGES_PER_DAY), { path: ["ranges"] })
  .refine(({ ranges }) => overlappingDays(ranges).length === 0, { path: ["ranges"] });
export type ShopHours = z.infer<typeof ShopHours>;

/** `GET` and `PUT /v1/me/shop-hours`: the week's ranges by day and opening time; empty until the Owner first saves. */
export const ShopHoursResponse = z.strictObject({ ranges: z.array(ShopHoursRange) });
export type ShopHoursResponse = z.infer<typeof ShopHoursResponse>;

/**
 * `PUT /v1/me/shop-open`: the Owner's open/closed switch (#380). Matching the
 * weekly hours cancels any override. Closing during hours lasts until the next
 * opening; opening outside hours needs `until`, a half hour no later than it.
 */
export const ShopOpenChange = z.strictObject({ open: z.boolean(), until: z.iso.datetime().optional() });
export type ShopOpenChange = z.infer<typeof ShopOpenChange>;

/** `GET` and `PUT /v1/me/shop-open`: whether the shop is open now, and why. */
export const ShopOpenStatus = z.strictObject({
  open: z.boolean(),
  /** When `open` changes next; null for a shop with no closed time and no override. */
  until: z.iso.datetime().nullable(),
  /** The Owner's switch, not the weekly hours, decides `open` until `until`. */
  setByOwner: z.boolean(),
  /** What the weekly hours alone say now. */
  scheduledOpen: z.boolean(),
  /** The next time the hours go from closed to open; null when the week has no closed time. */
  nextOpening: z.iso.datetime().nullable(),
});
export type ShopOpenStatus = z.infer<typeof ShopOpenStatus>;

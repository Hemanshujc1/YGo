import { indiaToday, MINUTES_PER_DAY, rangeLength, type ShopHoursRange, type ShopOpenStatus } from "@ygo/contracts";
import type { Pool, PoolClient } from "pg";

const MINUTE = 60_000;
/** India is UTC+5:30 all year, with no daylight saving. */
const INDIA_OFFSET = 330;

/** Days since 1 Jan 1970 in India at `now`. */
const indiaDay = (now: Date) => Math.floor((Math.floor(now.getTime() / MINUTE) + INDIA_OFFSET) / MINUTES_PER_DAY);
/** A day's weekday, 1 Monday to 7 Sunday; 1 Jan 1970 was a Thursday. */
const weekdayOf = (day: number) => ((day + 3) % 7) + 1;

/** Today's weekday in India, 1 Monday to 7 Sunday. */
export function indiaWeekday(now: Date): number {
  return weekdayOf(indiaDay(now));
}

/** The Owner's switch as stored on `shops`, or null when it was never set. */
export function overrideOf(row: { open_override: boolean | null; open_override_until: Date | null }) {
  return row.open_override === null || !row.open_override_until ? null : { open: row.open_override, until: row.open_override_until };
}

/** One of the shop's holidays: whole India calendar days, `starts` through `ends` (#382). */
export type Holiday = { starts: string; ends: string };

/** The holidays of these shops not ended by today in India; ended ones never change the hours ahead. */
export async function holidaysOf(client: Pool | PoolClient, shopIds: readonly string[], now: Date) {
  return (await client.query<Holiday & { shopId: string }>(
    `SELECT shop_id AS "shopId", to_char(starts, 'YYYY-MM-DD') AS starts, to_char(ends, 'YYYY-MM-DD') AS ends
     FROM shop_holidays WHERE shop_id = ANY($1::uuid[]) AND ends >= $2`, [shopIds, indiaToday(now)])).rows;
}

/** Days since 1 Jan 1970 for an India calendar date such as "2030-01-01". */
const dayOf = (date: string) => Date.parse(date) / (MINUTES_PER_DAY * MINUTE);
/** The minute an India day starts, counted like `Date` minutes. */
const dayStart = (day: number) => day * MINUTES_PER_DAY - INDIA_OFFSET;

/** The India days, as day numbers, that holidays close. */
function holidayCheck(holidays: readonly Holiday[]) {
  const spans = holidays.map((holiday) => ({ from: dayOf(holiday.starts), to: dayOf(holiday.ends) }));
  return { last: Math.max(0, ...spans.map((span) => span.to)), closed: (day: number) => spans.some((span) => day >= span.from && day <= span.to) };
}

/**
 * What the weekly hours and holidays say at `now`, and when the shop next opens
 * and closes (owner's answers 1 and 2 on #380, 2 and 7 on #382). A holiday
 * closes its whole India day, so a range running past midnight stops at a
 * holiday's start and opens again when it ends.
 */
export function schedule(ranges: readonly ShopHoursRange[], holidays: readonly Holiday[], now: Date) {
  // A shop with no hours yet counts as open (owner's answer 8 on #371).
  if (ranges.length === 0) return { open: true, nextOpening: null, nextClosing: null };
  const minutes = Math.floor(now.getTime() / MINUTE);
  const today = indiaDay(now);
  const off = holidayCheck(holidays);
  // A whole week past the last holiday shows every opening and closing the hours have.
  const last = Math.max(today, off.last) + 8;
  // Each range from yesterday on, cut at midnight so a holiday drops whole days.
  const pieces: [number, number][] = [];
  for (let day = today - 1; day <= last; day++) {
    for (const range of ranges.filter((range) => range.weekday === weekdayOf(day))) {
      const opens = dayStart(day) + range.opens;
      const closes = opens + rangeLength(range);
      for (let part = day; dayStart(part) < closes; part++) {
        if (!off.closed(part)) pieces.push([Math.max(opens, dayStart(part)), Math.min(closes, dayStart(part + 1))]);
      }
    }
  }
  // Touching pieces are one open stretch, so only a start after closed time is an opening.
  const stretches: [number, number][] = [];
  for (const [from, to] of pieces.sort((a, b) => a[0] - b[0])) {
    const previous = stretches.at(-1);
    if (previous && from <= previous[1]) previous[1] = Math.max(previous[1], to);
    else stretches.push([from, to]);
  }
  const at = (minute: number | undefined) => minute === undefined ? null : new Date(minute * MINUTE);
  const current = stretches.find(([from, to]) => from <= minutes && minutes < to);
  // A stretch reaching the end of the search never closes: the hours have no closed time.
  const closing = stretches.find(([, to]) => to > minutes)?.[1];
  return {
    open: Boolean(current),
    nextOpening: at(stretches.find(([from]) => from > minutes)?.[0]),
    nextClosing: closing !== undefined && closing < dayStart(last) ? at(closing) : null,
  };
}

/** Whether today in India is a holiday, and the weekdays of today and the next 6 days that are (#382). */
export function holidaysNear(holidays: readonly Holiday[], now: Date) {
  const today = indiaDay(now);
  const off = holidayCheck(holidays);
  const week = [0, 1, 2, 3, 4, 5, 6].map((ahead) => today + ahead).filter(off.closed).map(weekdayOf);
  return { today: off.closed(today), week: week.sort() };
}

/** The Owner's switch while it lasts, else the weekly hours and holidays. */
export function openStatus(ranges: readonly ShopHoursRange[], holidays: readonly Holiday[], override: { open: boolean; until: Date } | null, now: Date): ShopOpenStatus {
  const hours = schedule(ranges, holidays, now);
  const active = override && override.until > now ? override : null;
  const until = active ? active.until : hours.open ? hours.nextClosing : hours.nextOpening;
  return {
    open: active ? active.open : hours.open,
    until: until?.toISOString() ?? null,
    setByOwner: Boolean(active),
    scheduledOpen: hours.open,
    nextOpening: hours.nextOpening?.toISOString() ?? null,
  };
}

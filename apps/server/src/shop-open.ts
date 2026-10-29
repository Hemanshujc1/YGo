import { MINUTES_PER_DAY, rangeLength, type ShopHoursRange, type ShopOpenStatus } from "@ygo/contracts";

const WEEK = MINUTES_PER_DAY * 7;
const MINUTE = 60_000;
/** India is UTC+5:30 all year, with no daylight saving. */
const INDIA_OFFSET = 330;

/** Minutes since Monday 12:00 AM in India; 1 Jan 1970 was a Thursday, three days past Monday. */
function weekMinute(minutes: number): number {
  const local = minutes + INDIA_OFFSET;
  return ((Math.floor(local / MINUTES_PER_DAY) + 3) % 7) * MINUTES_PER_DAY + (local % MINUTES_PER_DAY);
}

/** What the weekly hours alone say at `now`, and when they next open and close (owner's answers 1 and 2 on #380). */
export function schedule(ranges: readonly ShopHoursRange[], now: Date) {
  const minutes = Math.floor(now.getTime() / MINUTE);
  const at = weekMinute(minutes);
  const spans = ranges.map((range) => ({ start: (range.weekday - 1) * MINUTES_PER_DAY + range.opens, length: rangeLength(range) }));
  const openAt = (minute: number) => spans.some(({ start, length }) => (minute - start + WEEK) % WEEK < length);
  // Back-to-back ranges are one open stretch, so only a start after closed time is an opening.
  const openings = spans.map(({ start }) => start).filter((start) => !openAt((start - 1 + WEEK) % WEEK));
  const closings = spans.map(({ start, length }) => (start + length) % WEEK).filter((end) => !openAt(end));
  // The next such minute after now, from 1 to a whole week ahead.
  const next = (marks: number[]) => marks.length
    ? new Date((minutes + Math.min(...marks.map((mark) => ((mark - at - 1 + WEEK) % WEEK) + 1))) * MINUTE)
    : null;
  // A shop with no hours yet counts as open (owner's answer 8 on #371).
  return { open: ranges.length === 0 || openAt(at), nextOpening: next(openings), nextClosing: next(closings) };
}

/** The Owner's switch while it lasts, else the weekly hours. */
export function openStatus(ranges: readonly ShopHoursRange[], override: { open: boolean; until: Date } | null, now: Date): ShopOpenStatus {
  const hours = schedule(ranges, now);
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

import { HOURS_STEP_MINUTES, MAX_RANGES_PER_DAY, MINUTES_PER_DAY, type ShopHoursRange } from "@ygo/contracts";

/** One opening on the form, in minutes past midnight. */
export type Opening = { opens: number; closes: number };
/** The week on the form: Monday first, each day in the order the Owner added its openings. */
export type Week = Opening[][];

/** Every time an opening can start or end, 12:00 AM to 11:30 PM. */
export const TIMES = Array.from({ length: MINUTES_PER_DAY / HOURS_STEP_MINUTES }, (_, index) => index * HOURS_STEP_MINUTES);

export function toWeek(ranges: readonly ShopHoursRange[]): Week {
  return Array.from({ length: 7 }, (_, day) => ranges.filter((range) => range.weekday === day + 1).map(({ opens, closes }) => ({ opens, closes })));
}

export function toRanges(week: Week): ShopHoursRange[] {
  return week.flatMap((day, index) => day.map((opening) => ({ weekday: index + 1, ...opening })));
}

/** The next opening for a day: 9:00 AM – 9:00 PM on a closed day, else two hours from its last close. */
export function nextOpening(day: Opening[]): Opening {
  const last = day.at(-1);
  if (!last) return { opens: 9 * 60, closes: 21 * 60 };
  return { opens: last.closes, closes: (last.closes + 120) % MINUTES_PER_DAY };
}

export const canAdd = (day: Opening[]) => day.length < MAX_RANGES_PER_DAY;

/** "Copy to all days": every day gets this day's openings (owner's answer 5 on #371). */
export function copyToAll(week: Week, from: number): Week {
  return week.map(() => week[from]?.map((opening) => ({ ...opening })) ?? []);
}

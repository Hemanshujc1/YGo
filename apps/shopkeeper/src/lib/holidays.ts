import { addDays, HOLIDAY_DAYS_AHEAD } from "@ygo/contracts";

/**
 * The dates a holiday's From or To can take, as `Date.parse` values for the
 * time sheet: from `first` to HOLIDAY_DAYS_AHEAD after today, as the server
 * allows (owner's answer 3 on #382).
 */
export function dateChoices(first: string, today: string): number[] {
  const last = Date.parse(addDays(today, HOLIDAY_DAYS_AHEAD));
  const choices: number[] = [];
  for (let at = Date.parse(first); at <= last; at += 86_400_000) choices.push(at);
  return choices;
}

/** A time-sheet value back to its calendar date. */
export const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10);

/** A holiday on the form. `started` holds the start of one under way, which can't move (second round, answer 3). */
export type Draft = { id?: string; starts: string; ends: string; started: boolean };

/** Picking From moves To along when To would fall before it. */
export function pickFrom(draft: Draft, starts: string): Draft {
  return { ...draft, starts, ends: draft.ends < starts ? starts : draft.ends };
}

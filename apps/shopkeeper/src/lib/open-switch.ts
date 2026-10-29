import type { ApiResult } from "@ygo/api-client";
import { HOURS_STEP_MINUTES, type ShopOpenStatus } from "@ygo/contracts";
import { formatTime, formatWeekday } from "@ygo/format";

const STEP = HOURS_STEP_MINUTES * 60_000;
const DAY = 24 * 60 * 60_000;
/** India is UTC+5:30 all year. */
const indiaDay = (at: number) => Math.floor((at + 330 * 60_000) / DAY);

/** "Open until" choices: each half hour after now, up to and including the next opening (owner's answer 22 on #371). */
export function untilChoices(now: number, nextOpening: string): number[] {
  const last = Date.parse(nextOpening);
  const choices: number[] = [];
  for (let at = Math.floor(now / STEP) * STEP + STEP; at <= last; at += STEP) choices.push(at);
  return choices;
}

/** "9:00 PM" today, "tomorrow 9:00 AM", or "Tue 9:00 AM" further on, all in India. */
export function when(at: number | string, now: number, tomorrow: string): string {
  const time = formatTime(at);
  const days = indiaDay(new Date(at).getTime()) - indiaDay(now);
  return days === 0 ? time : days === 1 ? `${tomorrow} ${time}` : `${formatWeekday(at)} ${time}`;
}

/**
 * After a save, the server's answer is the saved position; a failed save keeps
 * the last saved one, so the switch moves back (design system: Toggle).
 */
export function settle(saved: ShopOpenStatus, answer: ApiResult<ShopOpenStatus> | null): { saved: ShopOpenStatus; failed: boolean } {
  return answer?.ok ? { saved: answer.data, failed: false } : { saved, failed: true };
}

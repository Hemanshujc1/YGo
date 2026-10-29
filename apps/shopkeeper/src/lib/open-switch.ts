import type { ApiResult } from "@ygo/api-client";
import { HOURS_STEP_MINUTES, type ShopOpenStatus } from "@ygo/contracts";

const STEP = HOURS_STEP_MINUTES * 60_000;

/** "Open until" choices: each half hour after now, up to and including the next opening (owner's answer 22 on #371). */
export function untilChoices(now: number, nextOpening: string): number[] {
  const last = Date.parse(nextOpening);
  const choices: number[] = [];
  for (let at = Math.floor(now / STEP) * STEP + STEP; at <= last; at += STEP) choices.push(at);
  return choices;
}

/**
 * After a save, the server's answer is the saved position; a failed save keeps
 * the last saved one, so the switch moves back (design system: Toggle).
 */
export function settle(saved: ShopOpenStatus, answer: ApiResult<ShopOpenStatus> | null): { saved: ShopOpenStatus; failed: boolean } {
  return answer?.ok ? { saved: answer.data, failed: false } : { saved, failed: true };
}

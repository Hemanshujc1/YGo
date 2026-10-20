import type { ApiResult } from "@ygo/api-client";
import type { Account, ErrorCode } from "@ygo/contracts";

/** How long "Send a new code" waits after a send: the server's own gap between two codes to one email. */
export const RESEND_WAIT_MS = 30_000;

/** The digits in the emailed code. */
export const CODE_LENGTH = 6;

/**
 * Seconds until "Send a new code" works, from the time of the last send
 * (#155, S2). It is worked out from the clock each time, so leaving the app
 * or the screen and coming back shows the time really left. A clock set back
 * never makes it longer than the wait.
 */
export function secondsLeft(sentAt: number | null, now: number): number {
  if (sentAt === null) return 0;
  const left = Math.ceil((sentAt + RESEND_WAIT_MS - now) / 1000);
  return Math.min(RESEND_WAIT_MS / 1000, Math.max(0, left));
}

/**
 * What the hidden code field holds: its digits only, at most six. Paste and
 * autofill may bring spaces or a dash; whether the code is right is
 * `LoginOtp`'s job.
 */
export function codeDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

/** The last code sent: to which email, and when. */
export type LastSend = { email: string; at: number };

/**
 * Whether C01's "Email me a code" sends again. The same email inside the
 * wait goes straight to C14, where the code already sent still works, so
 * coming back to C01 never restarts the countdown (#155, S2).
 */
export function needsSend(email: string, last: LastSend | null, now: number): boolean {
  return !(last && last.email === email && secondsLeft(last.at, now) > 0);
}

/** A problem shown under the email on C01, or on C14. `offline` is no answer at all. */
export type Problem = ErrorCode | "offline";

/** What happened to a send: sent, or the problem to show. */
export function sendOutcome(answer: ApiResult<undefined> | "offline"): Problem | null {
  if (answer === "offline") return "offline";
  return answer.ok ? null : answer.code;
}

/**
 * What C14 does with a checked code (#155, Q8):
 * - `signed-in`: the account the server answered.
 * - otherwise the problem, and whether the boxes stay open for typing.
 *   A wrong code, a server fault and no answer empty the boxes for another
 *   try. An expired code leaves only "Send a new code", and a locked email
 *   disables the boxes; both keep the boxes shut until a new code is sent.
 */
export type CheckOutcome =
  | { signedIn: Account }
  | { problem: Problem; boxesOpen: boolean };

export function checkOutcome(answer: ApiResult<Account> | "offline"): CheckOutcome {
  if (answer === "offline") return { problem: "offline", boxesOpen: true };
  if (answer.ok) return { signedIn: answer.data };
  const shut = answer.code === "CODE_EXPIRED" || answer.code === "CODE_LOCKED";
  return { problem: answer.code, boxesOpen: !shut };
}

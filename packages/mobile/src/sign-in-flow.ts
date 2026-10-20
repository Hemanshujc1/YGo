import type { ApiResult } from "@ygo/api-client";
import { type Account, type ErrorCode, LoginOtp } from "@ygo/contracts";

/** How long "Send a new code" waits after a send: the server's own gap between two codes to one email. */
export const RESEND_WAIT_MS = 30_000;

/** How many boxes C14 shows: the emailed code's digits. */
export const CODE_LENGTH = 6;

/**
 * A reading of two clocks. `wall` is the phone's clock: it runs while the
 * phone sleeps, but the person can set it back or forward. `steady` only runs
 * forward and can't be set, but may stop while the phone sleeps. It starts
 * again with each app start, so a moment is compared only with another from
 * the same run (the sends are kept in memory, never saved).
 */
export type Moment = { wall: number; steady: number };

/** Now, on both clocks. */
export function moment(): Moment {
  return { wall: Date.now(), steady: performance.now() };
}

/**
 * Seconds until "Send a new code" works, from the moment of the last send
 * (#155, S2). It is worked out from the clocks each time, so leaving the app
 * or the screen and coming back shows the time really left. The time passed
 * is the longer of the two clocks: setting the phone's clock back can't hold
 * the wait open, and a sleep the steady clock missed still counts.
 */
export function secondsLeft(sentAt: Moment | null, now: Moment): number {
  if (sentAt === null) return 0;
  const passed = Math.max(now.wall - sentAt.wall, now.steady - sentAt.steady);
  const left = Math.ceil((RESEND_WAIT_MS - passed) / 1000);
  return Math.min(RESEND_WAIT_MS / 1000, Math.max(0, left));
}

/**
 * What the hidden code field keeps of what is typed or pasted: its digits,
 * one per box. Paste and autofill may bring a space or a dash. A whole code
 * added after digits already typed (iOS fills the code in after them)
 * replaces them, and only the first code of an autofill that came twice is
 * kept. It decides nothing: `wholeCode` does.
 */
export function codeDigits(text: string, before = ""): string {
  const all = text.replace(/\D/g, "");
  const added = all.startsWith(before) ? all.slice(before.length) : all;
  return (added.length >= CODE_LENGTH ? added : all).slice(0, CODE_LENGTH);
}

/** The code to check, once the boxes hold one `LoginOtp` accepts; null until then. */
export function wholeCode(digits: string): string | null {
  const code = LoginOtp.safeParse(digits);
  return code.success ? code.data : null;
}

/** The last code sent to one email: when, and whether it is spent (expired, locked, or used by a sign-in this phone could not keep). */
export type Sent = { at: Moment; shut: boolean };

/**
 * The last code sent to each email since the last sign-in, by the checked
 * email. The server's 30-second gap is per email, so each email keeps its
 * own countdown and shut boxes: A, then B, then A again inside A's wait goes
 * straight back to A's code.
 */
export type Sends = ReadonlyMap<string, Sent>;

/** The sends once a new code went to `email` at `at`; its boxes are open. */
export function withSend(sends: Sends, email: string, at: Moment): Sends {
  return new Map(sends).set(email, { at, shut: false });
}

/** The sends once `email`'s code is spent. */
export function withShut(sends: Sends, email: string): Sends {
  const sent = sends.get(email);
  return sent ? new Map(sends).set(email, { ...sent, shut: true }) : sends;
}

/**
 * Whether C01's "Email me a code" sends again. An email inside its own wait
 * goes straight to C14, where the code already sent still works, so coming
 * back to C01 never restarts the countdown (#155, S2).
 */
export function needsSend(email: string, sends: Sends, now: Moment): boolean {
  const sent = sends.get(email);
  return !(sent && secondsLeft(sent.at, now) > 0);
}

/**
 * A problem shown under the email on C01, or on C14. `offline` is no answer
 * at all; `not-saved` is a sign-in the server accepted but this phone could
 * not keep, so its code is spent.
 */
export type Problem = ErrorCode | "offline" | "not-saved";

/**
 * What `sessionStore` rejects with when it can't save a sign-in, so C14 tells
 * it apart from no answer without guessing from the error's type.
 */
export class SessionNotSaved extends Error {
  constructor(cause: unknown) {
    super("The session could not be saved", { cause });
    this.name = "SessionNotSaved";
  }
}

/**
 * Which problem a call that rejected is: the store refusing to save the
 * session, or else no answer (no network, a timeout). Read by name, which
 * holds even where a subclass of Error loses `instanceof`.
 */
export function rejected(error: unknown): "offline" | "not-saved" {
  return error instanceof Error && error.name === "SessionNotSaved" ? "not-saved" : "offline";
}

/** Whether a problem is about what was typed, so its field shows a red edge. Others (no answer, a server fault) are not. */
export function aboutField(problem: Problem): boolean {
  return (
    problem === "VALIDATION_FAILED" || problem === "CODE_WRONG" || problem === "CODE_EXPIRED" || problem === "CODE_LOCKED"
  );
}

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
 *   disables the boxes; both keep the boxes shut until a new code is sent,
 *   and so does a sign-in this phone could not keep, whose code is spent.
 */
export type CheckOutcome =
  | { signedIn: Account }
  | { problem: Problem; boxesOpen: boolean };

export function checkOutcome(answer: ApiResult<Account> | "offline" | "not-saved"): CheckOutcome {
  if (answer === "offline") return { problem: "offline", boxesOpen: true };
  if (answer === "not-saved") return { problem: "not-saved", boxesOpen: false };
  if (answer.ok) return { signedIn: answer.data };
  const shut = answer.code === "CODE_EXPIRED" || answer.code === "CODE_LOCKED";
  return { problem: answer.code, boxesOpen: !shut };
}

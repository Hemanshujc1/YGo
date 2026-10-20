import type { ErrorCode } from "@ygo/contracts";
import type { Problem } from "./sign-in-flow";

/** Every word C01 and C14 show, from the app's `strings.ts`: the package holds none (ADR-0009). */
export type SignInWords = {
  /** C01: the app's name, an optional heading under it, and one line on what the app is for. */
  title: string;
  heading?: string;
  lead: string;
  emailLabel: string;
  /** Under the email when `Email` refuses it. */
  emailInvalid: string;
  /** "Email me a code". */
  send: string;
  /** Before the support email: "Help:". */
  help: string;
  code: {
    /** "Check your email". */
    title: string;
    /** "We sent a 6-digit code to {email}. Enter it here to sign in." */
    sentTo: (email: string) => string;
    /** The boxes' label, "Code", also read by screen readers. */
    label: string;
    /** "Checking code". */
    checking: string;
    /** "Send a new code", and the same while it waits: "Send a new code in 0:25". */
    resend: string;
    resendIn: (seconds: number) => string;
    /** "Use a different email". */
    otherEmail: string;
    /** "Not in your inbox? Look in spam or promotions." */
    spam: string;
  };
  /** When no answer came back: one for a send, one for a code being checked. */
  offline: { send: string; check: string };
  /** The app's words for each code the server answers. */
  errors: Record<ErrorCode, string>;
};

/** The words for a problem; no answer reads differently for a send and for a check. */
export function problemWords(words: SignInWords, problem: Problem, during: "send" | "check"): string {
  return problem === "offline" ? words.offline[during] : words.errors[problem];
}

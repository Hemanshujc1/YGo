import type { ErrorCode } from "@ygo/contracts";

// Every string the app shows lives here, so translation is a later pass over
// one file (CONTEXT.md: every string externalised from day one).
export const strings = {
  title: "YGo Admin",
  health: "Server health",
  checking: "Checking…",
  ok: "ok",
  unreachable: "The server cannot be reached.",
  notFound: "This page does not exist.",
  failed: "Something went wrong on this page.",
  // The server sends a machine code, never words (ADR-0004). @ygo/api-client
  // already turns a code it does not know into INTERNAL.
  errors: {
    VALIDATION_FAILED: "The server did not accept the request.",
    NOT_FOUND: "The server does not know this request.",
    UNAVAILABLE: "The server is running, but a service it needs is not answering.",
    INTERNAL: "Something went wrong on the server.",
    UPDATE_REQUIRED: "This page is out of date. Reload it to continue.",
    UNAUTHENTICATED: "Sign in to continue.",
    PROFILE_REQUIRED: "Add your name and phone number to continue.",
    CODE_WRONG: "That code is not right. Check the email and try again.",
    CODE_EXPIRED: "That code has expired. Ask for a new one.",
    CODE_LOCKED: "Too many wrong codes. Try again in 15 minutes.",
    TOO_MANY_REQUESTS: "Too many tries. Wait a little and try again.",
    PHONE_IN_USE: "Another account already uses this phone number. Contact support for help.",
    EMAIL_IN_USE: "Another account already uses this email address.",
    FORBIDDEN: "This account is not allowed to do that.",
  } satisfies Record<ErrorCode, string>,
};

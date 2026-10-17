import type { ErrorCode } from "@ygo/contracts";

// Every string the app shows lives here, so translation is a later pass over
// one file (CONTEXT.md: every string externalised from day one).
export const strings = {
  title: "YGo Shopkeeper",
  health: "Server health",
  checking: "Checking…",
  ok: "ok",
  unreachable: "The server cannot be reached.",
  // The server sends a machine code, never words (ADR-0004). @ygo/api-client
  // already turns a code it does not know into INTERNAL.
  errors: {
    VALIDATION_FAILED: "The server did not accept the request.",
    NOT_FOUND: "The server does not know this request.",
    UNAVAILABLE: "The server is running, but a service it needs is not answering.",
    INTERNAL: "Something went wrong on the server.",
    UPDATE_REQUIRED: "This version of YGo is too old. Update the app to continue.",
  } satisfies Record<ErrorCode, string>,
};

import type { Account } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import {
  aboutField,
  checkOutcome,
  codeDigits,
  needsSend,
  rejected,
  secondsLeft,
  sendOutcome,
  wholeCode,
} from "../src/sign-in-flow";

const sent = 1_000_000;
const account: Account = { id: "6f1c1d1e-0000-4000-8000-000000000001", email: "asha@example.com", name: null, phone: null };

describe("secondsLeft", () => {
  it("counts down 30 seconds from the send", () => {
    expect(secondsLeft(sent, sent)).toBe(30);
    expect(secondsLeft(sent, sent + 1)).toBe(30);
    expect(secondsLeft(sent, sent + 29_001)).toBe(1);
    expect(secondsLeft(sent, sent + 30_000)).toBe(0);
  });

  it("shows the time really left after the app was away, never 30 again", () => {
    expect(secondsLeft(sent, sent + 22_400)).toBe(8);
    expect(secondsLeft(sent, sent + 10 * 60_000)).toBe(0);
  });

  it("never waits longer than 30 seconds when the clock was set back", () => {
    expect(secondsLeft(sent, sent - 60_000)).toBe(30);
  });

  it("is ready when nothing was sent", () => {
    expect(secondsLeft(null, sent)).toBe(0);
  });
});

describe("codeDigits", () => {
  it.each([
    ["280419", "280419"],
    ["280 419", "280419"],
    ["280-419", "280419"],
    [" 2804190 ", "280419"],
    ["28a", "28"],
    ["", ""],
  ])("keeps the digits of %j", (typed, kept) => {
    expect(codeDigits(typed)).toBe(kept);
  });
});

describe("wholeCode", () => {
  it("is the code once all six boxes are full", () => {
    expect(wholeCode("280419")).toBe("280419");
  });

  it.each(["", "28041", "28a419"])("is nothing yet for %j", (digits) => {
    expect(wholeCode(digits)).toBeNull();
  });
});

describe("needsSend", () => {
  const last = { email: "asha@example.com", at: sent };

  it("sends the first time", () => {
    expect(needsSend("asha@example.com", null, sent)).toBe(true);
  });

  it("goes straight to the code for the same email inside the wait", () => {
    expect(needsSend("asha@example.com", last, sent + 5_000)).toBe(false);
  });

  it("sends to the same email once the wait is over", () => {
    expect(needsSend("asha@example.com", last, sent + 30_000)).toBe(true);
  });

  it("sends to a different email at once", () => {
    expect(needsSend("ravi@example.com", last, sent + 5_000)).toBe(true);
  });
});

describe("sendOutcome", () => {
  it.each([
    [{ ok: true, data: undefined }, null],
    [{ ok: false, status: 429, code: "TOO_MANY_REQUESTS" }, "TOO_MANY_REQUESTS"],
    [{ ok: false, status: 429, code: "CODE_LOCKED" }, "CODE_LOCKED"],
    [{ ok: false, status: 503, code: "UNAVAILABLE" }, "UNAVAILABLE"],
    ["offline", "offline"],
  ] as const)("%j shows %j", (answer, problem) => {
    expect(sendOutcome(answer)).toBe(problem);
  });
});

describe("checkOutcome", () => {
  it("signs in with the account the server answered", () => {
    expect(checkOutcome({ ok: true, data: account })).toEqual({ signedIn: account });
  });

  it.each([
    ["CODE_WRONG", true],
    ["INTERNAL", true],
    ["UNAVAILABLE", true],
    ["CODE_EXPIRED", false],
    ["CODE_LOCKED", false],
  ] as const)("%s leaves the boxes open: %s", (code, boxesOpen) => {
    expect(checkOutcome({ ok: false, status: 400, code })).toEqual({ problem: code, boxesOpen });
  });

  it("lets the person try again when no answer came", () => {
    expect(checkOutcome("offline")).toEqual({ problem: "offline", boxesOpen: true });
  });

  it("shuts the boxes when this phone could not keep the sign-in: the code is spent", () => {
    expect(checkOutcome("not-saved")).toEqual({ problem: "not-saved", boxesOpen: false });
  });
});

describe("rejected", () => {
  it.each([
    ["no network", new TypeError("Network request failed"), "offline"],
    ["a timeout", new DOMException("timed out", "TimeoutError"), "offline"],
    ["an abort", new DOMException("aborted", "AbortError"), "offline"],
    ["the store refusing to save", new Error("Keychain write failed"), "not-saved"],
  ])("reads %s as %s", (_, error, problem) => {
    expect(rejected(error)).toBe(problem);
  });
});

describe("aboutField", () => {
  it.each(["VALIDATION_FAILED", "CODE_WRONG", "CODE_EXPIRED", "CODE_LOCKED"] as const)("marks the field for %s", (problem) => {
    expect(aboutField(problem)).toBe(true);
  });

  it.each(["offline", "not-saved", "INTERNAL", "UNAVAILABLE", "TOO_MANY_REQUESTS"] as const)(
    "leaves the field alone for %s",
    (problem) => {
      expect(aboutField(problem)).toBe(false);
    },
  );
});

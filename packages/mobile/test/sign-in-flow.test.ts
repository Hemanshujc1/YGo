import type { Account } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import {
  aboutField,
  checkOutcome,
  codeDigits,
  needsSend,
  rejected,
  secondsLeft,
  SessionNotSaved,
  sendOutcome,
  wholeCode,
} from "../src/sign-in-flow";

const sent = { wall: 1_000_000, steady: 5_000 };
/** `ms` later on both clocks. */
const after = (ms: number) => ({ wall: sent.wall + ms, steady: sent.steady + ms });
const account: Account = { id: "6f1c1d1e-0000-4000-8000-000000000001", email: "asha@example.com", name: null, phone: null };

describe("secondsLeft", () => {
  it("counts down 30 seconds from the send", () => {
    expect(secondsLeft(sent, sent)).toBe(30);
    expect(secondsLeft(sent, after(1))).toBe(30);
    expect(secondsLeft(sent, after(29_001))).toBe(1);
    expect(secondsLeft(sent, after(30_000))).toBe(0);
  });

  it("shows the time really left after the app was away, never 30 again", () => {
    expect(secondsLeft(sent, after(22_400))).toBe(8);
    expect(secondsLeft(sent, after(10 * 60_000))).toBe(0);
  });

  it("ends after 30 running seconds even when the phone's clock was set back", () => {
    const setBack = (ms: number) => ({ wall: sent.wall - 60 * 60_000 + ms, steady: sent.steady + ms });
    expect(secondsLeft(sent, setBack(0))).toBe(30);
    expect(secondsLeft(sent, setBack(12_000))).toBe(18);
    expect(secondsLeft(sent, setBack(30_000))).toBe(0);
  });

  it("counts a sleep the steady clock missed", () => {
    expect(secondsLeft(sent, { wall: sent.wall + 40_000, steady: sent.steady + 2_000 })).toBe(0);
  });

  it("ends early when the phone's clock was set forward: the server still refuses a send too soon", () => {
    expect(secondsLeft(sent, { wall: sent.wall + 60 * 60_000, steady: sent.steady + 3_000 })).toBe(0);
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

  it("adds a typed digit to those before it", () => {
    expect(codeDigits("2804", "280")).toBe("2804");
  });

  it("drops a deleted digit", () => {
    expect(codeDigits("28", "280")).toBe("28");
  });

  it("takes a whole code filled in after digits already typed", () => {
    expect(codeDigits("1280419", "1")).toBe("280419");
    expect(codeDigits("28280419", "28")).toBe("280419");
  });

  it("keeps the first code of an autofill that came twice", () => {
    expect(codeDigits("280419280419")).toBe("280419");
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
    expect(needsSend("asha@example.com", last, after(5_000))).toBe(false);
  });

  it("sends to the same email once the wait is over", () => {
    expect(needsSend("asha@example.com", last, after(30_000))).toBe(true);
  });

  it("sends to a different email at once", () => {
    expect(needsSend("ravi@example.com", last, after(5_000))).toBe(true);
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
    ["any other failure of the call", new Error("Unexpected end of stream"), "offline"],
    ["something thrown that is no Error", "boom", "offline"],
    ["the store refusing to save", new SessionNotSaved(new Error("Keychain write failed")), "not-saved"],
  ])("reads %s as %s", (_, error, problem) => {
    expect(rejected(error)).toBe(problem);
  });

  it("keeps the store's own error as the cause", () => {
    const cause = new Error("Keychain write failed");
    expect(new SessionNotSaved(cause).cause).toBe(cause);
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

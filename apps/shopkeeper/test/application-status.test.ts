import { describe, expect, it } from "vitest";
import { steps, waiting } from "../src/lib/application-status";
import { strings } from "../src/strings";

const marks = (state: Parameters<typeof steps>[0]) => steps(state).map(({ step, mark }) => `${step}:${mark}`);

describe("steps", () => {
  it("lists the five steps in order", () => {
    expect(steps("submitted").map(({ step }) => step)).toEqual(["draft", "submitted", "under_review", "approved", "live"]);
  });

  it("marks Draft done and Submitted current once sent", () => {
    expect(marks("submitted")).toEqual(["draft:done", "submitted:current", "under_review:later", "approved:later", "live:later"]);
  });

  it("marks Under review current while Admin checks", () => {
    expect(marks("under_review")).toEqual(["draft:done", "submitted:done", "under_review:current", "approved:later", "live:later"]);
  });

  it("leaves Live still to come once Approved", () => {
    expect(marks("approved")).toEqual(["draft:done", "submitted:done", "under_review:done", "approved:current", "live:later"]);
  });

  it("marks every step done once Live (#363)", () => {
    expect(marks("live")).toEqual(["draft:done", "submitted:done", "under_review:done", "approved:done", "live:done"]);
  });
});

describe("waiting (#363)", () => {
  it("words each blocker in the server's order, with acceptance as the Owner's own step", () => {
    expect(waiting({ blockers: ["visit", "fee", "rate_card", "agreement"], rateCardMissing: ["commission"] })).toEqual([
      { blocker: "visit", line: strings.shopSetup.waiting.blockers.visit, own: false },
      { blocker: "fee", line: strings.shopSetup.waiting.blockers.fee, own: false },
      { blocker: "rate_card", line: strings.shopSetup.waiting.blockers.rate_card, own: false },
      { blocker: "agreement", line: strings.shopSetup.waiting.blockers.agreement, own: true },
    ]);
  });

  it("is empty once nothing blocks Live", () => {
    expect(waiting({ blockers: [], rateCardMissing: [] })).toEqual([]);
  });
});

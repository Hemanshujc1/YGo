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
  it("words each blocker in the server's order, with hours and acceptance as the Owner's own steps", () => {
    expect(waiting({ blockers: ["visit", "fee", "rate_card", "hours", "agreement"], rateCardMissing: ["commission"] })).toEqual([
      { blocker: "visit", line: strings.shopSetup.waiting.blockers.visit, href: null },
      { blocker: "fee", line: strings.shopSetup.waiting.blockers.fee, href: null },
      { blocker: "rate_card", line: strings.shopSetup.waiting.blockers.rate_card, href: null },
      { blocker: "hours", line: strings.shopSetup.waiting.blockers.hours, href: "/hours" },
      { blocker: "agreement", line: strings.shopSetup.waiting.blockers.agreement, href: "/agreement" },
    ]);
  });

  it("is empty once nothing blocks Live", () => {
    expect(waiting({ blockers: [], rateCardMissing: [] })).toEqual([]);
  });
});

it("keeps completed onboarding steps done for a suspended shop", () => {
  expect(marks("suspended")).toEqual(marks("live"));
});

it("keeps historical onboarding steps complete for a closed shop", () => {
  expect(marks("closed")).toEqual(marks("live"));
});

import { describe, expect, it } from "vitest";
import { steps } from "../src/lib/application-status";

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
});

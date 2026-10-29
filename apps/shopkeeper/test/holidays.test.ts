import { describe, expect, it } from "vitest";
import { dateChoices, dateOf, editDraft, pickFrom } from "../src/lib/holidays";

describe("holidays form (#382)", () => {
  it("offers each date from the first one up to 180 days after today", () => {
    const choices = dateChoices("2030-01-01", "2030-01-01");
    expect(choices).toHaveLength(181);
    expect([choices[0], choices[1], choices.at(-1)].map((at) => dateOf(at ?? 0))).toEqual(["2030-01-01", "2030-01-02", "2030-06-30"]);
    expect(dateChoices("2030-06-30", "2030-01-01").map(dateOf)).toEqual(["2030-06-30"]);
  });

  it("starts To at today for a started holiday, and at its From for a future one", () => {
    expect(dateOf(dateChoices("2029-12-28", "2030-01-01")[0] ?? 0)).toBe("2030-01-01");
    expect(dateOf(dateChoices("2030-01-05", "2030-01-01")[0] ?? 0)).toBe("2030-01-05");
  });

  it("locks the From date of a holiday starting today or earlier, not of a later one", () => {
    const holiday = { id: "h", starts: "2030-01-01", ends: "2030-01-03" };
    expect(editDraft(holiday, "2030-01-01").started).toBe(true);
    expect(editDraft(holiday, "2030-01-02").started).toBe(true);
    expect(editDraft(holiday, "2029-12-31").started).toBe(false);
  });

  it("moves To along when From passes it, and keeps a later To", () => {
    const draft = { starts: "2030-01-01", ends: "2030-01-03", started: false };
    expect(pickFrom(draft, "2030-01-05")).toEqual({ ...draft, starts: "2030-01-05", ends: "2030-01-05" });
    expect(pickFrom(draft, "2030-01-02")).toEqual({ ...draft, starts: "2030-01-02" });
  });
});

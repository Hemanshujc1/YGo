import { describe, expect, it } from "vitest";
import { dateChoices, dateOf, pickFrom } from "../src/lib/holidays";

describe("holidays form (#382)", () => {
  it("offers each date from the first one up to 180 days after today", () => {
    const choices = dateChoices("2030-01-01", "2030-01-01");
    expect(choices).toHaveLength(181);
    expect([choices[0], choices[1], choices.at(-1)].map((at) => dateOf(at ?? 0))).toEqual(["2030-01-01", "2030-01-02", "2030-06-30"]);
    expect(dateChoices("2030-06-30", "2030-01-01").map(dateOf)).toEqual(["2030-06-30"]);
  });

  it("moves To along when From passes it, and keeps a later To", () => {
    const draft = { starts: "2030-01-01", ends: "2030-01-03", started: false };
    expect(pickFrom(draft, "2030-01-05")).toEqual({ ...draft, starts: "2030-01-05", ends: "2030-01-05" });
    expect(pickFrom(draft, "2030-01-02")).toEqual({ ...draft, starts: "2030-01-02" });
  });
});

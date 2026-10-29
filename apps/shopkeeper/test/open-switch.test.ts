import { describe, expect, it } from "vitest";
import { settle, untilChoices, when } from "../src/lib/open-switch";

/** A time in India. 1 Jan 2030 is a Tuesday. */
const ist = (local: string) => Date.parse(`${local}+05:30`);
const saved = { open: false, until: "2030-01-02T03:30:00.000Z", setByOwner: false, scheduledOpen: false, nextOpening: "2030-01-02T03:30:00.000Z" };

describe("open/closed switch (#380)", () => {
  it("offers each half hour after now up to and including the next opening", () => {
    const choices = untilChoices(ist("2030-01-01T22:10:00"), new Date(ist("2030-01-02T01:00:00")).toISOString());
    expect(choices).toEqual(["22:30", "23:00", "23:30"].map((time) => ist(`2030-01-01T${time}:00`))
      .concat(["00:00", "00:30", "01:00"].map((time) => ist(`2030-01-02T${time}:00`))));
    expect(untilChoices(ist("2030-01-01T22:00:00"), new Date(ist("2030-01-01T22:30:00")).toISOString())).toEqual([ist("2030-01-01T22:30:00")]);
  });

  it("says when in India: a time today, tomorrow, or a weekday further on", () => {
    const now = ist("2030-01-01T23:00:00");
    expect(when(ist("2030-01-01T23:30:00"), now, "tomorrow")).toBe("11:30 PM");
    expect(when(new Date(ist("2030-01-02T09:00:00")).toISOString(), now, "tomorrow")).toBe("tomorrow 9:00 AM");
    expect(when(ist("2030-01-03T09:00:00"), now, "tomorrow")).toBe("Thu 9:00 AM");
  });

  it("takes the server's answer after a save, and moves back to the last saved position when it fails", () => {
    const opened = { ...saved, open: true, setByOwner: true, until: "2030-01-01T16:30:00.000Z" };
    expect(settle(saved, { ok: true, data: opened })).toEqual({ saved: opened, failed: false });
    expect(settle(saved, { ok: false, status: 409, code: "SHOP_NOT_LIVE" })).toEqual({ saved, failed: true });
    expect(settle(saved, null)).toEqual({ saved, failed: true });
  });
});

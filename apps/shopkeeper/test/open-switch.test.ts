import { describe, expect, it } from "vitest";
import { settle, untilChoices } from "../src/lib/open-switch";

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

  it("takes the server's answer after a save, and moves back to the last saved position when it fails", () => {
    const opened = { ...saved, open: true, setByOwner: true, until: "2030-01-01T16:30:00.000Z" };
    expect(settle(saved, { ok: true, data: opened })).toEqual({ saved: opened, failed: false });
    expect(settle(saved, { ok: false, status: 409, code: "SHOP_NOT_LIVE" })).toEqual({ saved, failed: true });
    expect(settle(saved, null)).toEqual({ saved, failed: true });
  });
});

import { describe, expect, it } from "vitest";
import { canAdd, copyToAll, nextOpening, TIMES, toRanges, toWeek } from "../src/lib/hours";

describe("opening hours form (#371)", () => {
  it("offers every half hour of the day", () => {
    expect(TIMES).toHaveLength(48);
    expect([TIMES[0], TIMES[1], TIMES.at(-1)]).toEqual([0, 30, 1410]);
  });

  it("turns the server's ranges into a Monday-first week and back", () => {
    const ranges = [{ weekday: 1, opens: 540, closes: 780 }, { weekday: 1, opens: 960, closes: 1320 }, { weekday: 7, opens: 1320, closes: 120 }];
    const week = toWeek(ranges);
    expect(week).toEqual([[{ opens: 540, closes: 780 }, { opens: 960, closes: 1320 }], [], [], [], [], [], [{ opens: 1320, closes: 120 }]]);
    expect(toRanges(week)).toEqual(ranges);
  });

  it("starts a closed day at 9:00 AM – 9:00 PM and a later opening two hours from the last close, past midnight too", () => {
    expect(nextOpening([])).toEqual({ opens: 540, closes: 1260 });
    expect(nextOpening([{ opens: 540, closes: 780 }])).toEqual({ opens: 780, closes: 900 });
    expect(nextOpening([{ opens: 1080, closes: 1380 }])).toEqual({ opens: 1380, closes: 60 });
  });

  it("stops at 3 openings a day", () => {
    expect(canAdd([{ opens: 0, closes: 60 }, { opens: 120, closes: 180 }])).toBe(true);
    expect(canAdd([{ opens: 0, closes: 60 }, { opens: 120, closes: 180 }, { opens: 240, closes: 300 }])).toBe(false);
  });

  it("copies one day's openings to every day, closing days when it is closed", () => {
    const week = toWeek([{ weekday: 2, opens: 540, closes: 1260 }, { weekday: 5, opens: 600, closes: 660 }]);
    expect(copyToAll(week, 1)).toEqual(Array.from({ length: 7 }, () => [{ opens: 540, closes: 1260 }]));
    expect(copyToAll(week, 0)).toEqual(Array.from({ length: 7 }, () => []));
  });
});

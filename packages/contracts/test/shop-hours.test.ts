import { describe, expect, it } from "vitest";
import { overlappingDays, rangeLength, ShopHours, type ShopHoursRange } from "../src/index";

const range = (weekday: number, opens: number, closes: number): ShopHoursRange => ({ weekday, opens, closes });
const h = (hours: number) => hours * 60;

describe("shop hours (#371)", () => {
  it("runs a close at or before the open into the next day, and 12:00 AM – 12:00 AM is 24 hours", () => {
    expect(rangeLength(range(1, h(9), h(21)))).toBe(h(12));
    expect(rangeLength(range(1, h(22), h(2)))).toBe(h(4));
    expect(rangeLength(range(1, 0, 0))).toBe(h(24));
    expect(rangeLength(range(1, h(9), h(9)))).toBe(h(24));
  });

  it("allows touching ranges and finds overlaps within a day, across midnight and from Sunday into Monday", () => {
    expect(overlappingDays([range(1, h(9), h(13)), range(1, h(13), h(17)), range(1, h(22), h(2)), range(2, h(2), h(6))])).toEqual([]);
    expect(overlappingDays([range(1, h(9), h(13)), range(1, h(12), h(17))])).toEqual([1]);
    expect(overlappingDays([range(3, h(22), h(3)), range(4, h(2), h(10))])).toEqual([3]);
    expect(overlappingDays([range(7, h(20), h(1)), range(1, 0, h(9))])).toEqual([7]);
    expect(overlappingDays([range(1, 0, 0), range(2, 0, 0)])).toEqual([]);
    expect(overlappingDays([range(1, h(9), h(12)), range(1, h(9), h(12))])).toEqual([1]);
    // One range a week that runs 24 hours never meets itself.
    expect(overlappingDays([range(5, h(6), h(6))])).toEqual([]);
  });

  it("takes up to 3 ranges a day in 30-minute steps, and at least one in the week", () => {
    expect(ShopHours.safeParse({ ranges: [range(1, h(6), h(9)), range(1, h(10), h(13)), range(1, h(16), h(22))] }).success).toBe(true);
    expect(ShopHours.safeParse({ ranges: [range(1, 0, h(1)), range(1, h(2), h(3)), range(1, h(4), h(5)), range(1, h(6), h(7))] }).success).toBe(false);
    expect(ShopHours.safeParse({ ranges: [range(1, h(9) + 15, h(12))] }).success).toBe(false);
    expect(ShopHours.safeParse({ ranges: [range(1, h(9), h(24))] }).success).toBe(false);
    expect(ShopHours.safeParse({ ranges: [range(8, h(9), h(12))] }).success).toBe(false);
    expect(ShopHours.safeParse({ ranges: [range(1, h(9), h(13)), range(1, h(12), h(17))] }).success).toBe(false);
    expect(ShopHours.safeParse({ ranges: [] }).success).toBe(false);
  });
});

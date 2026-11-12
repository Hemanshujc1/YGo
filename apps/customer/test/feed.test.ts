import { describe, expect, it } from "vitest";
import { feedQuery, termsLine } from "../src/lib/feed";
import { strings } from "../src/strings";

describe("feedQuery (#369)", () => {
  it("asks with the pincode and the pin", () => {
    expect(feedQuery({ pincode: "411038", name: "Kothrud", point: { latitude: 18.5, longitude: 73.8 } }))
      .toEqual({ pincode: "411038", latitude: 18.5, longitude: 73.8 });
  });

  it("has no query for a place kept without a pin, so Home asks for one", () => {
    expect(feedQuery({ pincode: "411045", name: "Baner" })).toBeNull();
  });
});

describe("termsLine (#597)", () => {
  const card = { estimatedMinutes: 15, deliveryFee: "30" };
  it("shows delivery while the shop delivers, pickup only without it, and no orders when nothing is open", () => {
    expect(termsLine({ ...card, delivers: true, pickup: true })).toBe("About 15 min · Delivery ₹30");
    expect(termsLine({ ...card, delivers: false, pickup: true })).toBe(strings.feed.pickupOnly);
    expect(termsLine({ ...card, delivers: false, pickup: false })).toBe(strings.feed.notTaking);
  });
});

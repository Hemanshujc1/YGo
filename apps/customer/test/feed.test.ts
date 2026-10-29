import { describe, expect, it } from "vitest";
import { feedQuery } from "../src/lib/feed";

describe("feedQuery (#369)", () => {
  it("asks with the pincode and the pin", () => {
    expect(feedQuery({ pincode: "411038", name: "Kothrud", point: { latitude: 18.5, longitude: 73.8 } }))
      .toEqual({ pincode: "411038", latitude: 18.5, longitude: 73.8 });
  });

  it("has no query for a place kept without a pin, so Home asks for one", () => {
    expect(feedQuery({ pincode: "411045", name: "Baner" })).toBeNull();
  });
});

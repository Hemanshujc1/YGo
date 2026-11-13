import { describe, expect, it } from "vitest";
import { RateOrderBody, RateOrderResponse } from "../src/index";

describe("rating contracts (TRU-1, #82)", () => {
  it("accepts integers from 1 to 5 for RateOrderBody", () => {
    for (let stars = 1; stars <= 5; stars++) {
      expect(RateOrderBody.safeParse({ stars }).success).toBe(true);
    }
    expect(RateOrderBody.safeParse({ stars: 0 }).success).toBe(false);
    expect(RateOrderBody.safeParse({ stars: 6 }).success).toBe(false);
    expect(RateOrderBody.safeParse({ stars: 4.5 }).success).toBe(false);
    expect(RateOrderBody.safeParse({ stars: "5" }).success).toBe(false);
    expect(RateOrderBody.safeParse({}).success).toBe(false);
  });

  it("validates RateOrderResponse", () => {
    expect(RateOrderResponse.safeParse({ stars: 5 }).success).toBe(true);
    expect(RateOrderResponse.safeParse({ stars: 0 }).success).toBe(false);
  });
});


import { describe, expect, it } from "vitest";
import { money } from "../src/lib/money";

describe("money (#475)", () => {
  it("shows the largest counter bill exactly, which a JS number would round", () => {
    expect(money("9998999999990001")).toBe("₹9,99,89,99,99,99,90,001");
    expect(money("60.00")).toBe("₹60");
  });
});

import { describe, expect, it } from "vitest";
import { fromPaise, toPaise } from "../src/paise";

describe("paise", () => {
  it("reads rupees as paise", () => {
    expect(toPaise("12.5")).toBe(1250n);
    expect(toPaise("0.05")).toBe(5n);
    expect(toPaise("7")).toBe(700n);
    expect(toPaise("-12.50")).toBe(-1250n);
  });

  it("writes paise as rupees with two decimals", () => {
    expect(fromPaise(1250n)).toBe("12.50");
    expect(fromPaise(5n)).toBe("0.05");
    expect(fromPaise(-1250n)).toBe("-12.50");
    expect(fromPaise(0n)).toBe("0.00");
  });
});

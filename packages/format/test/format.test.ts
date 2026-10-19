import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatTime } from "../src/index";

function expectIndianFormats() {
  it("groups numbers the Indian way", () => {
    expect(formatNumber(125_000)).toBe("1,25,000");
    expect(formatNumber(1_234.5)).toBe("1,234.5");
  });

  it("shows every money amount as rupees with two decimals", () => {
    expect(formatMoney(125_000)).toBe("₹1,25,000.00");
    expect(formatMoney(20.5)).toBe("₹20.50");
    expect(formatMoney(-20)).toBe("−₹20.00");
  });

  it("shows dates and 12-hour times in India", () => {
    const instant = "2026-10-13T20:35:00.000Z";
    expect(formatDate(instant)).toBe("14/10/2026");
    expect(formatTime(instant)).toBe("2:05 AM");
    expect(formatDateTime(instant)).toBe("14/10/2026, 2:05 AM");
  });
}

describe("Indian display formats", expectIndianFormats);

// Hermes on iOS has no NumberFormat.formatToParts, and calling it crashed the app.
describe("Indian display formats without formatToParts", () => {
  const prototypes = [Intl.NumberFormat.prototype, Intl.DateTimeFormat.prototype];
  const originals = prototypes.map((prototype) => prototype.formatToParts);

  beforeAll(() => {
    for (const prototype of prototypes) {
      Object.defineProperty(prototype, "formatToParts", { value: undefined, configurable: true });
    }
  });

  afterAll(() => {
    prototypes.forEach((prototype, i) => {
      Object.defineProperty(prototype, "formatToParts", { value: originals[i], configurable: true });
    });
  });

  expectIndianFormats();
});

// Android's Intl writes "₹ 1,25,000.00", with a no-break space after the sign.
describe("Indian display formats with Android's space after ₹", () => {
  type Format = (value: number | bigint) => string;
  const original = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, "format") as PropertyDescriptor;
  const originalGet = original.get as (this: Intl.NumberFormat) => Format;

  beforeAll(() => {
    Object.defineProperty(Intl.NumberFormat.prototype, "format", {
      configurable: true,
      get(this: Intl.NumberFormat) {
        const format = originalGet.call(this);
        return ((value) => format(value).replace("₹", "₹ ")) satisfies Format;
      },
    });
  });

  afterAll(() => {
    Object.defineProperty(Intl.NumberFormat.prototype, "format", original);
  });

  expectIndianFormats();
});

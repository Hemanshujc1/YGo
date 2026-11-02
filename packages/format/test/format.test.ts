import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDayMonth, formatDayMonthYear, formatDayTime, formatMinuteOfDay, formatMoney, formatNumber, trimDecimal, formatPhone, formatTime, formatWeekday } from "../src/index";

function expectIndianFormats() {
  it("groups numbers the Indian way", () => {
    expect(formatNumber(125_000)).toBe("1,25,000");
    expect(formatNumber(1_234.5)).toBe("1,234.5");
  });

  it("shows money without .00 for whole rupees and with two digits for paise (#413)", () => {
    expect([formatMoney(125_000), formatMoney(60), formatMoney(0), formatMoney(20.5), formatMoney(59.05), formatMoney(-20), formatMoney(-20.5), formatMoney(10n)])
      .toEqual(["₹1,25,000", "₹60", "₹0", "₹20.50", "₹59.05", "−₹20", "−₹20.50", "₹10"]);
    expect(formatMoney(12_345_678_901_234_567_891n)).toBe("₹1,23,45,67,89,01,23,45,67,891");
  });

  it("rounds to paise before dropping .00 and never shows a negative zero", () => {
    expect([formatMoney(59.999), formatMoney(0.004), formatMoney(-0.001), formatMoney(-0), formatMoney(59.995), formatMoney(19.994)])
      .toEqual(["₹60", "₹0", "₹0", "₹0", "₹60", "₹19.99"]);
    expect([formatMoney(1.005), formatMoney(-1.005), formatMoney(-59.995), formatMoney(-0.004), formatMoney(-19.995)])
      .toEqual(["₹1.01", "−₹1.01", "−₹60", "₹0", "−₹20"]);
  });

  it("shows a decimal string exactly, past the 15 digits a number holds (#475)", () => {
    expect([formatMoney("9998999999990001"), formatMoney("99999999999999.99"), formatMoney("9998999999990001.5")])
      .toEqual(["₹9,99,89,99,99,99,90,001", "₹9,99,99,99,99,99,999.99", "₹9,99,89,99,99,99,90,001.50"]);
    expect(formatMoney("-9998999999990001.25")).toBe("−₹9,99,89,99,99,99,90,001.25");
  });

  it("rounds a decimal string like a number: half away from zero, no negative zero (#475)", () => {
    const amounts = ["125000", "60", "0", "20.5", "59.05", "-20", "-20.5", "59.999", "0.004", "-0.001", "-0", "59.995", "19.994", "1.005", "-1.005", "-59.995", "-0.004", "-19.995", "60.00"];
    expect(amounts.map(formatMoney)).toEqual(amounts.map((amount) => formatMoney(Number(amount))));
    expect([formatMoney("-59.995"), formatMoney("1.005"), formatMoney("-0.004"), formatMoney("60.00")]).toEqual(["−₹60", "₹1.01", "₹0", "₹60"]);
  });

  it("throws on a string that is not a plain decimal amount, rather than showing a made-up one (#475)", () => {
    for (const bad of ["", "-", "+", ".", "1.2.3", "1.", ".5", "1e3", "1,000", " 60", "60 ", "--5", "abc"]) {
      expect(() => formatMoney(bad), JSON.stringify(bad)).toThrow(RangeError);
    }
  });

  it("shows dates and 12-hour times in India", () => {
    const instant = "2026-10-13T20:35:00.000Z";
    expect(formatDate(instant)).toBe("14/10/2026");
    expect(formatTime(instant)).toBe("2:05 AM");
    expect(formatDateTime(instant)).toBe("14/10/2026, 2:05 AM");
  });

  it("shows a minute of the day as a time (#371)", () => {
    expect([0, 540, 720, 1410].map(formatMinuteOfDay)).toEqual(["12:00 AM", "9:00 AM", "12:00 PM", "11:30 PM"]);
  });

  it("names the weekday in India, where 1 Jan 2030 6:30 PM UTC is already Wednesday", () => {
    expect(formatWeekday("2030-01-01T12:00:00Z")).toBe("Tue");
    expect(formatWeekday("2030-01-01T18:30:00Z")).toBe("Wed");
  });

  it("says when in India: a time today, tomorrow, or a weekday further on", () => {
    const ist = (local: string) => Date.parse(`${local}+05:30`);
    const now = ist("2030-01-01T23:00:00");
    expect(formatDayTime(ist("2030-01-01T23:30:00"), now, "tomorrow")).toBe("11:30 PM");
    expect(formatDayTime(new Date(ist("2030-01-02T09:00:00")).toISOString(), now, "tomorrow")).toBe("tomorrow 9:00 AM");
    expect(formatDayTime(ist("2030-01-03T09:00:00"), now, "tomorrow")).toBe("Thu 9:00 AM");
    expect(formatDayTime(ist("2030-01-07T09:00:00"), now, "tomorrow")).toBe("Mon 9:00 AM");
    // 7 or more days on, the date: a weekday alone would name the wrong week (#382).
    expect(formatDayTime(ist("2030-01-08T09:00:00"), now, "tomorrow")).toBe("8 Jan 9:00 AM");
    expect(formatDayMonth(ist("2030-11-12T09:00:00"))).toBe("12 Nov");
    expect(formatDayMonthYear(ist("2029-11-12T09:00:00"))).toBe("12 Nov 2029");
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

// Hermes on Android and iOS throws TypeError: Cannot convert BigInt to number when format() receives BigInt (#479).
describe("Indian display formats on Hermes (no BigInt in Intl)", () => {
  type Format = (value: number | bigint) => string;
  const original = Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype, "format") as PropertyDescriptor;
  const originalGet = original.get as (this: Intl.NumberFormat) => Format;

  beforeAll(() => {
    Object.defineProperty(Intl.NumberFormat.prototype, "format", {
      configurable: true,
      get(this: Intl.NumberFormat) {
        const format = originalGet.call(this);
        return ((value) => {
          if (typeof value === "bigint") throw new TypeError("Cannot convert BigInt to number");
          return format(value);
        }) satisfies Format;
      },
    });
  });

  afterAll(() => {
    Object.defineProperty(Intl.NumberFormat.prototype, "format", original);
  });

  expectIndianFormats();
});

describe("phone numbers", () => {
  it("shows a stored Indian number as two groups of five, without +91", () => {
    expect(formatPhone("+919876543210")).toBe("98765 43210");
  });

  it("shows anything else as stored", () => {
    expect(formatPhone("+4420794600")).toBe("+4420794600");
    expect(formatPhone("+91987654321")).toBe("+91987654321");
    expect(formatPhone("+915876543210")).toBe("+915876543210");
    expect(formatPhone("")).toBe("");
  });
});

describe("trimDecimal", () => {
  it("cuts trailing zeros without rounding (#413)", () => {
    expect(["10.00", "12.50", "12.3456", "10.0004", "100", "0.00", "7.69"].map(trimDecimal)).toEqual(["10", "12.5", "12.3456", "10.0004", "100", "0", "7.69"]);
  });
});

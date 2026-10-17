import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatMoney, formatNumber, formatTime } from "../src/index";

describe("Indian display formats", () => {
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
});

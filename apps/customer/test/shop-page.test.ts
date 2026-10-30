import { describe, expect, it } from "vitest";
import { closedLine } from "../src/lib/feed";
import { hoursLine, offLabel, packLabel, partLabel, shopSections, weekRows } from "../src/lib/shop-page";

describe("shop page labels (#370)", () => {
  it("shows a pack below 1 kg or 1 L in g or ml, and counts pieces", () => {
    expect([packLabel("0.5", "kg"), packLabel("0.25", "l"), packLabel("1", "kg"), packLabel("1.5", "l"), packLabel("1", "each"), packLabel("12", "each")])
      .toEqual(["500 g", "250 ml", "1 kg", "1.5 L", "1 pc", "12 pcs"]);
  });

  it("names what is left of a pack with its price and no trailing zeros (#377)", () => {
    expect([partLabel({ quantity: "0.4", price: "16.00" }, "kg"), partLabel({ quantity: "2.5", price: "59.50" }, "l")])
      .toEqual(["Only 400 g left · ₹16", "Only 2.5 L left · ₹59.50"]);
  });

  it("names the percent off to two decimals with no trailing zeros, and nothing at 0.00%", () => {
    expect([offLabel({ discountPercent: "7.69" }), offLabel({ discountPercent: "10.00" }), offLabel({ discountPercent: "7.50" }), offLabel({ discountPercent: "0.00" }), offLabel({ discountPercent: null })])
      .toEqual(["7.69% off", "10% off", "7.5% off", null, null]);
  });

  it("keeps the server's category, product and pack order as SectionList sections", () => {
    const pack = (listingId: string, quantity: string) => ({ listingId, quantity, price: "10.00", mrp: null, discountPercent: null, outOfStock: false, part: null });
    const product = (id: string, packs: ReturnType<typeof pack>[]) => ({ id, name: id, brand: null, baseUnit: "kg" as const, packs });
    const groups = [
      { category: "Groceries", products: [product("atta", [pack("a1", "5")]), product("dal", [pack("d1", "0.5"), pack("d2", "1")])] },
      { category: "Stationery", products: [product("pen", [pack("p1", "1")])] },
    ];
    expect(shopSections(groups)).toEqual([
      { key: "Groceries", title: "Groceries", data: groups[0]?.products },
      { key: "Stationery", title: "Stationery", data: groups[1]?.products },
    ]);
    expect(shopSections(groups)[0]?.data[1]?.packs.map((listed) => listed.listingId)).toEqual(["d1", "d2"]);
    expect(shopSections([])).toEqual([]);
  });
});

describe("opening hours on C04 and C05 (#381)", () => {
  /** A time in India. 1 Jan 2030 is a Tuesday. */
  const ist = (local: string) => Date.parse(`${local}+05:30`);
  const iso = (local: string) => new Date(ist(local)).toISOString();
  const h = (hours: number) => hours * 60;
  const shop = {
    id: "8a0e4f8e-1c55-4d3c-9b8e-6b6f1f7f2a10", name: "Day Dairy", estimatedMinutes: 15, deliveryFee: "30", minimumOrder: "100", fssaiNumber: "11223344556677",
    open: true, opensAt: null, closesAt: iso("2030-01-01T21:00:00"), today: 2, holiday: false, holidays: [] as number[],
    hours: [{ weekday: 1, opens: h(22), closes: h(2) }, { weekday: 2, opens: h(9), closes: h(13) }, { weekday: 2, opens: h(16), closes: h(21) }, { weekday: 3, opens: 0, closes: 0 }],
  };

  it("says closed with the next opening on a C04 card, and nothing while open", () => {
    const now = ist("2030-01-01T14:00:00");
    expect(closedLine({ open: false, opensAt: iso("2030-01-01T16:00:00"), holiday: false }, now)).toBe("Closed · opens 4:00 PM");
    expect(closedLine({ open: false, opensAt: iso("2030-01-02T09:00:00"), holiday: false }, now)).toBe("Closed · opens tomorrow 9:00 AM");
    expect(closedLine({ open: false, opensAt: iso("2030-01-07T09:00:00"), holiday: false }, now)).toBe("Closed · opens Mon 9:00 AM");
    expect(closedLine({ open: true, opensAt: null, holiday: false }, now)).toBeNull();
  });

  it("gives C05 one line: open today, open until, open 24 hours or closed now", () => {
    expect(hoursLine(shop, ist("2030-01-01T10:00:00"))).toBe("Open today, 9:00 AM – 1:00 PM, 4:00 PM – 9:00 PM");
    // Monday's past-midnight range, or the Owner's switch, open outside today's ranges.
    expect(hoursLine({ ...shop, closesAt: iso("2030-01-01T02:00:00") }, ist("2030-01-01T01:00:00"))).toBe("Open now · until 2:00 AM");
    expect(hoursLine({ ...shop, closesAt: iso("2030-01-01T23:00:00") }, ist("2030-01-01T22:00:00"))).toBe("Open now · until 11:00 PM");
    expect(hoursLine({ ...shop, closesAt: null }, ist("2030-01-01T10:00:00"))).toBe("Open 24 hours");
    expect(hoursLine({ ...shop, open: false, closesAt: null, opensAt: iso("2030-01-01T16:00:00") }, ist("2030-01-01T14:00:00"))).toBe("Closed now · opens 4:00 PM");
  });

  it("reads a 24-hour day naturally in a week that closes, keeping \"Open 24 hours\" for a shop that never does", () => {
    // Wednesday runs 12:00 AM – 12:00 AM, but the shop closes on Thursday, so it has a closing time.
    const wednesday = { ...shop, today: 3, closesAt: iso("2030-01-03T00:00:00") };
    expect(hoursLine(wednesday, ist("2030-01-02T10:00:00"))).toBe("Open all day today");
    const fromNine = { ...shop, today: 4, closesAt: iso("2030-01-04T09:00:00"), hours: [{ weekday: 4, opens: h(9), closes: h(9) }] };
    expect(hoursLine(fromNine, ist("2030-01-03T10:00:00"))).toBe("Open today, 24 hours from 9:00 AM");
    expect(weekRows(fromNine.hours, 4, [])[3]).toEqual({ day: "Thursday", text: "24 hours from 9:00 AM", today: true });
    expect(hoursLine({ ...wednesday, closesAt: null }, ist("2030-01-02T10:00:00"))).toBe("Open 24 hours");
  });

  it("lists the week Monday first with today marked, closed days and 24-hour days", () => {
    expect(weekRows(shop.hours, 2, []).slice(0, 4)).toEqual([
      { day: "Monday", text: "10:00 PM – 2:00 AM", today: false },
      { day: "Tuesday", text: "9:00 AM – 1:00 PM, 4:00 PM – 9:00 PM", today: true },
      { day: "Wednesday", text: "All day", today: false },
      { day: "Thursday", text: "Closed", today: false },
    ]);
  });

  it("says a shop is closed for a holiday on C04 and C05, dates the opening a week or more away, and marks holidays in the week (#382)", () => {
    const now = ist("2030-01-01T10:00:00");
    expect(closedLine({ open: false, opensAt: iso("2030-01-03T09:00:00"), holiday: true }, now)).toBe("Holiday · opens Thu 9:00 AM");
    expect(closedLine({ open: false, opensAt: iso("2030-01-11T09:00:00"), holiday: true }, now)).toBe("Holiday · opens 11 Jan 9:00 AM");
    const away = { ...shop, open: false, closesAt: null, opensAt: iso("2030-01-11T09:00:00"), holiday: true, holidays: [1, 2, 3, 4, 5, 6, 7] };
    expect(hoursLine(away, now)).toBe("Closed for a holiday · opens 11 Jan 9:00 AM");
    // Opened by the Owner on a holiday: today's hours don't apply, so the line gives the switch's end.
    expect(hoursLine({ ...shop, closesAt: iso("2030-01-01T12:00:00"), holidays: [2] }, now)).toBe("Open now · until 12:00 PM");
    expect(weekRows(shop.hours, 2, [2, 4]).slice(0, 4).map((row) => row.text)).toEqual(["10:00 PM – 2:00 AM", "Holiday", "All day", "Holiday"]);
  });
});

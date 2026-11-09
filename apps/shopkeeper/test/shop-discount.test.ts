import { describe, expect, it } from "vitest";
import { emptyDiscount, toBody, toForm, worstPercent } from "../src/lib/shop-discount";

const rule = { id: "00000000-0000-4000-8000-000000000001", version: 2, form: "percentage" as const, percentage: "10.0000", cap: "20.00", amount: null, minimumOrder: null, status: "active" as const };

describe("S34 shop discount form (#63)", () => {
  it("shows a saved rule without trailing zeros, and a paused or off one as off", () => {
    expect(toForm(rule)).toEqual({ form: "percentage", percentage: "10", cap: "20", amount: "", minimumOrder: "", active: true });
    expect(toForm({ ...rule, status: "paused" }).active).toBe(false);
    expect(toForm(null)).toEqual(emptyDiscount);
  });

  it("builds the request from the contract's own rules for each form", () => {
    expect(toBody({ ...emptyDiscount, percentage: "10", cap: "" })).toEqual({ ok: true, body: { form: "percentage", percentage: "10", cap: null, active: true } });
    expect(toBody({ ...emptyDiscount, form: "flat", amount: "200", minimumOrder: "1000", percentage: "5" })).toEqual({ ok: true, body: { form: "flat", amount: "200", minimumOrder: "1000", active: true } });
  });

  it("names the fields that are empty or not above zero", () => {
    expect(toBody(emptyDiscount)).toEqual({ ok: false, fields: ["percentage"] });
    expect(toBody({ ...emptyDiscount, percentage: "10", cap: "0" })).toEqual({ ok: false, fields: ["cap"] });
    expect(toBody({ ...emptyDiscount, form: "flat", amount: "200", minimumOrder: "" })).toEqual({ ok: false, fields: ["minimumOrder"] });
  });

  it("shows the worst case the server will hold to the maximum", () => {
    expect(worstPercent({ ...emptyDiscount, percentage: "12.50" })).toBe("12.5");
    expect(worstPercent({ ...emptyDiscount, form: "flat", amount: "200", minimumOrder: "900" })).toBe("22.22");
    expect(worstPercent(emptyDiscount)).toBeNull();
  });
});

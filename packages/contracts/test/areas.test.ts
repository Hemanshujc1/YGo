import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  Area,
  AreaParams,
  AreasResponse,
  CreateAreaBody,
  EditAreaBody,
  invalidFields,
  Serviceability,
  ServiceabilityQuery,
  WaitlistBody,
} from "../src/index";

/** The fields a refused value names. */
function fieldsRefused(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected the parse to fail");
  return invalidFields(result.error);
}

const area = {
  id: "00000000-0000-4000-8000-000000000201",
  name: "Kothrud",
  pincodes: ["411029", "411038"],
  paused: false,
};
const hundred = Array.from({ length: 100 }, (_, i) => String(411000 + i));

describe("Area", () => {
  it("accepts an Area and a list of them", () => {
    expect(Area.parse(area)).toEqual(area);
    expect(AreasResponse.parse({ areas: [area] })).toEqual({ areas: [area] });
    expect(AreasResponse.parse({ areas: [] })).toEqual({ areas: [] });
  });

  it("refuses an Area without its paused state", () => {
    expect(fieldsRefused(Area, { ...area, paused: undefined })).toEqual(["paused"]);
  });

  it("takes the Area id from the path", () => {
    expect(AreaParams.parse({ id: area.id })).toEqual({ id: area.id });
    expect(fieldsRefused(AreaParams, { id: "kothrud" })).toEqual(["id"]);
  });
});

describe("CreateAreaBody", () => {
  it("trims the name and removes spaces from pincodes", () => {
    expect(CreateAreaBody.parse({ name: "  Kothrud ", pincodes: ["411 038"] })).toEqual({
      name: "Kothrud",
      pincodes: ["411038"],
    });
  });

  it("accepts 100 pincodes", () => {
    expect(CreateAreaBody.parse({ name: "Kothrud", pincodes: hundred }).pincodes).toHaveLength(100);
  });

  it.each([
    ["no pincodes", []],
    ["more than 100", [...hundred, "412000"]],
    ["the same pincode twice", ["411038", "411029", "411038"]],
    ["the same pincode twice once spaces are removed", ["411038", "411 038"]],
    ["a pincode starting with 0", ["011038"]],
    ["a pincode of five digits", ["41103"]],
  ])("refuses %s", (_, pincodes) => {
    expect(fieldsRefused(CreateAreaBody, { name: "Kothrud", pincodes })[0]).toMatch(/^pincodes/);
  });

  it("refuses a blank name, one over 100 characters, and an unexpected field", () => {
    expect(fieldsRefused(CreateAreaBody, { name: "   ", pincodes: ["411038"] })).toEqual(["name"]);
    expect(fieldsRefused(CreateAreaBody, { name: "a".repeat(101), pincodes: ["411038"] })).toEqual(["name"]);
    expect(fieldsRefused(CreateAreaBody, { name: "Kothrud", pincodes: ["411038"], reason: "New" })).toEqual(["reason"]);
  });
});

describe("EditAreaBody", () => {
  it("accepts new pincodes with a reason", () => {
    expect(EditAreaBody.parse({ pincodes: ["411 029"], reason: "  Add Karve Nagar " })).toEqual({
      pincodes: ["411029"],
      reason: "Add Karve Nagar",
    });
  });

  it.each([true, false])("accepts paused %s with a reason", (paused) => {
    expect(EditAreaBody.parse({ paused, reason: "Monsoon flooding" })).toEqual({ paused, reason: "Monsoon flooding" });
  });

  it("refuses a missing, blank or over-long reason", () => {
    expect(fieldsRefused(EditAreaBody, { paused: true })).toEqual(["reason"]);
    expect(fieldsRefused(EditAreaBody, { paused: true, reason: "   " })).toEqual(["reason"]);
    expect(fieldsRefused(EditAreaBody, { paused: true, reason: "a".repeat(501) })).toEqual(["reason"]);
  });

  it("refuses two changes at once, or none, so each edit is one change", () => {
    expect(EditAreaBody.safeParse({ pincodes: ["411029"], paused: true, reason: "Both" }).success).toBe(false);
    expect(EditAreaBody.safeParse({ reason: "Nothing" }).success).toBe(false);
  });

  it("refuses the same pincode twice, and a rename", () => {
    expect(fieldsRefused(EditAreaBody, { pincodes: ["411029", "411 029"], reason: "Twice" })).toEqual(["pincodes"]);
    expect(fieldsRefused(EditAreaBody, { name: "Karve Nagar", reason: "Rename" })).toEqual(["name"]);
  });
});

describe("serviceability", () => {
  it("takes a pincode from the query, without spaces", () => {
    expect(ServiceabilityQuery.parse({ pincode: "411 038" })).toEqual({ pincode: "411038" });
    expect(fieldsRefused(ServiceabilityQuery, { pincode: "011038" })).toEqual(["pincode"]);
  });

  it("accepts both answers", () => {
    expect(Serviceability.parse({ serviceable: true, areaName: "Kothrud" })).toEqual({ serviceable: true, areaName: "Kothrud" });
    expect(Serviceability.parse({ serviceable: false })).toEqual({ serviceable: false });
  });

  it("refuses serviceable without the Area name", () => {
    expect(Serviceability.safeParse({ serviceable: true }).success).toBe(false);
  });
});

describe("WaitlistBody", () => {
  it("cleans the pincode and phone", () => {
    expect(WaitlistBody.parse({ pincode: "411 038", phone: "98765 43210" })).toEqual({
      pincode: "411038",
      phone: "+919876543210",
    });
  });

  it("names a bad pincode or phone", () => {
    expect(fieldsRefused(WaitlistBody, { pincode: "41103", phone: "12345" })).toEqual(["pincode", "phone"]);
  });
});

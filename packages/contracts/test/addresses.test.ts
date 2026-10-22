import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AddressAreaLine,
  AddressFlat,
  invalidFields,
  SaveAddressBody,
  SavedAddress,
  SavedAddressesResponse,
  SavedAddressParams,
} from "../src/index";

/** The fields a refused value names. */
function fieldsRefused(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected the parse to fail");
  return invalidFields(result.error);
}

const home = {
  label: "home",
  flat: "Flat 4B, Sai Heights",
  areaLine: "Baner Road, Baner",
  pincode: "411045",
  point: { latitude: 18.559, longitude: 73.7868 },
};
const id = "00000000-0000-4000-8000-000000000301";

describe("AddressFlat", () => {
  it("trims, and takes 1 to 100 characters", () => {
    expect(AddressFlat.parse("  Flat 4B ")).toBe("Flat 4B");
    expect(AddressFlat.parse("a".repeat(100))).toHaveLength(100);
    expect(AddressFlat.safeParse("   ").success).toBe(false);
    expect(AddressFlat.safeParse("a".repeat(101)).success).toBe(false);
  });
});

describe("AddressAreaLine", () => {
  it("trims, and takes 1 to 200 characters", () => {
    expect(AddressAreaLine.parse(" Baner Road ")).toBe("Baner Road");
    expect(AddressAreaLine.parse("a".repeat(200))).toHaveLength(200);
    expect(AddressAreaLine.safeParse("").success).toBe(false);
    expect(AddressAreaLine.safeParse("a".repeat(201)).success).toBe(false);
  });
});

describe("SaveAddressBody", () => {
  it("accepts a place with its pin, and cleans the flat and pincode", () => {
    expect(SaveAddressBody.parse({ ...home, flat: " Flat 4B, Sai Heights ", pincode: "411 045" })).toEqual(home);
  });

  it("accepts a place without a pin", () => {
    expect(SaveAddressBody.parse({ ...home, point: null }).point).toBeNull();
  });

  it("refuses a missing flat or label, and a label it doesn't know", () => {
    expect(fieldsRefused(SaveAddressBody, { ...home, flat: " " })).toEqual(["flat"]);
    expect(fieldsRefused(SaveAddressBody, { ...home, label: undefined })).toEqual(["label"]);
    expect(fieldsRefused(SaveAddressBody, { ...home, label: "school" })).toEqual(["label"]);
  });

  it("accepts Home, Work and Other", () => {
    for (const label of ["home", "work", "other"]) expect(SaveAddressBody.parse({ ...home, label }).label).toBe(label);
  });

  it("refuses a pin outside the box around India", () => {
    expect(fieldsRefused(SaveAddressBody, { ...home, point: { latitude: 0, longitude: 0 } })).toEqual([
      "point.latitude",
      "point.longitude",
    ]);
    expect(fieldsRefused(SaveAddressBody, { ...home, point: { latitude: 73.7868, longitude: 18.559 } })).toEqual([
      "point.latitude",
      "point.longitude",
    ]);
    expect(fieldsRefused(SaveAddressBody, { ...home, point: { latitude: 51.5, longitude: 73.7 } })).toEqual([
      "point.latitude",
    ]);
  });

  it("accepts a pin at the edges of the box", () => {
    expect(SaveAddressBody.safeParse({ ...home, point: { latitude: 6, longitude: 68 } }).success).toBe(true);
    expect(SaveAddressBody.safeParse({ ...home, point: { latitude: 38, longitude: 98 } }).success).toBe(true);
  });

  it("refuses a pin without a coordinate, a bad pincode, and an extra field", () => {
    expect(fieldsRefused(SaveAddressBody, { ...home, point: { latitude: 18.559 } })).toEqual(["point.longitude"]);
    expect(fieldsRefused(SaveAddressBody, { ...home, pincode: "011045" })).toEqual(["pincode"]);
    expect(fieldsRefused(SaveAddressBody, { ...home, id })).toEqual(["id"]);
  });
});

describe("SavedAddress", () => {
  it("accepts a saved address and a list of them", () => {
    expect(SavedAddress.parse({ ...home, id })).toEqual({ ...home, id });
    expect(SavedAddressesResponse.parse({ addresses: [{ ...home, id }] })).toEqual({ addresses: [{ ...home, id }] });
    expect(SavedAddressesResponse.parse({ addresses: [] })).toEqual({ addresses: [] });
  });

  it("refuses a saved address without its id or with an extra field", () => {
    expect(fieldsRefused(SavedAddress, home)).toEqual(["id"]);
    expect(fieldsRefused(SavedAddress, { ...home, id, accountId: id })).toEqual(["accountId"]);
  });

  it("takes the address id from the path", () => {
    expect(SavedAddressParams.parse({ id })).toEqual({ id });
    expect(fieldsRefused(SavedAddressParams, { id: "home" })).toEqual(["id"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  CalendarDate,
  CorrectShopApplicationBody,
  ErrorCode,
  invalidFields,
  MyShopApplicationResponse,
  SaveShopApplicationBody,
  SendShopApplicationBody,
  ServiceRadiusMetres,
  ShopAddress,
  ShopApplication,
  ShopEntityType,
  ShopName,
} from "../src/index";

/** The fields a refused value names. */
function fieldsRefused(schema: z.ZodType, value: unknown): string[] {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("expected the parse to fail");
  return invalidFields(result.error);
}

const complete = {
  shopName: "Sai General Stores",
  address: "Shop 3, Paud Road, Kothrud",
  pincode: "411038",
  location: { latitude: 18.5074, longitude: 73.8077 },
  ownerName: "Asha Kulkarni",
  entityType: "proprietorship",
  pan: "ABCDE1234F",
  fssaiNumber: "11223344556677",
  fssaiExpiry: "2027-03-31",
  serviceRadiusMetres: 2000,
  upiId: "asha.k@okhdfcbank",
};

describe("ShopName", () => {
  it("trims, and takes 1 to 100 characters", () => {
    expect(ShopName.parse("  Sai Stores ")).toBe("Sai Stores");
    expect(ShopName.parse("a".repeat(100))).toHaveLength(100);
    expect(ShopName.safeParse("  ").success).toBe(false);
    expect(ShopName.safeParse("a".repeat(101)).success).toBe(false);
  });
});

describe("ShopAddress", () => {
  it("trims, and takes 1 to 300 characters", () => {
    expect(ShopAddress.parse(" Paud Road ")).toBe("Paud Road");
    expect(ShopAddress.parse("a".repeat(300))).toHaveLength(300);
    expect(ShopAddress.safeParse("").success).toBe(false);
    expect(ShopAddress.safeParse("a".repeat(301)).success).toBe(false);
  });
});

describe("ShopEntityType", () => {
  it("takes the four legal forms only", () => {
    expect(ShopEntityType.options).toEqual(["proprietorship", "partnership_firm", "llp", "company"]);
    expect(ShopEntityType.safeParse("huf").success).toBe(false);
  });
});

describe("ServiceRadiusMetres", () => {
  it("takes 0.5 km steps from 0.5 km to 5 km", () => {
    for (const metres of [500, 2000, 2500, 5000]) expect(ServiceRadiusMetres.parse(metres)).toBe(metres);
    for (const metres of [0, 250, 1200, 5500]) expect(ServiceRadiusMetres.safeParse(metres).success).toBe(false);
  });
});

describe("CalendarDate", () => {
  it("takes a real YYYY-MM-DD date only", () => {
    expect(CalendarDate.parse("2027-02-28")).toBe("2027-02-28");
    for (const date of ["2027-02-30", "31/03/2027", "2027-3-31"]) expect(CalendarDate.safeParse(date).success).toBe(false);
  });
});

describe("SaveShopApplicationBody", () => {
  it("takes any part of the fields, and null to empty one", () => {
    expect(SaveShopApplicationBody.parse({})).toEqual({});
    expect(SaveShopApplicationBody.parse({ shopName: " Sai Stores ", pan: null })).toEqual({ shopName: "Sai Stores", pan: null });
  });

  it("names a value that breaks its rule", () => {
    expect(fieldsRefused(SaveShopApplicationBody, { pan: "ABCDE1234", serviceRadiusMetres: 1200 })).toEqual([
      "pan",
      "serviceRadiusMetres",
    ]);
  });

  it("can't empty the service radius", () => {
    expect(fieldsRefused(SaveShopApplicationBody, { serviceRadiusMetres: null })).toEqual(["serviceRadiusMetres"]);
  });

  it("takes no Owner phone or email, which come from the account", () => {
    expect(fieldsRefused(SaveShopApplicationBody, { ownerPhone: "+919876543210" })).toEqual(["ownerPhone"]);
  });
});

describe("SendShopApplicationBody", () => {
  // 00:30 on 26 Oct 2026 in India, while it is still the 25th in UTC.
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-25T19:00:00Z") }));
  afterEach(() => vi.useRealTimers());

  it("takes every field filled in", () => {
    expect(SendShopApplicationBody.parse({ ...complete, pan: "abcde 1234 f" }).pan).toBe("ABCDE1234F");
  });

  it("names each missing field", () => {
    const missing = { ...complete, pan: undefined, location: undefined };
    expect(fieldsRefused(SendShopApplicationBody, missing)).toEqual(["location", "pan"]);
  });

  it("needs an FSSAI expiry after today in India", () => {
    expect(SendShopApplicationBody.safeParse({ ...complete, fssaiExpiry: "2026-10-27" }).success).toBe(true);
    expect(fieldsRefused(SendShopApplicationBody, { ...complete, fssaiExpiry: "2026-10-26" })).toEqual(["fssaiExpiry"]);
  });

  it("reads the clock on each check, not once", () => {
    const tomorrow = { ...complete, fssaiExpiry: "2026-10-27" };
    expect(SendShopApplicationBody.safeParse(tomorrow).success).toBe(true);
    vi.setSystemTime(new Date("2026-10-26T19:00:00Z"));
    expect(fieldsRefused(SendShopApplicationBody, tomorrow)).toEqual(["fssaiExpiry"]);
  });

  it("names a past expiry together with the other errors", () => {
    expect(fieldsRefused(SendShopApplicationBody, { ...complete, pan: undefined, fssaiExpiry: "2026-01-31" })).toEqual([
      "pan",
      "fssaiExpiry",
    ]);
  });
});

describe("CorrectShopApplicationBody", () => {
  it("takes one or more fields with a reason, and a past FSSAI expiry", () => {
    const body = { fssaiExpiry: "2026-01-31", upiId: "Asha@OKSBI", reason: " Licence checked at the visit " };
    expect(CorrectShopApplicationBody.parse(body)).toEqual({
      fssaiExpiry: "2026-01-31",
      upiId: "asha@oksbi",
      reason: "Licence checked at the visit",
    });
  });

  it("refuses a field without a reason", () => {
    expect(fieldsRefused(CorrectShopApplicationBody, { shopName: "Sai Stores" })).toEqual(["reason"]);
  });

  it("refuses a reason with no field, or only empty ones, naming fields", () => {
    expect(fieldsRefused(CorrectShopApplicationBody, { reason: "Nothing" })).toEqual(["fields"]);
    expect(fieldsRefused(CorrectShopApplicationBody, { shopName: undefined, reason: "Nothing" })).toEqual(["fields"]);
  });

  it("can't empty a field", () => {
    expect(fieldsRefused(CorrectShopApplicationBody, { pan: null, reason: "Typo" })).toEqual(["pan"]);
  });
});

describe("ShopApplication", () => {
  it("reads a fresh Draft, null until Start, and a sent application", () => {
    const draft = {
      id: "00000000-0000-4000-8000-000000000401",
      state: "draft",
      ...Object.fromEntries(Object.keys(complete).map((key) => [key, null])),
      ownerName: "Asha Kulkarni",
      serviceRadiusMetres: 2000,
      areaName: null,
      ownerPhone: "+919876543210",
      ownerEmail: "asha@example.com",
      submittedAt: null,
    };
    expect(MyShopApplicationResponse.parse({ application: draft }).application?.state).toBe("draft");
    expect(MyShopApplicationResponse.parse({ application: null })).toEqual({ application: null });
    const sent = { ...draft, ...complete, state: "submitted", areaName: "Kothrud", submittedAt: "2026-10-25T10:00:00.000Z" };
    expect(ShopApplication.parse(sent)).toEqual(sent);
  });
});

describe("shop application error codes", () => {
  it("are known codes", () => {
    for (const code of ["SHOP_APPLICATION_EXISTS", "SHOP_APPLICATION_SENT", "PINCODE_NOT_IN_AREA", "SHOP_STATE_CHANGE_REFUSED"]) {
      expect(ErrorCode.safeParse(code).success).toBe(true);
    }
  });
});

import type { ShopApplication } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import { changed, draftBody, isoDate, shown, stepRadius, typedDate, typedFrom } from "../src/lib/application-form";

const draft: ShopApplication = {
  id: "8f6c1f0e-1d2b-4c3a-9e8f-7a6b5c4d3e2f",
  state: "draft",
  shopName: null,
  address: null,
  pincode: null,
  location: null,
  ownerName: "Asha Kulkarni",
  entityType: null,
  pan: null,
  fssaiNumber: null,
  fssaiExpiry: null,
  serviceRadiusMetres: 2000,
  upiId: null,
  areaName: null,
  ownerPhone: "+919876543210",
  ownerEmail: "asha@example.com",
  submittedAt: null,
};

describe("typedFrom", () => {
  it("shows empty fields blank and the FSSAI expiry as DD/MM/YYYY", () => {
    const typed = typedFrom({ ...draft, pan: "ABCDE1234F", fssaiExpiry: "2027-03-31", entityType: "llp" });
    expect(typed).toMatchObject({ shopName: "", ownerName: "Asha Kulkarni", pan: "ABCDE1234F", fssaiExpiry: "31/03/2027" });
    expect(typed).toMatchObject({ entityType: "llp", serviceRadiusMetres: 2000 });
  });
});

describe("typedDate", () => {
  it("shows a saved date as DD/MM/YYYY, which isoDate reads back unchanged", () => {
    expect(typedDate("2027-04-03")).toBe("03/04/2027");
    expect(isoDate(typedDate("2027-04-03"))).toBe("2027-04-03");
  });
});

describe("isoDate", () => {
  it("turns DD/MM/YYYY into YYYY-MM-DD, padding one-digit parts", () => {
    expect(isoDate("31/03/2027")).toBe("2027-03-31");
    expect(isoDate("1/4/2027")).toBe("2027-04-01");
  });

  it("keeps anything else as typed", () => {
    expect(isoDate("2027-03-31")).toBe("2027-03-31");
    expect(isoDate("31/03/2027/1")).toBe("31/03/2027/1");
  });
});

describe("draftBody", () => {
  it("sends every field, an empty one as null, as the server's rules write it", () => {
    const typed = { ...typedFrom(draft), pan: " abcde 1234f ", fssaiExpiry: "31/3/2027", upiId: "Asha@OKHDFCBank", shopName: "  " };
    expect(draftBody(typed)).toEqual({
      ok: true,
      body: {
        shopName: null,
        address: null,
        pincode: null,
        ownerName: "Asha Kulkarni",
        pan: "ABCDE1234F",
        fssaiNumber: null,
        fssaiExpiry: "2027-03-31",
        upiId: "asha@okhdfcbank",
        entityType: null,
        serviceRadiusMetres: 2000,
      },
    });
  });

  it("leaves the saved location alone", () => {
    const answer = draftBody(typedFrom(draft));
    expect(answer.ok && "location" in answer.body).toBe(false);
  });

  it("names each filled-in field that breaks its rule and saves nothing", () => {
    const typed = { ...typedFrom(draft), pincode: "011038", pan: "ABCDE", fssaiExpiry: "31/02/2027", upiId: "asha" };
    expect(draftBody(typed)).toEqual({ ok: false, wrong: ["pincode", "pan", "fssaiExpiry", "upiId"] });
  });
});

describe("shown", () => {
  it("keeps the server's named fields that the form shows", () => {
    expect(shown(["pan", "location", "entityType"])).toEqual(["pan", "entityType"]);
    expect(shown(undefined)).toEqual([]);
  });
});

describe("changed", () => {
  it("is true once any field differs from the saved form", () => {
    const saved = typedFrom(draft);
    expect(changed(saved, saved)).toBe(false);
    expect(changed({ ...saved, serviceRadiusMetres: 2500 }, saved)).toBe(true);
    expect(changed({ ...saved, shopName: "Asha Stores" }, saved)).toBe(true);
  });
});

describe("stepRadius", () => {
  it("moves 0.5 km at a time between 0.5 km and 5 km", () => {
    expect(stepRadius(2000, 1)).toBe(2500);
    expect(stepRadius(2000, -1)).toBe(1500);
    expect(stepRadius(500, -1)).toBeNull();
    expect(stepRadius(5000, 1)).toBeNull();
  });
});

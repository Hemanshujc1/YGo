import type { ShopApplication } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import { changed, draftBody, isoDate, realDate, sendBody, shown, stepRadius, type Typed, typedDate, typedFrom } from "../src/lib/application-form";

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
    expect(typed).toMatchObject({ entityType: "llp", serviceRadiusMetres: 2000, location: null });
  });

  it("keeps the saved location", () => {
    expect(typedFrom({ ...draft, location: { latitude: 18.5, longitude: 73.8 } }).location).toEqual({ latitude: 18.5, longitude: 73.8 });
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

  it("leaves the location out until the phone gives one, so a saved one is never erased", () => {
    const answer = draftBody(typedFrom(draft));
    expect(answer.ok && "location" in answer.body).toBe(false);
  });

  it("sends the location from the phone", () => {
    const answer = draftBody({ ...typedFrom(draft), location: { latitude: 18.5, longitude: 73.8 } });
    expect(answer.ok && answer.body.location).toEqual({ latitude: 18.5, longitude: 73.8 });
  });

  it("names each filled-in field that breaks its rule and saves nothing", () => {
    const typed = { ...typedFrom(draft), pincode: "011038", pan: "ABCDE", fssaiExpiry: "31/02/2027", upiId: "asha" };
    expect(draftBody(typed)).toEqual({ ok: false, wrong: ["pincode", "pan", "fssaiExpiry", "upiId"] });
  });
});

/** A form ready to send, with a licence valid until 2099. */
const filled: Typed = {
  ...typedFrom(draft),
  shopName: "Asha Stores",
  address: "12 MG Road, Pune",
  pincode: "411045",
  location: { latitude: 18.5, longitude: 73.8 },
  entityType: "proprietorship",
  pan: "ABCDE1234F",
  fssaiNumber: "12345678901234",
  fssaiExpiry: "31/12/2099",
  upiId: "asha@okhdfcbank",
};

describe("sendBody", () => {
  it("sends every field as the server's rules write it", () => {
    expect(sendBody(filled)).toEqual({
      ok: true,
      body: {
        shopName: "Asha Stores",
        address: "12 MG Road, Pune",
        pincode: "411045",
        location: { latitude: 18.5, longitude: 73.8 },
        ownerName: "Asha Kulkarni",
        entityType: "proprietorship",
        pan: "ABCDE1234F",
        fssaiNumber: "12345678901234",
        fssaiExpiry: "2099-12-31",
        serviceRadiusMetres: 2000,
        upiId: "asha@okhdfcbank",
      },
    });
  });

  it("names every empty field, the missing location among them", () => {
    expect(sendBody(typedFrom(draft))).toEqual({
      ok: false,
      wrong: ["shopName", "address", "pincode", "location", "entityType", "pan", "fssaiNumber", "fssaiExpiry", "upiId"],
    });
  });

  it("names a licence date that has passed", () => {
    expect(sendBody({ ...filled, fssaiExpiry: "01/01/2020" })).toEqual({ ok: false, wrong: ["fssaiExpiry"] });
  });
});

describe("realDate", () => {
  it("is true for a real date, past or future, and false for anything else", () => {
    expect(realDate({ ...filled, fssaiExpiry: "01/01/2020" })).toBe(true);
    expect(realDate(filled)).toBe(true);
    expect(realDate({ ...filled, fssaiExpiry: "31/02/2020" })).toBe(false);
    expect(realDate({ ...filled, fssaiExpiry: "" })).toBe(false);
  });
});

describe("shown", () => {
  it("keeps the server's named fields that the form shows", () => {
    expect(shown(["pan", "location", "areaName", "entityType"])).toEqual(["pan", "location", "entityType"]);
  });

  it("names the field for a part of it, once", () => {
    expect(shown(["location.latitude", "location.longitude", "pan"])).toEqual(["location", "pan"]);
    expect(shown(undefined)).toEqual([]);
  });
});

describe("changed", () => {
  it("is true once any field differs from the saved form", () => {
    const saved = typedFrom(draft);
    expect(changed(saved, saved)).toBe(false);
    expect(changed({ ...saved, serviceRadiusMetres: 2500 }, saved)).toBe(true);
    expect(changed({ ...saved, shopName: "Asha Stores" }, saved)).toBe(true);
    expect(changed({ ...saved, location: { latitude: 18.5, longitude: 73.8 } }, saved)).toBe(true);
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

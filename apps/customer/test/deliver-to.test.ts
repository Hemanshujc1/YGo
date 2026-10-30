import type { ApiResult } from "@ygo/api-client";
import type { SavedAddress, SavedAddressesResponse } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import { addressQuery, createDeliverTo, deliverLine, pickAddress } from "../src/lib/deliver-to";

const shopId = "5b0c7f1e-2a4d-4e8f-9b6a-1c3d5e7f9a0b";
const address = (id: string, label: SavedAddress["label"], flat: string, latitude: number): SavedAddress => ({
  id, label, flat, areaLine: "Kothrud", pincode: "411038", point: { latitude, longitude: 73.8 },
});
const work = address("0b6f3f1e-8f2a-4d6e-9a51-5c1d2e3f4a01", "work", "Office 12", 18.51);
const home = address("0b6f3f1e-8f2a-4d6e-9a51-5c1d2e3f4a02", "home", "Flat 4B", 18.5);
const added = address("0b6f3f1e-8f2a-4d6e-9a51-5c1d2e3f4a03", "other", "Flat 9", 18.52);
const homePlace = { pincode: "411038", latitude: 18.5, longitude: 73.8 };

describe("Deliver to (#427)", () => {
  it("shows the label and flat, and prices at the address's own pin", () => {
    expect(deliverLine(home)).toBe("Home · Flat 4B");
    expect(addressQuery(work)).toEqual({ pincode: "411038", latitude: 18.51, longitude: 73.8 });
    expect(addressQuery({ ...work, point: null })).toBeUndefined();
  });

  it("picks one just added, else the Customer's choice, else Home's place, else the newest", () => {
    const list = [work, home];
    expect(pickAddress(list, { known: null, chosen: undefined, place: homePlace })).toBe(home);
    expect(pickAddress(list, { known: null, chosen: undefined, place: { ...homePlace, latitude: 18.6 } })).toBe(work);
    expect(pickAddress(list, { known: null, chosen: work.id, place: homePlace })).toBe(work);
    expect(pickAddress([added, ...list], { known: new Set([work.id, home.id]), chosen: work.id, place: homePlace })).toBe(added);
    // A choice since removed falls back.
    expect(pickAddress([home], { known: new Set([work.id, home.id]), chosen: work.id, place: undefined })).toBe(home);
    expect(pickAddress([], { known: null, chosen: undefined, place: homePlace })).toBeNull();
  });

  it("asks for the shop's addresses, keeps a choice, and keeps an address added from C07 chosen", async () => {
    let answer: ApiResult<SavedAddressesResponse> = { ok: true, data: { addresses: [work, home] } };
    const asked: string[] = [];
    const store = createDeliverTo({ savedAddresses: async (shop) => (asked.push(shop), answer) }, shopId);
    expect(store.get().status).toBe("loading");
    await store.load(homePlace);
    expect(asked).toEqual([shopId]);
    expect(store.get()).toMatchObject({ status: "ready", address: home });
    store.choose(work.id);
    await store.load(homePlace);
    expect(store.get().address).toBe(work);
    answer = { ok: true, data: { addresses: [added, work, home] } };
    await store.load(homePlace);
    expect(store.get().address).toBe(added);
    await store.load(homePlace);
    expect(store.get().address).toBe(added);
  });

  it("fails openly on the first read and keeps the list shown on a later one", async () => {
    let fail = true;
    const store = createDeliverTo({ savedAddresses: async () => { if (fail) throw new TypeError("offline"); return { ok: true, data: { addresses: [home] } }; } }, shopId);
    await store.load(homePlace);
    expect(store.get().status).toBe("failed");
    fail = false;
    await store.load(homePlace);
    expect(store.get()).toMatchObject({ status: "ready", address: home });
    fail = true;
    await store.load(homePlace);
    expect(store.get()).toMatchObject({ status: "ready", address: home });
  });
});

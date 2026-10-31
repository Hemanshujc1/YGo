import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/index";

const account = {
  id: "0b9d6f8e-3c41-4a57-9f2e-6d1c8a7b5e40",
  email: "asha@example.com",
  name: "Asha Kulkarni",
  phone: "+919876543210",
  theme: "system",
};
const pair = (n: number) => ({ accessToken: `a${n}`, refreshToken: `r${n}`, account });
const unauthenticated = { error: { code: "UNAUTHENTICATED" } };

interface Call {
  method: string;
  path: string;
  body: unknown;
  auth: string | null;
}

const answer = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

/**
 * A server that signs in with pair 1 and issues the next pair on each
 * refresh. Only the newest access token is accepted.
 */
function fakeServer() {
  let issued = 1;
  let valid = "a1";
  return {
    expire() {
      valid = "";
    },
    handle(call: Call): Response {
      if (call.path === "/v1/auth/code") return answer(204);
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") {
        issued += 1;
        valid = `a${issued}`;
        return answer(200, pair(issued));
      }
      if (call.auth !== `Bearer ${valid}`) return answer(401, unauthenticated);
      if (call.path === "/v1/auth/sign-out") return answer(204);
      return answer(200, account);
    },
  };
}

/** A client over `handle`, with a store holding `saved` as if from an earlier launch. */
function setup(handle: (call: Call) => Response | Promise<Response>, saved: string | null = null) {
  const calls: Call[] = [];
  let stored = saved;
  /** Each token passed to `set`, when it is called. */
  const sets: string[] = [];
  let reads = 0;
  let held: Promise<void> | null = null;
  /** The store methods whose next call fails, as when secure storage is unavailable. */
  const failing = new Set<"get" | "set" | "clear">();
  const fail = (op: "get" | "set" | "clear") => {
    if (!failing.delete(op)) return;
    throw new Error("Keychain unavailable");
  };
  const onSignedOut = vi.fn();
  const onUpdateRequired = vi.fn();
  const onSaveFailed = vi.fn();
  const client = createApiClient({
    baseUrl: "https://api.test",
    onSignedOut,
    onUpdateRequired,
    onSaveFailed,
    session: {
      get: async () => {
        reads += 1;
        fail("get");
        return stored;
      },
      set: async (token) => {
        sets.push(token);
        const wait = held;
        held = null;
        await wait;
        fail("set");
        stored = token;
      },
      clear: async () => {
        fail("clear");
        stored = null;
      },
    },
    fetch: (input, init) => {
      const url = new URL(String(input));
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname + url.search,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        auth: new Headers(init?.headers).get("authorization"),
      };
      calls.push(call);
      return Promise.resolve(handle(call));
    },
  });
  const refreshes = () => calls.filter((call) => call.path === "/v1/auth/refresh").length;
  /** Holds the store's next `set` until the returned function is called. */
  const holdNextSet = () => {
    let release = () => {};
    held = new Promise((resolve) => (release = resolve));
    return () => release();
  };
  /** Makes the store's next `op` fail, as when secure storage is unavailable. */
  const failNext = (op: "get" | "set" | "clear") => {
    failing.add(op);
  };
  return { client, calls, refreshes, sets, reads: () => reads, holdNextSet, failNext, stored: () => stored, onSignedOut, onUpdateRequired, onSaveFailed };
}

/** A server answer held until `release(path)`; `waiting()` counts those held. */
function holds() {
  const held = new Map<string, () => void>();
  return {
    hold: (path: string) => new Promise<void>((release) => held.set(path, release)),
    release: (path: string) => held.get(path)?.(),
    waiting: () => held.size,
  };
}

const signIn = { email: "asha@example.com", code: "123456" };

describe("each call", () => {
  it("sends its method, path, body and token", async () => {
    const { client, calls, stored } = setup(fakeServer().handle);
    expect(await client.requestCode({ email: "asha@example.com" })).toEqual({ ok: true, data: undefined });
    expect(await client.verifyCode({ email: "asha@example.com", code: "123456" })).toEqual({
      ok: true,
      data: account,
    });
    expect(stored()).toBe("r1");
    await client.me();
    await client.setProfile({ name: "Asha Kulkarni", phone: "+919876543210" });
    await client.changeName({ name: "Asha K" });
    expect(await client.setTheme({ theme: "dark" })).toEqual({ ok: true, data: account });
    await client.signOut();

    expect(calls).toEqual([
      { method: "POST", path: "/v1/auth/code", body: { email: "asha@example.com" }, auth: null },
      { method: "POST", path: "/v1/auth/verify", body: { email: "asha@example.com", code: "123456" }, auth: null },
      { method: "GET", path: "/v1/me", body: undefined, auth: "Bearer a1" },
      {
        method: "PUT",
        path: "/v1/me/profile",
        body: { name: "Asha Kulkarni", phone: "+919876543210" },
        auth: "Bearer a1",
      },
      { method: "PATCH", path: "/v1/me", body: { name: "Asha K" }, auth: "Bearer a1" },
      { method: "PUT", path: "/v1/me/theme", body: { theme: "dark" }, auth: "Bearer a1" },
      { method: "POST", path: "/v1/auth/sign-out", body: undefined, auth: "Bearer a1" },
    ]);
    expect(stored()).toBeNull();
  });

  it("checks a pincode and leaves a number, signed in", async () => {
    const { client, calls } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/waitlist") return answer(204);
      return answer(200, { serviceable: false });
    });
    await client.verifyCode(signIn);
    expect(await client.checkServiceability("411038")).toEqual({ ok: true, data: { serviceable: false } });
    expect(await client.joinWaitlist({ pincode: "411038", phone: "+919876543210" })).toEqual({ ok: true, data: undefined });
    expect(calls.slice(1)).toEqual([
      { method: "GET", path: "/v1/serviceability?pincode=411038", body: undefined, auth: "Bearer a1" },
      { method: "POST", path: "/v1/waitlist", body: { pincode: "411038", phone: "+919876543210" }, auth: "Bearer a1" },
    ]);
  });

  it("searches places and gets a picked one's point, signed in (#257)", async () => {
    const session = "00000000-0000-4000-8000-000000000401";
    const matches = [{ id: "ChIJ-baner_1", title: "Baner Road", detail: "Baner, Pune, Maharashtra" }];
    const point = { latitude: 18.559, longitude: 73.7868 };
    const { client, calls } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path.startsWith("/v1/places?")) return answer(200, { matches });
      return answer(200, { point });
    });
    await client.verifyCode(signIn);
    expect(await client.searchPlaces("Baner Road & Co", session)).toEqual({ ok: true, data: { matches } });
    expect(await client.placePoint("ChIJ-baner_1", session)).toEqual({ ok: true, data: { point } });
    expect(calls.slice(1)).toEqual([
      { method: "GET", path: `/v1/places?text=Baner+Road+%26+Co&session=${session}`, body: undefined, auth: "Bearer a1" },
      { method: "GET", path: `/v1/places/point?id=ChIJ-baner_1&session=${session}`, body: undefined, auth: "Bearer a1" },
    ]);
  });

  it("lists, saves and removes saved addresses, signed in", async () => {
    const saved = {
      id: "00000000-0000-4000-8000-000000000301",
      label: "home",
      flat: "Flat 4B",
      areaLine: "Baner Road, Baner",
      pincode: "411045",
      point: { latitude: 18.559, longitude: 73.7868 },
    } as const;
    const { id, ...body } = saved;
    const { client, calls } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.method === "GET") return answer(200, { addresses: [saved] });
      if (call.method === "POST") return answer(201, saved);
      return answer(204);
    });
    await client.verifyCode(signIn);
    expect(await client.savedAddresses()).toEqual({ ok: true, data: { addresses: [saved] } });
    expect(await client.saveAddress(body)).toEqual({ ok: true, data: saved });
    expect(await client.removeAddress(id)).toEqual({ ok: true, data: undefined });
    expect(calls.slice(1)).toEqual([
      { method: "GET", path: "/v1/me/addresses", body: undefined, auth: "Bearer a1" },
      { method: "POST", path: "/v1/me/addresses", body, auth: "Bearer a1" },
      { method: "DELETE", path: `/v1/me/addresses/${id}`, body: undefined, auth: "Bearer a1" },
    ]);
  });

  it("starts, saves and sends the shop application, signed in", async () => {
    const draft = {
  id: "00000000-0000-4000-8000-000000000401",
  state: "draft",
  shopName: "Sai General Stores",
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
} as const;
    const body = {
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
    } as const;
    const { client, calls } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.method === "GET") return answer(200, { application: null, liveCheck: null });
      return answer(call.method === "POST" && call.path.endsWith("/shop-application") ? 201 : 200, draft);
    });
    await client.verifyCode(signIn);
    expect(await client.shopApplication()).toEqual({ ok: true, data: { application: null, liveCheck: null } });
    expect(await client.startShopApplication()).toEqual({ ok: true, data: draft });
    expect(await client.saveShopApplication({ shopName: "Sai General Stores", pan: null })).toEqual({ ok: true, data: draft });
    expect(await client.sendShopApplication(body)).toEqual({ ok: true, data: draft });
    expect(calls.slice(1)).toEqual([
      { method: "GET", path: "/v1/me/shop-application", body: undefined, auth: "Bearer a1" },
      { method: "POST", path: "/v1/me/shop-application", body: undefined, auth: "Bearer a1" },
      { method: "PATCH", path: "/v1/me/shop-application", body: { shopName: "Sai General Stores", pan: null }, auth: "Bearer a1" },
      { method: "POST", path: "/v1/me/shop-application/send", body, auth: "Bearer a1" },
    ]);
  });

  it("places, lists, reads and cancels orders, and carries the cart a CART_CHANGED answers with (#427, #426)", async () => {
    const shopId = "5b0c7f1e-2a4d-4e8f-9b6a-1c3d5e7f9a0b";
    const orderId = "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e";
    const cart = { shop: { id: shopId, name: "Sai General Stores" }, revision: 3, lines: [], quote: null, placeable: false, reasons: [] };
    const { client, calls } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path.endsWith("/order")) return answer(409, { error: { code: "CART_CHANGED", cart } });
      return answer(409, { error: { code: "ORDER_STATUS_CHANGED" } });
    });
    await client.verifyCode(signIn);
    const body = { revision: 2, total: "482.00", addressId: orderId };
    expect(await client.placeOrder(shopId, body)).toMatchObject({ ok: false, status: 409, code: "CART_CHANGED", cart });
    expect(await client.orders()).toMatchObject({ ok: false, code: "ORDER_STATUS_CHANGED" });
    expect(await client.order(orderId)).toMatchObject({ ok: false, code: "ORDER_STATUS_CHANGED" });
    expect(await client.cancelOrder(orderId)).toMatchObject({ ok: false, code: "ORDER_STATUS_CHANGED" });
    await client.savedAddresses(shopId);
    expect(calls.slice(1).map(({ method, path, body: sent }) => ({ method, path, sent }))).toEqual([
      { method: "POST", path: `/v1/carts/${shopId}/order`, sent: body },
      { method: "GET", path: "/v1/orders", sent: undefined },
      { method: "GET", path: `/v1/orders/${orderId}`, sent: undefined },
      { method: "POST", path: `/v1/orders/${orderId}/cancel`, sent: undefined },
      { method: "GET", path: `/v1/me/addresses?shopId=${shopId}`, sent: undefined },
    ]);
  });

  it("reads, accepts and rejects a shop's order, and carries the short lines NOT_ENOUGH_STOCK answers with (#431)", async () => {
    const orderId = "7d2e9a4c-6b1f-4c3a-8e5d-0f2a4b6c8d1e";
    const shortLines = [{ name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", count: 2, part: null, available: "1" }];
    const { client, calls } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path.endsWith("/accept")) return answer(409, { error: { code: "NOT_ENOUGH_STOCK", shortLines } });
      return answer(409, { error: { code: "ORDER_EXPIRED" } });
    });
    await client.verifyCode(signIn);
    expect(await client.shopOrders()).toMatchObject({ ok: false, code: "ORDER_EXPIRED" });
    expect(await client.shopOrder(orderId)).toMatchObject({ ok: false, code: "ORDER_EXPIRED" });
    expect(await client.acceptOrder(orderId)).toMatchObject({ ok: false, status: 409, code: "NOT_ENOUGH_STOCK", shortLines });
    expect(await client.rejectOrder(orderId, { reason: "too_busy" })).toMatchObject({ ok: false, code: "ORDER_EXPIRED" });
    expect(calls.slice(1).map(({ method, path, body: sent }) => ({ method, path, sent }))).toEqual([
      { method: "GET", path: "/v1/me/shop-orders", sent: undefined },
      { method: "GET", path: `/v1/me/shop-orders/${orderId}`, sent: undefined },
      { method: "POST", path: `/v1/me/shop-orders/${orderId}/accept`, sent: undefined },
      { method: "POST", path: `/v1/me/shop-orders/${orderId}/reject`, sent: { reason: "too_busy" } },
    ]);
  });

  it("reads a pincode in no Area as its code", async () => {
    const { client } = setup((call) =>
      call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(409, { error: { code: "PINCODE_NOT_IN_AREA" } }),
    );
    await client.verifyCode(signIn);
    expect(await client.sendShopApplication({
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
    } as const)).toEqual({ ok: false, status: 409, code: "PINCODE_NOT_IN_AREA" });
  });

  it("reads catalog listings and sends price and opening-stock writes", async () => {
    const id = "00000000-0000-4000-8000-000000000201";
    const item = {
      packId: id, productId: id, name: "Rice", brand: null, baseUnit: "kg", classification: "measured",
      packQuantity: "1", barcode: null, listing: null, stock: "0", held: "0", openingStockRecorded: false, openingStock: "0",
    };
    const listing = { ...item, listing: {
      id, onlinePrice: "20.50", counterPrice: "21", mrp: "25", lowStockLevel: "0", available: true,
      minimumOrderQuantity: "0.25", quantityStep: "0.05", quantityOptions: [],
    } };
    const opening = { listingId: id, quantity: "2.5", recordedAt: "2030-01-01T00:00:00.000Z" };
    const body = {
      onlinePrice: "20.50", counterPrice: "21", mrp: "25", lowStockLevel: "0", available: true,
      minimumOrderQuantity: "0.25", quantityStep: "0.05", quantityOptions: [],
    };
    const { client, calls } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.method === "GET") return answer(200, { items: [item] });
      if (call.method === "PUT") return answer(200, listing);
      return answer(201, opening);
    });
    await client.verifyCode(signIn);
    expect(await client.shopListings()).toEqual({ ok: true, data: { items: [item] } });
    expect(await client.saveShopListing(id, body)).toEqual({ ok: true, data: listing });
    expect(await client.openingStock(id, { quantity: "2.5", clientId: "00000000-0000-4000-8000-000000000202" })).toEqual({ ok: true, data: opening });
    expect(calls.slice(1).map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/v1/me/shop-listings" },
      { method: "PUT", path: `/v1/me/shop-listings/${id}` },
      { method: "POST", path: `/v1/me/shop-listings/${id}/opening-stock` },
    ]);
  });

  it("reads the saved address limit as its code", async () => {
    const { client } = setup((call) =>
      call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(409, { error: { code: "ADDRESS_LIMIT_REACHED" } }),
    );
    await client.verifyCode(signIn);
    expect(
      await client.saveAddress({ label: "other", flat: "2", areaLine: "Baner", pincode: "411045", point: null }),
    ).toEqual({ ok: false, status: 409, code: "ADDRESS_LIMIT_REACHED" });
  });

  it("reads a serviceable pincode with its Area name", async () => {
    const { client } = setup((call) =>
      call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, { serviceable: true, areaName: "Kothrud" }),
    );
    await client.verifyCode(signIn);
    expect(await client.checkServiceability("411038")).toEqual({ ok: true, data: { serviceable: true, areaName: "Kothrud" } });
  });

  it("asks the feed with the pincode and the pin (#369)", async () => {
    const shop = { id: "8f7c3a52-2a3e-4e0b-9f1d-3c5b7a6e4d21", name: "Sai General Stores", estimatedMinutes: 15, deliveryFee: "30.00", open: false, opensAt: "2030-01-02T03:30:00.000Z", holiday: false };
    const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, { shops: [shop] }));
    await client.verifyCode(signIn);
    expect(await client.feed({ pincode: "411038", latitude: 18.5, longitude: 73.8 })).toEqual({ ok: true, data: { shops: [shop] } });
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/feed?pincode=411038&latitude=18.5&longitude=73.8" });
  });

  it("asks for a shop page with the same query and passes on a shop that can't serve (#370)", async () => {
    const id = "8f7c3a52-2a3e-4e0b-9f1d-3c5b7a6e4d21";
    const page = {
      shop: {
        id, name: "Sai General Stores", estimatedMinutes: 15, deliveryFee: "30", open: true, opensAt: null, holiday: false, minimumOrder: "100",
        fssaiNumber: "11223344556677", closesAt: null, hours: [{ weekday: 2, opens: 540, closes: 1260 }], today: 2, holidays: [],
      },
      groups: [{ category: "Groceries", products: [{ id, name: "Toor Dal", brand: null, baseUnit: "kg", imageUrl: null, packs: [
        { listingId: id, quantity: "1", price: "135.00", mrp: "150.00", discountPercent: "10.00", outOfStock: false, part: null },
      ] }] }],
    };
    let found = true;
    const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : found ? answer(200, page) : answer(404, { error: { code: "NOT_FOUND" } }));
    await client.verifyCode(signIn);
    const here = { pincode: "411038", latitude: 18.5, longitude: 73.8 };
    expect(await client.shopPage(id, here)).toEqual({ ok: true, data: page });
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: `/v1/shops/${id}?pincode=411038&latitude=18.5&longitude=73.8` });
    found = false;
    expect(await client.shopPage(id, here)).toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
  });

  it("searches with the pincode, the pin and the typed text (#398)", async () => {
    const id = "8f7c3a52-2a3e-4e0b-9f1d-3c5b7a6e4d21";
    const shop = { id, name: "Sai General Stores", estimatedMinutes: 15, deliveryFee: "30", open: true, opensAt: null, holiday: false,
      products: [{ id, name: "Toor Dal", brand: "Tata", inStock: true }], moreProducts: 2 };
    const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, { shops: [shop] }));
    await client.verifyCode(signIn);
    expect(await client.search({ pincode: "411038", latitude: 18.5, longitude: 73.8, q: "arhar dal" })).toEqual({ ok: true, data: { shops: [shop] } });
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/search?pincode=411038&latitude=18.5&longitude=73.8&q=arhar+dal" });
  });

  it("reads and saves a cart with the place, and passes on an old revision (#405)", async () => {
    const id = "8f7c3a52-2a3e-4e0b-9f1d-3c5b7a6e4d21";
    const cart = {
      shop: { id, name: "Sai General Stores" }, revision: 1,
      lines: [{ listingId: id, name: "Toor Dal", brand: null, baseUnit: "kg", quantity: "1", price: "135.00", count: 2, state: "orderable", part: null, left: null, lineTotal: "270.00" }],
      quote: { productValue: "270.00", deliveryFee: "30.00", smallCartFee: null, total: "300.00" }, placeable: true, reasons: [],
    };
    let changed = false;
    const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : changed ? answer(409, { error: { code: "CART_CHANGED" } }) : answer(200, cart));
    await client.verifyCode(signIn);
    const here = { pincode: "411038", latitude: 18.5, longitude: 73.8 };
    expect(await client.cart(id, here)).toEqual({ ok: true, data: cart });
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: `/v1/carts/${id}?pincode=411038&latitude=18.5&longitude=73.8` });
    const body = { revision: 0, lines: [{ listingId: id, count: 2 }] };
    expect(await client.saveCart(id, here, body)).toEqual({ ok: true, data: cart });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", path: `/v1/carts/${id}?pincode=411038&latitude=18.5&longitude=73.8`, body });
    changed = true;
    expect(await client.saveCart(id, here, body)).toEqual({ ok: false, status: 409, code: "CART_CHANGED" });
  });

  it("reads and saves the Owner's opening hours (#371)", async () => {
    const ranges = [{ weekday: 1, opens: 540, closes: 1260 }];
    const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, { ranges }));
    await client.verifyCode(signIn);
    expect(await client.shopHours()).toEqual({ ok: true, data: { ranges } });
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/me/shop-hours" });
    expect(await client.saveShopHours({ ranges })).toEqual({ ok: true, data: { ranges } });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", path: "/v1/me/shop-hours", body: { ranges } });
  });

  it("reads and sets the Owner's open/closed switch (#380)", async () => {
    const status = { open: false, until: "2030-01-02T03:30:00.000Z", setByOwner: true, scheduledOpen: true, nextOpening: "2030-01-02T03:30:00.000Z" };
    const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, status));
    await client.verifyCode(signIn);
    expect(await client.shopOpen()).toEqual({ ok: true, data: status });
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/me/shop-open" });
    expect(await client.setShopOpen({ open: false })).toEqual({ ok: true, data: status });
    expect(calls.at(-1)).toMatchObject({ method: "PUT", path: "/v1/me/shop-open", body: { open: false } });
  });

  it("reads, adds, edits and removes the Owner's holidays (#382)", async () => {
    const id = "8f7c3a52-2a3e-4e0b-9f1d-3c5b7a6e4d21";
    const list = { upcoming: [{ id, starts: "2030-01-05", ends: "2030-01-06" }], past: [] };
    const dates = { starts: "2030-01-05", ends: "2030-01-06" };
    const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, list));
    await client.verifyCode(signIn);
    expect(await client.shopHolidays()).toEqual({ ok: true, data: list });
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/me/shop-holidays" });
    expect(await client.saveShopHoliday(dates)).toEqual({ ok: true, data: list });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/v1/me/shop-holidays", body: dates });
    await client.saveShopHoliday(dates, id);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", path: `/v1/me/shop-holidays/${id}`, body: dates });
    expect(await client.removeShopHoliday(id)).toEqual({ ok: true, data: list });
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", path: `/v1/me/shop-holidays/${id}` });
  });

  it("counts a sign-in answer that breaks the contract as INTERNAL and keeps no session", async () => {
    const { client, stored } = setup(() => answer(200, { accessToken: "a1", account }));
    expect(await client.verifyCode({ email: "asha@example.com", code: "123456" })).toEqual({
      ok: false,
      status: 200,
      code: "INTERNAL",
    });
    expect(stored()).toBeNull();
  });

  it("passes on a refused code", async () => {
    const { client } = setup(() => answer(400, { error: { code: "CODE_WRONG" } }));
    expect(await client.verifyCode({ email: "asha@example.com", code: "123456" })).toEqual({
      ok: false,
      status: 400,
      code: "CODE_WRONG",
    });
  });

  it("keeps no session when the phone cannot save it", async () => {
    const { client, calls, failNext, onSaveFailed } = setup(fakeServer().handle);
    failNext("set");
    await expect(client.verifyCode(signIn)).rejects.toThrow("Keychain unavailable");
    expect(onSaveFailed).not.toHaveBeenCalled();
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/verify"]);
  });

  it("keeps a sign-in the phone could not save when a call has refreshed it meanwhile, since that saves its own", async () => {
    const { client, calls, sets, holdNextSet, failNext, stored } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(10));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(11));
      return call.auth === "Bearer a10" ? answer(401, unauthenticated) : answer(200, account);
    });
    const release = holdNextSet();
    failNext("set");
    const signingIn = client.verifyCode(signIn);
    await vi.waitFor(() => expect(sets).toEqual(["r10"]));
    expect(await client.me()).toEqual({ ok: true, data: account });
    release();

    await expect(signingIn).rejects.toThrow("Keychain unavailable");
    await vi.waitFor(() => expect(stored()).toBe("r11"));
    const sent = calls.length;
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls.slice(sent).map((call) => call.auth)).toEqual(["Bearer a11"]);
  });

  it("refuses to sign in without a session store", async () => {
    const client = createApiClient({ baseUrl: "https://api.test", fetch: () => Promise.resolve(answer(200, pair(1))) });
    await expect(client.verifyCode({ email: "asha@example.com", code: "123456" })).rejects.toThrow(
      "session store",
    );
  });
});

describe("refresh", () => {
  it("refreshes once when the access token has expired, and the call succeeds", async () => {
    const server = fakeServer();
    const { client, calls, refreshes, stored } = setup(server.handle);
    await client.verifyCode({ email: "asha@example.com", code: "123456" });
    server.expire();

    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(refreshes()).toBe(1);
    expect(calls.find((call) => call.path === "/v1/auth/refresh")?.body).toEqual({ refreshToken: "r1" });
    expect(calls.at(-1)?.auth).toBe("Bearer a2");
    expect(stored()).toBe("r2");
  });

  it("shares one refresh between three calls refused together", async () => {
    const server = fakeServer();
    const { client, refreshes } = setup(server.handle);
    await client.verifyCode({ email: "asha@example.com", code: "123456" });
    server.expire();

    const results = await Promise.all([client.me(), client.me(), client.changeName({ name: "Asha K" })]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(refreshes()).toBe(1);
  });

  it("refreshes before the first call when only the saved token is left, as when the app has just opened", async () => {
    const { client, calls } = setup(fakeServer().handle, "r0");
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/refresh", "/v1/me"]);
    expect(calls[0]?.body).toEqual({ refreshToken: "r0" });
  });

  it("answers UNAUTHENTICATED without calling the server when there is no session", async () => {
    const { client, calls, onSignedOut } = setup(fakeServer().handle);
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls).toEqual([]);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("clears the store and calls onSignedOut when the server refuses the refresh token", async () => {
    const { client, stored, onSignedOut } = setup(() => answer(401, unauthenticated), "r0");
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(stored()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("clears the store when the server says the refresh token is malformed", async () => {
    const { client, stored, onSignedOut } = setup(
      () => answer(400, { error: { code: "VALIDATION_FAILED", fields: ["refreshToken"] } }),
      "r0",
    );
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(stored()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("keeps the saved token when a 400 does not name it", async () => {
    const { client, stored, onSignedOut } = setup(
      () => answer(400, { error: { code: "VALIDATION_FAILED", fields: ["email"] } }),
      "r0",
    );
    expect(await client.me()).toEqual({ ok: false, status: 400, code: "INTERNAL" });
    expect(stored()).toBe("r0");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("clears the store when a refresh succeeds but breaks the contract, since the saved token is used up", async () => {
    const { client, calls, stored, onSignedOut } = setup(() => answer(200, { accessToken: "a1", account }), "r0");
    expect(await client.me()).toEqual({ ok: false, status: 200, code: "INTERNAL" });
    expect(stored()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    // Trying again doesn't send the used-up token.
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls).toHaveLength(1);
  });

  it("keeps the saved token when a refresh failure is not JSON, so trying again refreshes with it", async () => {
    const fake = fakeServer();
    let refreshes = 0;
    const { client, calls, stored, onSignedOut } = setup((call) => {
      if (call.path === "/v1/auth/refresh" && ++refreshes === 1) return new Response("<html>Bad gateway</html>", { status: 502 });
      return fake.handle(call);
    }, "r0");
    expect(await client.me()).toEqual({ ok: false, status: 502, code: "INTERNAL" });
    expect(stored()).toBe("r0");
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls.map((call) => call.body)).toEqual([{ refreshToken: "r0" }, { refreshToken: "r0" }, undefined]);
    expect(stored()).toBe("r2");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("rejects a call when the phone cannot read the saved token, and the next call reads it again", async () => {
    const { client, calls, failNext } = setup(fakeServer().handle, "r0");
    failNext("get");
    await expect(client.me()).rejects.toThrow("Keychain unavailable");
    expect(calls).toEqual([]);
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls[0]?.body).toEqual({ refreshToken: "r0" });
  });

  it("reads the saved token once per launch, then refreshes with the newest one in memory", async () => {
    const server = fakeServer();
    const { client, calls, reads } = setup(server.handle, "r0");
    await client.me();
    server.expire();
    await client.me();
    expect(reads()).toBe(1);
    expect(calls.filter((call) => call.path === "/v1/auth/refresh").map((call) => call.body)).toEqual([
      { refreshToken: "r0" },
      { refreshToken: "r2" },
    ]);
  });

  it("lets calls go on with the new access token before the phone has saved the refresh token", async () => {
    const { client, holdNextSet, stored } = setup(fakeServer().handle, "r0");
    const release = holdNextSet();
    const ok = { ok: true, data: account };
    expect(await Promise.all([client.me(), client.changeName({ name: "Asha K" })])).toEqual([ok, ok]);
    expect(stored()).toBe("r0");
    release();
    await vi.waitFor(() => expect(stored()).toBe("r2"));
  });

  it("goes on when the phone cannot save a refreshed token, and the next refresh saves again", async () => {
    const server = fakeServer();
    const { client, calls, failNext, stored, onSaveFailed } = setup(server.handle, "r0");
    failNext("set");
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(stored()).toBe("r0");
    await vi.waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1));
    expect(onSaveFailed).toHaveBeenCalledWith(new Error("Keychain unavailable"));
    server.expire();
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls.at(-1)?.auth).toBe("Bearer a3");
    await vi.waitFor(() => expect(stored()).toBe("r3"));
    expect(onSaveFailed).toHaveBeenCalledTimes(1);
  });

  it("tries the refusal and the clear again when the phone could not clear a refused token", async () => {
    const { client, refreshes, failNext, stored, onSignedOut } = setup(() => answer(401, unauthenticated), "r0");
    failNext("clear");
    await expect(client.me()).rejects.toThrow("Keychain unavailable");
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(refreshes()).toBe(2);
    expect(stored()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("shares a failed refresh too, so calls refused together do not refresh twice", async () => {
    const { client, refreshes } = setup(() => answer(503, { error: { code: "UNAVAILABLE" } }), "r0");
    const results = await Promise.all([client.me(), client.changeName({ name: "Asha K" })]);
    expect(results).toEqual([
      { ok: false, status: 503, code: "UNAVAILABLE" },
      { ok: false, status: 503, code: "UNAVAILABLE" },
    ]);
    expect(refreshes()).toBe(1);
  });

  it("keeps the saved token when there is no network", async () => {
    const { client, stored, onSignedOut } = setup(() => Promise.reject(new TypeError("Network request failed")), "r0");
    await expect(client.me()).rejects.toThrow("Network request failed");
    expect(stored()).toBe("r0");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("keeps the saved token and passes on the answer when the server is down", async () => {
    const { client, stored, onSignedOut } = setup(() => answer(503, { error: { code: "UNAVAILABLE" } }), "r0");
    expect(await client.me()).toEqual({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(stored()).toBe("r0");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("passes on a call still refused after a refresh, without refreshing again", async () => {
    // Signs in and refreshes, but refuses every other call.
    const { client, refreshes } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(2));
      return answer(401, unauthenticated);
    });
    await client.verifyCode({ email: "asha@example.com", code: "123456" });
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(refreshes()).toBe(1);
  });

  it("passes on two calls refused together and still refused after their shared refresh", async () => {
    const { client, calls, refreshes } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(2));
      return answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);
    const results = await Promise.all([client.me(), client.changeName({ name: "Asha K" })]);
    expect(results).toEqual([
      { ok: false, status: 401, code: "UNAUTHENTICATED" },
      { ok: false, status: 401, code: "UNAUTHENTICATED" },
    ]);
    expect(refreshes()).toBe(1);
    expect(calls.map((call) => call.auth)).toEqual([null, "Bearer a1", "Bearer a1", null, "Bearer a2", "Bearer a2"]);
  });

  it("sends a call refused after the refresh has landed again with the new token, without refreshing again", async () => {
    const server = holds();
    const fake = fakeServer();
    const { client, calls, refreshes } = setup(async (call) => {
      if (call.auth === "Bearer a1") await server.hold(call.path);
      return fake.handle(call);
    });
    await client.verifyCode(signIn);
    fake.expire();

    const loading = client.me();
    const saving = client.setProfile({ name: "Asha Kulkarni", phone: "+919876543210" });
    await vi.waitFor(() => expect(server.waiting()).toBe(2));
    server.release("/v1/me");
    expect(await loading).toEqual({ ok: true, data: account });
    server.release("/v1/me/profile");
    expect(await saving).toEqual({ ok: true, data: account });

    expect(refreshes()).toBe(1);
    expect(calls.at(-1)).toMatchObject({ path: "/v1/me/profile", auth: "Bearer a2" });
  });

  it("refreshes once at most, so a call refused after refreshing first sends two requests, not four", async () => {
    const { client, calls } = setup(
      (call) => (call.path === "/v1/auth/refresh" ? answer(200, pair(1)) : answer(401, unauthenticated)),
      "r0",
    );
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/refresh", "/v1/me"]);
  });
});

describe("signOut", () => {
  it("clears the store when the network is down", async () => {
    const { client, stored, onSignedOut } = setup(() => Promise.reject(new TypeError("Network request failed")), "r0");
    await client.signOut();
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("does not call onSignedOut when the session had already ended", async () => {
    const { client, stored, onSignedOut } = setup(() => answer(401, unauthenticated), "r0");
    await client.signOut();
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("fires onUpdateRequired when the server refuses this version", async () => {
    const { client, stored, onUpdateRequired } = setup(() => answer(426, { error: { code: "UPDATE_REQUIRED" } }), "r0");
    await client.signOut();
    expect(onUpdateRequired).toHaveBeenCalledTimes(1);
    expect(stored()).toBeNull();
  });

  it("answers a call made while it runs as signed out, without asking the server", async () => {
    const server = holds();
    const fake = fakeServer();
    const { client, calls, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/sign-out") await server.hold(call.path);
      return fake.handle(call);
    });
    await client.verifyCode(signIn);

    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    server.release("/v1/auth/sign-out");
    await signingOut;

    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/verify", "/v1/auth/sign-out"]);
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("does not refresh for a call begun before it and refused while it runs", async () => {
    const server = holds();
    const { client, refreshes, stored } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(2));
      await server.hold(call.path);
      return call.path === "/v1/auth/sign-out" ? answer(204) : answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);

    const loading = client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(2));
    server.release("/v1/me");
    expect(await loading).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    server.release("/v1/auth/sign-out");
    await signingOut;

    expect(refreshes()).toBe(0);
    expect(stored()).toBeNull();
  });

  it("rejects when the phone cannot clear the saved token, and leaves later calls signed out", async () => {
    const { client, calls, failNext } = setup(fakeServer().handle);
    await client.verifyCode(signIn);
    failNext("clear");
    await expect(client.signOut()).rejects.toThrow("Keychain unavailable");
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/verify", "/v1/auth/sign-out"]);
  });

  it("leaves later calls signed out", async () => {
    const { client } = setup(fakeServer().handle);
    await client.verifyCode({ email: "asha@example.com", code: "123456" });
    await client.signOut();
    expect(await client.me()).toEqual({ ok: false, status: 401, code: "UNAUTHENTICATED" });
  });
});

describe("a sign-in or sign-out during another change", () => {
  const signedOut = { ok: false, status: 401, code: "UNAUTHENTICATED" };
  /** Lets every answer and store write already released finish. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("a sign-out while a refresh is saving its token clears the store after the save", async () => {
    const server = fakeServer();
    const { client, calls, sets, holdNextSet, stored, onSignedOut } = setup(server.handle);
    await client.verifyCode(signIn);
    server.expire();
    const release = holdNextSet();

    // `me` goes on with the refreshed token without waiting for the save.
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(sets).toEqual(["r1", "r2"]);
    const signingOut = client.signOut();
    await settle();
    expect(stored()).toBe("r1");
    release();
    await signingOut;

    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(await client.me()).toEqual(signedOut);
    expect(calls.filter((call) => call.path === "/v1/auth/sign-out").map((call) => call.auth)).toEqual([
      "Bearer a2",
    ]);
  });

  it("a newer sign-in while a refresh is saving its token keeps the newer session", async () => {
    let signIns = 0;
    const { client, calls, sets, holdNextSet, stored } = setup((call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(++signIns * 10));
      if (call.path === "/v1/auth/refresh") return answer(200, pair(11));
      if (call.auth === "Bearer a10") return answer(401, unauthenticated);
      return answer(200, account);
    });
    await client.verifyCode(signIn);
    const release = holdNextSet();

    // The call goes on with the refreshed token while the phone saves it.
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(sets).toEqual(["r10", "r11"]);
    const signingIn = client.verifyCode(signIn);
    await settle();
    release();

    expect(await signingIn).toEqual({ ok: true, data: account });
    // The older write lands first.
    expect(sets).toEqual(["r10", "r11", "r20"]);
    expect(stored()).toBe("r20");
    await client.me();
    expect(calls.at(-1)?.auth).toBe("Bearer a20");
  });

  it("drops a sign-in answer that arrives after sign-out", async () => {
    const server = holds();
    const { client, calls, stored } = setup(async (call) => {
      await server.hold(call.path);
      return answer(200, pair(1));
    });

    const signingIn = client.verifyCode(signIn);
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    await client.signOut();
    server.release("/v1/auth/verify");

    expect(await signingIn).toEqual(signedOut);
    expect(stored()).toBeNull();
    expect(await client.me()).toEqual(signedOut);
    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/verify"]);
  });

  it("a sign-out does not clear a sign-in begun after it", async () => {
    const server = holds();
    let signIns = 0;
    const { client, calls, stored } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(++signIns));
      if (call.path === "/v1/auth/sign-out") {
        await server.hold(call.path);
        return answer(204);
      }
      return answer(200, account);
    });
    await client.verifyCode(signIn);

    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    expect(await client.verifyCode(signIn)).toEqual({ ok: true, data: account });
    server.release("/v1/auth/sign-out");
    await signingOut;

    expect(stored()).toBe("r2");
    await client.me();
    expect(calls.at(-1)?.auth).toBe("Bearer a2");
  });

  it("keeps a sign-in begun during a sign-out that answers after the sign-out ends", async () => {
    const server = holds();
    let signIns = 0;
    const { client, stored } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") {
        if (++signIns === 2) await server.hold(call.path);
        return answer(200, pair(signIns));
      }
      if (call.path === "/v1/auth/sign-out") {
        await server.hold(call.path);
        return answer(204);
      }
      return answer(200, account);
    });
    await client.verifyCode(signIn);

    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    const signingIn = client.verifyCode(signIn);
    await vi.waitFor(() => expect(server.waiting()).toBe(2));
    server.release("/v1/auth/sign-out");
    await signingOut;
    server.release("/v1/auth/verify");

    expect(await signingIn).toEqual({ ok: true, data: account });
    expect(stored()).toBe("r2");
    expect(await client.me()).toEqual({ ok: true, data: account });
  });

  it("calls onSignedOut when a sign-in kept during an older sign-out then ends", async () => {
    const server = holds();
    const { client, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/sign-out") {
        await server.hold(call.path);
        return answer(204);
      }
      return answer(401, unauthenticated);
    });
    await client.verifyCode(signIn);

    const signingOut = client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    await client.verifyCode(signIn);
    expect(await client.me()).toEqual(signedOut);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    server.release("/v1/auth/sign-out");
    await signingOut;

    expect(stored()).toBeNull();
  });

  it("a refresh that answers after a newer sign-in changes nothing", async () => {
    const server = holds();
    const { client, calls, sets, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") {
        await server.hold(call.path);
        return answer(200, pair(9));
      }
      return answer(200, account);
    }, "r0");

    const opening = client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    await client.verifyCode(signIn);
    server.release("/v1/auth/refresh");

    // The call begun before the sign-in is not sent with either session's token.
    expect(await opening).toEqual(signedOut);
    expect(sets).toEqual(["r1"]);
    expect(stored()).toBe("r1");
    await client.me();
    expect(calls.at(-1)?.auth).toBe("Bearer a1");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("a call after a sign-in does not wait for a refresh begun before it", async () => {
    const server = holds();
    const { client } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      if (call.path === "/v1/auth/refresh") {
        await server.hold(call.path);
        throw new TypeError("Network request failed");
      }
      return answer(200, account);
    }, "r0");

    const opening = client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    await client.verifyCode(signIn);
    let loaded = false;
    const loading = client.me().finally(() => (loaded = true));
    await vi.waitFor(() => expect(loaded).toBe(true));
    server.release("/v1/auth/refresh");

    expect(await loading).toEqual({ ok: true, data: account });
    await expect(opening).rejects.toThrow("Network request failed");
  });

  it("a sign-out tapped twice does not count as the session ending by itself", async () => {
    const server = holds();
    const { client, calls, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      await server.hold(call.path);
      return answer(call.path === "/v1/auth/sign-out" ? 204 : 401, unauthenticated);
    });
    await client.verifyCode(signIn);

    const first = client.signOut();
    // The second has no session left to end, so it asks the server nothing.
    await client.signOut();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    server.release("/v1/auth/sign-out");
    await first;

    expect(calls.map((call) => call.path)).toEqual(["/v1/auth/verify", "/v1/auth/sign-out"]);
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(stored()).toBeNull();
  });

  it("clears the store when a sign-in kept during a sign-out could not be saved", async () => {
    const { client, failNext, stored, server, signingOut } = await signOutWaitingOnRefresh(false);
    failNext("set");
    await expect(client.verifyCode(signIn)).rejects.toThrow("Keychain unavailable");
    server.release("/v1/auth/refresh");
    await signingOut;
    expect(stored()).toBeNull();
  });

  it("a sign-out tapped twice still clears the store when the second clear fails", async () => {
    const server = holds();
    const { client, failNext, stored } = setup(async (call) => {
      if (call.path === "/v1/auth/verify") return answer(200, pair(1));
      await server.hold(call.path);
      return answer(204);
    });
    await client.verifyCode(signIn);
    const first = client.signOut();
    failNext("clear");
    await expect(client.signOut()).rejects.toThrow("Keychain unavailable");
    expect(stored()).toBe("r1");
    server.release("/v1/auth/sign-out");
    await first;
    expect(stored()).toBeNull();
  });

  /** Signs in as pair 10, then holds a sign-out behind a refresh to pair 11 under way. */
  async function signOutWaitingOnRefresh(holdSecondSignIn: boolean) {
    const server = holds();
    let signIns = 0;
    const handle = async (call: Call) => {
      if (call.path === "/v1/auth/verify") {
        if (++signIns === 2 && holdSecondSignIn) await server.hold(call.path);
        return answer(200, pair(signIns * 10));
      }
      if (call.path === "/v1/auth/refresh") {
        await server.hold(call.path);
        return answer(200, pair(11));
      }
      if (call.path === "/v1/auth/sign-out") return answer(204);
      return call.auth === "Bearer a10" ? answer(401, unauthenticated) : answer(200, account);
    };
    const client = setup(handle);
    await client.client.verifyCode(signIn);
    const loading = client.client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    const signingOut = client.client.signOut();
    return { ...client, server, loading, signingOut };
  }

  it("keeps a sign-in begun while a sign-out waits for a refresh, that answers after the sign-out", async () => {
    const { client, calls, stored, server, loading, signingOut } = await signOutWaitingOnRefresh(true);
    const signingIn = client.verifyCode(signIn);
    await vi.waitFor(() => expect(server.waiting()).toBe(2));
    server.release("/v1/auth/refresh");
    await signingOut;
    server.release("/v1/auth/verify");

    expect(await signingIn).toEqual({ ok: true, data: account });
    expect(await loading).toEqual(signedOut);
    expect(stored()).toBe("r20");
    expect(calls.find((call) => call.path === "/v1/auth/sign-out")?.auth).toBe("Bearer a11");
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls.at(-1)?.auth).toBe("Bearer a20");
  });

  it("a sign-in kept while a sign-out waits for a refresh is not signed out by it", async () => {
    const { client, calls, stored, server, signingOut } = await signOutWaitingOnRefresh(false);
    expect(await client.verifyCode(signIn)).toEqual({ ok: true, data: account });
    expect(stored()).toBe("r20");
    server.release("/v1/auth/refresh");
    await signingOut;

    expect(stored()).toBe("r20");
    expect(calls.find((call) => call.path === "/v1/auth/sign-out")?.auth).toBe("Bearer a11");
    expect(await client.me()).toEqual({ ok: true, data: account });
    expect(calls.at(-1)?.auth).toBe("Bearer a20");
  });

  it("a sign-out while the app is opening tells the server, with the refreshed token", async () => {
    const server = holds();
    const { client, calls, refreshes, stored, onSignedOut } = setup(async (call) => {
      if (call.path === "/v1/auth/refresh") {
        await server.hold(call.path);
        return answer(200, pair(1));
      }
      if (call.path === "/v1/auth/sign-out") return answer(204);
      return answer(200, account);
    }, "r0");

    const opening = client.me();
    await vi.waitFor(() => expect(server.waiting()).toBe(1));
    const signingOut = client.signOut();
    server.release("/v1/auth/refresh");
    await signingOut;
    await opening;

    expect(calls.filter((call) => call.path === "/v1/auth/sign-out")).toEqual([
      { method: "POST", path: "/v1/auth/sign-out", body: undefined, auth: "Bearer a1" },
    ]);
    expect(refreshes()).toBe(1);
    expect(stored()).toBeNull();
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});


describe("ACC-1 provider sessions", () => {
  const identity = { provider: "google" as const, nonce: "a".repeat(64), identityToken: "signed-token" };
  it("saves the provider session and uses its ordinary access token", async () => {
    const h = setup((call) => call.path === "/v1/auth/identity" ? answer(200, pair(1)) : answer(200, account));
    expect(await h.client.verifyIdentity(identity)).toEqual({ ok: true, data: account });
    expect(h.sets).toEqual(["r1"]);
    await h.client.me();
    expect(h.calls.at(-1)?.auth).toBe("Bearer a1");
  });
  it("keeps tokens out of mailbox-challenge results and does not save a session", async () => {
    const h = setup(() => answer(200, { emailVerificationRequired: "asha@example.com" }));
    expect(await h.client.verifyIdentity(identity)).toEqual({ ok: true, data: { emailVerificationRequired: "asha@example.com" } });
    expect(h.sets).toEqual([]);
  });
  it("discards a provider response arriving after sign-out", async () => {
    let release!: (response: Response) => void;
    const h = setup((call) => call.path === "/v1/auth/identity" ? new Promise((resolve) => { release = resolve; }) : answer(204));
    const signing = h.client.verifyIdentity(identity);
    await h.client.signOut();
    release(answer(200, pair(1)));
    expect(await signing).toMatchObject({ ok: false, code: "UNAUTHENTICATED" });
    expect(h.sets).toEqual([]);
  });
  it("reports a secure-storage failure instead of announcing sign-in", async () => {
    const h = setup(() => answer(200, pair(1)));
    h.failNext("set");
    await expect(h.client.verifyIdentity(identity)).rejects.toThrow("Keychain unavailable");
  });
});

it("pushes ordered actions with authentication and validates per-action results", async () => {
  const id = "00000000-0000-4000-8000-000000000391";
  const body = { deviceId: id, sentAt: "2030-01-01T00:00:00.000Z", actions: [{ id, sequence: 1, shopId: id,
    type: "opening_stock", payload: { packId: id, quantity: "2" }, createdAt: "2030-01-01T00:00:00.000Z", clockSuspect: false }] };
  const data = { results: [{ actionId: id, sequence: 1, status: "rejected", code: "ACTION_TOO_OLD", result: null, clockSuspect: false }] };
  const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, data));
  await client.verifyCode(signIn);
  expect(await client.syncActions(body)).toEqual({ ok: true, data });
  expect(calls.at(-1)).toEqual({ method: "POST", path: "/v1/sync/actions", auth: "Bearer a1", body });
});

it("reads linked shop Stock with authentication and validates its response", async () => {
  const data = { shopId: "00000000-0000-4000-8000-000000000392", state: "suspended", items: [] };
  const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, data));
  await client.verifyCode({ email: "a@example.com", code: "123456" });
  expect(await client.shopStock()).toEqual({ ok: true, data });
  expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/me/stock", auth: "Bearer a1" });
});

it("pulls authenticated Stock deltas with an encoded cursor and validates the response", async () => {
  const id = "00000000-0000-4000-8000-000000000393";
  const data = { shopId: id, state: "live", cursor: `${id}:2`, changes: [] };
  const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, data));
  await client.verifyCode(signIn);
  expect(await client.syncChanges()).toEqual({ ok: true, data });
  expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/sync/changes", auth: "Bearer a1" });
  expect(await client.syncChanges(`${id}:1`)).toEqual({ ok: true, data });
  expect(calls.at(-1)?.path).toBe(`/v1/sync/changes?since=${id}%3A1`);
});

it("checks authenticated shop access independently of catalog readiness", async () => {
  const data = { shopId: "00000000-0000-4000-8000-000000000394", state: "closed" };
  const { client, calls } = setup((call) => call.path === "/v1/auth/verify" ? answer(200, pair(1)) : answer(200, data));
  await client.verifyCode(signIn);
  expect(await client.syncAccess()).toEqual({ ok: true, data });
  expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/v1/sync/access", auth: "Bearer a1" });
});

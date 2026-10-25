import type { SaveAddressBody } from "@ygo/contracts";
import type { AddressAt } from "@ygo/mobile";
import { describe, expect, it } from "vitest";
import type { AreaAnswer, Place } from "../src/lib/location-flow";
import { addressBody, confirmAddress, type Geocoder, readPin, searchPlaces } from "../src/lib/map-place";

const shivajiNagar = { latitude: 18.5196, longitude: 73.8399 };
// What @ygo/mobile's addressAt answers for Prabhat Road (its own tests cover the phone's lookup).
const prabhat = (point = shivajiNagar): AddressAt => ({
  point,
  pincode: "411005",
  street: "Prabhat Road",
  district: "Shivaji Nagar",
  city: "Pune",
  line: "Prabhat Road, Shivaji Nagar, Pune",
});
const geocoder = (find: Geocoder["find"], addressAt: Geocoder["addressAt"] = async (point) => prabhat(point)): Geocoder => ({
  find,
  addressAt,
});

describe("readPin", () => {
  it("names the spot from the address there", async () => {
    expect(await readPin(geocoder(async () => []), shivajiNagar)).toEqual({
      place: {
        pincode: "411005",
        name: "Shivaji Nagar",
        areaLine: "Prabhat Road, Shivaji Nagar, Pune",
        point: shivajiNagar,
      },
      title: "Prabhat Road, Shivaji Nagar",
      detail: "Pune 411005",
    });
  });

  it("falls back to the city when the street or locality is missing, and cuts the area line to 200", async () => {
    const cityOnly = await readPin(geocoder(async () => [], async () => ({ ...prabhat(), street: null, district: null, line: "Pune" })), shivajiNagar);
    expect(cityOnly).toMatchObject({ place: { name: "Pune", areaLine: "Pune" }, title: "Pune", detail: "Pune 411005" });
    const long = await readPin(geocoder(async () => [], async () => ({ ...prabhat(), line: `${"x".repeat(199)} y` })), shivajiNagar);
    expect(long?.place.areaLine).toBe("x".repeat(199));
  });

  it("is null when no address there fits", async () => {
    expect(await readPin(geocoder(async () => [], async () => null), shivajiNagar)).toBeNull();
  });
});

describe("searchPlaces", () => {
  it("is empty when nothing is found, so C15 shows the no-results message", async () => {
    expect(await searchPlaces(geocoder(async () => []), "Nowhere")).toEqual([]);
    expect(await searchPlaces(geocoder(() => Promise.reject(new Error("no results"))), "Nowhere")).toEqual([]);
  });

  it("lists a single match, so it is seen before the map", async () => {
    const spots = await searchPlaces(geocoder(async () => [shivajiNagar]), "  Prabhat Road  ");
    expect(spots).toHaveLength(1);
    expect(spots[0]?.title).toBe("Prabhat Road, Shivaji Nagar");
  });

  it("searches the trimmed text, takes at most 5 matches, and drops those with no address", async () => {
    let searched = "";
    const points = Array.from({ length: 7 }, (_, i) => ({ latitude: 18.5 + i / 100, longitude: 73.8 }));
    const spots = await searchPlaces(
      geocoder(
        async (text) => {
          searched = text;
          return points;
        },
        async (point) => (point.latitude === 18.51 ? null : { ...prabhat(point), street: `Road ${point.latitude}` }),
      ),
      " 411005 ",
    );
    expect(searched).toBe("411005");
    expect(spots.map((spot) => spot.place.point?.latitude)).toEqual([18.5, 18.52, 18.53, 18.54]);
  });

  it("lists matches that name the same place once", async () => {
    const spots = await searchPlaces(geocoder(async () => [shivajiNagar, { ...shivajiNagar, latitude: 18.52 }]), "411005");
    expect(spots).toHaveLength(1);
    expect(spots[0]?.place.point).toEqual(shivajiNagar);
  });

  it("looks the matches up one at a time", async () => {
    let running = 0;
    let most = 0;
    const slow = async (point: AddressAt["point"]) => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return prabhat(point);
    };
    await searchPlaces(geocoder(async () => [shivajiNagar, shivajiNagar, shivajiNagar], slow), "Pune");
    expect(most).toBe(1);
  });
});

describe("addressBody", () => {
  const pinned: Place = { pincode: "411005", areaLine: "Prabhat Road, Shivaji Nagar, Pune", point: shivajiNagar };

  it("sends the pin, area line, label and trimmed flat", () => {
    expect(addressBody(pinned, "home", "  Flat 4B  ")).toEqual({
      label: "home",
      flat: "Flat 4B",
      areaLine: "Prabhat Road, Shivaji Nagar, Pune",
      pincode: "411005",
      point: shivajiNagar,
    });
  });

  it("sends no pin or area line for a typed pincode", () => {
    expect(addressBody({ pincode: "411005" }, "other", "Flat 4B")).toMatchObject({ areaLine: null, point: null });
  });

  it("is null when the flat is empty or over 100 characters", () => {
    expect(addressBody(pinned, "home", "   ")).toBeNull();
    expect(addressBody(pinned, "home", "x".repeat(101))).toBeNull();
  });
});

describe("confirmAddress", () => {
  const place: Place = { pincode: "411005", name: "Shivaji Nagar" };
  const body: SaveAddressBody = { label: "home", flat: "Flat 4B", areaLine: null, pincode: "411005", point: null };

  function steps(area: AreaAnswer, save: () => Promise<{ ok: true; data: unknown } | { ok: false; status: number; code: "ADDRESS_LIMIT_REACHED" }>) {
    const done: string[] = [];
    return {
      done,
      steps: {
        askArea: async () => (done.push("area"), area),
        saveAddress: async () => (done.push("save"), save()),
        keep: async () => void done.push("keep"),
      },
    };
  }

  it("asks, saves, then keeps the place, served or not", async () => {
    for (const area of [{ kind: "served", areaName: "Shivaji Nagar" }, { kind: "not-served" }] as const) {
      const run = steps(area, async () => ({ ok: true, data: {} }));
      expect(await confirmAddress(run.steps, place, body)).toEqual({ kind: "done" });
      expect(run.done).toEqual(["area", "save", "keep"]);
    }
  });

  it("never keeps the place when the server refuses or can't be reached", async () => {
    const full = steps({ kind: "not-served" }, async () => ({ ok: false, status: 409, code: "ADDRESS_LIMIT_REACHED" }));
    expect(await confirmAddress(full.steps, place, body)).toEqual({ kind: "error", code: "ADDRESS_LIMIT_REACHED" });
    expect(full.done).toEqual(["area", "save"]);

    const offline = steps({ kind: "served", areaName: "Shivaji Nagar" }, () => Promise.reject(new TypeError("Network request failed")));
    expect(await confirmAddress(offline.steps, place, body)).toEqual({ kind: "offline" });
    expect(offline.done).toEqual(["area", "save"]);
  });

  it("saves nothing when the area check fails", async () => {
    const run = steps({ kind: "offline" }, async () => ({ ok: true, data: {} }));
    expect(await confirmAddress(run.steps, place, body)).toEqual({ kind: "offline" });
    expect(run.done).toEqual(["area"]);
  });

  it("is not-saved when the phone can't keep it", async () => {
    const run = steps({ kind: "served", areaName: "Shivaji Nagar" }, async () => ({ ok: true, data: {} }));
    const failing = { ...run.steps, keep: () => Promise.reject(new Error("keychain locked")) };
    expect(await confirmAddress(failing, place, body)).toEqual({ kind: "not-saved" });
  });

  it("sends the same body again when Confirm is retried after the phone can't keep it or the answer is lost", async () => {
    const other = addressBody({ pincode: "411005", areaLine: "Prabhat Road", point: shivajiNagar }, "other", " Flat 4B ");
    if (!other) throw new Error("expected a body");
    const sent: SaveAddressBody[] = [];
    const served = { kind: "served", areaName: "Shivaji Nagar" } as const;
    const saveAddress = async (sentBody: SaveAddressBody) => (sent.push(sentBody), { ok: true as const, data: {} });
    const keepFails = { askArea: async () => served, saveAddress, keep: () => Promise.reject(new Error("keychain locked")) };
    const lost = {
      askArea: async () => served,
      saveAddress: (sentBody: SaveAddressBody) => (sent.push(sentBody), Promise.reject(new TypeError("Network request failed"))),
      keep: async () => {},
    };
    const works = { askArea: async () => served, saveAddress, keep: async () => {} };

    expect(await confirmAddress(keepFails, place, other)).toEqual({ kind: "not-saved" });
    expect(await confirmAddress(lost, place, other)).toEqual({ kind: "offline" });
    expect(await confirmAddress(works, place, other)).toEqual({ kind: "done" });
    expect(sent).toEqual([other, other, other]);
  });
});

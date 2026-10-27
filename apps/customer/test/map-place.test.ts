import { type ErrorCode, PlaceSession, type SaveAddressBody } from "@ygo/contracts";
import type { GeoAddress } from "@ygo/mobile/address-at";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AreaAnswer, Place } from "../src/lib/location-flow";
import {
  addressBody,
  confirmAddress,
  type Geocoder,
  newSession,
  pickPlace,
  type PinView,
  pinSpot,
  placeSessions,
  readPin,
  searchPlaces,
} from "../src/lib/map-place";

const prabhat: GeoAddress = {
  isoCountryCode: "IN",
  postalCode: "411005",
  street: "Prabhat Road",
  name: "12",
  district: "Shivaji Nagar",
  city: "Pune",
};
const shivajiNagar = { latitude: 18.5196, longitude: 73.8399 };
const geocoder = (addresses: Geocoder["addresses"] = async () => [prabhat]): Geocoder => ({ addresses });

describe("readPin", () => {
  it("names the spot from the first address with a pincode", async () => {
    const pin = await readPin(
      geocoder(async () => [{ ...prabhat, postalCode: null }, prabhat]),
      shivajiNagar,
    );
    expect(pin).toEqual({
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

  it("falls back to the address's name, then the city, when a part is missing or empty", async () => {
    const named = await readPin(geocoder(async () => [{ ...prabhat, street: null }]), shivajiNagar);
    expect(named?.title).toBe("12, Shivaji Nagar");
    const bare = { isoCountryCode: "IN", postalCode: "411005", street: null, name: null, district: null, city: "Pune" };
    const cityOnly = await readPin(geocoder(async () => [bare]), shivajiNagar);
    expect(cityOnly).toMatchObject({ place: { name: "Pune", areaLine: "Pune" }, title: "Pune", detail: "Pune 411005" });
    const emptyDistrict = await readPin(geocoder(async () => [{ ...prabhat, district: "" }]), shivajiNagar);
    expect(emptyDistrict?.place.name).toBe("Pune");
  });

  it("is null when no address there has a pincode, the lookup fails, or the pin is outside India", async () => {
    expect(await readPin(geocoder(async () => [{ ...prabhat, postalCode: "SW1A 1AA" }]), shivajiNagar)).toBeNull();
    expect(await readPin(geocoder(() => Promise.reject(new Error("rate limited"))), shivajiNagar)).toBeNull();
    expect(await readPin(geocoder(), { latitude: 51.5, longitude: -0.12 })).toBeNull();
  });

  it("is null for an address the phone names as outside India, even inside India's box with a pincode-like code", async () => {
    // Lhasa sits inside AddressPoint's box, and its postal code 850000 passes the pincode rule.
    const lhasa = { latitude: 29.65, longitude: 91.1 };
    const china: GeoAddress = { isoCountryCode: "CN", postalCode: "850000", street: "Beijing Middle Road", name: null, district: "Chengguan", city: "Lhasa" };
    expect(await readPin(geocoder(async () => [china]), lhasa)).toBeNull();
    expect(await readPin(geocoder(async () => [{ ...china, isoCountryCode: "cn" }]), lhasa)).toBeNull();
  });

  it("keeps an address with no country, and skips a foreign one for an Indian one at the same spot", async () => {
    expect((await readPin(geocoder(async () => [{ ...prabhat, isoCountryCode: null }]), shivajiNagar))?.place.pincode).toBe("411005");
    const nepal: GeoAddress = { ...prabhat, isoCountryCode: "NP", postalCode: "560001" };
    expect((await readPin(geocoder(async () => [nepal, { ...prabhat, isoCountryCode: "in" }]), shivajiNagar))?.place.pincode).toBe("411005");
  });
});

const session = "00000000-0000-4000-8000-000000000401";
const baner = { id: "ChIJ-baner_1", title: "Baner Road", detail: "Baner, Pune, Maharashtra" };
const point = { latitude: 18.559, longitude: 73.7868 };
const failed = (code: ErrorCode) => ({ ok: false as const, status: 400, code });

/** Our server's place search, answering as given and recording each call. */
function places(search: unknown, picked: unknown = { ok: true, data: { point } }) {
  const calls: string[] = [];
  const answer = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value as never));
  return {
    calls,
    searchPlaces: (text: string, given: string) => (calls.push(`search ${text} ${given}`), answer(search)),
    placePoint: (id: string, given: string) => (calls.push(`point ${id} ${given}`), answer(picked)),
  };
}

describe("searchPlaces", () => {
  it("searches the trimmed text with the session, and answers Google's matches", async () => {
    const server = places({ ok: true, data: { matches: [baner] } });
    expect(await searchPlaces(server, "  Baner Road  ", session)).toEqual([baner]);
    expect(server.calls).toEqual([`search Baner Road ${session}`]);
  });

  it("is empty when nothing matches, and bad-text without asking when the text breaks the search rule", async () => {
    expect(await searchPlaces(places({ ok: true, data: { matches: [] } }), "Nowhere", session)).toEqual([]);
    const server = places({ ok: true, data: { matches: [baner] } });
    expect(await searchPlaces(server, "Baner\u0000", session)).toBe("bad-text");
    expect(await searchPlaces(server, "a".repeat(101), session)).toBe("bad-text");
    expect(server.calls).toEqual([]);
  });

  it("searches a pasted multi-line address as one line", async () => {
    const server = places({ ok: true, data: { matches: [baner] } });
    expect(await searchPlaces(server, "Flat 4,\nBaner Road\t Pune\r\n", session)).toEqual([baner]);
    expect(server.calls).toEqual([`search Flat 4, Baner Road Pune ${session}`]);
  });

  it("names why it found nothing: no answer, the hourly limit, or the search down", async () => {
    expect(await searchPlaces(places(new Error("offline")), "Baner", session)).toBe("offline");
    expect(await searchPlaces(places(failed("TOO_MANY_REQUESTS")), "Baner", session)).toBe("too-many");
    expect(await searchPlaces(places(failed("UNAVAILABLE")), "Baner", session)).toBe("unavailable");
  });
});

describe("pickPlace", () => {
  it("answers the tapped match's point, asked with the search's session", async () => {
    const server = places(null);
    expect(await pickPlace(server, baner.id, session)).toEqual(point);
    expect(server.calls).toEqual([`point ${baner.id} ${session}`]);
  });

  it("names why there is no point: gone, no answer, the hourly limit, or the search down", async () => {
    expect(await pickPlace(places(null, failed("NOT_FOUND")), baner.id, session)).toBe("gone");
    expect(await pickPlace(places(null, new Error("offline")), baner.id, session)).toBe("offline");
    expect(await pickPlace(places(null, failed("TOO_MANY_REQUESTS")), baner.id, session)).toBe("too-many");
    expect(await pickPlace(places(null, failed("UNAVAILABLE")), baner.id, session)).toBe("unavailable");
  });
});

describe("newSession", () => {
  it("makes a new version-4 UUID each time, as the server's session rule takes", () => {
    const first = newSession();
    expect(PlaceSession.safeParse(first).success).toBe(true);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newSession()).not.toBe(first);
  });
});

describe("placeSessions", () => {
  const counting = () => {
    let made = 0;
    return placeSessions(() => `s${++made}`);
  };

  it("gives each search a new session, and the pick the session its search used", () => {
    const sessions = counting();
    const first = sessions.search();
    const second = sessions.search();
    expect(second).not.toBe(first);
    expect(sessions.pick()).toBe(second);
  });

  it("never sends an ended session again: a retry after a failed pick, or a tap after Back, gets a new one", () => {
    const sessions = counting();
    const searched = sessions.search();
    const picked = sessions.pick();
    const retried = sessions.pick();
    const afterBack = sessions.pick();
    expect(picked).toBe(searched);
    expect(new Set([picked, retried, afterBack]).size).toBe(3);
    expect(sessions.search()).not.toBe(afterBack);
  });

  it("makes real sessions by default", () => {
    const sessions = placeSessions();
    expect(PlaceSession.safeParse(sessions.search()).success).toBe(true);
    expect(PlaceSession.safeParse(sessions.pick()).success).toBe(true);
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

describe("pinSpot", () => {
  const before = { latitude: 18.5196, longitude: 73.8399 };
  const after = { latitude: 18.5590, longitude: 73.7868 };
  // Each spot has its own pincode, so a saved body shows which spot it came from.
  const beyond = { latitude: 18.5314, longitude: 73.8446 };
  const pincodes = new Map([[before.latitude, "411005"], [after.latitude, "411045"], [beyond.latitude, "411007"]]);
  const at = async ({ latitude }: { latitude: number }) => [{ ...prabhat, postalCode: pincodes.get(latitude) ?? null }];

  // A geocoder whose answers wait until the test lands them, in any order.
  const held = () => {
    const asked: { latitude: number }[] = [];
    const waiting: (() => void)[] = [];
    const lookup = geocoder((point) => {
      asked.push(point);
      return new Promise((done) => waiting.push(() => void at(point).then(done)));
    });
    return { lookup, asked, land: (i: number) => waiting[i]?.() };
  };

  // What Confirm would send if tapped now: the body with the pin's spot, or nothing when Confirm is off.
  const tap = (pin: ReturnType<typeof pinSpot>) => {
    const place = pin.place();
    return place && addressBody(place, "home", "Flat 4");
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("saves where the map stops when Confirm is tapped right after a swipe, never the spot before (#339)", async () => {
    const pin = pinSpot(geocoder(at), () => {});
    pin.open(before);
    await vi.advanceTimersByTimeAsync(0);
    expect(tap(pin)?.point).toEqual(before);

    // The swipe: the map starts moving, and Confirm is tapped while it still glides.
    pin.moving(true);
    expect(tap(pin)).toBeNull();

    // The map stops; Confirm stays off until the new spot is read.
    pin.moved(after);
    pin.moving(false);
    expect(tap(pin)).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(tap(pin)).toMatchObject({ point: after, pincode: "411045" });
  });

  it("lets Confirm save the same spot again when the map stops where it started", async () => {
    const pin = pinSpot(geocoder(at), () => {});
    pin.open(before);
    await vi.advanceTimersByTimeAsync(0);
    // Android reports a move that ends where it began, as when the map opens.
    pin.moving(true);
    pin.moving(false);
    expect(tap(pin)).toMatchObject({ point: before, pincode: "411005" });
  });

  it("keeps Confirm off when a read lands while the map is moving", async () => {
    let land = () => {};
    const slow = geocoder((point) => new Promise((done) => (land = () => void at(point).then(done))));
    const views: PinView[] = [];
    const pin = pinSpot(slow, (view) => views.push(view));
    pin.open(before);
    pin.moving(true);
    land();
    await vi.advanceTimersByTimeAsync(0);
    expect(tap(pin)).toBeNull();
    expect(views.at(-1)?.reading).toBe(true);
  });

  it("never lets a late read of the old spot replace the newer one", async () => {
    const waiting: (() => void)[] = [];
    const held = geocoder((point) => new Promise((done) => waiting.push(() => void at(point).then(done))));
    const views: PinView[] = [];
    const pin = pinSpot(held, (view) => views.push(view));
    pin.open(before);
    pin.moving(true);
    pin.moved(after);
    pin.moving(false);
    await vi.advanceTimersByTimeAsync(600);
    // The new spot's read lands first, then the old one.
    waiting[1]?.();
    await vi.advanceTimersByTimeAsync(0);
    waiting[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(tap(pin)).toMatchObject({ point: after, pincode: "411045" });
    expect(views.at(-1)).toMatchObject({ reading: false, spot: { place: { pincode: "411045" } } });
  });

  it("ignores a read still on its way when the screen leaves, and asks nothing more", async () => {
    const { lookup, asked, land } = held();
    const views: PinView[] = [];
    const pin = pinSpot(lookup, (view) => views.push(view));
    pin.open(before);
    pin.moving(true);
    pin.moved(after);
    pin.moving(false);
    pin.leave();
    const shown = views.length;
    land(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(asked).toEqual([before]);
    expect(views).toHaveLength(shown);
    expect(tap(pin)).toBeNull();
  });

  it("reads where the map is, not where it opened, when the screen starts again after leaving", async () => {
    // React runs a screen's effects again after leaving, as in development and after a hot reload.
    const { lookup, land } = held();
    const pin = pinSpot(lookup, () => {});
    pin.open(before);
    land(0);
    await vi.advanceTimersByTimeAsync(0);
    pin.moving(true);
    pin.moved(after);
    pin.moving(false);
    await vi.advanceTimersByTimeAsync(600);
    pin.leave();
    pin.open(before);
    expect(tap(pin)).toBeNull();
    land(1);
    land(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(tap(pin)).toMatchObject({ point: after, pincode: "411045" });
  });

  it("turns Confirm on after starting again when the screen left while the map was moving", async () => {
    // The map that was moving may be gone with its stop, so the screen that starts again must not wait for it.
    const { lookup, land } = held();
    const pin = pinSpot(lookup, () => {});
    pin.open(before);
    land(0);
    await vi.advanceTimersByTimeAsync(0);
    pin.moving(true);
    pin.leave();
    pin.open(before);
    land(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(tap(pin)).toMatchObject({ point: before });
  });

  it("keeps Confirm off through repeated moves while a read is on its way, and saves only the last stop", async () => {
    const { lookup, asked, land } = held();
    const pin = pinSpot(lookup, () => {});
    pin.open(before);
    land(0);
    await vi.advanceTimersByTimeAsync(0);
    pin.moving(true);
    pin.moved(after);
    pin.moving(false);
    await vi.advanceTimersByTimeAsync(600);
    // The map moves on before the read of the spot after the first swipe lands.
    pin.moving(true);
    pin.moved(beyond);
    pin.moving(false);
    land(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(tap(pin)).toBeNull();
    await vi.advanceTimersByTimeAsync(600);
    expect(asked).toEqual([before, after, beyond]);
    expect(tap(pin)).toBeNull();
    land(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(tap(pin)).toMatchObject({ point: beyond, pincode: "411007" });
  });

  describe("overlapping movement reports", () => {
    it("stays off through several starts and turns on only after the stop's read (a drag, then a fling)", async () => {
      const pin = pinSpot(geocoder(at), () => {});
      pin.open(before);
      await vi.advanceTimersByTimeAsync(0);
      pin.moving(true);
      pin.moving(true);
      expect(tap(pin)).toBeNull();
      pin.moved(after);
      pin.moving(false);
      expect(tap(pin)).toBeNull();
      await vi.advanceTimersByTimeAsync(600);
      expect(tap(pin)).toMatchObject({ point: after, pincode: "411045" });
    });

    it("stays off when the map starts again while a read is on its way, until it stops", async () => {
      const { lookup, land } = held();
      const pin = pinSpot(lookup, () => {});
      pin.open(before);
      land(0);
      await vi.advanceTimersByTimeAsync(0);
      pin.moving(true);
      pin.moved(after);
      pin.moving(false);
      await vi.advanceTimersByTimeAsync(600);
      pin.moving(true);
      land(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(tap(pin)).toBeNull();
      // It stops where it was, so the read that landed is the right one.
      pin.moving(false);
      expect(tap(pin)).toMatchObject({ point: after, pincode: "411045" });
    });

    it("stays off when a stop arrives with no start before the first read lands", async () => {
      const { lookup, land } = held();
      const pin = pinSpot(lookup, () => {});
      pin.open(before);
      pin.moving(false);
      expect(tap(pin)).toBeNull();
      land(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(tap(pin)).toMatchObject({ point: before, pincode: "411005" });
    });
  });
});

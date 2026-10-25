import { describe, expect, it } from "vitest";
import {
  askArea,
  newestOnly,
  placeLabel,
  sentOutcome,
  stale,
  refusedSearch,
  typedPlace,
  waitlistBody,
} from "../src/lib/location-flow";

describe("typedPlace", () => {
  it("takes a pincode with the server's rule", () => {
    expect(typedPlace(" 411 045 ")).toEqual({ pincode: "411045" });
    expect(typedPlace("011045")).toBeNull();
    expect(typedPlace("41104")).toBeNull();
    expect(typedPlace("")).toBeNull();
  });
});

describe("refusedSearch", () => {
  it("clears a place name as the field turns into Pincode, with no error yet", () => {
    expect(refusedSearch("Baner Road", false)).toEqual({ place: null, text: "", invalid: false });
    expect(refusedSearch("41104", false)).toEqual({ place: null, text: "", invalid: false });
  });

  it("keeps a valid pincode as typed and opens Confirm with it", () => {
    expect(refusedSearch(" 411045 ", false)).toEqual({ place: { pincode: "411045" }, text: " 411045 ", invalid: false });
    expect(refusedSearch("411045", true)).toEqual({ place: { pincode: "411045" }, text: "411045", invalid: false });
  });

  it("keeps a wrong pincode typed in Pincode mode, with the error", () => {
    expect(refusedSearch("41104", true)).toEqual({ place: null, text: "41104", invalid: true });
  });
});

describe("placeLabel", () => {
  it("shows the name with the pincode, or the pincode alone", () => {
    expect(placeLabel({ pincode: "411045", name: "Baner" })).toBe("Baner, 411045");
    expect(placeLabel({ pincode: "411045" })).toBe("411045");
  });
});

describe("askArea", () => {
  it("is served, with the Area's name", async () => {
    const api = { checkServiceability: async () => ({ ok: true, data: { serviceable: true, areaName: "Baner" } }) as const };
    expect(await askArea(api, "411045")).toEqual({ kind: "served", areaName: "Baner" });
  });

  it("is not served, for a pincode in no Area or a paused one", async () => {
    const api = { checkServiceability: async () => ({ ok: true, data: { serviceable: false } }) as const };
    expect(await askArea(api, "411045")).toEqual({ kind: "not-served" });
  });

  it("is offline when no answer comes", async () => {
    const api = { checkServiceability: () => Promise.reject(new TypeError("Network request failed")) };
    expect(await askArea(api, "411045")).toEqual({ kind: "offline" });
  });

  it("passes on a refusal's code", async () => {
    const api = { checkServiceability: async () => ({ ok: false, status: 503, code: "UNAVAILABLE" }) as const };
    expect(await askArea(api, "411045")).toEqual({ kind: "error", code: "UNAVAILABLE" });
  });
});

describe("waitlistBody", () => {
  it("sends the phone as the server stores it", () => {
    expect(waitlistBody("411045", "98765 43210")).toEqual({ pincode: "411045", phone: "+919876543210" });
  });

  it("is null when the phone breaks the rule", () => {
    expect(waitlistBody("411045", "12345")).toBeNull();
  });
});

describe("sentOutcome", () => {
  it("is saved, a refusal's code, or offline", async () => {
    expect(await sentOutcome(async () => ({ ok: true, data: undefined }))).toBe("saved");
    expect(await sentOutcome(async () => ({ ok: false, status: 429, code: "TOO_MANY_REQUESTS" }))).toBe("TOO_MANY_REQUESTS");
    expect(await sentOutcome(() => Promise.reject(new TypeError("Network request failed")))).toBe("offline");
  });
});

describe("newestOnly", () => {
  function later<T>(value: T) {
    let settle = () => {};
    const promise = new Promise<T>((resolve) => (settle = () => resolve(value)));
    return { promise, settle };
  }

  it("drops an answer that lands after a newer ask began", async () => {
    const asks = newestOnly();
    const first = later("411045 served");
    const second = later("411007 not served");
    const firstAnswer = asks.ask(first.promise);
    const secondAnswer = asks.ask(second.promise);
    second.settle();
    first.settle();
    expect(await secondAnswer).toBe("411007 not served");
    expect(await firstAnswer).toBe(stale);
  });

  it("drops an answer that lands after the screen left or the account changed", async () => {
    const asks = newestOnly();
    const slow = later("served");
    const answer = asks.ask(slow.promise);
    asks.drop();
    slow.settle();
    expect(await answer).toBe(stale);
  });

  it("keeps a retry's answer", async () => {
    const asks = newestOnly();
    expect(await asks.ask(Promise.resolve("offline"))).toBe("offline");
    expect(await asks.ask(Promise.resolve("served"))).toBe("served");
  });
});

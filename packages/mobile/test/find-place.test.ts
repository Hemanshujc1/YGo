import { describe, expect, it } from "vitest";
import { findPlace, type Locator } from "../src/find-place";

const baner = { latitude: 18.559, longitude: 73.786 };
const locator = (allowed: boolean, position: Locator["position"], servicesOn = true): Locator => ({
  askPermission: async () => allowed,
  servicesOn: async () => servicesOn,
  position,
});

describe("findPlace", () => {
  it("is off when location is refused, and never asks where the phone is", async () => {
    let asked = false;
    const found = await findPlace(
      locator(false, async () => {
        asked = true;
        return baner;
      }),
    );
    expect(found).toEqual({ kind: "off" });
    expect(asked).toBe(false);
  });

  it("finds where the phone is, as latitude and longitude, with its accuracy", async () => {
    expect(await findPlace(locator(true, async () => ({ ...baner, altitude: 560, accuracy: 12 })))).toEqual({
      kind: "found",
      point: baner,
      accuracy: 12,
    });
  });

  it("gives no accuracy when the phone gives none or one that is not a distance", async () => {
    for (const accuracy of [null, undefined, 0, -1, Number.NaN]) {
      expect(await findPlace(locator(true, async () => ({ ...baner, accuracy })))).toEqual({ kind: "found", point: baner, accuracy: null });
    }
  });

  it("is not found outside India", async () => {
    expect(await findPlace(locator(true, async () => ({ latitude: 51.5, longitude: -0.12 })))).toEqual({ kind: "not-found" });
  });

  it("says when location is off for the whole phone", async () => {
    expect(await findPlace(locator(true, async () => baner, false))).toEqual({ kind: "phone-off" });
  });

  it("is not found when asking for permission fails", async () => {
    const failing: Locator = { ...locator(true, async () => baner), askPermission: () => Promise.reject(new Error("no activity")) };
    expect(await findPlace(failing)).toEqual({ kind: "not-found" });
  });

  it("stops waiting for a position after the timeout", async () => {
    expect(await findPlace(locator(true, () => new Promise(() => {})), 10)).toEqual({ kind: "not-found" });
  });

  it("is not found when no position comes", async () => {
    expect(await findPlace(locator(true, () => Promise.reject(new Error("no position"))))).toEqual({ kind: "not-found" });
  });
});

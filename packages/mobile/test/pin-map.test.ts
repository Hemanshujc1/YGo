import { describe, expect, it, vi } from "vitest";

// The map and React Native are native code; only the spot checks run here.
vi.mock("nativewind", () => ({ cssInterop: vi.fn() }));
vi.mock("react-native", () => ({ View: () => null }));
vi.mock("react-native-maps", () => ({ default: () => null, PROVIDER_GOOGLE: "google" }));

const { samePoint, spotNow } = await import("../src/pin-map");

describe("samePoint", () => {
  const spot = { latitude: 18.5204, longitude: 73.8567 };

  it("treats the map's tiny rounding as the same spot, so Android's opening report reads nothing", () => {
    expect(samePoint(spot, { latitude: 18.5204000004, longitude: 73.8566999996 })).toBe(true);
  });

  it("treats a moved map as a new spot", () => {
    expect(samePoint(spot, { latitude: 18.52041, longitude: 73.8567 })).toBe(false);
    expect(samePoint(spot, { latitude: 18.5204, longitude: 73.85671 })).toBe(false);
  });
});

describe("spotNow", () => {
  const stopped = { latitude: 18.5204, longitude: 73.8567 };
  const gliding = { latitude: 18.5311, longitude: 73.8442 };

  it("reads the spot under the pin at the tap, not where the map last stopped, so a tap while it still glides gets the new spot", async () => {
    const map = { getCamera: async () => ({ center: gliding, heading: 0, pitch: 0, zoom: 17 }) };
    expect(await spotNow(map, stopped)).toEqual(gliding);
  });

  it("falls back to where the map last stopped when the map can't say", async () => {
    expect(await spotNow({ getCamera: () => Promise.reject(new Error("no camera")) }, stopped)).toEqual(stopped);
    expect(await spotNow(null, stopped)).toEqual(stopped);
  });
});

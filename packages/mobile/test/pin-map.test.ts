import { describe, expect, it, vi } from "vitest";

// The map and React Native are native code; only the spot check runs here.
vi.mock("nativewind", () => ({ cssInterop: vi.fn() }));
vi.mock("react-native", () => ({ View: () => null }));
vi.mock("react-native-maps", () => ({ default: () => null, PROVIDER_GOOGLE: "google" }));

const { samePoint } = await import("../src/pin-map");

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

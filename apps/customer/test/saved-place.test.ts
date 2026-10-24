import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => stored.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void stored.set(key, value),
}));

const { savePlace, savedPlace } = await import("../src/lib/saved-place");

describe("savedPlace", () => {
  beforeEach(() => stored.clear());

  it("reads back a place with its pin and area line", async () => {
    const place = {
      pincode: "411005",
      name: "Shivaji Nagar",
      areaLine: "Prabhat Road, Shivaji Nagar, Pune",
      point: { latitude: 18.5196, longitude: 73.8399 },
    };
    await savePlace("account-1", place);
    expect(await savedPlace("account-1")).toEqual(place);
    expect(await savedPlace("account-2")).toBeNull();
  });

  it("still reads a place kept before #242", async () => {
    stored.set("place.account-1", JSON.stringify({ pincode: "411045", name: "Baner" }));
    expect(await savedPlace("account-1")).toEqual({ pincode: "411045", name: "Baner" });
  });

  it("drops a broken pin or area line, and is null without a valid pincode", async () => {
    stored.set("place.account-1", JSON.stringify({ pincode: "411045", areaLine: "", point: { latitude: 0, longitude: 0 } }));
    expect(await savedPlace("account-1")).toEqual({ pincode: "411045" });
    stored.set("place.account-1", "not json");
    expect(await savedPlace("account-1")).toBeNull();
    stored.set("place.account-1", JSON.stringify({ name: "Baner" }));
    expect(await savedPlace("account-1")).toBeNull();
  });
});

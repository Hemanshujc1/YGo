import type { SavedAddress } from "@ygo/contracts";
import { describe, expect, it } from "vitest";
import type { Place } from "../src/lib/location-flow";
import { addressLine, chooseAddress, loadAddresses, removeSaved } from "../src/lib/saved-addresses";

const home: SavedAddress = {
  id: "0b6f3f1e-8f2a-4d6e-9a51-5c1d2e3f4a5b",
  label: "home",
  flat: "4B",
  areaLine: "Prabhat Road, Shivaji Nagar, Pune",
  pincode: "411005",
  point: { latitude: 18.5196, longitude: 73.8399 },
};
// Saved on Android with location refused: a typed pincode, no pin (#217, answer 6).
const typed: SavedAddress = { ...home, id: "1c7a4b2f-9e3b-4f7a-8b62-6d2e3f4a5b6c", label: "other", flat: "12", areaLine: null, point: null };

describe("addressLine", () => {
  it("shows the flat and area line, or the pincode when there is no area line", () => {
    expect(addressLine(home)).toBe("4B, Prabhat Road, Shivaji Nagar, Pune");
    expect(addressLine(typed)).toBe("12, 411005");
  });
});

describe("loadAddresses", () => {
  it("returns the server's list in its order", async () => {
    const addresses = await loadAddresses({ savedAddresses: async () => ({ ok: true, data: { addresses: [typed, home] } }) });
    expect(addresses).toEqual([typed, home]);
  });

  it("is null when the server refuses or can't be reached", async () => {
    expect(await loadAddresses({ savedAddresses: async () => ({ ok: false, status: 500, code: "INTERNAL" }) })).toBeNull();
    expect(await loadAddresses({ savedAddresses: () => Promise.reject(new TypeError("Network request failed")) })).toBeNull();
  });
});

describe("chooseAddress", () => {
  it("keeps the place with its pin and area line", async () => {
    const kept: Place[] = [];
    expect(await chooseAddress(async (place) => void kept.push(place), home)).toBe("done");
    expect(kept).toEqual([{ pincode: "411005", areaLine: "Prabhat Road, Shivaji Nagar, Pune", point: home.point }]);
  });

  it("keeps the pincode alone for a place saved without a pin", async () => {
    const kept: Place[] = [];
    expect(await chooseAddress(async (place) => void kept.push(place), typed)).toBe("done");
    expect(kept).toEqual([{ pincode: "411005" }]);
  });

  it("is not-saved when the phone can't keep it, or the pincode breaks the rule", async () => {
    expect(await chooseAddress(() => Promise.reject(new Error("keychain locked")), home)).toBe("not-saved");
    const kept: Place[] = [];
    expect(await chooseAddress(async (place) => void kept.push(place), { ...home, pincode: "41100" })).toBe("not-saved");
    expect(kept).toEqual([]);
  });
});

describe("removeSaved", () => {
  it("removes once, and counts an address already gone as removed", async () => {
    const sent: string[] = [];
    const api = (answer: Awaited<ReturnType<Parameters<typeof removeSaved>[0]["removeAddress"]>>) => ({
      removeAddress: async (id: string) => {
        sent.push(id);
        return answer;
      },
    });
    expect(await removeSaved(api({ ok: true, data: undefined }), home.id)).toBe("removed");
    expect(await removeSaved(api({ ok: false, status: 404, code: "NOT_FOUND" }), home.id)).toBe("removed");
    expect(sent).toEqual([home.id, home.id]);
  });

  it("fails without retrying when offline or refused", async () => {
    let calls = 0;
    const offline = { removeAddress: () => (calls++, Promise.reject(new TypeError("Network request failed"))) };
    expect(await removeSaved(offline, home.id)).toBe("failed");
    expect(calls).toBe(1);
    expect(await removeSaved({ removeAddress: async () => ({ ok: false, status: 500, code: "INTERNAL" }) }, home.id)).toBe("failed");
  });
});

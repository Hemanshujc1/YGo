import { describe, expect, it } from "vitest";
import { addressAt, type GeoAddress } from "../src/address-at";

const prabhat: GeoAddress = {
  isoCountryCode: "IN",
  postalCode: "411005",
  street: "Prabhat Road",
  name: "12",
  district: "Shivaji Nagar",
  city: "Pune",
};
const shivajiNagar = { latitude: 18.5196, longitude: 73.8399 };
const lookup = (addresses: GeoAddress[]) => async () => addresses;

describe("addressAt", () => {
  it("reads the first address with a pincode, with its parts and line", async () => {
    expect(await addressAt(lookup([{ ...prabhat, postalCode: null }, prabhat]), shivajiNagar)).toEqual({
      point: shivajiNagar,
      pincode: "411005",
      street: "Prabhat Road",
      district: "Shivaji Nagar",
      city: "Pune",
      line: "Prabhat Road, Shivaji Nagar, Pune",
    });
  });

  it("falls back to the address's name for the street, and leaves out a missing or empty part", async () => {
    expect((await addressAt(lookup([{ ...prabhat, street: null }]), shivajiNagar))?.line).toBe("12, Shivaji Nagar, Pune");
    const bare = { isoCountryCode: "IN", postalCode: "411005", street: "", name: null, district: "", city: "Pune" };
    expect(await addressAt(lookup([bare]), shivajiNagar)).toMatchObject({ street: null, district: null, city: "Pune", line: "Pune" });
    expect((await addressAt(lookup([{ ...prabhat, district: "Pune", city: "Pune" }]), shivajiNagar))?.line).toBe("Prabhat Road, Pune");
  });

  it("is null when no address there has a pincode, the lookup fails, or the point is outside India", async () => {
    expect(await addressAt(lookup([{ ...prabhat, postalCode: "SW1A 1AA" }]), shivajiNagar)).toBeNull();
    expect(await addressAt(() => Promise.reject(new Error("rate limited")), shivajiNagar)).toBeNull();
    expect(await addressAt(lookup([prabhat]), { latitude: 51.5, longitude: -0.12 })).toBeNull();
  });

  it("is null for an address the phone names as outside India, even inside India's box with a pincode-like code", async () => {
    // Lhasa sits inside AddressPoint's box, and its postal code 850000 passes the pincode rule.
    const lhasa = { latitude: 29.65, longitude: 91.1 };
    const china: GeoAddress = { isoCountryCode: "CN", postalCode: "850000", street: "Beijing Middle Road", name: null, district: "Chengguan", city: "Lhasa" };
    expect(await addressAt(lookup([china]), lhasa)).toBeNull();
    expect(await addressAt(lookup([{ ...china, isoCountryCode: "cn" }]), lhasa)).toBeNull();
  });

  it("keeps an address with no country, and skips a foreign one for an Indian one at the same spot", async () => {
    expect((await addressAt(lookup([{ ...prabhat, isoCountryCode: null }]), shivajiNagar))?.pincode).toBe("411005");
    const nepal: GeoAddress = { ...prabhat, isoCountryCode: "NP", postalCode: "560001" };
    expect((await addressAt(lookup([nepal, { ...prabhat, isoCountryCode: "in" }]), shivajiNagar))?.pincode).toBe("411005");
  });

  it("looks up and keeps only the point's latitude and longitude", async () => {
    // The phone's geocoder adds altitude and accuracy, which the server's strict point refuses.
    let asked: unknown;
    const found = await addressAt(
      async (point) => {
        asked = point;
        return [prabhat];
      },
      { ...shivajiNagar, altitude: 560, accuracy: 100 } as typeof shivajiNagar,
    );
    expect(asked).toEqual(shivajiNagar);
    expect(found?.point).toEqual(shivajiNagar);
  });
});

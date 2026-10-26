import { AddressPoint, Pincode } from "@ygo/contracts";

/** One address the phone's own map lookup names at a spot (`expo-location`'s reverse lookup, with no map key). */
export type GeoAddress = {
  /** "IN" for India; null when the phone doesn't say. */
  isoCountryCode: string | null;
  postalCode: string | null;
  street: string | null;
  name: string | null;
  district: string | null;
  city: string | null;
};

/**
 * The address at a spot: its pincode, its parts, and `line`, the street (or
 * the place's name), locality and city each named once, such as "Prabhat
 * Road, Shivaji Nagar, Pune". Each app cuts `line` to its own field's limit.
 */
export type AddressAt = {
  point: AddressPoint;
  pincode: string;
  street: string | null;
  district: string | null;
  city: string | null;
  line: string;
};

const unique = (parts: (string | null)[]) => [...new Set(parts.filter((part): part is string => !!part))];

/**
 * The address at a point, from the first address in India with a pincode;
 * null when there is none, the lookup fails, or the point is outside India.
 * Each app passes its own lookup, so the package needs no location module.
 *
 * The box `AddressPoint` checks also holds parts of Nepal, China and other
 * neighbours, whose postal codes can look like a pincode, so an address the
 * phone names as in another country is skipped; one with no country is kept.
 * Only latitude and longitude are kept: the phone's results also carry
 * altitude, accuracy or zoom, which the server's strict `AddressPoint` refuses.
 * Used by C15 (#242).
 */
export async function addressAt(
  lookup: (point: AddressPoint) => Promise<GeoAddress[]>,
  { latitude, longitude }: AddressPoint,
): Promise<AddressAt | null> {
  const point = AddressPoint.safeParse({ latitude, longitude });
  if (!point.success) return null;
  let addresses;
  try {
    addresses = await lookup(point.data);
  } catch {
    return null;
  }
  for (const address of addresses) {
    if (address.isoCountryCode && address.isoCountryCode.toUpperCase() !== "IN") continue;
    const pincode = Pincode.safeParse(address.postalCode ?? "");
    if (!pincode.success) continue;
    const street = address.street || address.name || null;
    const district = address.district || null;
    const city = address.city || null;
    return { point: point.data, pincode: pincode.data, street, district, city, line: unique([street, district, city]).join(", ") };
  }
  return null;
}

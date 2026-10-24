import type { ApiResult } from "@ygo/api-client";
import { type AddressLabel, AddressPoint, type ErrorCode, Pincode, SaveAddressBody } from "@ygo/contracts";
import { type AreaAnswer, type Place, sentOutcome } from "./location-flow";

/** The phone's own map lookups, given by the screens so the tests can stand in for them (#242). */
export interface Geocoder {
  /** The spots a typed name, street or pincode points to. */
  find(text: string): Promise<{ latitude: number; longitude: number }[]>;
  /** The addresses at a spot. */
  addresses(point: AddressPoint): Promise<GeoAddress[]>;
}

export type GeoAddress = {
  postalCode: string | null;
  street: string | null;
  name: string | null;
  district: string | null;
  city: string | null;
};

/** A place on the map, with the two lines Confirm shows: "Prabhat Road, Shivaji Nagar" and "Pune 411005". */
export type Spot = { place: Place; title: string; detail: string };

/** Search shows at most this many matches (#217, answer 5). */
const searchLimit = 5;
const unique = (parts: (string | null)[]) => [...new Set(parts.filter((part): part is string => !!part))];

/** The spot at a point, from the first address with a pincode; null when there is none, or the point is outside India. */
async function spotAt(geocoder: Geocoder, point: AddressPoint): Promise<Spot | null> {
  if (!AddressPoint.safeParse(point).success) return null;
  for (const address of await geocoder.addresses(point)) {
    const pincode = Pincode.safeParse(address.postalCode ?? "");
    if (!pincode.success) continue;
    const street = address.street ?? address.name;
    const title = unique([street, address.district]).join(", ");
    const areaLine = unique([street, address.district, address.city]).join(", ").slice(0, 200).trim();
    const name = address.district ?? address.city;
    return {
      place: { pincode: pincode.data, point, ...(name && { name }), ...(areaLine && { areaLine }) },
      title: title || (address.city ?? pincode.data),
      detail: unique([address.city, pincode.data]).join(" "),
    };
  }
  return null;
}

/** Where the pin stands, or null when no pincode is found there: "Move the pin a little" (#242, Q6). */
export async function readPin(geocoder: Geocoder, point: AddressPoint): Promise<Spot | null> {
  try {
    return await spotAt(geocoder, point);
  } catch {
    return null;
  }
}

/** Up to 5 matches for the search field, each with a pincode (#242, Q4); empty when nothing is found. */
export async function searchPlaces(geocoder: Geocoder, text: string): Promise<Spot[]> {
  try {
    const points = (await geocoder.find(text.trim())).slice(0, searchLimit);
    const spots = await Promise.all(points.map((point) => readPin(geocoder, point)));
    return spots.filter((spot): spot is Spot => spot !== null);
  } catch {
    return [];
  }
}

/** Confirm's body for the server, or null when "Flat, house or floor" breaks the server's rule (#217, answer 7). */
export function addressBody(place: Place, label: AddressLabel, flat: string): SaveAddressBody | null {
  const parsed = SaveAddressBody.safeParse({
    label,
    flat,
    areaLine: place.areaLine ?? null,
    pincode: place.pincode,
    point: place.point ?? null,
  });
  return parsed.success ? parsed.data : null;
}

/** What Confirm ended with: done (go Home), or the message to show while staying on Confirm. */
export type Confirmed = { kind: "done" } | { kind: "not-saved" } | Extract<AreaAnswer, { kind: "offline" | "error" }>;

/**
 * Confirm's steps in order (#242, Q9): ask about the area, save the address on
 * the server, then keep the place on the phone. A served or not-served place
 * is saved alike; any failure stops before the place is kept, so it is never
 * chosen.
 */
export async function confirmAddress(
  steps: {
    askArea(pincode: string): Promise<AreaAnswer>;
    saveAddress(body: SaveAddressBody): Promise<ApiResult<unknown>>;
    keep(place: Place): Promise<void>;
  },
  place: Place,
  body: SaveAddressBody,
): Promise<Confirmed> {
  const area = await steps.askArea(place.pincode);
  if (area.kind === "offline" || area.kind === "error") return area;
  const saved = await sentOutcome(() => steps.saveAddress(body));
  if (saved === "offline") return { kind: "offline" };
  if (saved !== "saved") return { kind: "error", code: saved satisfies ErrorCode };
  try {
    await steps.keep(place);
  } catch {
    return { kind: "not-saved" };
  }
  return { kind: "done" };
}

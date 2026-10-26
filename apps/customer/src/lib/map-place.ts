import type { ApiResult } from "@ygo/api-client";
import {
  type AddressLabel,
  type AddressPoint,
  type ErrorCode,
  type PlaceMatch,
  type PlacePointResponse,
  type PlaceSearchResponse,
  PlaceSearchText,
  SaveAddressBody,
} from "@ygo/contracts";
import { addressAt, type GeoAddress } from "@ygo/mobile/address-at";
import { type AreaAnswer, type Place, sentOutcome } from "./location-flow";

/** The phone's own map lookup, given by the screens so the tests can stand in for it (#242). */
export interface Geocoder {
  /** The addresses at a spot. */
  addresses(point: AddressPoint): Promise<GeoAddress[]>;
}

/** A place on the map, with the two lines Confirm shows: "Prabhat Road, Shivaji Nagar" and "Pune 411005". */
export type Spot = { place: Place; title: string; detail: string };

const unique = (parts: (string | null)[]) => [...new Set(parts.filter((part): part is string => !!part))];

/**
 * Where the pin stands, or null when no pincode is found there: "Move the pin
 * a little" (#242, Q6). The address is `@ygo/mobile`'s `addressAt`, which
 * never rejects; the area line is its line, cut to 200.
 */
export async function readPin(geocoder: Geocoder, point: AddressPoint): Promise<Spot | null> {
  const at = await addressAt((where) => geocoder.addresses(where), point);
  if (!at) return null;
  const title = unique([at.street, at.district]).join(", ");
  const areaLine = at.line.slice(0, 200).trim();
  const name = at.district || at.city;
  return {
    place: { pincode: at.pincode, point: at.point, ...(name && { name }), ...(areaLine && { areaLine }) },
    title: title || at.city || at.pincode,
    detail: unique([at.city, at.pincode]).join(" "),
  };
}

/** Our server's place search, which asks Google Places (#257, Q4). */
type Places = {
  searchPlaces(text: string, session: string): Promise<ApiResult<PlaceSearchResponse>>;
  placePoint(id: string, session: string): Promise<ApiResult<PlacePointResponse>>;
};

/** Why a search or a pick has nothing to show: no answer, past the hourly limit (Q8), or the search is down. */
export type PlaceTrouble = "offline" | "too-many" | "unavailable";

const trouble = (code: ErrorCode): PlaceTrouble => (code === "TOO_MANY_REQUESTS" ? "too-many" : "unavailable");

/**
 * A new Google session for one search and the pick that ends it (#257, Q5).
 * A version-4 UUID; it only groups billing, so `Math.random` is enough.
 */
export function newSession(): string {
  const hex = (length: number) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

/**
 * The Google session for C15's searches and the pick that ends one (#257, Q5).
 * Each search starts a new session. A pick sends the session its search used
 * and moves on to a new one, so a later tap, after Back from Confirm or a
 * failed pick, never sends a session Google has already ended.
 */
export function placeSessions(make: () => string = newSession) {
  let current = make();
  return {
    /** A new session for a search. */
    search: () => (current = make()),
    /** The session to send with a pick, which ends it. */
    pick() {
      const ended = current;
      current = make();
      return ended;
    },
  };
}

/**
 * Up to 5 of Google's matches for the search field, each with Google's two
 * lines and no pincode (#257, Q6); empty when nothing is found. Line breaks
 * and tabs, as a pasted address brings, become spaces; text that still breaks
 * the search rule is "bad-text", without asking.
 */
export async function searchPlaces(places: Places, text: string, session: string): Promise<PlaceMatch[] | PlaceTrouble | "bad-text"> {
  const checked = PlaceSearchText.safeParse(text.replace(/\s+/g, " "));
  if (!checked.success) return "bad-text";
  const answer = await places.searchPlaces(checked.data, session).catch(() => null);
  if (!answer) return "offline";
  return answer.ok ? answer.data.matches : trouble(answer.code);
}

/** A tapped match's point, for Confirm to open at; "gone" when Google no longer knows the place. */
export async function pickPlace(places: Places, id: string, session: string): Promise<AddressPoint | PlaceTrouble | "gone"> {
  const answer = await places.placePoint(id, session).catch(() => null);
  if (!answer) return "offline";
  if (answer.ok) return answer.data.point;
  return answer.code === "NOT_FOUND" ? "gone" : trouble(answer.code);
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
 *
 * Retrying (#242, review of #249): on any failure Confirm stays open with its
 * message and nothing retries by itself. The customer taps Confirm again, which
 * sends the same body. That is safe even when the first save reached the server
 * (the phone failed to keep it, or the answer was lost offline): the server
 * replaces a Home or Work address, and answers an identical Other address with
 * the one it already has, so a retry never adds a second address.
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

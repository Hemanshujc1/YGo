import type { ApiResult } from "@ygo/api-client";
import { AddressPoint, type ErrorCode, Pincode, type Serviceability, WaitlistBody } from "@ygo/contracts";

/**
 * Where shops should deliver: the pincode, and the place name when the phone's
 * location gave one (#216, Q6). A place confirmed on the map also keeps its
 * pin and area line (#242, Q10).
 */
export type Place = { pincode: string; name?: string; areaLine?: string; point?: AddressPoint };

/** "Baner, 411045", or the pincode alone when it was typed. */
export const placeLabel = (place: Place) => (place.name ? `${place.name}, ${place.pincode}` : place.pincode);

/** The phone's location calls, given by C15 so the tests can stand in for them. */
export interface Locator {
  /** Asks for location while the app is in use (#216, Q4); true when allowed. */
  askPermission(): Promise<boolean>;
  /** False when location is switched off for the whole phone. */
  servicesOn(): Promise<boolean>;
  /** Where the phone is now. Rejects when no position comes. */
  position(): Promise<{ latitude: number; longitude: number }>;
}

/**
 * What "Use my current location" found:
 * - `found`: where the phone is, where Confirm opens the pin (#242, Q7).
 * - `off`: location was refused, so C15 shows "Location is off for YGo".
 * - `phone-off`: location is switched off for the whole phone.
 * - `not-found`: no position in time, or one outside India: "Couldn't find your pincode".
 */
export type Found = { kind: "found"; point: AddressPoint } | { kind: "off" | "phone-off" | "not-found" };

/** How long C15 waits for a position before asking for a typed pincode. */
const findTimeout = 15_000;

export async function findPlace(locator: Locator, timeout = findTimeout): Promise<Found> {
  let position;
  try {
    if (!(await locator.askPermission())) return { kind: "off" };
    if (!(await locator.servicesOn())) return { kind: "phone-off" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), timeout)));
    position = await Promise.race([locator.position(), late]).finally(() => clearTimeout(timer));
  } catch {
    return { kind: "not-found" };
  }
  // Latitude and longitude only: the phone's position also carries altitude and accuracy.
  const point = AddressPoint.safeParse({ latitude: position.latitude, longitude: position.longitude });
  return point.success ? { kind: "found", point: point.data } : { kind: "not-found" };
}

/** A typed pincode checked with the server's own rule (#216, Q5); null when it breaks it. */
export function typedPlace(text: string): Place | null {
  const pincode = Pincode.safeParse(text);
  return pincode.success ? { pincode: pincode.data } : null;
}

/**
 * A search on Android just refused location, or already in Pincode mode (#217,
 * answer 6): a valid pincode opens Confirm and is kept as typed. Otherwise a
 * place name typed for search is cleared as the field turns into Pincode, with
 * no error yet; in Pincode mode the text stays and breaks the rule.
 */
export function refusedSearch(text: string, pincodeMode: boolean): { place: Place | null; text: string; invalid: boolean } {
  const place = typedPlace(text);
  if (place) return { place, text, invalid: false };
  return pincodeMode ? { place: null, text, invalid: true } : { place: null, text: "", invalid: false };
}

/** The server's answer for a pincode: served, not served (C03), no answer, or a refusal. */
export type AreaAnswer =
  | { kind: "served"; areaName: string }
  | { kind: "not-served" }
  | { kind: "offline" }
  | { kind: "error"; code: ErrorCode };

export async function askArea(
  api: { checkServiceability(pincode: string): Promise<ApiResult<Serviceability>> },
  pincode: string,
): Promise<AreaAnswer> {
  let answer;
  try {
    answer = await api.checkServiceability(pincode);
  } catch {
    return { kind: "offline" };
  }
  if (!answer.ok) return { kind: "error", code: answer.code };
  return answer.data.serviceable ? { kind: "served", areaName: answer.data.areaName } : { kind: "not-served" };
}

/** C03's "Leave my number": the body to send, or null when the phone breaks the `Phone` rule. */
export function waitlistBody(pincode: string, phone: string): WaitlistBody | null {
  const parsed = WaitlistBody.safeParse({ pincode, phone });
  return parsed.success ? parsed.data : null;
}

/** What happened to "Leave my number" or a saved address: saved, or the message to show (#216, Q7). */
export async function sentOutcome(send: () => Promise<ApiResult<unknown>>): Promise<"saved" | "offline" | ErrorCode> {
  try {
    const answer = await send();
    return answer.ok ? "saved" : answer.code;
  } catch {
    return "offline";
  }
}

export const stale = Symbol("stale");

/**
 * Keeps only the newest ask's answer (#216, Q3 safeguard): an answer that
 * lands after a newer ask began, or after `drop` (the screen left, or the
 * account or pincode changed), comes back as `stale` and is ignored.
 */
export function newestOnly() {
  let turn = 0;
  return {
    async ask<T>(work: Promise<T>): Promise<T | typeof stale> {
      const mine = ++turn;
      const answer = await work;
      return mine === turn ? answer : stale;
    },
    drop() {
      turn++;
    },
  };
}

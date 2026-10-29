import type { ApiResult } from "@ygo/api-client";
import { AddressAreaLine, AddressPoint, type SavedAddress, type SavedAddressesResponse } from "@ygo/contracts";
import { type Place, sentOutcome, typedPlace } from "./location-flow";

/** A row's second line: "4B, Prabhat Road, Shivaji Nagar, Pune", or "4B, 411045" for a place saved without a pin (#243, Q2). */
export const addressLine = (address: SavedAddress) => `${address.flat}, ${address.areaLine ?? address.pincode}`;

/** C15's saved addresses section (#243, Q5): loading, failed with Try again, or the list. */
export type SavedList = { kind: "loading" } | { kind: "failed" } | { kind: "loaded"; addresses: SavedAddress[] };

/** A load landed: the new list, or on failure the list already shown, which stays (#243, Q5). */
export const afterLoad = (current: SavedList, found: SavedAddress[] | null): SavedList =>
  found ? { kind: "loaded", addresses: found } : current.kind === "loaded" ? current : { kind: "failed" };

/** A remove went through: the row leaves the list shown. */
export const withoutAddress = (current: SavedList, id: string): SavedList =>
  current.kind === "loaded" ? { kind: "loaded", addresses: current.addresses.filter((address) => address.id !== id) } : current;

/** The account's saved addresses, newest first, or null when they can't be loaded (#243, Q5). */
export async function loadAddresses(api: { savedAddresses(): Promise<ApiResult<SavedAddressesResponse>> }): Promise<SavedAddress[] | null> {
  try {
    const answer = await api.savedAddresses();
    return answer.ok ? answer.data.addresses : null;
  } catch {
    return null;
  }
}

/**
 * Tapping a saved row (#243, Q3): it becomes the chosen place on the phone,
 * with its pin and area line, and Home then checks its area. Nothing goes to
 * the server. "not-saved" when the phone can't keep it. An area line stored
 * before today's rules is left out, as the phone would drop it on reading.
 * A row with no pin, or one that breaks today's rules, is kept nowhere:
 * "needs-pin" sends it to Confirm to place one first (#373, owner's answer 6).
 */
export async function chooseAddress(keep: (place: Place) => Promise<void>, address: SavedAddress): Promise<"done" | "not-saved" | "needs-pin"> {
  const place = typedPlace(address.pincode);
  if (!place) return "not-saved";
  const point = AddressPoint.safeParse(address.point);
  if (!point.success) return "needs-pin";
  const areaLine = AddressAreaLine.safeParse(address.areaLine);
  try {
    await keep({ ...place, ...(areaLine.success && { areaLine: areaLine.data }), point: point.data });
  } catch {
    return "not-saved";
  }
  return "done";
}

/**
 * Remove on a saved row (#243, Q4), sent once with no retry. An address
 * already gone, removed from another phone, counts as removed.
 */
export async function removeSaved(api: { removeAddress(id: string): Promise<ApiResult<undefined>> }, id: string): Promise<"removed" | "failed"> {
  const outcome = await sentOutcome(() => api.removeAddress(id));
  return outcome === "saved" || outcome === "NOT_FOUND" ? "removed" : "failed";
}

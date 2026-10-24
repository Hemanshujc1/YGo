import type { ApiResult } from "@ygo/api-client";
import type { SavedAddress, SavedAddressesResponse } from "@ygo/contracts";
import { type Place, sentOutcome, typedPlace } from "./location-flow";

/** A row's second line: "4B, Prabhat Road, Shivaji Nagar, Pune", or "4B, 411045" for a place saved without a pin (#243, Q2). */
export const addressLine = (address: SavedAddress) => `${address.flat}, ${address.areaLine ?? address.pincode}`;

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
 * the server. "not-saved" when the phone can't keep it.
 */
export async function chooseAddress(keep: (place: Place) => Promise<void>, address: SavedAddress): Promise<"done" | "not-saved"> {
  const place = typedPlace(address.pincode);
  if (!place) return "not-saved";
  try {
    await keep({
      ...place,
      ...(address.areaLine && { areaLine: address.areaLine }),
      ...(address.point && { point: address.point }),
    });
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

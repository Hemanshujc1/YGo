import { AddressAreaLine, AddressPoint } from "@ygo/contracts";
import * as SecureStore from "expo-secure-store";
import { type Place, typedPlace } from "./location-flow";

// One place per signed-in account, so another person signing in on this phone
// never sees it (#216, Q2). Kept in secure storage: ADR-0001 keeps MMKV for
// display preferences only, and a pincode says where someone lives.
const key = (accountId: string) => `place.${accountId}`;

/**
 * The account's saved place; null when none is saved, or the phone can't read
 * its pincode back, so C15 asks again. A place kept before #242 has no pin or
 * area line, and still reads.
 */
export async function savedPlace(accountId: string): Promise<Place | null> {
  try {
    const value = await SecureStore.getItemAsync(key(accountId));
    const saved: Record<string, unknown> = value ? JSON.parse(value) : {};
    const place = typedPlace(typeof saved.pincode === "string" ? saved.pincode : "");
    if (!place) return null;
    const point = AddressPoint.safeParse(saved.point);
    const areaLine = AddressAreaLine.safeParse(saved.areaLine);
    return {
      ...place,
      ...(typeof saved.name === "string" && { name: saved.name }),
      ...(areaLine.success && { areaLine: areaLine.data }),
      ...(point.success && { point: point.data }),
    };
  } catch {
    return null;
  }
}

/** Rejects when the phone can't save it. */
export async function savePlace(accountId: string, place: Place): Promise<void> {
  await SecureStore.setItemAsync(key(accountId), JSON.stringify(place));
}

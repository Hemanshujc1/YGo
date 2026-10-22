import * as SecureStore from "expo-secure-store";
import { type Place, typedPlace } from "./location-flow";

// One place per signed-in account, so another person signing in on this phone
// never sees it (#216, Q2). Kept in secure storage: ADR-0001 keeps MMKV for
// display preferences only, and a pincode says where someone lives.
const key = (accountId: string) => `place.${accountId}`;

/** The account's saved place; null when none is saved, or the phone can't read it back whole, so C15 asks again. */
export async function savedPlace(accountId: string): Promise<Place | null> {
  try {
    const value = await SecureStore.getItemAsync(key(accountId));
    const saved: Partial<Place> = value ? JSON.parse(value) : {};
    const place = typedPlace(saved.pincode ?? "");
    return place && (typeof saved.name === "string" ? { ...place, name: saved.name } : place);
  } catch {
    return null;
  }
}

/** Rejects when the phone can't save it. */
export async function savePlace(accountId: string, place: Place): Promise<void> {
  await SecureStore.setItemAsync(key(accountId), JSON.stringify(place));
}

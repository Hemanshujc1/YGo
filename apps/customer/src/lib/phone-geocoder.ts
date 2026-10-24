import * as Location from "expo-location";
import type { Geocoder } from "./map-place";

/**
 * The phone's own place lookups, with no map key: C15's search and Confirm's
 * pin (#242). On Android they need location allowed (#217, answer 6).
 */
export const phoneGeocoder: Geocoder = {
  find: (text) => Location.geocodeAsync(text),
  addresses: (point) => Location.reverseGeocodeAsync(point),
};

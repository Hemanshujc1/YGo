import * as Location from "expo-location";
import type { Geocoder } from "./map-place";

/**
 * The phone's own lookup, with no map key: Confirm's pin (#242). On Android
 * it needs location allowed (#217, answer 6).
 */
export const phoneGeocoder: Geocoder = {
  addresses: (point) => Location.reverseGeocodeAsync(point),
};

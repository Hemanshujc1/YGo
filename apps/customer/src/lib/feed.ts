import type { FeedQuery } from "@ygo/contracts";
import type { Place } from "./location-flow";

/** The feed's query for a saved place; null for one with no pin, which Home asks to place on the map (owner's answer 12 on #47). */
export function feedQuery(place: Place): FeedQuery | null {
  return place.point ? { pincode: place.pincode, ...place.point } : null;
}

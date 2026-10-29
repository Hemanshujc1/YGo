import type { FeedQuery, FeedShop } from "@ygo/contracts";
import { formatDayTime } from "@ygo/format";
import { strings } from "../strings";
import type { Place } from "./location-flow";

/** The feed's query for a saved place; null for one with no pin, which Home asks to place on the map (owner's answer 12 on #47). */
export function feedQuery(place: Place): FeedQuery | null {
  return place.point ? { pincode: place.pincode, ...place.point } : null;
}

/** A closed shop's card line, "Closed · opens tomorrow 9:00 AM"; none while open (owner's answer 9 on #371). */
export function closedLine(shop: Pick<FeedShop, "open" | "opensAt">, now: number): string | null {
  return shop.open || !shop.opensAt ? null : strings.feed.closed(formatDayTime(shop.opensAt, now, strings.feed.tomorrow));
}

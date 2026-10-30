import type { FeedQuery, FeedShop } from "@ygo/contracts";
import { formatDayTime } from "@ygo/format";
import { strings } from "../strings";
import type { Place } from "./location-flow";

/** The feed's query for a saved place; null for one with no pin, which Home asks to place on the map (owner's answer 12 on #47). */
export function feedQuery(place: Place): FeedQuery | null {
  return place.point ? { pincode: place.pincode, ...place.point } : null;
}

/** The place a shop or cart link carries as route params; undefined for a link without one, or a broken one. */
export function paramsQuery({ pincode, latitude, longitude }: { pincode?: string; latitude?: string; longitude?: string }): FeedQuery | undefined {
  const place = { pincode: pincode ?? "", latitude: Number(latitude), longitude: Number(longitude) };
  return place.pincode && latitude && longitude && Number.isFinite(place.latitude) && Number.isFinite(place.longitude) ? place : undefined;
}

/**
 * A closed shop's card line, "Closed · opens tomorrow 9:00 AM", or
 * "Holiday · opens …" on one of its holidays; none while open (owner's answer
 * 9 on #371, 10 on #382).
 */
export function closedLine(shop: Pick<FeedShop, "open" | "opensAt" | "holiday">, now: number): string | null {
  if (shop.open || !shop.opensAt) return null;
  return (shop.holiday ? strings.feed.holiday : strings.feed.closed)(formatDayTime(shop.opensAt, now, strings.feed.tomorrow));
}

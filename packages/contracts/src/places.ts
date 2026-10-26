import { z } from "zod";
import { AddressPoint } from "./addresses";
import { PlaceSearchText } from "./fields";

/**
 * C15's place search (#257). The phone asks the server and the server asks
 * Google Places, so the key never ships in the app (Q4). A search and the
 * pick that ends it share one `session`, which Google bills as one (Q5).
 */

/** Made by the phone for each search; Google's session token. */
export const PlaceSession = z.uuid();

/** Google's place id: letters, digits, `_` and `-`. Some run past 100 characters, so it travels in the query, not the path. */
export const PlaceId = z.string().regex(/^[\w-]{1,1000}$/);

/** `GET /v1/places?text=&session=`: up to 5 places in India for the typed text (Q6). */
export const PlaceSearchQuery = z.strictObject({
  text: PlaceSearchText,
  session: PlaceSession,
});
export type PlaceSearchQuery = z.infer<typeof PlaceSearchQuery>;

/**
 * One match: Google's place id and its two lines, such as "Baner Road" over
 * "Baner, Pune, Maharashtra". It has no pincode: Confirm reads that under the pin (Q6).
 */
export const PlaceMatch = z.strictObject({ id: PlaceId, title: z.string(), detail: z.string() });
export type PlaceMatch = z.infer<typeof PlaceMatch>;

/** In Google's order; empty when nothing matches. */
export const PlaceSearchResponse = z.strictObject({ matches: z.array(PlaceMatch).max(5) });
export type PlaceSearchResponse = z.infer<typeof PlaceSearchResponse>;

/** `GET /v1/places/point?id=&session=`: the picked match's point, which ends the search's session. */
export const PlacePointQuery = z.strictObject({ id: PlaceId, session: PlaceSession });
export type PlacePointQuery = z.infer<typeof PlacePointQuery>;

export const PlacePointResponse = z.strictObject({ point: AddressPoint });
export type PlacePointResponse = z.infer<typeof PlacePointResponse>;

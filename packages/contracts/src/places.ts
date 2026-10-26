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

/**
 * Google's place id, an opaque "textual identifier". Google documents no
 * character set, so none is assumed: an id it hands out is never refused for
 * its characters. Google sets no maximum length, and an address in an Indian
 * script runs long (its own example for one in Hyderabad is 679 characters),
 * so the cap is only a guard, far past that. It travels in our query, and the
 * server percent-encodes it into one segment of Google's path; `.` and `..` are
 * refused because a URL resolves them as "this" and "up" segments even then.
 * Control characters such as NUL are refused, as in #269.
 */
export const PlaceId = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/\p{Cc}/u.test(value))
  .refine((value) => value !== "." && value !== "..");

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

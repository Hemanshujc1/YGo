import { z } from "zod";
import { AddressPoint } from "./addresses";

/**
 * C15's place search (#257). The phone asks the server and the server asks
 * Google Places, so the key never ships in the app (Q4). A search and the
 * pick that ends it share one `session`, which Google bills as one (Q5).
 */

/** Made by the phone for each search; Google's session token. */
export const PlaceSession = z.uuid();

/** `GET /v1/places?text=&session=`: up to 5 places in India for the typed text (Q6). */
export const PlaceSearchQuery = z.strictObject({
  text: z.string().trim().min(1).max(100),
  session: PlaceSession,
});
export type PlaceSearchQuery = z.infer<typeof PlaceSearchQuery>;

/**
 * One match: Google's place id and its two lines, such as "Baner Road" over
 * "Baner, Pune, Maharashtra". It has no pincode: Confirm reads that under the pin (Q6).
 */
export const PlaceMatch = z.strictObject({ id: z.string(), title: z.string(), detail: z.string() });
export type PlaceMatch = z.infer<typeof PlaceMatch>;

/** In Google's order; empty when nothing matches. */
export const PlaceSearchResponse = z.strictObject({ matches: z.array(PlaceMatch).max(5) });
export type PlaceSearchResponse = z.infer<typeof PlaceSearchResponse>;

/** `GET /v1/places/:id?session=`: the picked match's point, which ends the search's session. */
export const PlaceParams = z.strictObject({ id: z.string().regex(/^[\w-]{1,300}$/) });
export type PlaceParams = z.infer<typeof PlaceParams>;

export const PlacePointQuery = z.strictObject({ session: PlaceSession });
export type PlacePointQuery = z.infer<typeof PlacePointQuery>;

export const PlacePointResponse = z.strictObject({ point: AddressPoint });
export type PlacePointResponse = z.infer<typeof PlacePointResponse>;

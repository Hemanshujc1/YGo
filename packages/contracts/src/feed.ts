import { z } from "zod";
import { AddressPoint } from "./addresses";
import { Pincode } from "./fields";

/** `GET /v1/feed`: the Customer's pincode finds the Area, the pin tests each shop's radius (DSC-1). */
export const FeedQuery = z.strictObject({
  pincode: Pincode,
  latitude: z.coerce.number().pipe(AddressPoint.shape.latitude),
  longitude: z.coerce.number().pipe(AddressPoint.shape.longitude),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

/** A C04 card (DSC-2). The rating joins with #82, and opening hours with #371. */
export const FeedShop = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** Whole minutes, a multiple of 5 (owner's answer 3 on #47). */
  estimatedMinutes: z.number().int().positive(),
  /** Rupees with two decimals, from the shop's resolved rate card. */
  deliveryFee: z.string().regex(/^\d+\.\d{2}$/),
});
export type FeedShop = z.infer<typeof FeedShop>;

/** Nearest first; empty when the pincode is in no active Area. */
export const FeedResponse = z.strictObject({ shops: z.array(FeedShop) });
export type FeedResponse = z.infer<typeof FeedResponse>;

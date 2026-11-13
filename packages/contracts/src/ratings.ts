import { z } from "zod";

/** Body for rating an order (TRU-1, #82). 1 to 5 stars, with no written comment. */
export const RateOrderBody = z.strictObject({
  stars: z.number().int().min(1).max(5),
});
export type RateOrderBody = z.infer<typeof RateOrderBody>;

/** Response after rating an order (#82). */
export const RateOrderResponse = z.strictObject({
  stars: z.number().int().min(1).max(5),
});
export type RateOrderResponse = z.infer<typeof RateOrderResponse>;


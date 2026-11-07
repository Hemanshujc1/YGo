import { z } from "zod";
import { ProofExceptionBody } from "./orders";

/** Why the code could not be used, as the deliverer chose it on S29 (DLV-4). */
export const ProofExceptionReason = ProofExceptionBody.shape.reason;
export type ProofExceptionReason = z.infer<typeof ProofExceptionReason>;

/** A cursor names the last row of a page: the time the delivery closed, then the order id. */
const cursor = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** `GET /v1/admin/proof-exceptions` (A28, #60): Open or Reviewed, newest first, optionally for one shop or one deliverer. */
export const ProofExceptionsQuery = z.strictObject({
  status: z.enum(["open", "reviewed"]).default("open"),
  shopId: z.uuid().optional(),
  delivererId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: cursor.optional(),
});
export type ProofExceptionsQuery = z.infer<typeof ProofExceptionsQuery>;

export const ProofExceptionParams = z.strictObject({ orderId: z.uuid() });
export type ProofExceptionParams = z.infer<typeof ProofExceptionParams>;

/** `GET /v1/admin/proof-exceptions/:orderId/photo`: a private link that stops working after 5 minutes. 404 `PHOTO_EXPIRED` once the photo is removed. */
export const ProofExceptionPhotoAccess = z.strictObject({ downloadUrl: z.url(), expiresAt: z.iso.datetime() });
export type ProofExceptionPhotoAccess = z.infer<typeof ProofExceptionPhotoAccess>;

export const ProofException = z.strictObject({
  orderId: z.uuid(),
  orderNumber: z.number().int().positive(),
  shop: z.strictObject({ id: z.uuid(), name: z.string() }),
  deliverer: z.strictObject({ id: z.uuid(), name: z.string().nullable() }),
  reason: ProofExceptionReason,
  /** When the delivery closed. */
  recordedAt: z.iso.datetime(),
  /** Null until an Admin or the shop's Area Manager marks it reviewed. */
  reviewed: z.strictObject({ at: z.iso.datetime(), by: z.string().nullable() }).nullable(),
  /** The proof photo is kept 30 days: null once it has been removed. Never its key or a link; `GET .../photo` issues one on demand (#560). */
  photo: z.strictObject({ expiresAt: z.iso.datetime() }).nullable(),
});
export type ProofException = z.infer<typeof ProofException>;

/** How many proof exceptions a shop or a deliverer has, of any age: `open` still waits for review (DLV-4, R-8). Worked out from the orders. */
const Count = { total: z.number().int().nonnegative(), open: z.number().int().nonnegative() };
export const ProofExceptionCounts = z.strictObject({
  shops: z.array(z.strictObject({ shopId: z.uuid(), name: z.string(), ...Count })),
  deliverers: z.array(z.strictObject({ accountId: z.uuid(), name: z.string().nullable(), ...Count })),
});
export type ProofExceptionCounts = z.infer<typeof ProofExceptionCounts>;

export const ProofExceptionsResponse = z.strictObject({
  exceptions: z.array(ProofException),
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: cursor.nullable(),
  /** Counted over every proof exception the caller may see, not only this page or filter. */
  counts: ProofExceptionCounts,
});
export type ProofExceptionsResponse = z.infer<typeof ProofExceptionsResponse>;

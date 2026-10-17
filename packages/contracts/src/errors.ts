import { z } from "zod";

/**
 * Every machine code the API returns. The server never sends display text
 * (ADR-0004): each client maps a code to its own words. New codes are added,
 * never renamed or removed, so a client treats a code it does not know as
 * INTERNAL.
 */
export const ErrorCode = z.enum([
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "UNAVAILABLE",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The body of every non-2xx response. */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

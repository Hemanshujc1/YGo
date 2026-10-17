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

/**
 * The body of every non-2xx response. With VALIDATION_FAILED, `fields` names
 * each request-body field that broke its rule, as built by `invalidFields`;
 * the client shows its own message for each.
 */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    fields: z.array(z.string()).optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/**
 * The fields a failed parse names, once each, as dot paths such as
 * `address.pincode`. A form and the server both use it, so a field has the
 * same name on both sides. A problem with the whole value names no field.
 */
export function invalidFields(error: z.ZodError): string[] {
  const paths = error.issues
    .filter((issue) => issue.path.length > 0)
    .map((issue) => issue.path.map(String).join("."));
  return [...new Set(paths)];
}

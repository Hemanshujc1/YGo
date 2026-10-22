import { z } from "zod";

/**
 * Every machine code the API returns. The server never sends display text
 * (ADR-0004): each client maps a code to its own words. New codes are added,
 * never renamed or removed, so a client treats a code it does not know as
 * INTERNAL.
 *
 * Sign-in (#34), with the status each is sent with:
 * - UNAUTHENTICATED (401): no session, an expired access token, or a revoked session.
 * - PROFILE_REQUIRED (403): the name and phone are not set yet.
 * - CODE_WRONG (400): the sign-in code does not match.
 * - CODE_EXPIRED (400): the code is over 5 minutes old, or a newer one replaced it.
 * - CODE_LOCKED (429): 5 wrong tries lock the email for 15 minutes.
 * - TOO_MANY_REQUESTS (429): a limit on sending codes was hit.
 * - PHONE_IN_USE (409): another account has this phone number.
 *
 * Admin accounts (#37), with the status each is sent with:
 * - EMAIL_IN_USE (409): another account has this email.
 * - FORBIDDEN (403): signed in, but not allowed (for example, not an Admin).
 *
 * Areas (#213), with the status each is sent with:
 * - AREA_NAME_IN_USE (409): another Area has this name, ignoring case.
 * - PINCODE_IN_OTHER_AREA (409): another Area holds one or more of the
 *   pincodes; `conflicts` names each pincode and the Area holding it.
 * Master products (#203):
 * - PRODUCT_NAME_IN_USE (409): another global product has the same name and brand, ignoring case.
 */
export const ErrorCode = z.enum([
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "UNAVAILABLE",
  "INTERNAL",
  "UPDATE_REQUIRED",
  "UNAUTHENTICATED",
  "PROFILE_REQUIRED",
  "CODE_WRONG",
  "CODE_EXPIRED",
  "CODE_LOCKED",
  "TOO_MANY_REQUESTS",
  "PHONE_IN_USE",
  "EMAIL_IN_USE",
  "FORBIDDEN",
  "CATEGORY_NAME_IN_USE",
  "AREA_NAME_IN_USE",
  "PINCODE_IN_OTHER_AREA",
  "PRODUCT_NAME_IN_USE",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * The body of every non-2xx response. With VALIDATION_FAILED, `fields` names
 * each request-body field that broke its rule, as built by `invalidFields`;
 * the client shows its own message for each. With PINCODE_IN_OTHER_AREA,
 * `conflicts` names each pincode another Area holds.
 */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    fields: z.array(z.string()).optional(),
    conflicts: z.array(z.object({ pincode: z.string(), areaName: z.string() })).optional(),
    draftId: z.uuid().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/**
 * The fields a failed parse names, once each, as dot paths such as
 * `address.pincode`. A form and the server both use it, so a field has the
 * same name on both sides. An unexpected key is named too; any other problem
 * with the whole value names no field.
 */
export function invalidFields(error: z.ZodError): string[] {
  const paths = error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => [...issue.path, key])
      : [issue.path],
  );
  return [
    ...new Set(paths.filter((path) => path.length > 0).map((path) => path.map(String).join("."))),
  ];
}

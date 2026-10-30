import { z } from "zod";
import { CartResponse } from "./cart";
import { CatalogImportRowErrors } from "./catalog";
import { LiveCheck } from "./shops";

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
 * Catalog packs (#205):
 * - PACK_QUANTITY_IN_USE (409): this product already has that pack quantity, including inactive packs.
 * - BARCODE_IN_USE (409): another global pack holds this barcode, including inactive packs.
 * Catalog import (#258):
 * - CATALOG_IMPORT_ROWS_INVALID (409): rows became invalid between preview and commit; `rowErrors` contains the same list shape as preview.
 * - File-level import failures use VALIDATION_FAILED (400). Missing CSV/ZIP parts name the missing part; missing or unknown CSV columns name `catalogCsv`; unreadable ZIPs name `imagesZip`; an oversized file names the part that exceeded its limit.
 * Saved addresses (#217):
 * - ADDRESS_LIMIT_REACHED (409): the account already has 10 saved addresses.
 * Place search (#257):
 * - TOO_MANY_REQUESTS (429): the account searched 30 times in the last hour, or picked a match 30 times; each is counted on its own.
 * - UNAVAILABLE (503): Google Places did not answer, or no key is set.
 * - NOT_FOUND (404): the picked place is gone, or has no point in India.
 * Shop application (#40):
 * - SHOP_APPLICATION_EXISTS (409): the account already has a shop application or shop link (ACC-4).
 * - SHOP_APPLICATION_SENT (409): the Owner saved or sent an application that is no longer a Draft.
 * - PINCODE_NOT_IN_AREA (409): the shop's pincode is in no Area, at Send or in an Admin correction.
 * - SHOP_STATE_CHANGE_REFUSED (409): Start review on anything but Submitted, or Approve on anything but Under Review.
 * Visit evidence (#42):
 * - VISIT_PHOTO_LOCATION_MISSING (400): the uploaded JPEG has no valid GPS metadata.
 * - Invalid, oversized or unreadable evidence uses VALIDATION_FAILED, naming photo.
 * - A Draft is the Owner's own: Admin calls on one answer NOT_FOUND.
 * Shop setup (#43):
 * - SHOP_LISTING_NOT_READY (409): the shop has not been Approved yet.
 * - OPENING_STOCK_ALREADY_RECORDED (409): an opening movement already exists for this listing.
 * Onboarding agreement (#362):
 * - SHOP_NOT_APPROVED (409): the shop is not Approved or Live yet.
 * - RATE_CARD_INCOMPLETE (409): the shop's rate card is missing a required value (MNY-13).
 * - AGREEMENT_OUTDATED (409): the agreement version accepted is not the current one.
 * - RATE_CARD_CHANGED (409): a newer rate card affecting the shop was published after the one read.
 * Move to Live (#363):
 * - SHOP_NOT_READY (409): something still blocks Live; `liveCheck` names each blocker.
 * - SHOP_STATE_CHANGE_REFUSED (409) also answers Move to Live on anything but Approved.
 * Open/closed switch (#380):
 * - SHOP_NOT_LIVE (409): the switch works only once the shop is Live.
 * Search terms (#397):
 * - SEARCH_TERM_IN_USE (409): the list already pairs this typed word with this catalog word.
 * Holidays (#382):
 * - HOLIDAY_OVERLAP (409): the dates overlap another of the shop's holidays.
 * - TOO_MANY_HOLIDAYS (409): the shop already has MAX_UPCOMING_HOLIDAYS not ended yet.
 * - Dates outside today to HOLIDAY_DAYS_AHEAD, or moving the start of a holiday already under way, use VALIDATION_FAILED.
 * Placing an order (#424):
 * - CART_CHANGED (409): the revision or total C07 showed is not the server's fresh quote, or the cart can't be ordered now; `cart` is the cart as it is now.
 * - OWN_SHOP (403): the account is Owner or Staff of this shop (ACC-9).
 * - ORDER_STATUS_CHANGED (409): the order is no longer in a status this move starts from.
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
  "PACK_QUANTITY_IN_USE",
  "BARCODE_IN_USE",
  "ADDRESS_LIMIT_REACHED",
  "CATALOG_IMPORT_ROWS_INVALID",
  "SHOP_APPLICATION_EXISTS",
  "SHOP_APPLICATION_SENT",
  "PINCODE_NOT_IN_AREA",
  "SHOP_STATE_CHANGE_REFUSED",
  "VISIT_PHOTO_LOCATION_MISSING",
  "SHOP_LISTING_NOT_READY",
  "OPENING_STOCK_ALREADY_RECORDED",
  "SHOP_NOT_APPROVED",
  "RATE_CARD_INCOMPLETE",
  "AGREEMENT_OUTDATED",
  "RATE_CARD_CHANGED",
  "SHOP_NOT_READY",
  "SHOP_NOT_LIVE",
  "HOLIDAY_OVERLAP",
  "TOO_MANY_HOLIDAYS",
  "SEARCH_TERM_IN_USE",
  "CART_CHANGED",
  "OWN_SHOP",
  "ORDER_STATUS_CHANGED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * The body of every non-2xx response. With VALIDATION_FAILED, `fields` names
 * each request-body field or multipart file part that broke its rule, as built by `invalidFields`;
 * the client shows its own message for each. With PINCODE_IN_OTHER_AREA,
 * `conflicts` names each pincode another Area holds. With CATALOG_IMPORT_ROWS_INVALID,
 * `rowErrors` uses the same CatalogImportRowError shape as a preview response.
 * With SHOP_NOT_READY, `liveCheck` names what still blocks Live.
 * With CART_CHANGED from placing an order, `cart` is the cart as it is now.
 */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    fields: z.array(z.string()).optional(),
    conflicts: z.array(z.object({ pincode: z.string(), areaName: z.string() })).optional(),
    draftId: z.uuid().optional(),
    rowErrors: CatalogImportRowErrors.optional(),
    liveCheck: LiveCheck.optional(),
    cart: CartResponse.optional(),
  }).refine((error) => error.code !== "CATALOG_IMPORT_ROWS_INVALID" || error.rowErrors !== undefined),
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

import { z } from "zod";
import { AddressPoint } from "./addresses";
import {
  AdminActionReason,
  CalendarDate,
  FssaiNumber,
  Pan,
  PersonName,
  Pincode,
  ServiceRadiusMetres,
  ShopAddress,
  ShopEntityType,
  ShopName,
  UpiId,
} from "./fields";

/**
 * The shop application (#40): the Owner fills in a Draft in the Shopkeeper
 * app and sends it, and Admin reviews, corrects and approves it (ONB-1,
 * ONB-3). Numbers only: no image of an identity document and no bank details.
 * Decisions: the owner's answers on #40.
 */

/** Live, Suspended and Closed join when a shop can reach them (#46). */
export const ShopState = z.enum(["draft", "submitted", "under_review", "approved"]);
export type ShopState = z.infer<typeof ShopState>;

/** The ONB-3 fields; the Owner's phone and email come from the account. */
const applicationFields = {
  shopName: ShopName,
  address: ShopAddress,
  pincode: Pincode,
  /** Taken from the phone's GPS while standing in the shop (Q6). */
  location: AddressPoint,
  /** The legal name for invoices, filled in from the account's name at the start (Q11). */
  ownerName: PersonName,
  entityType: ShopEntityType,
  pan: Pan,
  fssaiNumber: FssaiNumber,
  fssaiExpiry: CalendarDate,
  serviceRadiusMetres: ServiceRadiusMetres,
  upiId: UpiId,
};
export type ShopApplicationField = keyof typeof applicationFields;

/**
 * `PATCH /v1/me/shop-application`: Save draft. A missing field stays as it
 * was and `null` empties it; a value given must keep its rule.
 */
export const SaveShopApplicationBody = z.strictObject({
  shopName: ShopName.nullable().optional(),
  address: ShopAddress.nullable().optional(),
  pincode: Pincode.nullable().optional(),
  location: AddressPoint.nullable().optional(),
  ownerName: PersonName.nullable().optional(),
  entityType: ShopEntityType.nullable().optional(),
  pan: Pan.nullable().optional(),
  fssaiNumber: FssaiNumber.nullable().optional(),
  fssaiExpiry: CalendarDate.nullable().optional(),
  serviceRadiusMetres: ServiceRadiusMetres.nullable().optional(),
  upiId: UpiId.nullable().optional(),
});
export type SaveShopApplicationBody = z.infer<typeof SaveShopApplicationBody>;

/** India's date at `now`, `YYYY-MM-DD`. India keeps UTC+5:30 all year. */
function indiaDate(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * `POST /v1/me/shop-application/send`: every field, with an FSSAI expiry
 * after today in India (Q10). The server saves and sends in one step; the
 * form runs the same check first. A pincode in no Area is refused by the
 * server as PINCODE_NOT_IN_AREA.
 */
export const SendShopApplicationBody = (now: Date) =>
  z.strictObject(applicationFields).refine((body) => body.fssaiExpiry > indiaDate(now), { path: ["fssaiExpiry"] });
export type SendShopApplicationBody = z.infer<ReturnType<typeof SendShopApplicationBody>>;

/**
 * `PATCH /v1/admin/shop-applications/:id`: Admin corrects one or more fields
 * with a reason, while Submitted, Under Review or Approved (Q5). Each field
 * goes on the admin action record by name, never its value. A past FSSAI
 * expiry is allowed here: Admin records what the licence says (D-17).
 */
export const CorrectShopApplicationBody = z
  .strictObject({
    shopName: ShopName.optional(),
    address: ShopAddress.optional(),
    pincode: Pincode.optional(),
    location: AddressPoint.optional(),
    ownerName: PersonName.optional(),
    entityType: ShopEntityType.optional(),
    pan: Pan.optional(),
    fssaiNumber: FssaiNumber.optional(),
    fssaiExpiry: CalendarDate.optional(),
    serviceRadiusMetres: ServiceRadiusMetres.optional(),
    upiId: UpiId.optional(),
    reason: AdminActionReason,
  })
  .refine((body) => Object.keys(body).some((key) => key !== "reason"));
export type CorrectShopApplicationBody = z.infer<typeof CorrectShopApplicationBody>;

/**
 * An application as stored. Plain types, so a row saved before a rule
 * changed still reads; a Draft's fields are null until filled in.
 * `areaName` is set at Send, from the pincode's Area (Q7).
 */
export const ShopApplication = z.strictObject({
  id: z.uuid(),
  state: ShopState,
  shopName: z.string().nullable(),
  address: z.string().nullable(),
  pincode: z.string().nullable(),
  location: z.strictObject({ latitude: z.number(), longitude: z.number() }).nullable(),
  ownerName: z.string().nullable(),
  entityType: ShopEntityType.nullable(),
  pan: z.string().nullable(),
  fssaiNumber: z.string().nullable(),
  fssaiExpiry: z.string().nullable(),
  serviceRadiusMetres: z.number().int(),
  upiId: z.string().nullable(),
  areaName: z.string().nullable(),
  ownerPhone: z.string().nullable(),
  ownerEmail: z.string(),
  submittedAt: z.iso.datetime().nullable(),
});
export type ShopApplication = z.infer<typeof ShopApplication>;

/** `GET /v1/me/shop-application`: null until the Owner taps Start. */
export const MyShopApplicationResponse = z.strictObject({ application: ShopApplication.nullable() });
export type MyShopApplicationResponse = z.infer<typeof MyShopApplicationResponse>;

/** `GET /v1/admin/shop-applications`: Submitted, Under Review and Approved, the longest waiting first. */
export const ShopApplicationsResponse = z.strictObject({ applications: z.array(ShopApplication) });
export type ShopApplicationsResponse = z.infer<typeof ShopApplicationsResponse>;

export const ShopApplicationParams = z.strictObject({ id: z.uuid() });

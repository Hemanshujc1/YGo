import { z } from "zod";
import { AddressPoint } from "./addresses";
import {
  AdminActionReason,
  CalendarDate,
  FssaiNumber,
  indiaToday,
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
  /**
   * Taken from the phone's GPS while standing in the shop (Q6). AddressPoint
   * is a rough box around India, not a border check.
   */
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

/** Each field rule, also taking `null`. */
function emptiable<T extends Record<string, z.ZodType>>(fields: T) {
  return Object.fromEntries(Object.entries(fields).map(([key, rule]) => [key, rule.nullable()])) as {
    [K in keyof T]: z.ZodNullable<T[K]>;
  };
}

/**
 * `PATCH /v1/me/shop-application`: Save draft. A missing field stays as it
 * was and `null` empties it; a value given must keep its rule. The service
 * radius can't be emptied: it starts at 2 km and always has a value (Q9).
 */
export const SaveShopApplicationBody = z
  .strictObject({ ...emptiable(applicationFields), serviceRadiusMetres: ServiceRadiusMetres })
  .partial();
export type SaveShopApplicationBody = z.infer<typeof SaveShopApplicationBody>;

/**
 * `POST /v1/me/shop-application/send`: every field, with an FSSAI expiry
 * after today in India (Q10). The clock is read on each check, and the
 * expiry is checked with the other fields so every error shows at once.
 * The server saves the fields and sends in one transaction; the form runs
 * the same check first. A pincode in no Area is refused by the server as
 * PINCODE_NOT_IN_AREA.
 */
export const SendShopApplicationBody = z.strictObject({
  ...applicationFields,
  fssaiExpiry: CalendarDate.refine((date) => date > indiaToday()),
});
export type SendShopApplicationBody = z.infer<typeof SendShopApplicationBody>;

/**
 * `PATCH /v1/admin/shop-applications/:id`: Admin corrects one or more fields
 * with a reason, while Submitted, Under Review or Approved (Q5). Each field
 * goes on the admin action record by name, never its value. A past FSSAI
 * expiry is allowed here: Admin records what the licence says (D-17). A body
 * with a reason and no field is refused, naming `fields`.
 */
export const CorrectShopApplicationBody = z
  .strictObject({ ...applicationFields, reason: AdminActionReason })
  .partial()
  .required({ reason: true })
  .refine((body) => Object.entries(body).some(([key, value]) => key !== "reason" && value !== undefined), {
    path: ["fields"],
  });
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

/**
 * An application as the Admin web reads it: with the Area Manager Admin
 * assigned it to, or null for Admin's own shop (#299). Only the Admin
 * endpoints answer it, so an Owner never sees who manages their shop.
 */
export const AdminShopApplication = ShopApplication.extend({
  areaManager: z.strictObject({ id: z.uuid(), name: z.string().nullable(), email: z.string() }).nullable(),
});
export type AdminShopApplication = z.infer<typeof AdminShopApplication>;

/**
 * `GET /v1/admin/shop-applications`: Submitted, Under Review and Approved, the longest waiting first.
 * An Area Manager gets only the shops assigned to them (#299).
 */
export const ShopApplicationsResponse = z.strictObject({ applications: z.array(AdminShopApplication) });
export type ShopApplicationsResponse = z.infer<typeof ShopApplicationsResponse>;

export const ShopApplicationParams = z.strictObject({ id: z.uuid() });

/**
 * `PUT /v1/admin/shop-applications/:id/area-manager`: Admin assigns the shop to an
 * Area Manager, moves it to another, or takes it back with null, with a reason (#299).
 * An id that is not an Area Manager answers VALIDATION_FAILED naming `areaManagerId`.
 */
export const AssignShopAreaManagerBody = z.strictObject({ areaManagerId: z.uuid().nullable(), reason: AdminActionReason });
export type AssignShopAreaManagerBody = z.infer<typeof AssignShopAreaManagerBody>;

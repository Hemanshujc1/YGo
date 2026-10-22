import { z } from "zod";
import { AddressAreaLine, AddressFlat, Pincode } from "./fields";

/**
 * A Customer's saved addresses, chosen and confirmed on C15 (#217). Each
 * confirmed place is saved; the account keeps at most 10.
 */

/** A new Home or Work replaces the account's old one; Other can repeat (owner decision on #217). */
export const AddressLabel = z.enum(["home", "work", "other"]);
export type AddressLabel = z.infer<typeof AddressLabel>;

/**
 * The confirmed pin. The server does no map lookups, so it only checks the
 * point lies in a box around India, which catches swapped or zeroed
 * coordinates (#217).
 */
export const AddressPoint = z.strictObject({
  latitude: z.number().min(6).max(38),
  longitude: z.number().min(68).max(98),
});
export type AddressPoint = z.infer<typeof AddressPoint>;

/**
 * `POST /v1/me/addresses`. `point` is null when the place was typed as a
 * pincode on an Android phone with location refused (owner decision on #217).
 */
export const SaveAddressBody = z.strictObject({
  label: AddressLabel,
  flat: AddressFlat,
  areaLine: AddressAreaLine,
  pincode: Pincode,
  point: AddressPoint.nullable(),
});
export type SaveAddressBody = z.infer<typeof SaveAddressBody>;

export const SavedAddress = SaveAddressBody.extend({ id: z.uuid() });
export type SavedAddress = z.infer<typeof SavedAddress>;

/** The server sends the newest first. */
export const SavedAddressesResponse = z.strictObject({ addresses: z.array(SavedAddress) });
export type SavedAddressesResponse = z.infer<typeof SavedAddressesResponse>;

/** `DELETE /v1/me/addresses/:id` */
export const SavedAddressParams = z.strictObject({ id: z.uuid() });

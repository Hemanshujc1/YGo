import { z } from "zod";
import { AddressAreaLine, AddressFlat, Pincode } from "./fields";

/**
 * A Customer's saved addresses, chosen and confirmed on C15 (#217). Each
 * confirmed place is saved; the account keeps at most 10.
 */

/**
 * A new Home or Work replaces the account's old one, so it never meets the
 * 10-address limit; Other can repeat (owner decision on #217). Saving an
 * Other the same in every field answers the one already saved, so a retried
 * save never adds a second (#242).
 */
export const AddressLabel = z.enum(["home", "work", "other"]);
export type AddressLabel = z.infer<typeof AddressLabel>;

/**
 * The confirmed pin. The server does no map lookups, so this is only a rough
 * box around India, not a border check: it catches swapped or zeroed
 * coordinates, and lets through parts of neighbouring countries (#217).
 */
export const AddressPoint = z.strictObject({
  latitude: z.number().min(6).max(38),
  longitude: z.number().min(68).max(98),
});
export type AddressPoint = z.infer<typeof AddressPoint>;

/**
 * `POST /v1/me/addresses`. `point` and `areaLine` are null when the place
 * was typed as a pincode on an Android phone with location refused, since
 * the phone can't look the place up then (owner decision on #217).
 */
export const SaveAddressBody = z.strictObject({
  label: AddressLabel,
  flat: AddressFlat,
  areaLine: AddressAreaLine.nullable(),
  pincode: Pincode,
  point: AddressPoint.nullable(),
});
export type SaveAddressBody = z.infer<typeof SaveAddressBody>;

/** Plain types, so a stored row from before a rule changed still lists. */
export const SavedAddress = z.strictObject({
  id: z.uuid(),
  label: AddressLabel,
  flat: z.string(),
  areaLine: z.string().nullable(),
  pincode: z.string(),
  point: z.strictObject({ latitude: z.number(), longitude: z.number() }).nullable(),
});
export type SavedAddress = z.infer<typeof SavedAddress>;

/** The server sends the newest first. */
export const SavedAddressesResponse = z.strictObject({ addresses: z.array(SavedAddress) });
export type SavedAddressesResponse = z.infer<typeof SavedAddressesResponse>;

/** `DELETE /v1/me/addresses/:id` */
export const SavedAddressParams = z.strictObject({ id: z.uuid() });

import { z } from "zod";
import { AddressAreaLine, AddressFlat, Pincode } from "./fields";

/**
 * A Customer's saved addresses, chosen and confirmed on C15 (#217). Each
 * confirmed place is saved; the account keeps at most 10.
 */

/**
 * A new Home or Work replaces the account's old one, so replacing never meets
 * the 10-address limit; Other can repeat (owner decision on #217). Saving an
 * Other the same in every field answers the one already saved, moved to the
 * newest, so a retried save never adds a second (#242).
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

/**
 * `GET /v1/me/addresses?shopId=`: with a shop, only the addresses with a pin it delivers to now,
 * for C07's Deliver to (#427, owner's answer 1).
 */
export const SavedAddressesQuery = z.strictObject({ shopId: z.uuid().optional() });
export type SavedAddressesQuery = z.infer<typeof SavedAddressesQuery>;

/** The server sends the newest first. */
export const SavedAddressesResponse = z.strictObject({ addresses: z.array(SavedAddress) });
export type SavedAddressesResponse = z.infer<typeof SavedAddressesResponse>;

/** `DELETE /v1/me/addresses/:id` */
export const SavedAddressParams = z.strictObject({ id: z.uuid() });

/**
 * `PUT /v1/me/addresses/:id/point`: puts the pin on a saved address that has
 * none, keeping its pincode, flat and label (#373, owner's answer 6). Sending
 * it again answers the same address.
 */
export const AddressPinBody = z.strictObject({ point: AddressPoint });
export type AddressPinBody = z.infer<typeof AddressPinBody>;

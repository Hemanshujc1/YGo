import { z } from "zod";
import { AdminActionReason, AreaName, Phone, Pincode } from "./fields";

/**
 * Admin-named Areas of pincodes, and the Customer's "not serviceable yet"
 * check (#38, #213). A pincode belongs to one Area at most.
 */

/** 1 to 100 pincodes, none twice once spaces are removed (owner decisions on #213). */
const AreaPincodes = z
  .array(Pincode)
  .min(1)
  .max(100)
  .refine((pincodes) => new Set(pincodes).size === pincodes.length);

/** The server sends `pincodes` sorted. */
export const Area = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  pincodes: z.array(z.string()),
  paused: z.boolean(),
});
export type Area = z.infer<typeof Area>;
export const AreasResponse = z.strictObject({ areas: z.array(Area) });
export type AreasResponse = z.infer<typeof AreasResponse>;
export const AreaParams = z.strictObject({ id: z.uuid() });

/** The server records the creation with the fixed reason "Area created". */
export const CreateAreaBody = z.strictObject({ name: AreaName, pincodes: AreaPincodes });
export type CreateAreaBody = z.infer<typeof CreateAreaBody>;

/**
 * One change per edit, so each edit writes one admin action record: the whole
 * new pincode list, or pause (`true`) / resume (`false`). Always with a reason.
 */
export const EditAreaBody = z
  .strictObject({
    pincodes: AreaPincodes.optional(),
    paused: z.boolean().optional(),
    reason: AdminActionReason,
  })
  .refine((body) => (body.pincodes === undefined) !== (body.paused === undefined));
export type EditAreaBody = z.infer<typeof EditAreaBody>;

/** `GET /v1/serviceability?pincode=` */
export const ServiceabilityQuery = z.strictObject({ pincode: Pincode });
export type ServiceabilityQuery = z.infer<typeof ServiceabilityQuery>;

/** A pincode in no Area, or in a paused one, is not serviceable. */
export const Serviceability = z.discriminatedUnion("serviceable", [
  z.strictObject({ serviceable: z.literal(true), areaName: z.string() }),
  z.strictObject({ serviceable: z.literal(false) }),
]);
export type Serviceability = z.infer<typeof Serviceability>;

/** "Leave my number" on C03. A repeat for the same pincode replaces the saved phone. */
export const WaitlistBody = z.strictObject({ pincode: Pincode, phone: Phone });
export type WaitlistBody = z.infer<typeof WaitlistBody>;

import { z } from "zod";
import { Phone } from "./fields";

/** The Owner invites a person by phone number and chooses `can deliver` (ACC-6, DLV-1, S20). */
export const InviteStaffBody = z.strictObject({ phone: Phone, canDeliver: z.boolean() });
export type InviteStaffBody = z.infer<typeof InviteStaffBody>;

/** The one-time join code, shown to the Owner once and valid until `expiresAt`. */
export const StaffInviteResponse = z.strictObject({ code: z.string(), expiresAt: z.iso.datetime() });
export type StaffInviteResponse = z.infer<typeof StaffInviteResponse>;

/** People who are not working in the shop now: an open invitation, or a deactivated link that a re-invite restores (S16). */
export const StaffInvite = z.strictObject({
  phone: z.string(),
  name: z.string().nullable(),
  canDeliver: z.boolean(),
  status: z.enum(["invited", "deactivated"]),
  expiresAt: z.iso.datetime().nullable(),
});
export type StaffInvite = z.infer<typeof StaffInvite>;
export const StaffInvitesResponse = z.strictObject({ invites: z.array(StaffInvite) });
export type StaffInvitesResponse = z.infer<typeof StaffInvitesResponse>;

/** The invited person types the code the Owner shows (S21). */
export const JoinShopBody = z.strictObject({ code: z.string().trim().toUpperCase().regex(/^[A-Z2-9]{8}$/) });
export type JoinShopBody = z.infer<typeof JoinShopBody>;
export const JoinShopResponse = z.strictObject({ shopName: z.string().nullable() });
export type JoinShopResponse = z.infer<typeof JoinShopResponse>;

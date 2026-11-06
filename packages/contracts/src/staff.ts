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

/** 32 characters with no I, O, 0 or 1, so a code read aloud or off a screen is not mistyped. The server draws codes from it and S21 accepts only it. */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 8;

/** The invited person types the code the Owner shows (S21). */
export const JoinShopBody = z.strictObject({ code: z.string().trim().toUpperCase().regex(new RegExp(`^[${JOIN_CODE_ALPHABET}]{${JOIN_CODE_LENGTH}}$`)) });
export type JoinShopBody = z.infer<typeof JoinShopBody>;
export const JoinShopResponse = z.strictObject({ shopName: z.string().nullable() });
export type JoinShopResponse = z.infer<typeof JoinShopResponse>;

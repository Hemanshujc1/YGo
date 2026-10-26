import { z } from "zod";
import {
  AdminActionReason, OnboardingFeeAmount, OnboardingPaymentDate, OnboardingPaymentReference,
  ShopVisitDate, ShopVisitNotes, VISIT_PHOTO_MAX_BYTES,
} from "./fields";

/** ACC-14: in-person confirmation never means an SMS code was checked. */
export const PhoneConfirmationState = z.enum(["unverified", "visit_confirmed", "sms_verified"]);
export type PhoneConfirmationState = z.infer<typeof PhoneConfirmationState>;

/** POST /v1/admin/shop-applications/:id/visit-photo-upload; private presigned PUT. */
export const CreateVisitPhotoUploadBody = z.strictObject({
  contentType: z.literal("image/jpeg"),
  byteLength: z.number().int().min(1).max(VISIT_PHOTO_MAX_BYTES),
});
export type CreateVisitPhotoUploadBody = z.infer<typeof CreateVisitPhotoUploadBody>;
export const VisitPhotoUpload = z.strictObject({ id: z.uuid(), uploadUrl: z.url() });
export type VisitPhotoUpload = z.infer<typeof VisitPhotoUpload>;

/** Every A08 check is mandatory (owner decisions on #42). */
export const ShopVisitChecks = z.strictObject({
  pan: z.literal(true),
  fssai: z.literal(true),
  ownerPhone: z.literal(true),
  ownerEmail: z.literal(true),
  alarmPermission: z.literal(true),
  testerOptIn: z.literal(true),
});
export type ShopVisitChecks = z.infer<typeof ShopVisitChecks>;

/** POST /v1/admin/shop-applications/:id/visits. GPS comes from the file, never this body. */
export const RecordShopVisitBody = z.strictObject({
  photoUploadId: z.uuid(),
  visitDate: ShopVisitDate,
  checks: ShopVisitChecks,
  notes: ShopVisitNotes.optional(),
});
export type RecordShopVisitBody = z.infer<typeof RecordShopVisitBody>;

/**
 * Immutable visit history. Photo may be purged independently of the durable
 * visit (DEL-10). capturedAt preserves photo metadata when present; it can
 * lack a timezone. recordedAt is always the server's UTC timestamp (#42).
 */
export const ShopVisit = z.strictObject({
  id: z.uuid(),
  visitDate: z.string(),
  recordedAt: z.iso.datetime(),
  actorId: z.uuid(),
  checks: ShopVisitChecks,
  notes: z.string().nullable(),
  photo: z.strictObject({
    id: z.uuid(),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    capturedAt: z.string().nullable(),
  }).nullable(),
});
export type ShopVisit = z.infer<typeof ShopVisit>;

/** Private GET access is issued afresh to an authorized Admin, never stored in history. */
export const ShopVisitParams = z.strictObject({ id: z.uuid(), visitId: z.uuid() });
export const VisitPhotoAccess = z.strictObject({ downloadUrl: z.url() });
export type VisitPhotoAccess = z.infer<typeof VisitPhotoAccess>;

/**
 * POST /v1/admin/shop-applications/:id/onboarding-fees. No fixed fee (MNY-3).
 * The pilot uses waived (ONB-2). A paid entry requires amount/date/reference;
 * replacing an existing entry additionally requires reason, checked by the
 * server against its history. Every save appends, rather than overwrites.
 */
export const RecordOnboardingFeeBody = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("waived"), reason: AdminActionReason }),
  z.strictObject({
    status: z.literal("paid"), amount: OnboardingFeeAmount,
    paymentDate: OnboardingPaymentDate, reference: OnboardingPaymentReference,
    reason: AdminActionReason.optional(),
  }),
]);
export type RecordOnboardingFeeBody = z.infer<typeof RecordOnboardingFeeBody>;

const feeRecord = { id: z.uuid(), actorId: z.uuid(), recordedAt: z.iso.datetime() };
export const OnboardingFee = z.discriminatedUnion("status", [
  z.strictObject({ ...feeRecord, status: z.literal("waived"), reason: z.string() }),
  z.strictObject({
    ...feeRecord, status: z.literal("paid"), amount: z.string(),
    paymentDate: z.string(), reference: z.string(), reason: z.string().nullable(),
  }),
]);
export type OnboardingFee = z.infer<typeof OnboardingFee>;

/** GET /v1/admin/shop-applications/:id/onboarding; both histories newest first. */
export const ShopOnboarding = z.strictObject({
  visits: z.array(ShopVisit),
  fees: z.array(OnboardingFee),
  ownerPhoneState: PhoneConfirmationState,
  ownerEmailConfirmedAt: z.iso.datetime().nullable(),
});
export type ShopOnboarding = z.infer<typeof ShopOnboarding>;

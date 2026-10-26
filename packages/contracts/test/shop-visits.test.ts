import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateVisitPhotoUploadBody, ErrorCode, invalidFields, OnboardingFeeAmount,
  PhoneConfirmationState, RecordOnboardingFeeBody, RecordShopVisitBody,
  ShopOnboarding, ShopVisit, ShopVisitChecks, ShopVisitParams, VisitPhotoAccess,
  VisitPhotoUpload, VISIT_PHOTO_MAX_BYTES,
} from "../src/index";

const id = "550e8400-e29b-41d4-a716-446655440000";
const checks = {
  pan: true, fssai: true, ownerPhone: true, ownerEmail: true,
  alarmPermission: true, testerOptIn: true,
};
const visit = { photoUploadId: id, visitDate: "2026-10-26", checks };
beforeEach(() => vi.useFakeTimers({ now: new Date("2026-10-26T12:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("private visit photo uploads", () => {
  it("accepts JPEG up to the agreed 10 MB, and refuses empty/oversized/non-JPEG files", () => {
    const body = { contentType: "image/jpeg", byteLength: VISIT_PHOTO_MAX_BYTES };
    expect(CreateVisitPhotoUploadBody.parse(body)).toEqual(body);
    for (const byteLength of [0, -1, 1.5, VISIT_PHOTO_MAX_BYTES + 1]) {
      expect(CreateVisitPhotoUploadBody.safeParse({ ...body, byteLength }).success).toBe(false);
    }
    for (const contentType of ["image/heic", "image/png", "text/plain"]) {
      expect(CreateVisitPhotoUploadBody.safeParse({ ...body, contentType }).success).toBe(false);
    }
  });

  it("returns upload and private access links separately from visit history", () => {
    const upload = { id, uploadUrl: "https://private.example.com/photo?signature=upload" };
    const access = { downloadUrl: "https://private.example.com/photo?signature=download" };
    expect(VisitPhotoUpload.parse(upload)).toEqual(upload);
    expect(VisitPhotoAccess.parse(access)).toEqual(access);
    expect(VisitPhotoUpload.safeParse({ ...upload, id: "invalid" }).success).toBe(false);
    expect(VisitPhotoAccess.safeParse({ downloadUrl: "invalid" }).success).toBe(false);
    expect(ShopVisitParams.parse({ id, visitId: id })).toEqual({ id, visitId: id });
    expect(ShopVisitParams.safeParse({ id, visitId: "invalid" }).success).toBe(false);
  });

  it("exposes the distinct missing-GPS error used by A08", () => {
    expect(ErrorCode.parse("VISIT_PHOTO_LOCATION_MISSING")).toBe("VISIT_PHOTO_LOCATION_MISSING");
  });
});

describe("recording the shop visit", () => {
  it.each(Object.keys(checks))("requires the %s check to be true", (field) => {
    for (const value of [false, undefined, "true"]) {
      const result = ShopVisitChecks.safeParse({ ...checks, [field]: value });
      expect(result.success).toBe(false);
      if (!result.success) expect(invalidFields(result.error)).toEqual([field]);
    }
  });

  it("accepts today in India while UTC is still yesterday, with optional trimmed notes", () => {
    vi.useFakeTimers({ now: new Date("2026-10-25T19:00:00Z") });
    expect(RecordShopVisitBody.parse(visit)).toEqual(visit);
    expect(RecordShopVisitBody.parse({ ...visit, notes: "  Met owner  " }).notes).toBe("Met owner");
    expect(RecordShopVisitBody.parse({ ...visit, notes: " " }).notes).toBe("");
    expect(RecordShopVisitBody.safeParse({ ...visit, notes: "a".repeat(501) }).success).toBe(false);
  });

  it("refuses future dates, rechecks the clock, and accepts previous visits", () => {
    vi.useFakeTimers({ now: new Date("2026-10-25T18:29:59Z") });
    const refused = RecordShopVisitBody.safeParse(visit);
    expect(refused.success).toBe(false);
    if (!refused.success) expect(invalidFields(refused.error)).toEqual(["visitDate"]);
    vi.setSystemTime(new Date("2026-10-25T18:30:00Z"));
    expect(RecordShopVisitBody.safeParse(visit).success).toBe(true);
    expect(RecordShopVisitBody.safeParse({ ...visit, visitDate: "2026-10-01" }).success).toBe(true);
    expect(RecordShopVisitBody.safeParse({ ...visit, visitDate: "2026-02-30" }).success).toBe(false);
  });

  it("refuses client-supplied GPS or recording time, and requires an upload ID", () => {
    vi.useFakeTimers({ now: new Date("2026-10-26T12:00:00Z") });
    for (const extra of [{ latitude: 18.5 }, { recordedAt: "2026-10-26T00:00:00Z" }]) {
      expect(RecordShopVisitBody.safeParse({ ...visit, ...extra }).success).toBe(false);
    }
    expect(RecordShopVisitBody.safeParse({ ...visit, photoUploadId: "" }).success).toBe(false);
  });
});

describe("fee records", () => {
  const paid = { status: "paid", amount: "1000.25", paymentDate: "2026-10-26", reference: "receipt-42" };

  it("requires a trimmed waiver reason, and refuses payment fields on a waiver", () => {
    expect(RecordOnboardingFeeBody.parse({ status: "waived", reason: " Pilot cohort " }))
      .toEqual({ status: "waived", reason: "Pilot cohort" });
    for (const reason of [undefined, "  ", "a".repeat(501)]) {
      expect(RecordOnboardingFeeBody.safeParse({ status: "waived", reason }).success).toBe(false);
    }
    expect(RecordOnboardingFeeBody.safeParse({ status: "waived", reason: "Pilot", amount: "1" }).success).toBe(false);
  });

  it("requires paid amount, real payment date and reference, with an optional change reason", () => {
    expect(RecordOnboardingFeeBody.parse(paid)).toEqual(paid);
    for (const field of ["amount", "paymentDate", "reference"]) {
      expect(RecordOnboardingFeeBody.safeParse({ ...paid, [field]: undefined }).success).toBe(false);
    }
    expect(RecordOnboardingFeeBody.safeParse({ ...paid, paymentDate: "2026-02-30" }).success).toBe(false);
    expect(RecordOnboardingFeeBody.safeParse({ ...paid, reference: " " }).success).toBe(false);
    expect(RecordOnboardingFeeBody.safeParse({ ...paid, reason: " " }).success).toBe(false);
    expect(RecordOnboardingFeeBody.parse({ ...paid, reason: " Correct receipt " }))
      .toEqual({ ...paid, reason: "Correct receipt" });
  });

  it("refuses future payments and reads India today on each check", () => {
    vi.useFakeTimers({ now: new Date("2026-10-25T18:29:59Z") });
    const refused = RecordOnboardingFeeBody.safeParse(paid);
    expect(refused.success).toBe(false);
    if (!refused.success) expect(invalidFields(refused.error)).toEqual(["paymentDate"]);
    vi.setSystemTime(new Date("2026-10-25T18:30:00Z"));
    expect(RecordOnboardingFeeBody.safeParse(paid).success).toBe(true);
    expect(RecordOnboardingFeeBody.safeParse({ ...paid, paymentDate: "2026-10-01" }).success).toBe(true);
    expect(RecordOnboardingFeeBody.safeParse({ ...paid, paymentDate: "2026-10-27" }).success).toBe(false);
  });

  it("keeps exact positive money within NUMERIC(12,2), with no hardcoded fee", () => {
    for (const amount of ["0.01", "1", "1000.5", "9999999999.99"]) {
      expect(OnboardingFeeAmount.parse(amount)).toBe(amount);
    }
    for (const amount of ["0", "0.00", "-1", "NaN", "1e3", "1.001", "10000000000", "01", 1000.25]) {
      expect(OnboardingFeeAmount.safeParse(amount).success).toBe(false);
    }
  });
});

describe("onboarding history", () => {
  it("keeps the three phone states distinct", () => {
    expect(PhoneConfirmationState.options).toEqual(["unverified", "visit_confirmed", "sms_verified"]);
    expect(PhoneConfirmationState.safeParse(true).success).toBe(false);
  });

  it("reads repeat visits, purged photos and fee history without revalidating historical input", () => {
    const entry = {
      id, actorId: id, visitDate: "2026-10-25", recordedAt: "2026-10-26T12:00:00Z",
      checks, notes: null, photo: { id, latitude: 18.5, longitude: 73.8, capturedAt: null },
    };
    const snapshot = {
      visits: [entry, { ...entry, photo: null }],
      fees: [
        { id, actorId: id, recordedAt: entry.recordedAt, status: "waived", reason: "Pilot" },
        { id, actorId: id, recordedAt: entry.recordedAt, status: "paid", amount: "1000.00",
          paymentDate: "2026-10-25", reference: "Receipt", reason: null },
      ],
      ownerPhoneState: "visit_confirmed", ownerEmailConfirmedAt: entry.recordedAt,
    };
    expect(ShopOnboarding.parse(snapshot)).toEqual(snapshot);
    for (const field of ["actorId", "recordedAt"]) {
      expect(ShopVisit.safeParse({ ...entry, [field]: undefined }).success).toBe(false);
    }
    for (const photo of [
      { ...entry.photo, latitude: 91 },
      { ...entry.photo, longitude: -181 },
      { ...entry.photo, downloadUrl: "https://private.example.com/photo" },
    ]) {
      expect(ShopVisit.safeParse({ ...entry, photo }).success).toBe(false);
    }
    const captured = { ...entry, photo: { ...entry.photo, capturedAt: "2026:10:25 15:30:00" } };
    expect(ShopOnboarding.parse({ ...snapshot, visits: [captured] }).visits[0]?.photo?.capturedAt)
      .toBe("2026:10:25 15:30:00");
  });
});

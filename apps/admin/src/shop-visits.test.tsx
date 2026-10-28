// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { createAdminApiClient } from "@ygo/api-client";
import type { OnboardingFee, ShopApplication, ShopOnboarding, ShopVisit } from "@ygo/contracts";
import { ShopVisitAndFeePanel } from "./shop-visits";
import { ShopApplicationReview } from "./shop-applications";
import { strings } from "./strings";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const id = "00000000-0000-4000-8000-000000000501";
const actorId = "00000000-0000-4000-8000-000000000099";
const application: ShopApplication = {
  id, state: "under_review", shopName: "Fresh Mart", address: "Main Road", pincode: "411038",
  location: { latitude: 18.5, longitude: 73.8 }, ownerName: "Owner Name", entityType: "proprietorship",
  pan: "ABCDE1234F", fssaiNumber: "12345678901234", fssaiExpiry: "2030-01-01", serviceRadiusMetres: 2000,
  upiId: "owner@upi", areaName: "Kothrud", ownerPhone: "+919876543210", ownerEmail: "owner@example.com",
  submittedAt: "2026-10-24T10:00:00.000Z",
};
const visit: ShopVisit = {
  id: "00000000-0000-4000-8000-000000000601", visitDate: "2026-10-24", recordedAt: "2026-10-24T10:00:00.000Z", actorId,
  checks: { pan: true, fssai: true, ownerPhone: true, ownerEmail: true, alarmPermission: true, testerOptIn: true },
  notes: "Met the Owner", photo: { id: "00000000-0000-4000-8000-000000000602", latitude: 18.5, longitude: 73.8, capturedAt: null },
};
const paidFee: OnboardingFee = {
  id: "00000000-0000-4000-8000-000000000701", actorId, recordedAt: "2026-10-24T10:00:00.000Z",
  status: "paid", amount: "25.50", paymentDate: "2026-10-24", reference: "RCPT-1", reason: null,
};
const empty: ShopOnboarding = { visits: [], fees: [], ownerPhoneState: "unverified", ownerEmailConfirmedAt: null };

function setup(overrides: Record<string, unknown> = {}, onboarding = empty) {
  const api = {
    getShopOnboarding: vi.fn().mockResolvedValue({ ok: true, data: onboarding }),
    createVisitPhotoUpload: vi.fn().mockResolvedValue({ ok: true, data: { id: visit.photo?.id, uploadUrl: "https://signed.test/photo" } }),
    recordShopVisit: vi.fn().mockResolvedValue({ ok: true, data: visit }),
    getVisitPhotoAccess: vi.fn().mockResolvedValue({ ok: true, data: { downloadUrl: "https://signed.test/private-photo" } }),
    recordOnboardingFee: vi.fn().mockResolvedValue({ ok: true, data: { ...paidFee, status: "waived", reason: "Pilot cohort" } }),
    ...overrides,
  };
  const router = createMemoryRouter([{
    path: "/", loader: () => application,
    element: <ShopVisitAndFeePanel api={api as unknown as ReturnType<typeof createAdminApiClient>} application={application} />,
    hydrateFallbackElement: <div />,
  }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return api;
}

describe("Admin visit and onboarding fee screen", () => {
  it("shows explicit phone confirmation state", async () => {
    setup({}, { ...empty, ownerPhoneState: "visit_confirmed", ownerEmailConfirmedAt: "2026-10-24T10:00:00.000Z" });
    expect(await screen.findByText(strings.phoneConfirmationStates.visit_confirmed)).toBeTruthy();
  });

  it("requires JPEG evidence and all six checks before asking for an upload URL", async () => {
    const api = setup();
    fireEvent.click(await screen.findByRole("button", { name: strings.recordVisit }));
    expect(await screen.findByText(strings.visitInvalidFields.photo)).toBeTruthy();
    expect(screen.getByText(strings.visitInvalidFields.checks)).toBeTruthy();
    expect(api.createVisitPhotoUpload).not.toHaveBeenCalled();

    const tooLarge = new File([new Uint8Array(10_000_001)], "shop.jpg", { type: "image/jpeg" });
    fireEvent.change(await screen.findByLabelText(strings.visitPhoto), { target: { files: [tooLarge] } });
    fireEvent.click(screen.getByRole("button", { name: strings.recordVisit }));
    expect(await screen.findByText(strings.visitInvalidFields.photo)).toBeTruthy();
    expect(api.createVisitPhotoUpload).not.toHaveBeenCalled();
  });

  it("rejects non-JPEG bytes even when the file declares image/jpeg", async () => {
    const api = setup();
    const spoofed = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "shop.jpg", { type: "image/jpeg" });
    fireEvent.change(await screen.findByLabelText(strings.visitPhoto), { target: { files: [spoofed] } });
    for (const label of Object.values(strings.visitChecks)) fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(await screen.findByRole("button", { name: strings.recordVisit }));
    expect(await screen.findByText(strings.visitInvalidFields.photo)).toBeTruthy();
    expect(api.createVisitPhotoUpload).not.toHaveBeenCalled();
  });

  it("rejects future visit dates before issuing an upload URL", async () => {
    const api = setup();
    const dateInput = await screen.findByLabelText(strings.visitDate) as HTMLInputElement;
    const future = new Date(`${dateInput.value}T00:00:00Z`);
    future.setUTCDate(future.getUTCDate() + 1);
    fireEvent.change(dateInput, { target: { value: future.toISOString().slice(0, 10) } });
    fireEvent.change(await screen.findByLabelText(strings.visitPhoto), {
      target: { files: [new File([new Uint8Array([255, 216, 255])], "shop.jpg", { type: "image/jpeg" })] },
    });
    for (const label of Object.values(strings.visitChecks)) fireEvent.click(screen.getByLabelText(label));
    fireEvent.click(await screen.findByRole("button", { name: strings.recordVisit }));
    expect(await screen.findByText(strings.visitInvalidFields.visitDate)).toBeTruthy();
    expect(api.createVisitPhotoUpload).not.toHaveBeenCalled();
  });

  it("uploads the chosen JPEG to its signed URL, records the visit and appends it to history", async () => {
    const put = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", put);
    const api = setup();
    const photo = new File([new Uint8Array([255, 216, 255])], "shop.jpg", { type: "image/jpeg" });
    fireEvent.change(await screen.findByLabelText(strings.visitPhoto), { target: { files: [photo] } });
    for (const label of Object.values(strings.visitChecks)) fireEvent.click(screen.getByLabelText(label));
    fireEvent.change(await screen.findByLabelText(strings.visitNotes), { target: { value: "Met the Owner" } });
    fireEvent.click(await screen.findByRole("button", { name: strings.recordVisit }));

    expect((await screen.findByRole("status")).textContent).toBe(strings.visitSaved);
    expect(api.createVisitPhotoUpload).toHaveBeenCalledWith(id, { contentType: "image/jpeg", byteLength: 3 });
    expect(put).toHaveBeenCalledWith("https://signed.test/photo", expect.objectContaining({ method: "PUT", body: photo }));
    expect(api.recordShopVisit).toHaveBeenCalledWith(id, expect.objectContaining({ photoUploadId: visit.photo?.id, checks: visit.checks, notes: "Met the Owner" }));
    expect(screen.getByText("Met the Owner")).toBeTruthy();
  });

  it("gets fresh private photo access only when evidence is opened", async () => {
    const api = setup({}, { ...empty, visits: [visit] });
    expect(api.getVisitPhotoAccess).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: strings.viewVisitPhoto }));
    const dialog = await screen.findByRole("dialog", { name: strings.visitPhotoTitle });
    expect(api.getVisitPhotoAccess).toHaveBeenCalledWith(id, visit.id);
    expect(within(dialog).getByRole("img").getAttribute("src")).toBe("https://signed.test/private-photo");
  });

  it("records the pilot waiver with a reason and retains the fee history", async () => {
    const waiver: OnboardingFee = { ...paidFee, status: "waived", reason: "Pilot cohort" };
    const api = setup({ recordOnboardingFee: vi.fn().mockResolvedValue({ ok: true, data: waiver }) });
    fireEvent.click(await screen.findByRole("button", { name: strings.saveFee }));
    expect(await screen.findByText(strings.feeInvalidFields.reason)).toBeTruthy();
    expect(api.recordOnboardingFee).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText(strings.feeReason), { target: { value: "Pilot cohort" } });
    fireEvent.click(await screen.findByRole("button", { name: strings.saveFee }));
    expect((await screen.findByRole("status")).textContent).toBe(strings.feeSaved);
    expect(api.recordOnboardingFee).toHaveBeenCalledWith(id, { status: "waived", reason: "Pilot cohort" });
    expect(screen.getByText(strings.feeWaiverReason("Pilot cohort"))).toBeTruthy();
  });

  it("requires the pilot waiver before paid fee changes are available", async () => {
    setup();
    await screen.findByLabelText(strings.feeStatus);
    expect(screen.getByRole("option", { name: strings.feePaid }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(strings.feePilotWaiverHint)).toBeTruthy();
  });

  it("requires a reason for later paid changes and records paid amount, date and reference", async () => {
    const previousWaiver: OnboardingFee = { id: "00000000-0000-4000-8000-000000000702", actorId, recordedAt: "2026-10-24T10:00:00.000Z", status: "waived", reason: "Pilot cohort" };
    const api = setup({ recordOnboardingFee: vi.fn().mockResolvedValue({ ok: true, data: paidFee }) }, { ...empty, fees: [previousWaiver] });
    fireEvent.change(await screen.findByLabelText(strings.feeStatus), { target: { value: "paid" } });
    fireEvent.change(screen.getByLabelText(strings.feeAmount), { target: { value: "25.50" } });
    fireEvent.change(screen.getByLabelText(strings.paymentReference), { target: { value: "RCPT-1" } });
    fireEvent.click(await screen.findByRole("button", { name: strings.saveFee }));
    expect(await screen.findByText(strings.feeReasonRequiredForChange)).toBeTruthy();
    expect(api.recordOnboardingFee).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText(strings.feeReason), { target: { value: "Corrected amount" } });
    fireEvent.click(await screen.findByRole("button", { name: strings.saveFee }));
    await waitFor(() => expect(api.recordOnboardingFee).toHaveBeenCalledWith(id, expect.objectContaining({ status: "paid", amount: "25.50", paymentDate: expect.any(String), reference: "RCPT-1", reason: "Corrected amount" })));
    expect(await screen.findByText(strings.feePayment("₹25.50", "24/10/2026", "RCPT-1"))).toBeTruthy();
  });

  it("does not show visit recording on Draft applications", async () => {
    const api = { currentRole: () => "admin" } as unknown as ReturnType<typeof createAdminApiClient>;
    const draft = { ...application, state: "draft" as const };
    const router = createMemoryRouter([{
      path: "/", loader: () => draft, element: <ShopApplicationReview api={api} />, hydrateFallbackElement: <div />,
    }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    await screen.findByRole("heading", { name: draft.shopName ?? "" });
    expect(screen.queryByRole("heading", { name: strings.onboarding })).toBeNull();
  });
});

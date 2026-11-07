// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { AdminProductRequest } from "@ygo/contracts";
import { ProductRequests } from "./product-requests";
import { strings } from "./strings";

afterEach(() => cleanup());

const request = (n: number, extra: Partial<AdminProductRequest> = {}): AdminProductRequest => ({
  id: `00000000-0000-4000-8000-00000000d0${n}`, name: `Jaggery ${n}`, brand: null, baseUnit: "kg", packQuantity: "0.500", counterPrice: "40.00", mrp: "45.00", status: "pending",
  reason: null, createdAt: "2030-01-01T00:00:00.000Z", productId: `00000000-0000-4000-8000-00000000e0${n}`, shop: { id: "00000000-0000-4000-8000-000000000a01", name: "Sai General Stores" },
  categoryName: "Staples", barcode: null, flagged: false, hasImage: true, excludedGood: false, mappedTo: null, ...extra,
});
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (code: string) => ({ ok: false as const, status: 409, code });

function setup(first: AdminProductRequest[], api: Record<string, unknown> = {}) {
  const calls = {
    listProductRequests: vi.fn().mockResolvedValue(ok({ requests: [] })), approveProductRequest: vi.fn(), mapProductRequest: vi.fn(), rejectProductRequest: vi.fn(),
    listMasterProducts: vi.fn(), listPacks: vi.fn(), ...api,
  };
  const router = createMemoryRouter([{ path: "/", loader: () => ({ requests: first }), element: <ProductRequests api={calls as unknown as Parameters<typeof ProductRequests>[0]["api"]} /> }]);
  render(<RouterProvider router={router} />);
  return calls as Record<"listProductRequests" | "approveProductRequest" | "mapProductRequest" | "rejectProductRequest" | "listMasterProducts" | "listPacks", ReturnType<typeof vi.fn>>;
}

describe("A11 Product requests screen (CAT-3, #62)", () => {
  it("shows each request with its shop, size and prices, marks a flagged one, and says plainly when none waits", async () => {
    setup([request(1, { flagged: true, barcode: "12345678" }), request(2)]);
    await screen.findByRole("heading", { name: strings.productRequests });
    expect(screen.getByText(/Requested by Sai General Stores · Staples · 0.5 kg · 12345678/)).toBeTruthy();
    expect(screen.getAllByText(strings.productRequestsFlagged)).toHaveLength(1);
    cleanup();
    setup([]);
    expect(await screen.findByText(strings.productRequestsNonePending)).toBeTruthy();
  });

  it("approves a request, then reads the queue again", async () => {
    const calls = setup([request(1)]);
    calls.approveProductRequest.mockResolvedValue(ok(request(1, { status: "approved" })));
    fireEvent.click(await screen.findByRole("button", { name: strings.productRequestsApprove }));
    await waitFor(() => expect(calls.listProductRequests).toHaveBeenCalledWith("pending"));
    expect(calls.approveProductRequest).toHaveBeenCalledWith(request(1).id);
  });

  it("keeps Approve off until the product has its image, and points to Products", async () => {
    setup([request(1, { hasImage: false })]);
    const approve = await screen.findByRole("button", { name: strings.productRequestsApprove });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("link", { name: strings.productRequestsAddImage }).getAttribute("href")).toBe("/products");
  });

  it("rejects only with a reason, and sends whether it is an excluded good", async () => {
    const calls = setup([request(1)]);
    calls.rejectProductRequest.mockResolvedValue(ok(request(1, { status: "rejected" })));
    fireEvent.click(await screen.findByRole("button", { name: strings.productRequestsReject }));
    const confirm = screen.getByRole("button", { name: strings.productRequestsRejectConfirm }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(strings.productRequestsReason), { target: { value: "  Tobacco  " } });
    fireEvent.click(screen.getByLabelText(strings.productRequestsExcluded));
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.rejectProductRequest).toHaveBeenCalledWith(request(1).id, { reason: "Tobacco", excludedGood: true }));
  });

  it("maps to a chosen pack of a published product of the same unit", async () => {
    const calls = setup([request(1)]);
    calls.listMasterProducts.mockResolvedValue(ok({ products: [
      { id: "p1", name: "Jaggery", brand: null, baseUnit: "kg", published: true, active: true },
      { id: "p2", name: "Soap", brand: null, baseUnit: "each", published: true, active: true },
      { id: "p3", name: "Draft", brand: null, baseUnit: "kg", published: false, active: true },
    ] }));
    calls.listPacks.mockResolvedValue(ok({ packs: [{ id: "k1", productId: "p1", quantity: "1.000", barcode: null, active: true }] }));
    calls.mapProductRequest.mockResolvedValue(ok(request(1, { status: "mapped" })));
    fireEvent.click(await screen.findByRole("button", { name: strings.productRequestsMap }));
    const product = await screen.findByLabelText(strings.productRequestsMapProduct);
    await waitFor(() => expect(Array.from((product as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([strings.productRequestsChoose, "Jaggery"]));
    expect((screen.getByRole("button", { name: strings.productRequestsMapConfirm }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(product, { target: { value: "p1" } });
    const pack = await screen.findByLabelText(strings.productRequestsMapPack);
    await waitFor(() => expect((pack as HTMLSelectElement).options).toHaveLength(2));
    fireEvent.change(pack, { target: { value: "k1" } });
    fireEvent.click(screen.getByRole("button", { name: strings.productRequestsMapConfirm }));
    await waitFor(() => expect(calls.mapProductRequest).toHaveBeenCalledWith(request(1).id, "k1"));
  });

  it("explains a refusal, and reads the queue again when the request was already answered", async () => {
    const calls = setup([request(1)]);
    calls.approveProductRequest.mockResolvedValue(fail("PRODUCT_REQUEST_RESOLVED"));
    fireEvent.click(await screen.findByRole("button", { name: strings.productRequestsApprove }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.errors.PRODUCT_REQUEST_RESOLVED);
    await waitFor(() => expect(calls.listProductRequests).toHaveBeenCalledWith("pending"));
  });

  it("shows the answered ones with how each was answered", async () => {
    const calls = setup([]);
    calls.listProductRequests.mockResolvedValue(ok({ requests: [
      request(1, { status: "rejected", reason: "Excluded good", excludedGood: true }),
      request(2, { status: "mapped", mappedTo: { packId: "k1", name: "Jaggery 1 kg" } }),
    ] }));
    fireEvent.click(await screen.findByRole("tab", { name: strings.productRequestsAnswered }));
    expect(await screen.findByText("Excluded good")).toBeTruthy();
    expect(screen.getByText(strings.productRequestsMappedTo("Jaggery 1 kg"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.productRequestsApprove })).toBeNull();
  });
});

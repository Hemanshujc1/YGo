// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { adminRoutes } from "./routes";
import { strings } from "./strings";

afterEach(cleanup);

const founder = { id: "00000000-0000-4000-8000-000000000001", email: "founder@example.com", name: "Founder", phone: "+919876543210" };
const created = { id: "00000000-0000-4000-8000-000000000002", email: "new@example.com", name: "New Admin", phone: "+919876543211" };

function setup(path: string, overrides: Record<string, unknown> = {}) {
  const api = {
    requestCode: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    verifyCode: vi.fn().mockResolvedValue({ ok: true, data: founder }),
    listAccounts: vi.fn().mockResolvedValue({ ok: true, data: { accounts: [founder] } }),
    createAccount: vi.fn().mockResolvedValue({ ok: true, data: created }),
    listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [] } }),
    createCategory: vi.fn(),
    editCategory: vi.fn(),
    signOut: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    ...overrides,
  };
  const router = createMemoryRouter(adminRoutes(api as Parameters<typeof adminRoutes>[0]), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { api, router };
}

describe("Admin web", () => {
  it("requests a code, verifies it, and opens protected accounts", async () => {
    const { api, router } = setup("/sign-in");
    fireEvent.change(screen.getByLabelText(strings.email), { target: { value: " FOUNDER@example.com " } });
    fireEvent.click(screen.getByRole("button", { name: strings.sendCode }));
    expect(await screen.findByText(strings.codeSent)).toBeTruthy();
    expect(api.requestCode).toHaveBeenCalledWith({ email: "founder@example.com" });
    fireEvent.change(screen.getByLabelText(strings.code), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: strings.verify }));
    await screen.findByText(founder.email);
    expect(screen.getByRole("navigation", { name: strings.navigation })).toBeTruthy();
    expect(screen.getByText("98765 43210")).toBeTruthy();
    expect(api.verifyCode).toHaveBeenCalledWith({ email: founder.email, code: "123456" });
    expect(router.state.location.pathname).toBe("/accounts");
  });

  it("keeps the code request answer generic and validates the code", async () => {
    const { api } = setup("/sign-in");
    fireEvent.change(screen.getByLabelText(strings.email), { target: { value: "not-admin@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: strings.sendCode }));
    await screen.findByText(strings.codeSent);
    fireEvent.click(screen.getByRole("button", { name: strings.verify }));
    expect(await screen.findByText(strings.invalidCode)).toBeTruthy();
    expect(api.verifyCode).not.toHaveBeenCalled();
  });

  it("protects accounts from unauthenticated and forbidden sessions", async () => {
    const { router, api } = setup("/accounts", {
      listAccounts: vi.fn().mockResolvedValue({ ok: false, status: 403, code: "FORBIDDEN" }),
    });
    await screen.findByRole("heading", { name: strings.signIn });
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(api.listAccounts).toHaveBeenCalledOnce();
  });

  it("shows loading and server error states", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((answer) => { resolve = answer; });
    const { router } = setup("/accounts", { listAccounts: vi.fn().mockReturnValue(pending) });
    expect(screen.getByText(strings.loading)).toBeTruthy();
    resolve({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(await screen.findByText(strings.failed)).toBeTruthy();
    expect(router.state.location.pathname).toBe("/accounts");
  });

  it("lists accounts, validates fields, and shows the created state", async () => {
    const { api } = setup("/accounts");
    await screen.findByText(founder.email);
    fireEvent.click(screen.getByRole("button", { name: strings.newAccount }));
    fireEvent.click(screen.getByRole("button", { name: strings.create }));
    expect(await screen.findByText(strings.invalidFields.email)).toBeTruthy();
    expect(api.createAccount).not.toHaveBeenCalled();
    fillCreate();
    fireEvent.click(screen.getByRole("button", { name: strings.create }));
    expect(await screen.findByText(strings.created)).toBeTruthy();
    expect(api.createAccount).toHaveBeenCalledWith({ email: created.email, name: created.name, phone: created.phone, reason: "Coverage" });
    fireEvent.click(screen.getByRole("button", { name: strings.backToAccounts }));
    expect(await screen.findByText(created.email)).toBeTruthy();
  });

  it.each(["EMAIL_IN_USE", "PHONE_IN_USE"] as const)("shows %s at its field", async (code) => {
    setup("/accounts", { createAccount: vi.fn().mockResolvedValue({ ok: false, status: 409, code }) });
    await screen.findByText(founder.email);
    fireEvent.click(screen.getByRole("button", { name: strings.newAccount }));
    fillCreate();
    fireEvent.click(screen.getByRole("button", { name: strings.create }));
    expect(await screen.findByText(strings.errors[code])).toBeTruthy();
    expect(screen.queryByText(strings.created)).toBeNull();
  });

  it("signs out and returns to sign-in", async () => {
    const { api, router } = setup("/accounts");
    await screen.findByText(founder.email);
    fireEvent.click(screen.getByRole("button", { name: strings.signOut }));
    await screen.findByRole("heading", { name: strings.signIn });
    expect(api.signOut).toHaveBeenCalledOnce();
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("warns when server sign-out is not confirmed", async () => {
    setup("/accounts", { signOut: vi.fn().mockRejectedValue(new Error("network")) });
    await screen.findByText(founder.email);
    fireEvent.click(screen.getByRole("button", { name: strings.signOut }));
    expect(await screen.findByText(strings.signOutUnconfirmed)).toBeTruthy();
  });
});

function fillCreate() {
  fireEvent.change(screen.getByLabelText(strings.email), { target: { value: created.email } });
  fireEvent.change(screen.getByLabelText(strings.name), { target: { value: created.name } });
  fireEvent.change(screen.getByLabelText(strings.phone), { target: { value: created.phone } });
  fireEvent.change(screen.getByLabelText(strings.reason), { target: { value: "Coverage" } });
}

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { adminRoutes } from "./routes";
import { strings } from "./strings";

afterEach(cleanup);

const founder = { id: "00000000-0000-4000-8000-000000000001", email: "founder@example.com", name: "Founder", phone: "+919876543210" };
const created = { id: "00000000-0000-4000-8000-000000000002", email: "new@example.com", name: "New Admin", phone: "+919876543211" };
const groceries = { id: "00000000-0000-4000-8000-000000000101", parentId: null, name: "Groceries", active: false, effectiveActive: false };
const stationery = { id: "00000000-0000-4000-8000-000000000102", parentId: null, name: "Stationery", active: true, effectiveActive: true };
const snacks = { id: "00000000-0000-4000-8000-000000000103", parentId: groceries.id, name: "Snacks", active: true, effectiveActive: false };

function setup(path: string, overrides: Record<string, unknown> = {}) {
  const api = {
    requestCode: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    verifyCode: vi.fn().mockResolvedValue({ ok: true, data: founder }),
    listAccounts: vi.fn().mockResolvedValue({ ok: true, data: { accounts: [founder] } }),
    createAccount: vi.fn().mockResolvedValue({ ok: true, data: created }),
    listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [] } }),
    createCategory: vi.fn(),
    editCategory: vi.fn(),
    listAreas: vi.fn(),
    createArea: vi.fn(),
    editArea: vi.fn(),
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

  it("shows inherited inactivity and restricts the parent picker", async () => {
    setup("/categories", { listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [groceries, stationery, snacks] } }) });
    await screen.findByRole("heading", { name: strings.categories });
    expect(screen.getByText(strings.categoryInactive)).toBeTruthy();
    expect(screen.getByText(strings.categoryInactiveViaParent)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.editCategory(groceries.name) }));
    expect(screen.getByRole("combobox", { name: strings.categoryParent }).querySelectorAll("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: strings.cancel }));
    fireEvent.click(screen.getByRole("button", { name: strings.editCategory(snacks.name) }));
    const options = [...screen.getByRole("combobox", { name: strings.categoryParent }).querySelectorAll("option")];
    expect(options.map((option) => option.textContent)).toEqual([strings.topLevel, `Groceries${strings.inactiveOption}`, "Stationery"]);
  });

  it("validates, creates, edits and moves categories, showing saved and field conflict states", async () => {
    const made = { id: "00000000-0000-4000-8000-000000000104", parentId: null, name: "Hardware", active: true, effectiveActive: true };
    const api = {
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [stationery] } }),
      createCategory: vi.fn().mockResolvedValueOnce({ ok: false, status: 409, code: "CATEGORY_NAME_IN_USE" }).mockResolvedValueOnce({ ok: true, data: made }),
      editCategory: vi.fn().mockResolvedValue({ ok: true, data: { ...made, parentId: stationery.id, name: "Tools" } }),
    };
    setup("/categories", api);
    await screen.findByRole("heading", { name: strings.categories });
    fireEvent.click(screen.getByRole("button", { name: strings.newCategory }));
    fireEvent.click(screen.getByRole("button", { name: strings.saveCategory }));
    expect(await screen.findByText(strings.categoryInvalidFields.name)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: strings.categoryName }), { target: { value: " Hardware " } });
    fireEvent.click(screen.getByRole("button", { name: strings.saveCategory }));
    expect(await screen.findByText(strings.errors.CATEGORY_NAME_IN_USE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.saveCategory }));
    expect((await screen.findByRole("status")).textContent).toBe(strings.categorySaved);
    expect(api.createCategory).toHaveBeenCalledWith({ name: "Hardware", parentId: null });
    fireEvent.click(screen.getByRole("button", { name: strings.editCategory(made.name) }));
    fireEvent.change(screen.getByRole("textbox", { name: strings.categoryName }), { target: { value: "Tools" } });
    fireEvent.change(screen.getByRole("combobox", { name: strings.categoryParent }), { target: { value: stationery.id } });
    fireEvent.click(screen.getByRole("button", { name: strings.saveCategory }));
    expect(await screen.findByText("Tools")).toBeTruthy();
    expect(api.editCategory).toHaveBeenCalledWith(made.id, { name: "Tools", parentId: stationery.id });
  });

  it("requires a reason to deactivate and updates child availability when the parent changes", async () => {
    const api = {
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [{ ...groceries, active: true, effectiveActive: true }, { ...snacks, effectiveActive: true }] } }),
      editCategory: vi.fn().mockResolvedValueOnce({ ok: true, data: groceries }).mockResolvedValueOnce({ ok: false, status: 503, code: "UNAVAILABLE" }),
    };
    setup("/categories", api);
    await screen.findByRole("heading", { name: strings.categories });
    fireEvent.click(screen.getByRole("button", { name: strings.deactivateCategory(groceries.name) }));
    expect(screen.getByRole("dialog", { name: strings.deactivateCategoryTitle(groceries.name) })).toBeTruthy();
    expect(screen.getByText(strings.deactivateParentWarning)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.confirmDeactivate }));
    expect(await screen.findByText(strings.categoryInvalidFields.reason)).toBeTruthy();
    expect(api.editCategory).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: " No longer needed " } });
    fireEvent.click(screen.getByRole("button", { name: strings.confirmDeactivate }));
    expect(await screen.findByText(strings.categoryInactiveViaParent)).toBeTruthy();
    expect(api.editCategory).toHaveBeenCalledWith(groceries.id, { active: false, reason: "No longer needed" });
    fireEvent.click(screen.getByRole("button", { name: strings.reactivateCategory(groceries.name) }));
    expect((await screen.findByRole("alert")).textContent).toBe(strings.failed);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText(strings.categoryInactive)).toBeTruthy();
    expect(api.editCategory).toHaveBeenLastCalledWith(groceries.id, { active: true });
  });

  it("shows loading, empty and retryable error states for categories", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const api = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ ok: true, data: { categories: [] } });
    setup("/categories", { listCategories: api });
    expect(screen.getByText(strings.categoriesLoading)).toBeTruthy();
    resolve({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(await screen.findByText(strings.failed)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.retry }));
    expect(await screen.findByText(strings.noCategories)).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each(["UNAUTHENTICATED", "FORBIDDEN"])("redirects a %s category session to sign-in", async (code) => {
    const { router } = setup("/categories", {
      listCategories: vi.fn().mockResolvedValue({ ok: false, status: code === "FORBIDDEN" ? 403 : 401, code }),
    });
    await screen.findByRole("heading", { name: strings.signIn });
    expect(router.state.location.pathname).toBe("/sign-in");
  });
});

function fillCreate() {
  fireEvent.change(screen.getByLabelText(strings.email), { target: { value: created.email } });
  fireEvent.change(screen.getByLabelText(strings.name), { target: { value: created.name } });
  fireEvent.change(screen.getByLabelText(strings.phone), { target: { value: created.phone } });
  fireEvent.change(screen.getByLabelText(strings.reason), { target: { value: "Coverage" } });
}

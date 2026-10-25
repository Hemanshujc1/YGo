// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { adminRoutes } from "./routes";
import { strings } from "./strings";
import { themeKey } from "./theme";

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

const founder = { id: "00000000-0000-4000-8000-000000000001", email: "founder@example.com", name: "Founder", phone: "+919876543210", theme: "system" };
const created = { id: "00000000-0000-4000-8000-000000000002", email: "new@example.com", name: "New Admin", phone: "+919876543211", theme: "system" };
const groceries = { id: "00000000-0000-4000-8000-000000000101", parentId: null, name: "Groceries", active: false, effectiveActive: false };
const stationery = { id: "00000000-0000-4000-8000-000000000102", parentId: null, name: "Stationery", active: true, effectiveActive: true };
const snacks = { id: "00000000-0000-4000-8000-000000000103", parentId: groceries.id, name: "Snacks", active: true, effectiveActive: false };
const apple = {
  id: "00000000-0000-4000-8000-000000000301", name: "Apples", brand: "Farm", categoryId: stationery.id,
  categoryName: stationery.name, categoryActive: true, categoryEffectiveActive: true, baseUnit: "each", classification: "counted",
  imageUrls: { 256: "https://images.test/256.webp", 512: "https://images.test/512.webp", 1024: "https://images.test/1024.webp" },
  published: true, active: true,
};
const applePack = { id: "00000000-0000-4000-8000-000000000401", productId: apple.id, quantity: "2", barcode: "12345678", active: true };
const kothrud = { id: "00000000-0000-4000-8000-000000000201", name: "Kothrud", pincodes: ["411038"], paused: false };
const aundh = { id: "00000000-0000-4000-8000-000000000202", name: "Aundh", pincodes: ["411007", "411027"], paused: true };

function setup(path: string, overrides: Record<string, unknown> = {}) {
  const api = {
    requestCode: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    verifyCode: vi.fn().mockResolvedValue({ ok: true, data: founder }),
    listAccounts: vi.fn().mockResolvedValue({ ok: true, data: { accounts: [founder] } }),
    createAccount: vi.fn().mockResolvedValue({ ok: true, data: created }),
    listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [] } }),
    listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [] } }),
    previewCatalogImport: vi.fn(),
    commitCatalogImport: vi.fn(),
    createMasterProduct: vi.fn(),
    editMasterProduct: vi.fn(),
    listPacks: vi.fn().mockResolvedValue({ ok: true, data: { packs: [] } }),
    createPack: vi.fn(),
    editPack: vi.fn(),
    createCategory: vi.fn(),
    editCategory: vi.fn(),
    listAreas: vi.fn(),
    listWaitlist: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
    createArea: vi.fn(),
    editArea: vi.fn(),
    listShopApplications: vi.fn(),
    getShopApplication: vi.fn(),
    correctShopApplication: vi.fn(),
    startShopApplicationReview: vi.fn(),
    approveShopApplication: vi.fn(),
    signOut: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
    me: vi.fn().mockResolvedValue({ ok: true, data: founder }),
    setTheme: vi.fn(),
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

  it("lists Areas A to Z with their pincodes and a Paused label", async () => {
    setup("/areas", { listAreas: vi.fn().mockResolvedValue({ ok: true, data: { areas: [kothrud, aundh] } }) });
    await screen.findByRole("heading", { name: strings.areas });
    expect(screen.getByRole("link", { name: strings.areas }).getAttribute("aria-current")).toBe("page");
    expect(screen.getAllByRole("list", { name: strings.areaPincodes }).map((list) => list.textContent)).toEqual(["411007411027", "411038"]);
    expect(screen.getAllByText(strings.areaPaused)).toHaveLength(1);
    expect(screen.getByRole("button", { name: strings.resumeArea(aundh.name) })).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.pauseArea(kothrud.name) })).toBeTruthy();
  });

  it("checks a new Area, shows each refusal, then saves it in A to Z order", async () => {
    const baner = { id: "00000000-0000-4000-8000-000000000203", name: "Baner", pincodes: ["411045", "411069"], paused: false };
    const api = {
      listAreas: vi.fn().mockResolvedValue({ ok: true, data: { areas: [aundh, kothrud] } }),
      createArea: vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 409, code: "AREA_NAME_IN_USE" })
        .mockResolvedValueOnce({ ok: false, status: 409, code: "PINCODE_IN_OTHER_AREA", conflicts: [{ pincode: "411038", areaName: kothrud.name }] })
        .mockResolvedValueOnce({ ok: true, data: baner }),
    };
    setup("/areas", api);
    await screen.findByRole("heading", { name: strings.areas });
    fireEvent.click(screen.getByRole("button", { name: strings.newArea }));
    fireEvent.click(screen.getByRole("button", { name: strings.saveArea }));
    expect(await screen.findByText(strings.areaInvalidFields.name)).toBeTruthy();
    expect(screen.getByText(strings.areaInvalidFields.pincodes)).toBeTruthy();
    expect(screen.getByText(strings.areaInvalidFields.reason)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: strings.areaName }), { target: { value: " Baner " } });
    fireEvent.change(screen.getByRole("textbox", { name: strings.areaPincodes }), { target: { value: "411045, 411045" } });
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: "Launch" } });
    fireEvent.click(screen.getByRole("button", { name: strings.saveArea }));
    expect(screen.getByText(strings.areaInvalidFields.pincodes)).toBeTruthy();
    expect(screen.queryByText(strings.areaInvalidFields.name)).toBeNull();
    expect(api.createArea).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: strings.areaPincodes }), { target: { value: "411 045,\n411069, 411038\n" } });
    fireEvent.click(screen.getByRole("button", { name: strings.saveArea }));
    expect(await screen.findByText(strings.errors.AREA_NAME_IN_USE)).toBeTruthy();
    expect(api.createArea).toHaveBeenCalledWith({ name: "Baner", pincodes: ["411045", "411069", "411038"], reason: "Launch" });
    fireEvent.click(screen.getByRole("button", { name: strings.saveArea }));
    expect(await screen.findByText(strings.pincodeInArea("411038", kothrud.name))).toBeTruthy();
    expect(screen.getByText(strings.errors.PINCODE_IN_OTHER_AREA)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: strings.areaName }) as HTMLInputElement).value).toBe(" Baner ");
    fireEvent.change(screen.getByRole("textbox", { name: strings.areaPincodes }), { target: { value: "411045, 411069" } });
    fireEvent.click(screen.getByRole("button", { name: strings.saveArea }));
    expect((await screen.findByRole("status")).textContent).toBe(strings.areaSaved);
    expect(screen.getAllByRole("list", { name: strings.areaPincodes }).map((list) => list.textContent)).toEqual(["411007411027", "411045411069", "411038"]);
  });

  it("edits an Area's pincodes starting from its current list", async () => {
    const api = {
      listAreas: vi.fn().mockResolvedValue({ ok: true, data: { areas: [kothrud] } }),
      editArea: vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 400, code: "VALIDATION_FAILED", fields: ["pincodes.1"] })
        .mockResolvedValueOnce({ ok: true, data: { ...kothrud, pincodes: ["411038", "411052"] } }),
    };
    setup("/areas", api);
    fireEvent.click(await screen.findByRole("button", { name: strings.editPincodes(kothrud.name) }));
    expect(screen.getByRole("heading", { name: strings.editPincodes(kothrud.name) })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: strings.areaName })).toBeNull();
    const pincodes = screen.getByRole("textbox", { name: strings.areaPincodes }) as HTMLTextAreaElement;
    expect(pincodes.value).toBe("411038");
    fireEvent.change(pincodes, { target: { value: "411038, 411052" } });
    fireEvent.click(screen.getByRole("button", { name: strings.saveArea }));
    expect(await screen.findByText(strings.areaInvalidFields.reason)).toBeTruthy();
    expect(api.editArea).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: "Extend to Warje" } });
    fireEvent.click(screen.getByRole("button", { name: strings.saveArea }));
    expect(await screen.findByText(strings.areaInvalidFields.pincodes)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.saveArea }));
    expect((await screen.findByRole("status")).textContent).toBe(strings.areaSaved);
    expect(api.editArea).toHaveBeenCalledWith(kothrud.id, { pincodes: ["411038", "411052"], reason: "Extend to Warje" });
    expect(screen.getByRole("list", { name: strings.areaPincodes }).textContent).toBe("411038411052");
  });

  it("pauses and resumes an Area, each with a reason", async () => {
    const api = {
      listAreas: vi.fn().mockResolvedValue({ ok: true, data: { areas: [kothrud] } }),
      editArea: vi.fn()
        .mockResolvedValueOnce({ ok: true, data: { ...kothrud, paused: true } })
        .mockResolvedValueOnce({ ok: false, status: 503, code: "UNAVAILABLE" })
        .mockResolvedValueOnce({ ok: false, status: 400, code: "VALIDATION_FAILED", fields: ["paused"] })
        .mockResolvedValueOnce({ ok: true, data: kothrud }),
    };
    setup("/areas", api);
    fireEvent.click(await screen.findByRole("button", { name: strings.pauseArea(kothrud.name) }));
    expect(screen.getByRole("dialog", { name: strings.pauseAreaTitle(kothrud.name) })).toBeTruthy();
    expect(screen.getByText(strings.pauseAreaNote)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.confirmPause }));
    expect(await screen.findByText(strings.areaInvalidFields.reason)).toBeTruthy();
    expect(api.editArea).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: " Monsoon flooding " } });
    fireEvent.click(screen.getByRole("button", { name: strings.confirmPause }));
    expect(await screen.findByText(strings.areaPaused)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.editArea).toHaveBeenCalledWith(kothrud.id, { paused: true, reason: "Monsoon flooding" });
    fireEvent.click(screen.getByRole("button", { name: strings.resumeArea(kothrud.name) }));
    expect(screen.getByRole("dialog", { name: strings.resumeAreaTitle(kothrud.name) })).toBeTruthy();
    expect(screen.queryByText(strings.pauseAreaNote)).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: "Roads open" } });
    fireEvent.click(screen.getByRole("button", { name: strings.confirmResume }));
    expect(await screen.findByText(strings.errors.UNAVAILABLE)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: strings.confirmResume }));
    expect(await screen.findByText(strings.areaInvalidFields.reason)).toBeTruthy();
    expect(screen.queryByText(strings.errors.UNAVAILABLE)).toBeNull();
    expect(api.editArea).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: "Roads open" } });
    fireEvent.click(screen.getByRole("button", { name: strings.confirmResume }));
    expect(await screen.findByText(strings.errors.VALIDATION_FAILED)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.confirmResume }));
    await waitFor(() => expect(screen.queryByText(strings.areaPaused)).toBeNull());
    expect(api.editArea).toHaveBeenLastCalledWith(kothrud.id, { paused: false, reason: "Roads open" });
  });

  it("shows loading, empty and retryable error states for Areas", async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const api = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ ok: true, data: { areas: [] } });
    setup("/areas", { listAreas: api });
    expect(screen.getByText(strings.areasLoading)).toBeTruthy();
    resolve({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(await screen.findByText(strings.failed)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.retry }));
    expect(await screen.findByText(strings.noAreas)).toBeTruthy();
    expect(api).toHaveBeenCalledTimes(2);
  });

  it.each(["UNAUTHENTICATED", "FORBIDDEN"])("redirects a %s Areas session to sign-in", async (code) => {
    const { router } = setup("/areas", {
      listAreas: vi.fn().mockResolvedValue({ ok: false, status: code === "FORBIDDEN" ? 403 : 401, code }),
    });
    await screen.findByRole("heading", { name: strings.signIn });
    expect(router.state.location.pathname).toBe("/sign-in");
  });

  it("lists and searches master products from the Admin navigation", async () => {
    setup("/accounts", {
      listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [apple] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [stationery] } }),
    });
    await screen.findByText(founder.email);
    fireEvent.click(screen.getByRole("link", { name: strings.products }));
    await screen.findByRole("heading", { name: strings.products });
    expect(screen.getByRole("link", { name: strings.products }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Apples")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: strings.searchProducts }), { target: { value: "farm" } });
    expect(screen.getByText("Apples")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: strings.searchProducts }), { target: { value: "pear" } });
    expect(screen.getByText(strings.noProductMatches)).toBeTruthy();
  });

  it("loads packs, creates a counted pack, edits it and deactivates with a reason", async () => {
    const changed = { ...applePack, quantity: "3", barcode: null };
    const inactive = { ...changed, active: false };
    const api = {
      listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [apple] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [stationery] } }),
      listPacks: vi.fn().mockResolvedValue({ ok: true, data: { packs: [] } }),
      createPack: vi.fn().mockResolvedValue({ ok: true, data: applePack }),
      editPack: vi.fn().mockResolvedValueOnce({ ok: true, data: changed }).mockResolvedValueOnce({ ok: true, data: inactive })
        .mockResolvedValueOnce({ ok: true, data: changed }),
    };
    setup("/products", api);
    await screen.findByRole("heading", { name: strings.products });
    fireEvent.click(screen.getByRole("button", { name: strings.managePacks(apple.name) }));
    expect(await screen.findByText(strings.noPacks)).toBeTruthy();
    expect(api.listPacks).toHaveBeenCalledWith(apple.id);
    fireEvent.click(screen.getByRole("button", { name: strings.newPack }));
    fireEvent.change(screen.getByRole("textbox", { name: strings.packQuantity("each") }), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: strings.savePack }));
    expect(await screen.findByText(strings.packInvalidFields.quantity)).toBeTruthy();
    expect(api.createPack).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: strings.packQuantity("each") }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("textbox", { name: strings.packBarcode }), { target: { value: applePack.barcode } });
    fireEvent.click(screen.getByRole("button", { name: strings.savePack }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", strings.packSaved);
    expect(api.createPack).toHaveBeenCalledWith(apple.id, { baseUnit: "each", quantity: "2", barcode: applePack.barcode });
    fireEvent.click(screen.getByRole("button", { name: strings.editPack("2") }));
    fireEvent.change(screen.getByRole("textbox", { name: strings.packQuantity("each") }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("textbox", { name: strings.packBarcode }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: strings.savePack }));
    expect(await screen.findByText(`${strings.noBarcode} · ${strings.packActive}`)).toBeTruthy();
    expect(api.editPack).toHaveBeenCalledWith(apple.id, applePack.id, { baseUnit: "each", quantity: "3", barcode: null });
    fireEvent.click(screen.getByRole("button", { name: strings.deactivatePack("3") }));
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: "Discontinued" } });
    fireEvent.click(screen.getByRole("button", { name: strings.confirmDeactivatePack }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", strings.packDeactivated);
    expect(api.editPack).toHaveBeenLastCalledWith(apple.id, applePack.id, { active: false, reason: "Discontinued" });
    fireEvent.click(screen.getByRole("button", { name: strings.reactivatePack("3") }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", strings.packReactivated);
    expect(api.editPack).toHaveBeenLastCalledWith(apple.id, applePack.id, { active: true });
  });

  it("shows duplicate barcode on the pack field and keeps the form", async () => {
    const api = {
      listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [apple] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [stationery] } }),
      createPack: vi.fn().mockResolvedValue({ ok: false, status: 409, code: "BARCODE_IN_USE" }),
    };
    setup("/products", api);
    await screen.findByRole("heading", { name: strings.products });
    fireEvent.click(screen.getByRole("button", { name: strings.managePacks(apple.name) }));
    await screen.findByText(strings.noPacks);
    fireEvent.click(screen.getByRole("button", { name: strings.newPack }));
    fireEvent.change(screen.getByRole("textbox", { name: strings.packQuantity("each") }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("textbox", { name: strings.packBarcode }), { target: { value: applePack.barcode } });
    fireEvent.click(screen.getByRole("button", { name: strings.savePack }));
    expect(await screen.findByText(strings.errors.BARCODE_IN_USE)).toBeTruthy();
    expect(screen.getByRole("button", { name: strings.savePack })).toBeTruthy();
  });

  it("allows three decimal places for a measured pack and rejects a fourth", async () => {
    const rice = { ...apple, id: "00000000-0000-4000-8000-000000000302", name: "Rice", baseUnit: "kg", classification: "measured" };
    const pack = { ...applePack, productId: rice.id, quantity: "0.125", barcode: null };
    const api = {
      listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [rice] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [stationery] } }),
      createPack: vi.fn().mockResolvedValue({ ok: true, data: pack }),
    };
    setup("/products", api);
    await screen.findByRole("heading", { name: strings.products });
    fireEvent.click(screen.getByRole("button", { name: strings.managePacks(rice.name) }));
    await screen.findByText(strings.noPacks);
    fireEvent.click(screen.getByRole("button", { name: strings.newPack }));
    const input = screen.getByRole("textbox", { name: strings.packQuantity("kg") });
    fireEvent.change(input, { target: { value: "0.1255" } });
    fireEvent.click(screen.getByRole("button", { name: strings.savePack }));
    expect(await screen.findByText(strings.packInvalidFields.quantity)).toBeTruthy();
    expect(api.createPack).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "0.125" } });
    fireEvent.click(screen.getByRole("button", { name: strings.savePack }));
    expect(await screen.findByText("0.125 kg")).toBeTruthy();
    expect(api.createPack).toHaveBeenCalledWith(rice.id, { baseUnit: "kg", quantity: "0.125", barcode: null });
  });

  it("shows pack loading and retries a failed list", async () => {
    let resolve!: (value: unknown) => void;
    const listPacks = vi.fn().mockReturnValueOnce(new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ ok: true, data: { packs: [applePack] } });
    setup("/products", {
      listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [apple] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [stationery] } }), listPacks,
    });
    await screen.findByRole("heading", { name: strings.products });
    fireEvent.click(screen.getByRole("button", { name: strings.managePacks(apple.name) }));
    expect(screen.getByText(strings.packsLoading)).toBeTruthy();
    resolve({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(await screen.findByText(strings.errors.UNAVAILABLE)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.retry }));
    expect(await screen.findByText("2 each")).toBeTruthy();
  });

  it("creates a master product with an image using the contract fields", async () => {
    const api = {
      listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [groceries, snacks, stationery] } }),
      createMasterProduct: vi.fn().mockResolvedValue({ ok: true, data: apple }),
    };
    setup("/products", api);
    await screen.findByRole("heading", { name: strings.products });
    fireEvent.click(screen.getByRole("button", { name: strings.newProduct }));
    expect(screen.getByRole("option", { name: `Groceries${strings.productCategoryInactive}` }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText(strings.productName), { target: { value: " Apples " } });
    fireEvent.change(screen.getByLabelText(strings.productBrand), { target: { value: " Farm " } });
    fireEvent.change(screen.getByLabelText(strings.productImage), { target: { files: [new File(["image"], "apple.png", { type: "image/png" })] } });
    await screen.findByRole("img", { name: strings.productImage });
    fireEvent.click(screen.getByRole("button", { name: strings.saveProduct }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", strings.productSaved);
    expect(api.createMasterProduct).toHaveBeenCalledWith({
      name: "Apples", brand: "Farm", categoryId: stationery.id, baseUnit: "each", classification: "counted", image: "aW1hZ2U=",
    });
  });

  it("recovers a failed image upload from its unpublished draft and keeps an existing image on edit", async () => {
    const draft = { ...apple, published: false, imageUrls: null };
    const api = {
      listMasterProducts: vi.fn().mockResolvedValueOnce({ ok: true, data: { products: [] } })
        .mockResolvedValueOnce({ ok: true, data: { products: [draft] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [stationery] } }),
      createMasterProduct: vi.fn().mockResolvedValue({ ok: false, status: 503, code: "UNAVAILABLE" }),
      editMasterProduct: vi.fn().mockResolvedValue({ ok: true, data: apple }),
    };
    setup("/products", api);
    await screen.findByRole("heading", { name: strings.products });
    fireEvent.click(screen.getByRole("button", { name: strings.newProduct }));
    fireEvent.change(screen.getByLabelText(strings.productName), { target: { value: apple.name } });
    fireEvent.change(screen.getByLabelText(strings.productBrand), { target: { value: apple.brand } });
    fireEvent.change(screen.getByLabelText(strings.productImage), { target: { files: [new File(["image"], "apple.png", { type: "image/png" })] } });
    await screen.findByRole("img", { name: strings.productImage });
    fireEvent.click(screen.getByRole("button", { name: strings.saveProduct }));
    expect(await screen.findByText(strings.productImagePending)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.saveProduct }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", strings.productSaved);
    expect(api.editMasterProduct).toHaveBeenCalledWith(draft.id, expect.objectContaining({ image: "aW1hZ2U=" }));

    fireEvent.click(screen.getByRole("button", { name: strings.editProduct(apple.name) }));
    fireEvent.change(screen.getByLabelText(strings.productName), { target: { value: "Green apples" } });
    fireEvent.click(screen.getByRole("button", { name: strings.saveProduct }));
    await waitFor(() => expect(api.editMasterProduct).toHaveBeenCalledTimes(2));
    expect(api.editMasterProduct).toHaveBeenLastCalledWith(apple.id, expect.not.objectContaining({ image: expect.anything() }));
  });

  it("requires a reason to deactivate a master product and can reactivate it", async () => {
    const inactive = { ...apple, active: false };
    const api = {
      listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [apple] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [stationery] } }),
      editMasterProduct: vi.fn().mockResolvedValueOnce({ ok: true, data: inactive }).mockResolvedValueOnce({ ok: true, data: apple }),
    };
    setup("/products", api);
    await screen.findByRole("heading", { name: strings.products });
    fireEvent.click(screen.getByRole("button", { name: strings.deactivateProduct }));
    fireEvent.click(screen.getByRole("dialog").querySelector("button") as HTMLButtonElement);
    expect(await screen.findByText(strings.productInvalidFields.reason)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: " Discontinued " } });
    fireEvent.click(screen.getByRole("dialog").querySelector("button") as HTMLButtonElement);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", strings.productDeactivated);
    expect(api.editMasterProduct).toHaveBeenCalledWith(apple.id, { active: false, reason: "Discontinued" });
    fireEvent.click(screen.getByRole("button", { name: strings.reactivateProduct }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", strings.productReactivated);
    expect(api.editMasterProduct).toHaveBeenLastCalledWith(apple.id, { active: true });
  });

  it("keeps an inactive category selected on edit and sends a blank brand as none", async () => {
    const pantry = { ...apple, categoryId: groceries.id, categoryName: groceries.name, categoryActive: false, categoryEffectiveActive: false };
    const api = {
      listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [pantry] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [groceries, stationery] } }),
      editMasterProduct: vi.fn().mockResolvedValue({ ok: true, data: { ...pantry, brand: null } }),
    };
    setup("/products", api);
    await screen.findByRole("heading", { name: strings.products });
    fireEvent.click(screen.getByRole("button", { name: strings.editProduct(pantry.name) }));
    expect(screen.getByLabelText<HTMLSelectElement>(strings.productCategory).value).toBe(groceries.id);
    fireEvent.change(screen.getByLabelText(strings.productBrand), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: strings.saveProduct }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", strings.productSaved);
    expect(api.editMasterProduct).toHaveBeenCalledWith(pantry.id, expect.objectContaining({ categoryId: groceries.id, brand: null }));
  });

  it("shows a failed deactivation once, inside the dialog", async () => {
    const api = {
      listMasterProducts: vi.fn().mockResolvedValue({ ok: true, data: { products: [apple] } }),
      listCategories: vi.fn().mockResolvedValue({ ok: true, data: { categories: [stationery] } }),
      editMasterProduct: vi.fn().mockResolvedValue({ ok: false, status: 503, code: "UNAVAILABLE" }),
    };
    setup("/products", api);
    await screen.findByRole("heading", { name: strings.products });
    fireEvent.click(screen.getByRole("button", { name: strings.deactivateProduct }));
    fireEvent.change(screen.getByRole("textbox", { name: strings.reason }), { target: { value: "Discontinued" } });
    fireEvent.click(screen.getByRole("dialog").querySelector("button") as HTMLButtonElement);
    expect(await screen.findByText(strings.errors.UNAVAILABLE)).toBeTruthy();
    expect(screen.getAllByText(strings.errors.UNAVAILABLE)).toHaveLength(1);
  });

  it("shows product loading, empty and retryable error states", async () => {
    let resolve!: (value: unknown) => void;
    const listMasterProducts = vi.fn().mockReturnValueOnce(new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ ok: true, data: { products: [] } });
    setup("/products", { listMasterProducts });
    expect(screen.getByText(strings.productsLoading)).toBeTruthy();
    resolve({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(await screen.findByText(strings.failed)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.retry }));
    expect(await screen.findByText(strings.noProducts)).toBeTruthy();
  });

  it("opens the read-only waitlist from navigation and formats captures in server order", async () => {
    const entries = [
      { accountId: founder.id, accountName: founder.name, accountEmail: founder.email, phone: "+919876543212", pincode: "411038", savedAt: "2030-01-01T00:00:00.000Z" },
      { accountId: created.id, accountName: null, accountEmail: created.email, phone: "+919876543213", pincode: "400001", savedAt: "2029-12-31T00:00:00.000Z" },
    ];
    setup("/accounts", { listWaitlist: vi.fn().mockResolvedValue({ ok: true, data: { entries } }) });
    await screen.findByText(founder.email);
    fireEvent.click(screen.getByRole("link", { name: strings.waitlist }));
    await screen.findByRole("heading", { name: strings.waitlist });
    expect(screen.getByRole("link", { name: strings.waitlist }).getAttribute("aria-current")).toBe("page");
    const rows = screen.getAllByRole("row");
    expect(rows[1]?.textContent).toContain("98765 43212");
    expect(rows[1]?.textContent).toContain("411038");
    expect(rows[1]?.textContent).toContain(founder.name);
    expect(rows[1]?.textContent).toContain(founder.email);
    expect(rows[1]?.textContent).toContain("01/01/2030, 5:30 AM");
    expect(rows[2]?.textContent).toContain(created.email);
    expect(rows[2]?.textContent).not.toContain(created.name);
    // Read-only: the header's theme and Sign out are the only buttons.
    expect(screen.getAllByRole("button").map((button) => button.textContent))
      .toEqual([strings.themes.system, strings.themes.light, strings.themes.dark, strings.signOut]);
  });

  it("shows waitlist loading, an alert with retry, and the empty state", async () => {
    let resolve!: (value: unknown) => void;
    const listWaitlist = vi.fn().mockReturnValueOnce(new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ ok: true, data: { entries: [] } });
    setup("/waitlist", { listWaitlist });
    expect(screen.getByText(strings.waitlistLoading)).toBeTruthy();
    resolve({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect((await screen.findByRole("alert")).textContent).toBe(strings.failed);
    fireEvent.click(screen.getByRole("button", { name: strings.retry }));
    expect(await screen.findByText(strings.noWaitlist)).toBeTruthy();
    expect(listWaitlist).toHaveBeenCalledTimes(2);
  });

  it.each(["UNAUTHENTICATED", "FORBIDDEN"])("redirects a %s waitlist session to sign-in", async (code) => {
    const { router } = setup("/waitlist", { listWaitlist: vi.fn().mockResolvedValue({ ok: false, status: code === "FORBIDDEN" ? 403 : 401, code }) });
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

describe("Admin theme (#263)", () => {
  const picker = () => screen.findByRole("group", { name: strings.theme });
  const option = (choice: "system" | "light" | "dark") => screen.getByRole("button", { name: strings.themes[choice] });
  const shown = () => document.documentElement.dataset.theme;
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  };

  it("shows no picker before sign-in, then takes the account's theme on sign-in", async () => {
    // The account load never answers here, so only the sign-in answer can set the theme.
    setup("/sign-in", {
      verifyCode: vi.fn().mockResolvedValue({ ok: true, data: { ...founder, theme: "dark" } }),
      me: vi.fn().mockReturnValue(new Promise(() => undefined)),
    });
    expect(screen.queryByRole("group", { name: strings.theme })).toBeNull();
    fireEvent.change(screen.getByLabelText(strings.email), { target: { value: founder.email } });
    fireEvent.click(screen.getByRole("button", { name: strings.sendCode }));
    fireEvent.change(await screen.findByLabelText(strings.code), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: strings.verify }));
    await picker();
    expect(shown()).toBe("dark");
    expect(localStorage.getItem(themeKey)).toBe("dark");
  });

  it("starts from this browser's copy, then the account's theme wins on load", async () => {
    localStorage.setItem(themeKey, "light");
    const me = deferred<unknown>();
    const { api } = setup("/accounts", { me: vi.fn().mockReturnValue(me.promise) });
    await picker();
    expect(option("light").getAttribute("aria-pressed")).toBe("true");
    me.resolve({ ok: true, data: { ...founder, theme: "dark" } });
    await waitFor(() => expect(option("dark").getAttribute("aria-pressed")).toBe("true"));
    expect(shown()).toBe("dark");
    expect(api.me).toHaveBeenCalledOnce();
  });

  it("applies a choice at once, saves it, and allows one save at a time", async () => {
    const save = deferred<unknown>();
    const { api } = setup("/accounts", { setTheme: vi.fn().mockReturnValue(save.promise) });
    await picker();
    await waitFor(() => expect(api.me).toHaveBeenCalled());
    fireEvent.click(option("dark"));
    expect(shown()).toBe("dark");
    expect(option("light")).toHaveProperty("disabled", true);
    fireEvent.click(option("light"));
    expect(api.setTheme).toHaveBeenCalledOnce();
    expect(api.setTheme).toHaveBeenCalledWith({ theme: "dark" });
    save.resolve({ ok: true, data: { ...founder, theme: "dark" } });
    await waitFor(() => expect(option("light")).toHaveProperty("disabled", false));
    expect(shown()).toBe("dark");
    expect(localStorage.getItem(themeKey)).toBe("dark");
    expect(screen.queryByText(strings.themeNotSaved)).toBeNull();
  });

  it("goes back to the system theme without the attribute", async () => {
    localStorage.setItem(themeKey, "dark");
    document.documentElement.dataset.theme = "dark";
    setup("/accounts", {
      me: vi.fn().mockResolvedValue({ ok: true, data: { ...founder, theme: "dark" } }),
      setTheme: vi.fn().mockResolvedValue({ ok: true, data: founder }),
    });
    await picker();
    fireEvent.click(option("system"));
    await waitFor(() => expect(option("system").getAttribute("aria-pressed")).toBe("true"));
    expect(shown()).toBeUndefined();
    expect(localStorage.getItem(themeKey)).toBe("system");
  });

  it.each([
    ["refused", () => Promise.resolve({ ok: false, status: 503, code: "UNAVAILABLE" })],
    ["unanswered", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("puts the old theme back with a message when the save is %s, and never retries", async (_name, answer) => {
    const { api } = setup("/accounts", { setTheme: vi.fn(answer) });
    await picker();
    await waitFor(() => expect(api.me).toHaveBeenCalled());
    fireEvent.click(option("dark"));
    expect(shown()).toBe("dark");
    expect(await screen.findByText(strings.themeNotSaved)).toBeTruthy();
    expect(option("system").getAttribute("aria-pressed")).toBe("true");
    expect(shown()).toBeUndefined();
    expect(localStorage.getItem(themeKey)).toBe("system");
    expect(api.setTheme).toHaveBeenCalledOnce();
  });

  it("keeps a choice under way when the account answers during the save", async () => {
    const me = deferred<unknown>();
    const save = deferred<unknown>();
    setup("/accounts", { me: vi.fn().mockReturnValue(me.promise), setTheme: vi.fn().mockReturnValue(save.promise) });
    await picker();
    fireEvent.click(option("dark"));
    me.resolve({ ok: true, data: { ...founder, theme: "light" } });
    await new Promise((done) => setTimeout(done));
    expect(shown()).toBe("dark");
    save.resolve({ ok: true, data: { ...founder, theme: "dark" } });
    await waitFor(() => expect(option("dark")).toHaveProperty("disabled", false));
    expect(shown()).toBe("dark");
  });

  it("goes back to the account's theme, not the older one, when a save fails after the account answered", async () => {
    const me = deferred<unknown>();
    const save = deferred<unknown>();
    setup("/accounts", { me: vi.fn().mockReturnValue(me.promise), setTheme: vi.fn().mockReturnValue(save.promise) });
    await picker();
    fireEvent.click(option("light"));
    me.resolve({ ok: true, data: { ...founder, theme: "dark" } });
    await new Promise((done) => setTimeout(done));
    save.resolve({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(await screen.findByText(strings.themeNotSaved)).toBeTruthy();
    expect(shown()).toBe("dark");
  });

  it("loads the account's theme again on the next page when the first load fails", async () => {
    const me = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, code: "UNAVAILABLE" })
      .mockResolvedValue({ ok: true, data: { ...founder, theme: "dark" } });
    const { router } = setup("/accounts", { me });
    await picker();
    await waitFor(() => expect(me).toHaveBeenCalledOnce());
    expect(shown()).toBeUndefined();
    await router.navigate("/waitlist");
    await waitFor(() => expect(shown()).toBe("dark"));
    expect(me).toHaveBeenCalledTimes(2);
  });

  it("keeps the save message after moving to another page", async () => {
    const save = deferred<unknown>();
    const { router } = setup("/accounts", { setTheme: vi.fn().mockReturnValue(save.promise) });
    await picker();
    fireEvent.click(option("dark"));
    await router.navigate("/waitlist");
    save.resolve({ ok: false, status: 503, code: "UNAVAILABLE" });
    expect(await screen.findByText(strings.themeNotSaved)).toBeTruthy();
    expect(shown()).toBeUndefined();
  });

  it("applies this browser's theme before the page draws, with the key the app keeps", () => {
    const html = readFileSync("index.html", "utf8");
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(script).toContain(`"${themeKey}"`);
    for (const [kept, attribute] of [["dark", "dark"], ["light", "light"], ["system", undefined], ["blue", undefined]] as const) {
      delete document.documentElement.dataset.theme;
      localStorage.setItem(themeKey, kept);
      new Function(script)();
      expect(document.documentElement.dataset.theme).toBe(attribute);
    }
  });
});

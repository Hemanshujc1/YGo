// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { CATALOG_IMPORT_CSV_FIELDS } from "@ygo/contracts";
import type { createAdminApiClient } from "@ygo/api-client";
import { CatalogImport } from "./catalog-import";
import { strings } from "./strings";

const copy = strings.catalogImport;
const header = CATALOG_IMPORT_CSV_FIELDS.join(",");
const row = 'apple,"Apples, red",Farm,,Fruit,each,counted,1,';
const csv = `${header}\r\n${row}\r\npear,"Pear\nlarge",Farm,,Fruit,each,counted,2,\r\n`;
const clean = { rowCount: 2, productCount: 2, packCount: 2, errors: [] };
const problems = [{ rowNumber: 3, reason: "CATEGORY_NOT_FOUND", field: "categoryName" }];
function setup() {
  const api = {
    previewCatalogImport: vi.fn().mockResolvedValue({ ok: true, data: clean }),
    commitCatalogImport: vi.fn().mockResolvedValue({ ok: true, data: { productsCreated: 2, productsSkipped: 0, packsCreated: 2, packsSkipped: 0 } }),
  };
  render(<MemoryRouter><CatalogImport api={api as unknown as ReturnType<typeof createAdminApiClient>} /></MemoryRouter>);
  return api;
}
function choose(text = csv) {
  const files = { catalogCsv: new File([text], "catalog.csv"), imagesZip: new File(["zip"], "images.zip") };
  for (const field of ["catalogCsv", "imagesZip"] as const) fireEvent.change(screen.getByLabelText(copy.parts[field]), { target: { files: [files[field]] } });
  return files;
}
async function check() {
  fireEvent.click(screen.getByRole("button", { name: copy.check }));
  await screen.findByText(copy.ready(2, 2, 2));
}
async function read(blob: Blob) {
  return new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Catalog import", () => {
  it("checks selected files, imports only after a clean preview, and reports reimport skips", async () => {
    const api = setup();
    expect(screen.getByRole("button", { name: copy.check })).toHaveProperty("disabled", true);
    const files = choose();
    await check();
    expect(api.previewCatalogImport).toHaveBeenCalledWith(files);
    fireEvent.click(screen.getByRole("button", { name: copy.commit }));
    await screen.findByText(copy.summary(2, 0, 2, 0));
    expect(api.commitCatalogImport).toHaveBeenCalledWith(files);
    fireEvent.click(screen.getByRole("button", { name: copy.again }));
    choose();
    api.commitCatalogImport.mockResolvedValue({ ok: true, data: { productsCreated: 0, productsSkipped: 2, packsCreated: 0, packsSkipped: 2 } });
    await check();
    fireEvent.click(screen.getByRole("button", { name: copy.commit }));
    await screen.findByText(copy.summary(0, 2, 0, 2));
  });

  it("shows every row problem, blocks import, and downloads each bad record with original columns", async () => {
    const api = setup();
    api.previewCatalogImport.mockResolvedValue({ ok: true, data: { ...clean, errors: [...problems, { ...problems[0], reason: "INVALID_ROW" }] } });
    choose();
    fireEvent.click(screen.getByRole("button", { name: copy.check }));
    await screen.findByText(copy.nothingImported);
    expect(screen.getByText(`${copy.reasons.CATEGORY_NOT_FOUND} (${copy.columns.categoryName})`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.commit })).toBeNull();
    const create = vi.fn().mockReturnValue("blob:test");
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: copy.download }));
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const output = await read(create.mock.calls[0]?.[0] as Blob);
    expect(output).toBe(`"${CATALOG_IMPORT_CSV_FIELDS.join('","')}"\r\n"pear","Pear\nlarge","Farm","","Fruit","each","counted","2",""\r\n`);
    expect(api.commitCatalogImport).not.toHaveBeenCalled();
  });

  it("offers a header-only template", async () => {
    setup();
    const create = vi.fn().mockReturnValue("blob:template");
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: copy.template }));
    expect(await read(create.mock.calls[0]?.[0] as Blob)).toBe(`${header}\r\n`);
  });

  it("clears a stale preview when either file changes and disables input during import", async () => {
    const api = setup(); choose(); await check();
    fireEvent.change(screen.getByLabelText(copy.parts.imagesZip), { target: { files: [new File(["new"], "new.zip")] } });
    expect(screen.queryByRole("button", { name: copy.commit })).toBeNull();
    await check();
    api.commitCatalogImport.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: copy.commit }));
    expect(screen.getByLabelText(copy.parts.catalogCsv)).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: copy.check })).toHaveProperty("disabled", true);
    expect(screen.getByText(copy.importing)).toBeTruthy();
  });

  it("returns commit-time row errors to the check step", async () => {
    const api = setup(); choose(); await check();
    api.commitCatalogImport.mockResolvedValue({ ok: false, code: "CATALOG_IMPORT_ROWS_INVALID", rowErrors: problems });
    fireEvent.click(screen.getByRole("button", { name: copy.commit }));
    await screen.findByText(copy.nothingImported);
    expect(screen.getByRole("button", { name: copy.download })).toBeTruthy();
    expect(screen.queryByRole("button", { name: copy.commit })).toBeNull();
  });

  it("shows file-level errors beside the named part and can retry checking", async () => {
    const api = setup(); choose();
    api.previewCatalogImport.mockResolvedValueOnce({ ok: false, code: "VALIDATION_FAILED", fields: ["imagesZip"] });
    fireEvent.click(screen.getByRole("button", { name: copy.check }));
    await screen.findByText(copy.invalidPart(copy.parts.imagesZip));
    expect(screen.getByLabelText(copy.parts.imagesZip).getAttribute("aria-invalid")).toBe("true");
    await check();
  });

  it("requires a fresh preview after an unconfirmed commit and permits a manual retry", async () => {
    const api = setup(); choose(); await check();
    api.commitCatalogImport.mockRejectedValueOnce(new TypeError("Network down"));
    fireEvent.click(screen.getByRole("button", { name: copy.commit }));
    await screen.findByText(copy.commitUnconfirmed);
    expect(screen.queryByRole("button", { name: copy.commit })).toBeNull();
    await check();
    expect(api.commitCatalogImport).toHaveBeenCalledOnce();
  });
});

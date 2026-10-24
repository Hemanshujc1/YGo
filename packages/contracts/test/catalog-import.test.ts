import { describe, expect, it } from "vitest";
import { CatalogImportPreviewResponse, CatalogImportResponse, CatalogImportRowError } from "../src/index";

describe("catalog import contracts (#41)", () => {
  it("accepts preview row errors and nonnegative integer counts", () => {
    expect(CatalogImportPreviewResponse.parse({
      rowCount: 3,
      productCount: 2,
      packCount: 3,
      errors: [{ rowNumber: 4, reason: "Barcode is already in use" }],
    })).toEqual({
      rowCount: 3,
      productCount: 2,
      packCount: 3,
      errors: [{ rowNumber: 4, reason: "Barcode is already in use" }],
    });
    expect(CatalogImportPreviewResponse.parse({ rowCount: 0, productCount: 0, packCount: 0, errors: [] }).errors).toEqual([]);
  });

  it("rejects invalid row errors and counts", () => {
    for (const value of [
      { rowNumber: 0, reason: "Bad row" },
      { rowNumber: 1.5, reason: "Bad row" },
      { rowNumber: 2, reason: "  " },
      { rowNumber: 2, reason: "Bad row", productCode: "P1" },
    ]) {
      expect(CatalogImportRowError.safeParse(value).success).toBe(false);
    }
    for (const value of [
      { rowCount: -1, productCount: 0, packCount: 0, errors: [] },
      { rowCount: 1.2, productCount: 0, packCount: 0, errors: [] },
      { rowCount: 0, productCount: 0, packCount: 0, errors: [], extra: true },
    ]) {
      expect(CatalogImportPreviewResponse.safeParse(value).success).toBe(false);
    }
  });

  it("accepts and validates the import completion summary", () => {
    expect(CatalogImportResponse.parse({ productsCreated: 1, productsSkipped: 1, packsCreated: 2, packsSkipped: 2 })).toEqual({
      productsCreated: 1,
      productsSkipped: 1,
      packsCreated: 2,
      packsSkipped: 2,
    });
    expect(CatalogImportResponse.safeParse({ productsCreated: 0, productsSkipped: 0, packsCreated: -1, packsSkipped: 0 }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  CATALOG_IMPORT_FILE_FIELDS,
  CATALOG_IMPORT_FILE_LIMITS,
  CATALOG_IMPORT_CSV_FIELDS,
  CatalogImportCsvRow,
  CatalogImportCsvField,
  CatalogImportFileField,
  CatalogImportPreviewResponse,
  CatalogImportResponse,
  CatalogImportRowError,
  PRODUCT_IMAGE_MAX_BYTES,
} from "../src/index";

const csvRow = {
  productCode: "APPLE-01",
  name: "Apples",
  brand: "Farm",
  parentCategoryName: "",
  categoryName: "Fruits and Vegetables",
  baseUnit: "each",
  classification: "counted",
  quantity: "6",
  barcode: "012345678901",
};

describe("catalog import contracts (#41)", () => {
  it("defines the multipart fields and bounded file sizes", () => {
    expect(CATALOG_IMPORT_FILE_FIELDS).toEqual(["catalogCsv", "imagesZip"]);
    expect(CATALOG_IMPORT_CSV_FIELDS).toEqual([
      "productCode", "name", "brand", "parentCategoryName", "categoryName", "baseUnit", "classification", "quantity", "barcode",
    ]);
    expect(CatalogImportFileField.parse("catalogCsv")).toBe("catalogCsv");
    expect(CatalogImportFileField.safeParse("file").success).toBe(false);
    expect(CatalogImportCsvField.parse("quantity")).toBe("quantity");
    expect(CATALOG_IMPORT_FILE_LIMITS).toEqual({
      csvBytes: 10 * 1024 * 1024,
      imagesZipBytes: 100 * 1024 * 1024,
      expandedImagesBytes: 100 * 1024 * 1024,
      imageBytes: PRODUCT_IMAGE_MAX_BYTES,
    });
  });

  it("validates and normalizes one pack row, including counted and measured quantities", () => {
    expect(CatalogImportCsvRow.parse(csvRow)).toEqual({ ...csvRow, brand: "Farm", parentCategoryName: null });
    expect(CatalogImportCsvRow.parse({
      ...csvRow,
      brand: "",
      parentCategoryName: "Groceries",
      categoryName: "Rice",
      baseUnit: "kg",
      classification: "measured",
      quantity: "1.125",
      barcode: "",
    })).toMatchObject({ brand: null, parentCategoryName: "Groceries", quantity: "1.125", barcode: null });
    for (const row of [
      { ...csvRow, extra: "no" },
      { ...csvRow, baseUnit: "kg", classification: "counted" },
      { ...csvRow, quantity: "1.5" },
      { ...csvRow, quantity: "1.1234" },
      { ...csvRow, barcode: "123456789" },
      { ...csvRow, productCode: "" },
      { ...csvRow, productCode: "APPLE.01" },
      { ...csvRow, productCode: "APPLE 01" },
    ]) {
      expect(CatalogImportCsvRow.safeParse(row).success).toBe(false);
    }
    expect(CatalogImportCsvRow.parse({ ...csvRow, barcode: " 012345678901 " }).barcode).toBe("012345678901");
  });

  it("accepts preview row errors and nonnegative integer counts", () => {
    expect(CatalogImportPreviewResponse.parse({
      rowCount: 3,
      productCount: 2,
      packCount: 3,
      errors: [{ rowNumber: 4, reason: "BARCODE_CONFLICT", field: "barcode" }],
    })).toEqual({
      rowCount: 3,
      productCount: 2,
      packCount: 3,
      errors: [{ rowNumber: 4, reason: "BARCODE_CONFLICT", field: "barcode" }],
    });
    expect(CatalogImportPreviewResponse.parse({ rowCount: 0, productCount: 0, packCount: 0, errors: [] }).errors).toEqual([]);
  });

  it("rejects invalid row errors and counts", () => {
    for (const value of [
      { rowNumber: 0, reason: "INVALID_ROW" },
      { rowNumber: 1, reason: "INVALID_ROW" },
      { rowNumber: 1.5, reason: "INVALID_ROW" },
      { rowNumber: 2, reason: "not-a-reason-code" },
      { rowNumber: 2, reason: "INVALID_ROW", field: "not-a-column" },
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

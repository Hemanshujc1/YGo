import type { FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { parse } from "csv-parse/sync";
import { Unzip, UnzipInflate, unzipSync } from "fflate";
import {
  CATALOG_IMPORT_CSV_FIELDS, CATALOG_IMPORT_FILE_FIELDS, CATALOG_IMPORT_FILE_LIMITS,
  CatalogImportCsvField, CatalogImportCsvRow, type CatalogImportFileField,
  type CatalogImportPreviewResponse, type CatalogImportRowError,
} from "@ygo/contracts";
import { InvalidProductImageError, type PreparedProductImage, type ProductImageStorage } from "./adapters/product-images";

export class CatalogImportFileError extends Error {
  constructor(public fields: CatalogImportFileField[]) { super("Invalid catalog import file"); }
}

export async function readCatalogImport(request: FastifyRequest): Promise<Record<CatalogImportFileField, Buffer>> {
  const files = {} as Record<CatalogImportFileField, Buffer>;
  if (!request.isMultipart()) throw new CatalogImportFileError([...CATALOG_IMPORT_FILE_FIELDS]);
  let current: CatalogImportFileField | undefined;
  try {
    for await (const part of request.parts()) {
      current = CATALOG_IMPORT_FILE_FIELDS.find((field) => field === part.fieldname);
      if (!current || part.type !== "file" || files[current]) throw new CatalogImportFileError(current ? [current] : [...CATALOG_IMPORT_FILE_FIELDS]);
      const limit = current === "catalogCsv" ? CATALOG_IMPORT_FILE_LIMITS.csvBytes : CATALOG_IMPORT_FILE_LIMITS.imagesZipBytes;
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of part.file) {
        bytes += chunk.length;
        if (bytes > limit) throw new CatalogImportFileError([current]);
        chunks.push(chunk);
      }
      if (part.file.truncated) throw new CatalogImportFileError([current]);
      files[current] = Buffer.concat(chunks);
    }
  } catch (error) {
    if (error instanceof CatalogImportFileError) throw error;
    if ((error as { code?: string }).code?.startsWith("FST_") || /multipart|premature|unexpected end/i.test(String(error))) {
      throw new CatalogImportFileError(current ? [current] : [...CATALOG_IMPORT_FILE_FIELDS]);
    }
    throw error;
  }
  const missing = CATALOG_IMPORT_FILE_FIELDS.filter((field) => !files[field]);
  if (missing.length) throw new CatalogImportFileError(missing);
  return files;
}

function imageFiles(zip: Buffer): Map<string, Buffer> {
  const codes = new Set<string>();
  let folder: string | undefined;
  let expanded = 0;
  const expected = new Map<string, { code: string; bytes: number }>();
  try {
    unzipSync(zip, { filter(entry) {
      const parts = entry.name.split("/");
      if (parts.some((part) => part === "__MACOSX" || part.startsWith("."))) return false;
      if (entry.name.endsWith("/")) return false;
      const prefix = parts.length === 1 ? "" : parts[0];
      const match = parts.at(-1)?.match(/^(.*)\.(jpg|png|webp)$/i);
      const code = CatalogImportCsvRow.shape.productCode.safeParse(match?.[1]);
      expanded += entry.originalSize;
      if (parts.length > 2 || parts.includes("") || !code.success || (folder !== undefined && folder !== prefix) || codes.has(code.data) ||
        entry.originalSize > CATALOG_IMPORT_FILE_LIMITS.imageBytes || expanded > CATALOG_IMPORT_FILE_LIMITS.expandedImagesBytes) {
        throw new CatalogImportFileError(["imagesZip"]);
      }
      folder = prefix;
      codes.add(code.data);
      expected.set(entry.name, { code: code.data, bytes: entry.originalSize });
      return false;
    } });
    // Stream the actual expansion too: ZIP size declarations are untrusted.
    const files = new Map<string, Buffer>();
    const started = new Set<string>();
    let actualBytes = 0;
    const unzip = new Unzip((file) => {
      if (file.name.split("/").some((part) => part === "__MACOSX" || part.startsWith(".")) || file.name.endsWith("/")) return;
      const entry = expected.get(file.name);
      if (!entry || started.has(file.name)) throw new CatalogImportFileError(["imagesZip"]);
      started.add(file.name);
      let bytes = 0;
      const chunks: Buffer[] = [];
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        bytes += chunk.length;
        actualBytes += chunk.length;
        if (bytes > CATALOG_IMPORT_FILE_LIMITS.imageBytes || actualBytes > CATALOG_IMPORT_FILE_LIMITS.expandedImagesBytes) throw new CatalogImportFileError(["imagesZip"]);
        chunks.push(Buffer.from(chunk));
        if (final) {
          if (bytes !== entry.bytes) throw new CatalogImportFileError(["imagesZip"]);
          files.set(entry.code, Buffer.concat(chunks));
        }
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    for (let offset = 0; offset < zip.length; offset += 4096) unzip.push(zip.subarray(offset, offset + 4096), offset + 4096 >= zip.length);
    if (files.size !== expected.size) throw new CatalogImportFileError(["imagesZip"]);
    return files;
  } catch { throw new CatalogImportFileError(["imagesZip"]); }
}

type ImportRow = CatalogImportCsvRow & { rowNumber: number };
type ResolvedRow = ImportRow & {
  identity: string; categoryId: string | null; categoryActive: boolean | null;
  productId: string | null; productCategoryId: string | null; productUnit: string | null; productClassification: string | null;
  packId: string | null; packBarcode: string | null; barcodePackId: string | null;
};

export async function previewCatalogImport(
  files: Record<CatalogImportFileField, Buffer>, db: Pool, images: Pick<ProductImageStorage, "prepare">,
): Promise<CatalogImportPreviewResponse> {
  return (await validateCatalogImport(files, db, images)).preview;
}

export async function validateCatalogImport(
  files: Record<CatalogImportFileField, Buffer>, db: Pool | PoolClient, images: Pick<ProductImageStorage, "prepare">,
  prepared?: Map<string, PreparedProductImage>,
) {
  let records: string[][];
  try { records = parse(new TextDecoder("utf-8", { fatal: true }).decode(files.catalogCsv), { bom: true, relax_column_count: true }); }
  catch { throw new CatalogImportFileError(["catalogCsv"]); }
  const header = records.shift();
  if (!header || header.length !== CATALOG_IMPORT_CSV_FIELDS.length || new Set(header).size !== header.length ||
    CATALOG_IMPORT_CSV_FIELDS.some((field) => !header.includes(field))) throw new CatalogImportFileError(["catalogCsv"]);
  const errors: CatalogImportRowError[] = [];
  const rows: ImportRow[] = [];
  const identities: Pick<ImportRow, "rowNumber" | "productCode" | "name" | "brand">[] = [];
  records.forEach((record, index) => {
    const rowNumber = index + 2;
    const raw = Object.fromEntries(header.map((field, i) => [field, record[i]]));
    // Other invalid fields must not hide a product-code conflict.
    const code = CatalogImportCsvRow.shape.productCode.safeParse(raw.productCode);
    // PostgreSQL text cannot represent NUL; preserve invalid-row errors without querying such identities.
    if (code.success && typeof raw.name === "string" && typeof raw.brand === "string" && !raw.name.includes("\0") && !raw.brand.includes("\0")) {
      // Compare readable identities even when name/brand themselves fail validation.
      identities.push({ rowNumber, productCode: code.data, name: raw.name.trim(), brand: raw.brand.trim() || null });
    }
    const parsed = CatalogImportCsvRow.safeParse(raw);
    if (record.length !== header.length) errors.push({ rowNumber, reason: "INVALID_ROW" });
    else if (parsed.success) rows.push({ ...parsed.data, rowNumber });
    else for (const field of new Set(parsed.error.issues.map((issue) => CatalogImportCsvField.safeParse(issue.path[0]).data))) {
      errors.push({ rowNumber, reason: "INVALID_ROW", ...(field ? { field } : {}) });
    }
  });
  // PostgreSQL lower() supplies the identity, matching the catalog's unique indexes exactly.
  const codeRows = await db.query<{ rowNumber: number; productCode: string; identity: string }>(
    `SELECT "rowNumber", "productCode", json_build_array(lower(name), lower(COALESCE(brand, '')))::text AS identity
     FROM jsonb_to_recordset($1::jsonb) AS r("rowNumber" int, "productCode" text, name text, brand text)
     ORDER BY "rowNumber"`, [JSON.stringify(identities)],
  );
  const codes = new Map<string, string>();
  for (const row of codeRows.rows) {
    if (codes.has(row.productCode) && codes.get(row.productCode) !== row.identity) errors.push({ rowNumber: row.rowNumber, reason: "DUPLICATE_PRODUCT_CODE", field: "productCode" });
    codes.set(row.productCode, row.identity);
  }
  const resolved = await db.query<ResolvedRow>(`SELECT r.*, json_build_array(lower(r.name), lower(COALESCE(r.brand, '')))::text AS identity,
    c.id AS "categoryId", (c.active AND COALESCE(parent.active, true)) AS "categoryActive",
    p.id AS "productId", p.category_id AS "productCategoryId", p.base_unit AS "productUnit", p.classification AS "productClassification",
    pack.id AS "packId", pack.barcode AS "packBarcode", barcode.id AS "barcodePackId"
    FROM jsonb_to_recordset($1::jsonb) AS r("rowNumber" int, "productCode" text, name text, brand text,
      "parentCategoryName" text, "categoryName" text, "baseUnit" text, classification text, quantity text, barcode text)
    LEFT JOIN categories parent ON parent.parent_id IS NULL AND lower(parent.name) = lower(r."parentCategoryName")
    LEFT JOIN categories c ON lower(c.name) = lower(r."categoryName") AND
      ((r."parentCategoryName" IS NULL AND c.parent_id IS NULL) OR (r."parentCategoryName" IS NOT NULL AND c.parent_id = parent.id))
    LEFT JOIN master_products p ON lower(p.name) = lower(r.name) AND COALESCE(lower(p.brand), '') = COALESCE(lower(r.brand), '')
    LEFT JOIN packs pack ON pack.product_id = p.id AND pack.quantity = r.quantity::numeric
    LEFT JOIN packs barcode ON barcode.barcode = r.barcode ORDER BY r."rowNumber"`, [JSON.stringify(rows)]);
  const products = new Map<string, ResolvedRow>();
  const packs = new Set<string>();
  const barcodes = new Map<string, string>();
  for (const row of resolved.rows) {
    const add = (reason: CatalogImportRowError["reason"], field?: CatalogImportCsvField) => errors.push({ rowNumber: row.rowNumber, reason, ...(field ? { field } : {}) });
    const previous = products.get(row.identity);
    if (!row.categoryId || (!row.productId && !row.categoryActive)) add("CATEGORY_NOT_FOUND", "categoryName");
    if ((row.productId && (row.productCategoryId !== row.categoryId || row.productUnit !== row.baseUnit || row.productClassification !== row.classification)) ||
      (previous && (previous.categoryId !== row.categoryId || previous.baseUnit !== row.baseUnit || previous.classification !== row.classification))) add("PRODUCT_DETAILS_MISMATCH");
    products.set(row.identity, row);
    const packKey = JSON.stringify([row.identity, Number(row.quantity)]);
    if (packs.has(packKey)) add("DUPLICATE_PACK", "quantity");
    packs.add(packKey);
    if ((row.packId && row.packBarcode !== row.barcode) || (row.barcodePackId && row.barcodePackId !== row.packId) ||
      (row.barcode && barcodes.has(row.barcode) && barcodes.get(row.barcode) !== packKey)) add("BARCODE_CONFLICT", "barcode");
    if (row.barcode) barcodes.set(row.barcode, packKey);
  }
  const sources = imageFiles(files.imagesZip);
  const invalid = new Set<string>();
  for (const [code, source] of sources) {
    try {
      if (!prepared?.has(code)) {
        const image = await images.prepare(source);
        prepared?.set(code, image);
      }
    }
    catch (error) { if (error instanceof InvalidProductImageError) invalid.add(code); else throw error; }
  }
  // A syntactically invalid row can still own an image; its row error already prevents commit.
  const rawCodes = new Set(records.map((record) => record[header.indexOf("productCode")]));
  if ([...sources.keys()].some((code) => !rawCodes.has(code))) throw new CatalogImportFileError(["imagesZip"]);
  for (const row of resolved.rows) {
    if (invalid.has(row.productCode)) errors.push({ rowNumber: row.rowNumber, reason: "INVALID_PRODUCT_IMAGE", field: "productCode" });
    else if (!row.productId && !sources.has(row.productCode)) errors.push({ rowNumber: row.rowNumber, reason: "MISSING_PRODUCT_IMAGE", field: "productCode" });
  }
  errors.sort((a, b) => a.rowNumber - b.rowNumber || a.reason.localeCompare(b.reason) || (a.field ?? "").localeCompare(b.field ?? ""));
  return { preview: { rowCount: records.length, productCount: products.size, packCount: packs.size, errors }, rows: resolved.rows };
}

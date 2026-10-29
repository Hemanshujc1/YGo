import { z } from "zod";
import { AdminActionReason, CountedPackQuantity, PackBarcode, PackQuantity, PRODUCT_IMAGE_MAX_BYTES, ProductBrand, ProductImage, ProductName, SearchWord } from "./fields";

/** Multipart fields; file-level VALIDATION_FAILED responses put these names in `fields`. */
export const CATALOG_IMPORT_FILE_FIELDS = ["catalogCsv", "imagesZip"] as const;
export const CatalogImportFileField = z.enum(CATALOG_IMPORT_FILE_FIELDS);
export type CatalogImportFileField = z.infer<typeof CatalogImportFileField>;

/** Byte limits enforced while reading the upload and expanding the image ZIP. */
export const CATALOG_IMPORT_FILE_LIMITS = {
  csvBytes: 10 * 1024 * 1024,
  imagesZipBytes: 100 * 1024 * 1024,
  expandedImagesBytes: 100 * 1024 * 1024,
  imageBytes: PRODUCT_IMAGE_MAX_BYTES,
} as const;

/** Admin-managed global categories (#200, CAT-5); two levels at most, no PostgreSQL-unrepresentable NUL (#269). */
export const CategoryName = z.string().trim().min(1).max(100).refine((value) => !value.includes("\0"));
export const Category = z.strictObject({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string(),
  active: z.boolean(),
  effectiveActive: z.boolean(),
});
export type Category = z.infer<typeof Category>;
export const CategoriesResponse = z.strictObject({ categories: z.array(Category) });
export type CategoriesResponse = z.infer<typeof CategoriesResponse>;
export const CategoryParams = z.strictObject({ id: z.uuid() });
export const CreateCategoryBody = z.strictObject({ name: CategoryName, parentId: z.uuid().nullable().default(null) });
export type CreateCategoryBody = z.infer<typeof CreateCategoryBody>;
export const EditCategoryBody = z.strictObject({
  name: CategoryName.optional(),
  parentId: z.uuid().nullable().optional(),
  active: z.boolean().optional(),
  reason: AdminActionReason.optional(),
}).refine((body) => body.name !== undefined || body.parentId !== undefined || body.active !== undefined);
export type EditCategoryBody = z.infer<typeof EditCategoryBody>;

/** A search term (#397, DSC-3): customer search for `typedWord` also looks for `catalogWord` ("kanda" finds onion). */
export const SearchTerm = z.strictObject({ id: z.uuid(), typedWord: z.string(), catalogWord: z.string() });
export type SearchTerm = z.infer<typeof SearchTerm>;
export const SearchTermsResponse = z.strictObject({ terms: z.array(SearchTerm) });
export type SearchTermsResponse = z.infer<typeof SearchTermsResponse>;
export const SearchTermParams = z.strictObject({ id: z.uuid() });
export type SearchTermParams = z.infer<typeof SearchTermParams>;
export const SearchTermBody = z.strictObject({ typedWord: SearchWord, catalogWord: SearchWord });
export type SearchTermBody = z.infer<typeof SearchTermBody>;

/** The canonical unit is `each` for counted products, or kg/l for measured products. */
export const ProductBaseUnit = z.enum(["each", "kg", "l"]);
export const ProductClassification = z.enum(["counted", "measured"]);

/** Column names in the one-row-per-pack CSV template. */
export const CATALOG_IMPORT_CSV_FIELDS = [
  "productCode",
  "name",
  "brand",
  "parentCategoryName",
  "categoryName",
  "baseUnit",
  "classification",
  "quantity",
  "barcode",
] as const;
export const CatalogImportCsvField = z.enum(CATALOG_IMPORT_CSV_FIELDS);
export type CatalogImportCsvField = z.infer<typeof CatalogImportCsvField>;

/** CSV row read by the Admin importer; empty optional cells normalize to null. */
export const CatalogImportCsvRow = z.strictObject({
  /** Repeated across pack rows for one product; ZIP entry is <productCode>.jpg|png|webp (extension case-insensitive). */
  productCode: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  name: ProductName,
  brand: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? null : value,
    ProductBrand,
  ).refine((value) => value !== undefined).transform((value) => value ?? null),
  parentCategoryName: z.string().trim().max(100).refine((value) => !value.includes("\0")).transform((value) => value || null),
  categoryName: CategoryName,
  baseUnit: ProductBaseUnit,
  classification: ProductClassification,
  quantity: PackQuantity,
  barcode: z.string().trim().max(13).transform((value) => value || null).pipe(PackBarcode.nullable()),
}).refine((row) => (row.classification === "counted") === (row.baseUnit === "each"), {
  path: ["classification"],
}).refine((row) => row.baseUnit !== "each" || CountedPackQuantity.safeParse(row.quantity).success, {
  path: ["quantity"],
});
export type CatalogImportCsvRow = z.infer<typeof CatalogImportCsvRow>;

export const MasterProduct = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  categoryId: z.uuid(),
  categoryName: z.string(),
  categoryActive: z.boolean(),
  categoryEffectiveActive: z.boolean(),
  baseUnit: ProductBaseUnit,
  classification: ProductClassification,
  imageUrls: z.strictObject({ 256: z.url(), 512: z.url(), 1024: z.url() }).nullable(),
  published: z.boolean(),
  active: z.boolean(),
});
export type MasterProduct = z.infer<typeof MasterProduct>;
export const MasterProductsResponse = z.strictObject({ products: z.array(MasterProduct) });
export type MasterProductsResponse = z.infer<typeof MasterProductsResponse>;
export const MasterProductParams = z.strictObject({ id: z.uuid() });

export const CreateMasterProductBody = z.strictObject({
  name: ProductName,
  brand: ProductBrand,
  categoryId: z.uuid(),
  baseUnit: ProductBaseUnit,
  classification: ProductClassification,
  image: ProductImage,
}).refine((body) => (body.classification === "counted") === (body.baseUnit === "each"), {
  path: ["baseUnit"],
});
export type CreateMasterProductBody = z.infer<typeof CreateMasterProductBody>;
export const EditMasterProductBody = z.strictObject({
  name: ProductName.optional(),
  brand: ProductBrand,
  categoryId: z.uuid().optional(),
  baseUnit: ProductBaseUnit.optional(),
  classification: ProductClassification.optional(),
  image: ProductImage.optional(),
  active: z.boolean().optional(),
  reason: AdminActionReason.optional(),
}).refine((body) => Object.keys(body).some((key) => key !== "reason")).refine((body) => {
  const baseUnit = body.baseUnit;
  const classification = body.classification;
  return baseUnit === undefined || classification === undefined || (classification === "counted") === (baseUnit === "each");
}, { path: ["baseUnit"] });
export type EditMasterProductBody = z.infer<typeof EditMasterProductBody>;

export const Pack = z.strictObject({
  id: z.uuid(),
  productId: z.uuid(),
  quantity: PackQuantity,
  barcode: PackBarcode.nullable(),
  active: z.boolean(),
});
export type Pack = z.infer<typeof Pack>;
export const PacksResponse = z.strictObject({ packs: z.array(Pack) });
export type PacksResponse = z.infer<typeof PacksResponse>;
export const ProductPacksParams = z.strictObject({ productId: z.uuid() });
export const PackParams = ProductPacksParams.extend({ id: z.uuid() });

function validPackQuantity(body: { baseUnit?: z.infer<typeof ProductBaseUnit>; quantity?: string }): boolean {
  return body.baseUnit !== "each" || body.quantity === undefined || CountedPackQuantity.safeParse(body.quantity).success;
}

export const CreatePackBody = z.strictObject({
  baseUnit: ProductBaseUnit,
  quantity: PackQuantity,
  barcode: PackBarcode.nullable().default(null),
}).refine(validPackQuantity, { path: ["quantity"] });
export type CreatePackBody = z.infer<typeof CreatePackBody>;
export const EditPackBody = z.strictObject({
  baseUnit: ProductBaseUnit.optional(),
  quantity: PackQuantity.optional(),
  barcode: PackBarcode.nullable().optional(),
  active: z.boolean().optional(),
  reason: AdminActionReason.optional(),
}).refine((body) => Object.keys(body).some((key) => key !== "reason" && key !== "baseUnit"))
  .refine((body) => body.quantity === undefined || body.baseUnit !== undefined, { path: ["baseUnit"] })
  .refine(validPackQuantity, { path: ["quantity"] });
export type EditPackBody = z.infer<typeof EditPackBody>;

/** Machine-readable row reasons; Admin maps these to its own display strings. */
export const CatalogImportRowErrorReason = z.enum([
  "INVALID_ROW",
  // Same code across pack rows for one name + brand is expected; error if it names different products.
  "DUPLICATE_PRODUCT_CODE",
  "CATEGORY_NOT_FOUND",
  "PRODUCT_DETAILS_MISMATCH",
  "DUPLICATE_PACK",
  "BARCODE_CONFLICT",
  "MISSING_PRODUCT_IMAGE",
  "INVALID_PRODUCT_IMAGE",
]);
export type CatalogImportRowErrorReason = z.infer<typeof CatalogImportRowErrorReason>;

/** A row-level problem; rowNumber is the one-based CSV record number, including the header as row 1. */
export const CatalogImportRowError = z.strictObject({
  // CSV records are one-based and include the header as record 1, so data starts at 2.
  rowNumber: z.number().int().min(2),
  reason: CatalogImportRowErrorReason,
  field: CatalogImportCsvField.optional(),
});
export type CatalogImportRowError = z.infer<typeof CatalogImportRowError>;
export const CatalogImportRowErrors = z.array(CatalogImportRowError);
export type CatalogImportRowErrors = z.infer<typeof CatalogImportRowErrors>;

/** Summary returned after validating the whole CSV and companion image ZIP. */
export const CatalogImportPreviewResponse = z.strictObject({
  rowCount: z.number().int().nonnegative(),
  productCount: z.number().int().nonnegative(),
  packCount: z.number().int().nonnegative(),
  errors: CatalogImportRowErrors,
});
export type CatalogImportPreviewResponse = z.infer<typeof CatalogImportPreviewResponse>;

/** Counts for catalog records created or already present after an import. */
export const CatalogImportResponse = z.strictObject({
  productsCreated: z.number().int().nonnegative(),
  productsSkipped: z.number().int().nonnegative(),
  packsCreated: z.number().int().nonnegative(),
  packsSkipped: z.number().int().nonnegative(),
});
export type CatalogImportResponse = z.infer<typeof CatalogImportResponse>;

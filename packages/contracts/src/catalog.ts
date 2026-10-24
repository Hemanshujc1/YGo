import { z } from "zod";
import { AdminActionReason, CountedPackQuantity, PackBarcode, PackQuantity, ProductBrand, ProductImage, ProductName } from "./fields";

/** Admin-managed global categories (#200, CAT-5); two levels at most. */
export const CategoryName = z.string().trim().min(1).max(100);
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

/** The canonical unit is `each` for counted products, or kg/l for measured products. */
export const ProductBaseUnit = z.enum(["each", "kg", "l"]);
export const ProductClassification = z.enum(["counted", "measured"]);

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

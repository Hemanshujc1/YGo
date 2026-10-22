import { z } from "zod";
import { AdminActionReason } from "./fields";

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
const ProductName = z.string().trim().min(1).max(200);
const ProductBrand = z.string().trim().min(1).max(100).nullable().optional();
const ProductImage = z.base64().max(13_981_016);

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

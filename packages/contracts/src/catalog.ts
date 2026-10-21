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

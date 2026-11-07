import { z } from "zod";
import { CountedPackQuantity, PackBarcode, PackQuantity, ProductBrand, ProductName, ShopPrice } from "./fields";

const Status = z.enum(["pending", "approved", "mapped", "rejected"]);
const dearer = (a: string, b: string) => Number(a) > Number(b);

/** S38 (CAT-3, #62): the shop asks for a product the catalog lacks. `clientId` makes a retried tap one request. */
export const CreateProductRequestBody = z.strictObject({
  clientId: z.uuid(),
  name: ProductName,
  brand: ProductBrand,
  categoryId: z.uuid(),
  baseUnit: z.enum(["each", "kg", "l"]),
  packQuantity: PackQuantity,
  barcode: PackBarcode.optional(),
  counterPrice: ShopPrice,
  mrp: ShopPrice,
}).superRefine((body, ctx) => {
  if (body.baseUnit === "each" && !CountedPackQuantity.safeParse(body.packQuantity).success) ctx.addIssue({ code: "custom", path: ["packQuantity"] });
  if (dearer(body.counterPrice, body.mrp)) ctx.addIssue({ code: "custom", path: ["counterPrice"] });
});
export type CreateProductRequestBody = z.infer<typeof CreateProductRequestBody>;

export const ProductRequestParams = z.strictObject({ id: z.uuid() });
export type ProductRequestParams = z.infer<typeof ProductRequestParams>;

/** A shop's own request, with how Admin answered it. */
export const ProductRequest = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  baseUnit: z.enum(["each", "kg", "l"]),
  packQuantity: PackQuantity,
  counterPrice: ShopPrice,
  mrp: ShopPrice,
  status: Status,
  /** Why it was rejected; null otherwise. */
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ProductRequest = z.infer<typeof ProductRequest>;

/** Requests newest first, and the categories a request may name (active, leaf), so the form needs no second call. */
export const ProductRequestsResponse = z.strictObject({
  requests: z.array(ProductRequest),
  categories: z.array(z.strictObject({ id: z.uuid(), name: z.string(), parentName: z.string().nullable() })),
});
export type ProductRequestsResponse = z.infer<typeof ProductRequestsResponse>;

/** A11: one request as Admin reads it. `flagged` is a denylist match (CAT-8): a prompt to look, never a refusal. */
export const AdminProductRequest = ProductRequest.extend({
  productId: z.uuid(),
  shop: z.strictObject({ id: z.uuid(), name: z.string() }),
  categoryName: z.string(),
  barcode: z.string().nullable(),
  flagged: z.boolean(),
  /** Approval needs the product's images first; Admin adds them on the product (A05). */
  hasImage: z.boolean(),
  excludedGood: z.boolean(),
  mappedTo: z.strictObject({ packId: z.uuid(), name: z.string() }).nullable(),
});
export type AdminProductRequest = z.infer<typeof AdminProductRequest>;

export const AdminProductRequestsQuery = z.strictObject({ status: z.enum(["pending", "resolved"]).default("pending") });
export type AdminProductRequestsQuery = z.infer<typeof AdminProductRequestsQuery>;

export const AdminProductRequestsResponse = z.strictObject({ requests: z.array(AdminProductRequest) });
export type AdminProductRequestsResponse = z.infer<typeof AdminProductRequestsResponse>;

export const MapProductRequestBody = z.strictObject({ packId: z.uuid() });
export type MapProductRequestBody = z.infer<typeof MapProductRequestBody>;

/** `excludedGood` is the D-9 case: the product leaves the shop's counter list. Any other reason leaves it on sale there. */
export const RejectProductRequestBody = z.strictObject({ reason: z.string().trim().min(1).max(500), excludedGood: z.boolean() });
export type RejectProductRequestBody = z.infer<typeof RejectProductRequestBody>;

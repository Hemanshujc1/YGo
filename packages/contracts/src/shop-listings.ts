import { z } from "zod";
import { PackQuantity, ProductName, ShopPrice } from "./fields";

export const BaseUnitQuantity = z.string().regex(/^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/);
export const SignedBaseUnitQuantity = z.string().regex(/^-?(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/);

export const ShopListingParams = z.strictObject({ packId: z.uuid() });

export const ShopQuantityPriceOption = z.strictObject({
  id: z.uuid(),
  name: ProductName,
  quantity: PackQuantity,
  price: ShopPrice,
});

export const ShopListingSettings = z.strictObject({
  id: z.uuid(),
  onlinePrice: ShopPrice,
  counterPrice: ShopPrice,
  mrp: ShopPrice,
  lowStockLevel: BaseUnitQuantity,
  available: z.boolean(),
  minimumOrderQuantity: PackQuantity.nullable(),
  quantityStep: PackQuantity.nullable(),
  quantityOptions: z.array(ShopQuantityPriceOption),
});

export const ShopListingCatalogItem = z.strictObject({
  packId: z.uuid(),
  productId: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  baseUnit: z.enum(["each", "kg", "l"]),
  classification: z.enum(["counted", "measured"]),
  packQuantity: PackQuantity,
  barcode: z.string().nullable(),
  listing: ShopListingSettings.nullable(),
  /** Left to sell: on hand less what accepted orders hold (#436). */
  stock: SignedBaseUnitQuantity,
  /** What accepted orders hold, "0" when none. */
  held: BaseUnitQuantity,
  openingStockRecorded: z.boolean(),
  /** The opening count as recorded and corrected (#452), "0" when none. */
  openingStock: BaseUnitQuantity,
});

export const ShopListingsResponse = z.strictObject({ items: z.array(ShopListingCatalogItem) });

export const ShopQuantityPriceOptionInput = z.strictObject({
  name: ProductName,
  quantity: PackQuantity,
  price: ShopPrice,
});

function priceInPaise(price: string): string | null {
  const parsed = ShopPrice.safeParse(price);
  if (!parsed.success) return null;
  const [whole, fraction = ""] = parsed.data.split(".");
  if (whole === undefined) return null;
  return `${whole.padStart(10, "0")}${fraction.padEnd(2, "0")}`;
}

export const SaveShopListingBody = z.strictObject({
  onlinePrice: ShopPrice,
  counterPrice: ShopPrice,
  mrp: ShopPrice,
  lowStockLevel: BaseUnitQuantity,
  available: z.boolean().default(true),
  minimumOrderQuantity: PackQuantity.nullable().default(null),
  quantityStep: PackQuantity.nullable().default(null),
  quantityOptions: z.array(ShopQuantityPriceOptionInput).max(20).default([]),
})
  .refine((body) => (body.minimumOrderQuantity === null) === (body.quantityStep === null), { path: ["quantityStep"] })
  .refine((body) => {
    const onlinePrice = priceInPaise(body.onlinePrice);
    const mrp = priceInPaise(body.mrp);
    return onlinePrice === null || mrp === null || onlinePrice <= mrp;
  }, { path: ["onlinePrice"] })
  .refine((body) => {
    const counterPrice = priceInPaise(body.counterPrice);
    const mrp = priceInPaise(body.mrp);
    return counterPrice === null || mrp === null || counterPrice <= mrp;
  }, { path: ["counterPrice"] });

export const OpeningStockBody = z.strictObject({
  quantity: BaseUnitQuantity,
  clientId: z.uuid(),
});

export const OpeningStockResponse = z.strictObject({
  listingId: z.uuid(),
  quantity: BaseUnitQuantity,
  recordedAt: z.iso.datetime(),
});

export type ShopListingCatalogItem = z.infer<typeof ShopListingCatalogItem>;
export type ShopListingsResponse = z.infer<typeof ShopListingsResponse>;
export type SaveShopListingBody = z.infer<typeof SaveShopListingBody>;
export type OpeningStockBody = z.infer<typeof OpeningStockBody>;
export type OpeningStockResponse = z.infer<typeof OpeningStockResponse>;

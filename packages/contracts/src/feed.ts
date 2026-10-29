import { z } from "zod";
import { AddressPoint } from "./addresses";
import { ProductBaseUnit } from "./catalog";
import { Pincode, ShopPrice } from "./fields";
import { ShopHoursRange, Weekday } from "./shop-hours";

/** `GET /v1/feed`: the Customer's pincode finds the Area, the pin tests each shop's radius (DSC-1). */
export const FeedQuery = z.strictObject({
  pincode: Pincode,
  latitude: z.coerce.number().pipe(AddressPoint.shape.latitude),
  longitude: z.coerce.number().pipe(AddressPoint.shape.longitude),
});
export type FeedQuery = z.infer<typeof FeedQuery>;

/** A C04 card (DSC-2). The rating joins with #82. */
export const FeedShop = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** Whole minutes, a multiple of 5 (owner's answer 3 on #47). */
  estimatedMinutes: z.number().int().positive(),
  /** Rupees as the shop's resolved rate card stores them, such as "30" or "25.5". */
  deliveryFee: ShopPrice,
  /** From the weekly hours and the Owner's switch, in India time (#381); a shop with no hours is open. */
  open: z.boolean(),
  /** When a closed shop opens next; null while open. */
  opensAt: z.iso.datetime().nullable(),
});
export type FeedShop = z.infer<typeof FeedShop>;

/** Open shops first, then closed ones, nearest first in each (owner's answer 9 on #371); empty when the pincode is in no active Area. */
export const FeedResponse = z.strictObject({ shops: z.array(FeedShop) });
export type FeedResponse = z.infer<typeof FeedResponse>;

/** `GET /v1/shops/:id` takes the feed's query: a shop the feed wouldn't list answers 404 (owner's answer 10 on #47). */
export const ShopPageParams = z.strictObject({ id: z.uuid() });
export type ShopPageParams = z.infer<typeof ShopPageParams>;

/** One pack the shop lists, priced online. */
export const ShopPagePack = z.strictObject({
  listingId: z.uuid(),
  /** The pack size in the product's base unit, such as "0.5" kg or "12" each. */
  quantity: z.string(),
  price: ShopPrice,
  /** Both set only when the price is below the MRP; the percent is whole and rounded down (owner's answer 3 on #370). */
  mrp: ShopPrice.nullable(),
  discountPercent: z.number().int().min(0).max(100).nullable(),
  /** Stock at or below zero: shown, never orderable (DSC-4, owner's answer 9 on #47). */
  outOfStock: z.boolean(),
});
export type ShopPagePack = z.infer<typeof ShopPagePack>;

export const ShopPageProduct = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  baseUnit: ProductBaseUnit,
  packs: z.array(ShopPagePack),
});
export type ShopPageProduct = z.infer<typeof ShopPageProduct>;

/** C05 Shop page (#370): the card's terms, the minimum order and FSSAI number (DSC-2), then products under their top category, A to Z. */
export const ShopPageResponse = z.strictObject({
  shop: FeedShop.extend({
    minimumOrder: ShopPrice,
    fssaiNumber: z.string(),
    /** When an open shop closes next; null while closed, or for a shop that never closes. */
    closesAt: z.iso.datetime().nullable(),
    /** The weekly hours by day and opening time, and today's weekday in India, for C05's hours line (#381). */
    hours: z.array(ShopHoursRange),
    today: Weekday,
  }),
  groups: z.array(z.strictObject({ category: z.string(), products: z.array(ShopPageProduct) })),
});
export type ShopPageResponse = z.infer<typeof ShopPageResponse>;

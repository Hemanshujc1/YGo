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
  /** Closed because today in India is one of the shop's holidays (#382). */
  holiday: z.boolean(),
});
export type FeedShop = z.infer<typeof FeedShop>;

/** Open shops first, then closed ones, nearest first in each (owner's answer 9 on #371); empty when the pincode is in no active Area. */
export const FeedResponse = z.strictObject({ shops: z.array(FeedShop) });
export type FeedResponse = z.infer<typeof FeedResponse>;

/** `GET /v1/shops/:id` takes the feed's query: a shop the feed wouldn't list answers 404 (owner's answer 10 on #47). */
export const ShopPageParams = z.strictObject({ id: z.uuid() });
export type ShopPageParams = z.infer<typeof ShopPageParams>;

/**
 * What is left of a pack when it is less than one pack (#377): measured goods only, the whole remainder at a
 * price in proportion to the pack's, with no MRP or percent off. Worked out by the server from stock, never sent by the phone.
 */
export const PartPack = z.strictObject({
  /** The remainder in the product's base unit, such as "0.4" kg. */
  quantity: z.string(),
  price: ShopPrice,
});
export type PartPack = z.infer<typeof PartPack>;

/** One pack the shop lists, priced online. */
export const ShopPagePack = z.strictObject({
  listingId: z.uuid(),
  /** The pack size in the product's base unit, such as "0.5" kg or "12" each. */
  quantity: z.string(),
  price: ShopPrice,
  /** Both set only when the price is below the MRP; the percent has two decimals, as text like "7.69" (owner's answer 3 on #370, #411). */
  mrp: ShopPrice.nullable(),
  discountPercent: z.string().regex(/^(?:100|\d{1,2})\.\d{2}$/).nullable(),
  /** Not one pack left and no part on sale: shown, never orderable (DSC-4, owner's answer 9 on #47). */
  outOfStock: z.boolean(),
  /** Set when less than one pack is left and that part is on sale (#377). */
  part: PartPack.nullable(),
});
export type ShopPagePack = z.infer<typeof ShopPagePack>;

export const ShopPageProduct = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  baseUnit: ProductBaseUnit,
  /** The 256 px photo for C05's row (#378); null when the server has no image storage set up. */
  imageUrl: z.url().nullable(),
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
    /** The weekdays of today and the next 6 days that are holidays (#382). */
    holidays: z.array(Weekday),
  }),
  groups: z.array(z.strictObject({ category: z.string(), products: z.array(ShopPageProduct) })),
});
export type ShopPageResponse = z.infer<typeof ShopPageResponse>;

/** `GET /v1/search` (#398, DSC-3): the feed's query and the typed text, which needs 2 characters. */
export const SearchQuery = FeedQuery.extend({ q: z.string().trim().min(2).max(60) });
export type SearchQuery = z.infer<typeof SearchQuery>;

/** A matching product, in stock when any pack the shop lists has a whole pack or a part on sale (owner's answer 3 on #398, #377); no prices. */
export const SearchProduct = z.strictObject({ id: z.uuid(), name: z.string(), brand: z.string().nullable(), inStock: z.boolean() });
export type SearchProduct = z.infer<typeof SearchProduct>;

/** A C04 card with up to 5 matching products A to Z and how many more match (owner's answer 2 on #398); none when only the shop's name matched. */
export const SearchShop = FeedShop.extend({ products: z.array(SearchProduct).max(5), moreProducts: z.number().int().min(0) });
export type SearchShop = z.infer<typeof SearchShop>;

/** The feed's shops in the feed's order, leaving out each one with no match. */
export const SearchResponse = z.strictObject({ shops: z.array(SearchShop) });
export type SearchResponse = z.infer<typeof SearchResponse>;

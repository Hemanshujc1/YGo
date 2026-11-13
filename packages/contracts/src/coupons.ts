import { z } from "zod";
import { RatePercentage, ShopPrice } from "./fields";

const positive = (value: string) => Number(value) > 0;

/** A coupon's code: letters and digits only, 3 to 20 of them, unique whatever the case (CRT-3, #70). */
export const CouponCode = z.string().trim().regex(/^[A-Za-z0-9]{3,20}$/);

/**
 * The terms an Admin or an Owner saves (CRT-3, FR-PRC-08). Two forms, like the shop-wide discount: a percentage with an optional cap, or a flat amount.
 * `minimumOrder` is the product value the eligible lines must reach; a flat coupon a shop pays for must have one, so its worst case can be held to the
 * maximum (D-12). Empty `areaIds` / `categoryIds` mean no restriction. An Owner's coupon is always shop-funded and always for their own shop; only an Admin
 * names the funding and the shop (ADM-5). `active` turns it on or off.
 */
const CouponCommon = {
  code: CouponCode,
  startsAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  usageLimit: z.number().int().min(1).max(10_000_000).nullable(),
  perCustomerLimit: z.number().int().min(1).max(1000),
  firstOrderOnly: z.boolean(),
  areaIds: z.array(z.uuid()).max(100),
  categoryIds: z.array(z.uuid()).max(100),
  active: z.boolean(),
};
const CouponForm = z.discriminatedUnion("form", [
  z.strictObject({ form: z.literal("percentage"), percentage: RatePercentage.refine(positive), cap: ShopPrice.refine(positive).nullable(), minimumOrder: ShopPrice.refine(positive).nullable(), ...CouponCommon }),
  z.strictObject({ form: z.literal("flat"), amount: ShopPrice.refine(positive), minimumOrder: ShopPrice.refine(positive).nullable(), ...CouponCommon }),
]);
const notBackwards = (body: { startsAt: string | null; expiresAt: string }) => body.startsAt === null || Date.parse(body.startsAt) < Date.parse(body.expiresAt);

/** An Owner saves a coupon their shop pays for. */
export const OwnerCouponBody = CouponForm.refine(notBackwards);
export type OwnerCouponBody = z.infer<typeof OwnerCouponBody>;

/** An Admin saves a coupon the platform pays for, or one a named shop pays for. */
export const AdminCouponBody = z.intersection(
  CouponForm.refine(notBackwards),
  z.discriminatedUnion("funding", [
    z.strictObject({ funding: z.literal("platform") }),
    z.strictObject({ funding: z.literal("shop"), shopId: z.uuid() }),
  ]),
);
export type AdminCouponBody = z.infer<typeof AdminCouponBody>;

export const CouponParams = z.strictObject({ id: z.uuid() });
export type CouponParams = z.infer<typeof CouponParams>;

/** `paused` is only ever set by YGo, when the maximum was lowered under a shop-funded coupon (D-12); saving it back under the maximum turns it on. */
export const CouponStatus = z.enum(["active", "off", "paused"]);

/** A coupon as Admin and its Owner see it. Amounts without trailing zeros; `used` counts the orders it is still in force on. */
export const Coupon = z.strictObject({
  id: z.uuid(),
  version: z.number().int().positive(),
  code: z.string(),
  funding: z.enum(["platform", "shop"]),
  shopId: z.uuid().nullable(),
  form: z.enum(["percentage", "flat"]),
  percentage: z.string().nullable(),
  cap: z.string().nullable(),
  amount: z.string().nullable(),
  minimumOrder: z.string().nullable(),
  startsAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime(),
  usageLimit: z.number().int().nullable(),
  perCustomerLimit: z.number().int(),
  firstOrderOnly: z.boolean(),
  areaIds: z.array(z.uuid()),
  categoryIds: z.array(z.uuid()),
  status: CouponStatus,
  used: z.number().int(),
});
export type Coupon = z.infer<typeof Coupon>;

/** `maximumPercentage` is the largest effective percentage a shop-funded coupon may reach for this shop (null for a platform-funded one). */
export const CouponsResponse = z.strictObject({ coupons: z.array(Coupon), maximumPercentage: z.string().nullable() });
export type CouponsResponse = z.infer<typeof CouponsResponse>;

export const CouponResponse = z.strictObject({ coupon: Coupon });
export type CouponResponse = z.infer<typeof CouponResponse>;

/**
 * Why a coupon does not apply to this cart, in the Customer's terms (CRT-3, CRT-4). Each names what to do: the app words it.
 * NOT_AVAILABLE: off, paused, unknown or for another shop or area. NOT_STARTED, EXPIRED: outside its dates. LIMIT_REACHED: used up. ALREADY_USED: this
 * Customer's own limit. FIRST_ORDER_ONLY: they have ordered before. WITH_BARGAIN: the order has a bargained line (BRG-5). NOTHING_ELIGIBLE: no line is in its categories.
 * BELOW_MINIMUM: the eligible lines are under its minimum order. NO_ROOM: a platform-funded coupon the order cannot pay for (floor rule). BETTER_OFFER: the shop-wide
 * discount takes more off, so the coupon was not applied and not counted as used (D-7).
 */
export const CouponReason = z.enum([
  "NOT_AVAILABLE", "NOT_STARTED", "EXPIRED", "LIMIT_REACHED", "ALREADY_USED", "FIRST_ORDER_ONLY", "WITH_BARGAIN",
  "NOTHING_ELIGIBLE", "BELOW_MINIMUM", "NO_ROOM", "BETTER_OFFER",
]);
export type CouponReason = z.infer<typeof CouponReason>;

/** `PUT /v1/carts/:shopId/coupon`: the one coupon on the cart, by its code (CRT-3). Any case. */
export const CartCouponBody = z.strictObject({ code: CouponCode });
export type CartCouponBody = z.infer<typeof CartCouponBody>;


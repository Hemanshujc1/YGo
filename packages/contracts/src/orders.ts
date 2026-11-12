import { z } from "zod";
import { AddressLabel, AddressPoint } from "./addresses";
import { ProductBaseUnit } from "./catalog";
import { Pincode } from "./fields";
import { Amount, LineCount } from "./pricing";
import { AppliedShopDiscount, ShopDiscountOffer } from "./shop-discount";

/** Every status an order can be in (#9); the terminal ones end it. */
export const OrderStatus = z.enum([
  "placed", "scheduled_pending_review", "awaiting_customer_confirm", "accepted", "scheduled_confirmed",
  "preparing", "ready", "out_for_delivery", "arrived",
  "delivered", "picked_up", "rejected_by_shop", "expired", "not_collected", "cancelled_by_customer", "cancelled_by_shop", "delivery_failed",
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  "delivered", "picked_up", "rejected_by_shop", "expired", "not_collected", "cancelled_by_customer", "cancelled_by_shop", "delivery_failed",
];

/**
 * `POST /v1/carts/:shopId/order` (#424): places the cart for delivery to a saved address with a pin.
 * `revision` and `total` are what C07 showed; either differing from the server's fresh quote is CART_CHANGED (CRT-2).
 */
export const PlaceOrderBody = z.union([
  z.strictObject({ revision: z.number().int().min(1), total: Amount, addressId: z.uuid() }),
  /**
   * A pickup (FUL-7, #65): no address and no delivery fee; paid at the shop's counter when collected. The shop must still serve the place the Customer is
   * ordering from (DSC-1: no pickup exception for a shop further away), so the same place the cart was priced for is sent.
   */
  z.strictObject({ revision: z.number().int().min(1), total: Amount, fulfilment: z.literal("pickup"), pincode: Pincode, latitude: AddressPoint.shape.latitude, longitude: AddressPoint.shape.longitude }),
]);
export type PlaceOrderBody = z.infer<typeof PlaceOrderBody>;

/** How an order reaches the Customer. */
export const Fulfilment = z.enum(["delivery", "pickup"]);
export type Fulfilment = z.infer<typeof Fulfilment>;

/** The modes a shop switches on or off and Admin can force off (FUL-1); scheduled delivery joins with its own ticket. */
export const FulfilmentMode = z.enum(["instant", "scheduled", "pickup"]);
export type FulfilmentMode = z.infer<typeof FulfilmentMode>;

export const OrderParams = z.strictObject({ id: z.uuid() });
export type OrderParams = z.infer<typeof OrderParams>;

/** S05's fixed Reject list (#425); each app words them in its own strings. */
export const RejectReason = z.enum(["out_of_stock", "too_busy", "closing_soon", "cannot_deliver"]);
export type RejectReason = z.infer<typeof RejectReason>;

/**
 * The Customer's one ask to cancel an accepted order (ORD-5, #59). `asked` waits for the shop; the shop's answer makes it
 * `agreed` (the order is cancelled) or `kept`; it becomes `closed_unanswered` when the order moves on first (ready,
 * a partial acceptance or a shop cancel).
 */
export const CancelRequestStatus = z.enum(["asked", "agreed", "kept", "closed_unanswered"]);
export type CancelRequestStatus = z.infer<typeof CancelRequestStatus>;
export const CancelRequest = z.strictObject({ status: CancelRequestStatus, askedAt: z.iso.datetime() });
export type CancelRequest = z.infer<typeof CancelRequest>;

/** Reasons for line reduction or removal in a partial acceptance proposal (ORD-3). */
export const OrderLineChangeReason = z.enum(["out_of_stock", "damaged", "near_expiry", "quality_issue"]);
export type OrderLineChangeReason = z.infer<typeof OrderLineChangeReason>;

/** A line in a partial acceptance proposal, showing original and changed figures (C10). */
export const OrderRevisionLine = z.strictObject({
  listingId: z.uuid(),
  name: z.string(),
  brand: z.string().nullable(),
  baseUnit: ProductBaseUnit,
  quantity: z.string(),
  originalCount: LineCount,
  count: z.number().int().min(0).max(999),
  originalPart: z.string().nullable(),
  part: z.string().nullable(),
  unitPrice: Amount,
  originalLineTotal: Amount,
  lineTotal: Amount,
  changeReason: OrderLineChangeReason.nullable(),
});
export type OrderRevisionLine = z.infer<typeof OrderRevisionLine>;

/** An open partial acceptance proposal awaiting Customer confirmation (C10, S05). */
export const OrderProposal = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  sourceStatus: OrderStatus,
  createdAt: z.iso.datetime(),
  confirmByAt: z.iso.datetime(),
  lines: z.array(OrderRevisionLine),
  productValue: Amount,
  /** The discount the proposal carries, re-applied from the order's frozen rule version (#572); null when none applies. */
  shopDiscount: AppliedShopDiscount,
  /** The offer of the order's rule when this proposal drops a discount the order had (a flat rule whose minimum order the revised basket no longer meets), so C10 can say why; null otherwise. */
  lostShopDiscount: ShopDiscountOffer.nullable(),
  deliveryFee: Amount,
  smallCartFee: Amount.nullable(),
  /** The pickup booking fee, which stands as quoted through a changed total; null on a delivery. */
  pickupFee: Amount.nullable(),
  total: Amount,
  originalProductValue: Amount,
  originalTotal: Amount,
});
export type OrderProposal = z.infer<typeof OrderProposal>;

/** A line as it was frozen at placement (MNY-7). */
export const OrderLine = z.strictObject({
  name: z.string(),
  brand: z.string().nullable(),
  baseUnit: ProductBaseUnit,
  /** The pack size in the product's base unit. */
  quantity: z.string(),
  count: LineCount,
  /** Set for the remainder of a pack (#377): the quantity bought, in the base unit. */
  part: z.string().nullable(),
  unitPrice: Amount,
  lineTotal: Amount,
});
export type OrderLine = z.infer<typeof OrderLine>;

/** A line on S05 with its shop listing id for partial acceptance (ORD-3). */
export const ShopOrderLine = OrderLine.extend({ listingId: z.uuid() });
export type ShopOrderLine = z.infer<typeof ShopOrderLine>;

/** C09 and C19. Paid in cash or UPI at the door, nothing before (MNY-1). */
export const OrderResponse = z.strictObject({
  id: z.uuid(),
  /** One running number for all shops, said on a phone call as "Order #1042". */
  number: z.number().int().positive(),
  status: OrderStatus,
  placedAt: z.iso.datetime(),
  /** `phone` is the Owner's, for Call the shop (ORD-8); null when the Owner has none. */
  shop: z.strictObject({ id: z.uuid(), name: z.string(), phone: z.string().nullable() }),
  fulfilment: Fulfilment,
  /** Null for a pickup, which has no address. */
  address: z.strictObject({ label: AddressLabel, flat: z.string(), areaLine: z.string().nullable(), pincode: z.string() }).nullable(),
  lines: z.array(OrderLine),
  productValue: Amount,
  /**
   * The shop-wide discount and the offer of the rule version that gave it; null when none applied. Once a revision is confirmed it is the revision's
   * own (re-applied from the same frozen rule version, #572), beside the revision's `productValue` and `total`.
   */
  shopDiscount: AppliedShopDiscount,
  deliveryFee: Amount,
  smallCartFee: Amount.nullable(),
  /** The pickup booking fee inside `total`, charged only when the pickup is completed (FUL-7); "0.00" on a pickup with none, null on a delivery. */
  pickupFee: Amount.nullable(),
  total: Amount,
  /** Why the shop rejected it, shown on C19 in the Customer's own words (owner's answer 3 on #425); null otherwise. */
  rejectReason: RejectReason.nullable(),
  /**
   * Still placed, but past ORDER_ANSWER_SECONDS by the server's clock: the shop can no longer answer. For the
   * moment before the `expire-orders` job (#57, every minute) moves it to Expired, C18 and C19 show "Shop did not answer" from this (owner's answer 4 on #426).
   */
  answerExpired: z.boolean(),
  handoverCode: z.string().regex(/^\d{4}$/).nullable(),
  /** Six wrong codes have locked the handover; a pickup's Customer asks for a new code, which opens it again (#597). */
  handoverLocked: z.boolean(),
  itemsCheckedAt: z.iso.datetime().nullable(),
  confirmByAt: z.iso.datetime().nullable(),
  proposal: OrderProposal.nullable(),
  /** The Customer's ask to cancel, once made; null before. The app offers Ask to cancel only while the order is accepted or preparing and this is null. */
  cancelRequest: CancelRequest.nullable(),
});
export type OrderResponse = z.infer<typeof OrderResponse>;

/** A row on C18 (#426). */
export const OrderSummary = OrderResponse.pick({ id: true, number: true, status: true, placedAt: true, shop: true, total: true, answerExpired: true, confirmByAt: true }).extend({
  /** The open proposal's total while the order awaits the Customer's confirmation, for the changed-total banner (#578); null otherwise. */
  proposedTotal: Amount.nullable(),
});
export type OrderSummary = z.infer<typeof OrderSummary>;

/**
 * `GET /v1/orders`, C18's two groups (owner's answers on #426).
 * - `active`: not final and not `answerExpired`. Those waiting on the Customer (awaiting_customer_confirm, arrived) first, then newest placed first.
 * - `past`: final or `answerExpired`, newest placed first, at most the newest 50.
 * Ties fall to the higher order number.
 */
export const OrdersResponse = z.strictObject({ active: z.array(OrderSummary), past: z.array(OrderSummary) });
export type OrdersResponse = z.infer<typeof OrdersResponse>;

/**
 * A placed order the shop hasn't answered expires this long after placement (ORD-2). Accept and Reject refuse
 * from this moment with ORDER_EXPIRED; the `expire-orders` job (#57) moves it to Expired. The server reads its own
 * setting, `ORDER_EXPIRE_SECONDS`; the apps count down from this constant. Changing the setting therefore needs an
 * app update that changes this value, until the order responses carry the server's deadline.
 */
export const ORDER_ANSWER_SECONDS = 600;

/** The statuses whose lines hold stock (#425): from Accept until the order leaves the shop's hands. */
export const STOCK_HOLDING_ORDER_STATUSES: readonly OrderStatus[] = ["accepted", "preparing", "ready", "out_for_delivery", "arrived", "awaiting_customer_confirm"];

/** `POST /v1/me/shop-orders/:id/reject`. */
export const RejectOrderBody = z.strictObject({ reason: RejectReason });
export type RejectOrderBody = z.infer<typeof RejectOrderBody>;

/** `POST /v1/me/shop-orders/:id/cancel`: the shop cancels an accepted, preparing or ready order, with a reason (ORD-5). Reject stays for orders still placed. */
export const CancelOrderBody = z.strictObject({ reason: RejectReason });
export type CancelOrderBody = z.infer<typeof CancelOrderBody>;

/** A line reduction or removal in a partial acceptance proposal (ORD-3). */
export const PartialAcceptLine = z.strictObject({
  listingId: z.uuid(),
  count: z.number().int().min(0).max(999),
  reason: OrderLineChangeReason.optional(),
});
export type PartialAcceptLine = z.infer<typeof PartialAcceptLine>;

/** `POST /v1/me/shop-orders/:id/partial-accept` (ORD-3, #526). */
export const PartialAcceptOrderBody = z.strictObject({
  lines: z.array(PartialAcceptLine).min(1),
});
export type PartialAcceptOrderBody = z.infer<typeof PartialAcceptOrderBody>;

/** `POST /v1/me/shop-orders/:id/partial-accept/preview`: dry-run quote preview for partial acceptance (ORD-3). */
export const PartialAcceptPreviewResponse = z.strictObject({
  productValue: Amount,
  shopDiscount: AppliedShopDiscount,
  deliveryFee: Amount,
  smallCartFee: Amount.nullable(),
  /** The pickup booking fee, which stands as quoted through a changed total; null on a delivery. */
  pickupFee: Amount.nullable(),
  total: Amount,
  originalTotal: Amount,
  /** Sending this would cancel the order at no cost, because the platform would lose money on it (D-5). */
  cancelsOrder: z.boolean(),
  /** Sending this goes ahead as a recorded exception below the contribution floor (D-5); false when it cancels. */
  belowFloor: z.boolean(),
});
export type PartialAcceptPreviewResponse = z.infer<typeof PartialAcceptPreviewResponse>;

/** A row on S04 (#425). `itemCount` is the number of distinct lines; `expiresAt` is set only while the order is placed. */
export const ShopOrderSummary = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  status: OrderStatus,
  placedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  confirmByAt: z.iso.datetime().nullable(),
  /** The Customer has asked to cancel and the shop has not answered. */
  cancelAsked: z.boolean(),
  itemCount: z.number().int().positive(),
  total: Amount,
  fulfilment: Fulfilment,
  /** Null for a pickup. */
  address: z.strictObject({ flat: z.string(), areaLine: z.string().nullable() }).nullable(),
  delivererId: z.uuid().nullable(),
});
export type ShopOrderSummary = z.infer<typeof ShopOrderSummary>;

/**
 * `GET /v1/me/shop-orders`, S04's three groups. `now` is the server's clock, so a countdown is
 * `expiresAt - now` and doesn't depend on the phone's own clock.
 * - `new`: placed orders still inside ORDER_ANSWER_SECONDS, oldest first.
 * - `accepted`: the STOCK_HOLDING_ORDER_STATUSES, oldest placed first.
 * - `doneToday`: final statuses whose last status change fell on today in India time, newest change first.
 */
export const ShopOrdersResponse = z.strictObject({
  now: z.iso.datetime(),
  canDeliver: z.boolean(),
  new: z.array(ShopOrderSummary),
  accepted: z.array(ShopOrderSummary),
  doneToday: z.array(ShopOrderSummary),
  myDeliveries: z.array(ShopOrderSummary),
});
export type ShopOrdersResponse = z.infer<typeof ShopOrdersResponse>;

/** S05: one of the shop's orders, as it was frozen. The Customer's name for the shop and the deliverer; the phone only for the assigned deliverer (DLV-7). */
export const ShopOrderResponse = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  status: OrderStatus,
  placedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  now: z.iso.datetime(),
  fulfilment: Fulfilment,
  /** Null for a pickup. */
  address: z.strictObject({ label: AddressLabel, flat: z.string(), areaLine: z.string().nullable(), pincode: z.string() }).nullable(),
  lines: z.array(ShopOrderLine),
  productValue: Amount,
  deliveryFee: Amount,
  smallCartFee: Amount.nullable(),
  pickupFee: Amount.nullable(),
  /** To collect at the door, or at the counter for a pickup (MNY-1). */
  total: Amount,
  rejectReason: RejectReason.nullable(),
  delivererId: z.uuid().nullable(),
  customer: z.strictObject({ name: z.string().nullable(), phone: z.string().nullable() }).nullable(),
  shopUpiId: z.string().nullable(),
  deliveryPhotoAvailable: z.boolean(),
  deliveryFailureReadyAt: z.iso.datetime().nullable(),
  confirmByAt: z.iso.datetime().nullable(),
  proposal: OrderProposal.nullable(),
  cancelRequest: CancelRequest.nullable(),
});
export type ShopOrderResponse = z.infer<typeof ShopOrderResponse>;

export const AssignDelivererBody = z.strictObject({ accountId: z.uuid() });
export type AssignDelivererBody = z.infer<typeof AssignDelivererBody>;
export const SetStaffCanDeliverBody = z.strictObject({ canDeliver: z.boolean() });
export type SetStaffCanDeliverBody = z.infer<typeof SetStaffCanDeliverBody>;
export const SetStaffCanDeliverResponse = z.strictObject({ accountId: z.uuid(), canDeliver: z.boolean() });
export type SetStaffCanDeliverResponse = z.infer<typeof SetStaffCanDeliverResponse>;
export const ShopDeliverer = z.strictObject({ accountId: z.uuid(), name: z.string().nullable(), role: z.enum(["owner", "staff"]), canDeliver: z.boolean() });
export type ShopDeliverer = z.infer<typeof ShopDeliverer>;
export const ShopDeliverersResponse = z.strictObject({ deliverers: z.array(ShopDeliverer) });
export type ShopDeliverersResponse = z.infer<typeof ShopDeliverersResponse>;
export const ShopStaff = z.strictObject({ accountId: z.uuid(), name: z.string().nullable(), phone: z.string().nullable(), canDeliver: z.boolean() });
export type ShopStaff = z.infer<typeof ShopStaff>;
export const ShopStaffResponse = z.strictObject({ staff: z.array(ShopStaff) });
export type ShopStaffResponse = z.infer<typeof ShopStaffResponse>;
export const DELIVERY_PHOTO_MAX_BYTES = 5_000_000;
export const DeliveryPhotoUploadBody = z.strictObject({ contentType: z.literal("image/jpeg"), byteLength: z.number().int().min(1).max(DELIVERY_PHOTO_MAX_BYTES) });
export type DeliveryPhotoUploadBody = z.infer<typeof DeliveryPhotoUploadBody>;
export const DeliveryPhotoUpload = z.strictObject({ id: z.uuid(), uploadUrl: z.url() });
export type DeliveryPhotoUpload = z.infer<typeof DeliveryPhotoUpload>;
export const CompleteDeliveryBody = z.strictObject({ handoverCode: z.string().regex(/^\d{4}$/), payment: z.enum(["cash", "upi"]), photoUploadId: z.uuid() });
export type CompleteDeliveryBody = z.infer<typeof CompleteDeliveryBody>;
/** Completes a pickup at the counter with the same code and no photo (FUL-7, MNY-1). */
export const CompletePickupBody = z.strictObject({ handoverCode: z.string().regex(/^\d{4}$/), payment: z.enum(["cash", "upi"]) });
export type CompletePickupBody = z.infer<typeof CompletePickupBody>;
export const ProofExceptionBody = z.strictObject({ reason: z.enum(["customer_phone_unavailable", "customer_phone_not_present", "someone_else_receiving", "other"]), photoUploadId: z.uuid(), payment: z.enum(["cash", "upi"]) });
export type ProofExceptionBody = z.infer<typeof ProofExceptionBody>;
export const DeliveryFailureReason = z.enum(["no_one_at_address", "customer_refused", "address_not_found", "other"]);
export type DeliveryFailureReason = z.infer<typeof DeliveryFailureReason>;
export const FailDeliveryBody = z.strictObject({ reason: DeliveryFailureReason, photoUploadId: z.uuid() });
export type FailDeliveryBody = z.infer<typeof FailDeliveryBody>;

/**
 * A line Accept can't fill from the stock left (NOT_ENOUGH_STOCK). `available` is what is left in the base unit, never packs:
 * the app divides it by `quantity` and rounds down for a whole-pack line (3 kg of 2 kg packs is "Only 1 left of Toor Dal 2 kg"),
 * and shows it as is for a part line ("Only 300 g left of Toor Dal").
 */
export const ShortLine = OrderLine.pick({ name: true, brand: true, baseUnit: true, quantity: true, count: true, part: true })
  .extend({ available: z.string() });
export type ShortLine = z.infer<typeof ShortLine>;

const belowFloorCursor = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

/** `GET /v1/admin/orders/below-floor-exceptions` (A30, MNY-4, ADM-7, #529). */
export const BelowFloorExceptionsQuery = z.strictObject({
  status: z.enum(["open", "reviewed"]).default("open"),
  shopId: z.uuid().optional(),
  areaManagerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: belowFloorCursor.optional(),
});
export type BelowFloorExceptionsQuery = z.infer<typeof BelowFloorExceptionsQuery>;

export const BelowFloorExceptionParams = z.strictObject({
  revisionId: z.uuid(),
});
export type BelowFloorExceptionParams = z.infer<typeof BelowFloorExceptionParams>;

/** An order revision that went ahead below the contribution floor as a recorded exception (D-5, #526, #529). */
export const BelowFloorException = z.strictObject({
  revisionId: z.uuid(),
  orderId: z.uuid(),
  orderNumber: z.number().int().positive(),
  shopId: z.uuid(),
  shopName: z.string(),
  placedAt: z.iso.datetime(),
  status: OrderStatus,
  originalTotal: Amount,
  revisedTotal: Amount,
  shortfall: Amount,
  platformContribution: Amount,
  reason: z.string().nullable(),
  reviewed: z.strictObject({
    at: z.iso.datetime(),
    by: z.string().nullable(),
  }).nullable(),
});
export type BelowFloorException = z.infer<typeof BelowFloorException>;

/** How many below-floor exceptions exist in scope: open and total (ADM-8, R-8). Worked out from the rows. */
export const BelowFloorExceptionCounts = z.strictObject({
  open: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  shops: z.array(z.strictObject({
    shopId: z.uuid(),
    name: z.string(),
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
  })),
  areaManagers: z.array(z.strictObject({
    accountId: z.uuid(),
    name: z.string().nullable(),
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
  })),
});
export type BelowFloorExceptionCounts = z.infer<typeof BelowFloorExceptionCounts>;

export const BelowFloorExceptionsResponse = z.strictObject({
  exceptions: z.array(BelowFloorException),
  nextCursor: z.string().nullable(),
  counts: BelowFloorExceptionCounts,
});
export type BelowFloorExceptionsResponse = z.infer<typeof BelowFloorExceptionsResponse>;

/**
 * One fulfilment mode of a shop (FUL-1, #65). `open` is whether the switches allow new orders: the shop has it on and Admin has not forced it off.
 * It does not read the rate card: a pickup whose card has lost its pickup rule is still `open` here, and the cart simply offers no pickup quote.
 */
export const FulfilmentModeState = z.strictObject({ mode: FulfilmentMode, shopOn: z.boolean(), adminForcedOff: z.boolean(), open: z.boolean() });
export type FulfilmentModeState = z.infer<typeof FulfilmentModeState>;
export const FulfilmentModesResponse = z.strictObject({ modes: z.array(FulfilmentModeState) });
export type FulfilmentModesResponse = z.infer<typeof FulfilmentModesResponse>;
export const FulfilmentModeParams = z.strictObject({ mode: FulfilmentMode });
export type FulfilmentModeParams = z.infer<typeof FulfilmentModeParams>;
/** An Owner switches one of the shop's own modes. */
export const SetFulfilmentModeBody = z.strictObject({ on: z.boolean() });
export type SetFulfilmentModeBody = z.infer<typeof SetFulfilmentModeBody>;
/** Admin forces a mode off for one shop, or lifts it. */
export const AdminFulfilmentModeParams = z.strictObject({ id: z.uuid(), mode: FulfilmentMode });
export type AdminFulfilmentModeParams = z.infer<typeof AdminFulfilmentModeParams>;
export const ForceFulfilmentModeBody = z.strictObject({ forcedOff: z.boolean() });
export type ForceFulfilmentModeBody = z.infer<typeof ForceFulfilmentModeBody>;

import { z } from "zod";
import { CalendarDate } from "./fields";
import { Amount } from "./pricing";

/**
 * One completed order on a weekly statement (#629, MNY-8, Q-6): what the order came to and what the shop owes YGo on it, from its final price.
 * `owed` is the order's platform contribution and always equals commission + feeShare + bookingFees − platformCoupon. `late` marks an order
 * completed before the statement's week: one that reached the server after its own week's statement was made, or, on the first statement,
 * any order from before it.
 */
export const StatementLine = z.strictObject({
  orderId: z.uuid(),
  orderNumber: z.number().int(),
  completedAt: z.iso.datetime(),
  late: z.boolean(),
  fulfilment: z.enum(["delivery", "pickup"]),
  orderTotal: Amount,
  commission: Amount,
  /** YGo's share of the delivery and small-cart fees. */
  feeShare: Amount,
  /** Both pickup booking fees: the customer's and the shop's. */
  bookingFees: Amount,
  /** The YGo-funded coupon, which comes off what the shop owes. */
  platformCoupon: Amount,
  owed: Amount,
});
export type StatementLine = z.infer<typeof StatementLine>;

/** A statement in a list: one shop's Monday–Sunday week (IST), never changed once made. Paid and overdue come with #79. */
export const StatementSummary = z.strictObject({
  id: z.uuid(),
  number: z.number().int(),
  shopId: z.uuid(),
  shopName: z.string(),
  periodStart: CalendarDate,
  periodEnd: CalendarDate,
  issuedAt: z.iso.datetime(),
  dueOn: CalendarDate,
  orderCount: z.number().int().positive(),
  total: Amount,
});
export type StatementSummary = z.infer<typeof StatementSummary>;

/** One whole statement, with the shop's name and address as they were when it was made (MNY-12). */
export const Statement = StatementSummary.extend({
  shopAddress: z.string().nullable(),
  shopPincode: z.string().nullable(),
  lines: z.array(StatementLine),
});
export type Statement = z.infer<typeof Statement>;

/**
 * What a shop owes YGo now, in its two parts (MNY-8): the statements made so far, and its completed orders not on a statement yet (this week's,
 * plus any the next statement will carry as late). Payments and adjustments come with #79.
 */
export const StatementBalance = z.strictObject({ onStatements: Amount, thisWeek: Amount, total: Amount });
export type StatementBalance = z.infer<typeof StatementBalance>;

/** A page of statements, newest first: the next page is asked for with `before` set to the last number shown. */
export const StatementsQuery = z.strictObject({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type StatementsQuery = z.infer<typeof StatementsQuery>;

/** `GET /v1/me/statements` (S15): the Owner's balance and a page of their statements. */
export const OwnerStatementsResponse = z.strictObject({
  balance: StatementBalance,
  statements: z.array(StatementSummary),
  nextBefore: z.number().int().nullable(),
});
export type OwnerStatementsResponse = z.infer<typeof OwnerStatementsResponse>;

/** `GET /v1/admin/statements` (A18): every shop's statements, newest first, or one week's when `week` names its Monday. */
export const AdminStatementsQuery = StatementsQuery.extend({ week: CalendarDate.optional() });
export type AdminStatementsQuery = z.infer<typeof AdminStatementsQuery>;

export const AdminStatementsResponse = z.strictObject({ statements: z.array(StatementSummary), nextBefore: z.number().int().nullable() });
export type AdminStatementsResponse = z.infer<typeof AdminStatementsResponse>;

/** `GET /v1/admin/shop-balances` (A18): each shop that owes anything, most owed first. */
export const ShopBalancesResponse = z.strictObject({
  balances: z.array(StatementBalance.extend({ shopId: z.uuid(), shopName: z.string() })),
});
export type ShopBalancesResponse = z.infer<typeof ShopBalancesResponse>;

export const StatementParams = z.strictObject({ id: z.uuid() });
export type StatementParams = z.infer<typeof StatementParams>;

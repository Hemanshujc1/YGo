import { z } from "zod";
import { BaseUnitQuantity, OpeningStockResponse } from "./shop-listings";

export const OpeningStockPayload = z.strictObject({ packId: z.uuid(), quantity: BaseUnitQuantity });
export const SyncAction = z.strictObject({
  id: z.uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), shopId: z.uuid(),
  type: z.string().min(1).max(80), payload: z.unknown(), createdAt: z.iso.datetime(), clockSuspect: z.boolean(),
});
export const SyncActionsBody = z.strictObject({
  deviceId: z.uuid(), sentAt: z.iso.datetime(), actions: z.array(SyncAction).min(1).max(500),
});
export const SyncActionCode = z.enum([
  "VALIDATION_FAILED", "NOT_FOUND", "SHOP_LISTING_NOT_READY", "OPENING_STOCK_ALREADY_RECORDED",
  "ACTION_TOO_OLD", "SEQUENCE_MISSING", "ACTION_CONFLICT",
]);
export const SyncActionResult = z.strictObject({
  actionId: z.uuid(), sequence: z.number().int().positive(), status: z.enum(["applied", "rejected", "retry"]),
  code: SyncActionCode.nullable(), result: OpeningStockResponse.nullable(), clockSuspect: z.boolean(),
}).refine((row) => row.status === "applied" ? row.code === null && row.result !== null : row.code !== null && row.result === null);
export const SyncActionsResponse = z.strictObject({ results: z.array(SyncActionResult) });
export type SyncAction = z.infer<typeof SyncAction>;
export type SyncActionsBody = z.infer<typeof SyncActionsBody>;
export type SyncActionResult = z.infer<typeof SyncActionResult>;
export type SyncActionsResponse = z.infer<typeof SyncActionsResponse>;

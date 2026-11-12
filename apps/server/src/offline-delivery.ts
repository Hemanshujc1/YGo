import type { PoolClient } from "pg";
import { DeliveryCallAttemptPayload, DeliveryCompletePayload, DeliveryFailedPayload, DeliveryProofExceptionPayload, type DeliveryActionResponse, type SyncAction, type SyncActionCode } from "@ygo/contracts";
import type { DeliveryActions, DeliveryKind } from "./delivery-actions";

export type DeliveryOutcome = { status: "applied"; result: DeliveryActionResponse } | { status: "rejected" | "retry"; code: SyncActionCode };
const kinds: Record<string, DeliveryKind | undefined> = { delivery_complete: "delivered", delivery_proof_exception: "proof_exception", delivery_failed: "failed" };

/**
 * One delivery action from the phone's queue (#616, DLV-3), run with the same rules as its online route. A refusal is kept in `offline_delivery_issues`
 * so the shop and Admin can see it: nothing is dropped, and Admin settles an order with a forced move. A photo that is to be removed once the batch commits is pushed to `cleanup`.
 */
export async function applyOfflineDelivery(client: PoolClient, actions: DeliveryActions, action: SyncAction, ctx: {
  accountId: string; now: Date; sentAt: Date; maxAgeSeconds: number; clockSuspect: boolean; photosAvailable: boolean; cleanup: { orderId: string; uploadId: string }[];
}): Promise<DeliveryOutcome> {
  const { accountId, now, clockSuspect } = ctx;
  const at = new Date(Math.min(Date.parse(action.createdAt), now.getTime()));
  const outcome = await run();
  // Only the order's own deliverer can leave an issue on it; an order that has moved on has nothing left to settle.
  if (outcome.status === "rejected" && outcome.code !== "NOT_FOUND" && outcome.code !== "ORDER_STATUS_CHANGED" && outcome.code !== "VALIDATION_FAILED") {
    const orderId = (action.payload as { orderId?: string } | null)?.orderId;
    if (orderId) await client.query(`INSERT INTO offline_delivery_issues (action_id, order_id, account_id, action, code, clock_suspect, created_at)
      SELECT $1, o.id, $3, $4, $5, $6, $7 FROM orders o WHERE o.id = $2 AND o.deliverer_id = $3 ON CONFLICT DO NOTHING`, [action.id, orderId, accountId, action.type, outcome.code, clockSuspect, now]);
  }
  return outcome;

  async function run(): Promise<DeliveryOutcome> {
    const kind = kinds[action.type];
    if (action.type === "delivery_call_attempt") {
      const body = DeliveryCallAttemptPayload.safeParse(action.payload);
      if (!body.success) return { status: "rejected", code: "VALIDATION_FAILED" };
      if (ctx.sentAt.getTime() - Date.parse(action.createdAt) > ctx.maxAgeSeconds * 1000) return { status: "rejected", code: "ACTION_TOO_OLD" };
      // A doubted clock cannot back-date the wait: the attempt counts from when the server heard of it.
      const refused = await actions.callAttempt(client, body.data.orderId, accountId, clockSuspect ? now : at);
      return refused ? { status: "rejected", code: refused } : { status: "applied", result: { orderId: body.data.orderId, status: "arrived" } };
    }
    const schema = kind === "delivered" ? DeliveryCompletePayload : kind === "proof_exception" ? DeliveryProofExceptionPayload : DeliveryFailedPayload;
    const body = kind ? schema.safeParse(action.payload) : null;
    if (!kind || !body?.success) return { status: "rejected", code: "VALIDATION_FAILED" };
    const { orderId, ...rest } = body.data;
    if (ctx.sentAt.getTime() - Date.parse(action.createdAt) > ctx.maxAgeSeconds * 1000) return { status: "rejected", code: "ACTION_TOO_OLD" };
    if (!ctx.photosAvailable) return { status: "retry", code: "UNAVAILABLE" };

    let suspect = clockSuspect;
    if (kind === "failed" && !suspect) {
      // The wait runs from the call attempt, so a doubted attempt doubts the failure too.
      const { rowCount } = await client.query(`SELECT 1 FROM sync_actions WHERE account_id = $1 AND clock_suspect AND action::jsonb ->> 'type' = 'delivery_call_attempt'
        AND action::jsonb -> 'payload' ->> 'orderId' = $2`, [accountId, orderId]);
      suspect = !!rowCount;
    }
    const checked = await actions.check(client, kind, orderId, accountId, rest, now, false, { at, clockSuspect: suspect });
    if (typeof checked === "string") return { status: "rejected", code: checked };
    const photoKey = await actions.savePhoto(orderId, accountId, rest.photoUploadId, checked.byteLength);
    if (photoKey === "UNAVAILABLE") return { status: "retry", code: "UNAVAILABLE" };
    if (photoKey === "DELIVERY_PHOTO_INVALID") return { status: "rejected", code: photoKey };
    const done = await actions.apply(client, kind, orderId, accountId, rest, photoKey, now, false);
    if (typeof done === "string") return { status: "rejected", code: done };
    ctx.cleanup.push({ orderId, uploadId: done.uploadId });
    return { status: "applied", result: { orderId, status: done.status } };
  }
}

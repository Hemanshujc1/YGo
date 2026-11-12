import type { Pool, PoolClient } from "pg";
import { DeliveryCallAttemptPayload, DeliveryCompletePayload, DeliveryFailedPayload, DeliveryProofExceptionPayload, type DeliveryActionResponse, type SyncAction, type SyncActionCode } from "@ygo/contracts";
import type { DeliveryActions, DeliveryKind } from "./delivery-actions";

/** `clockSuspect` is the effective doubt: the action's own, or one inherited from the call attempt it depends on. */
export type DeliveryOutcome = { status: "applied"; result: DeliveryActionResponse; clockSuspect: boolean } | { status: "rejected" | "retry"; code: SyncActionCode; clockSuspect: boolean };
/** A photo saved before the batch's transaction: its key, or why it could not be. */
export type PreparedPhotos = Map<string, string>;
const bodySchemas = { delivered: DeliveryCompletePayload, proof_exception: DeliveryProofExceptionPayload, failed: DeliveryFailedPayload };
const kinds: Record<string, DeliveryKind | undefined> = { delivery_complete: "delivered", delivery_proof_exception: "proof_exception", delivery_failed: "failed" };
const PHOTO_SAVE_LEASE_MS = 5 * 60_000;

/**
 * Saves the proof photos of a batch BEFORE its transaction opens, so slow storage never holds the account, shop or order locks (#616).
 * Only photos the account itself uploaded are read; a replayed or too-old action is skipped. A photo saved for an action the server then
 * refuses is left as a staged proof, which the expired-upload job removes. When storage fails, the rest of the batch is not tried
 * and those actions come back as `retry`, so the phone sends them again.
 */
export async function preparePhotos(pool: Pool, actions: DeliveryActions, list: SyncAction[], ctx: { accountId: string; now: Date; maxAgeSeconds: number }): Promise<PreparedPhotos> {
  const prepared: PreparedPhotos = new Map();
  let storageDown = false;
  for (const action of list) {
    const kind = kinds[action.type];
    const body = kind ? bodySchemas[kind].safeParse(action.payload) : null;
    if (!kind || !body?.success || ctx.now.getTime() - Date.parse(action.createdAt) > ctx.maxAgeSeconds * 1000) continue;
    const seen = await pool.query("SELECT 1 FROM sync_actions WHERE account_id = $1 AND action_id = $2", [ctx.accountId, action.id]);
    if (seen.rowCount) continue;
    if (storageDown) { prepared.set(action.id, "UNAVAILABLE"); continue; }
    const { orderId, photoUploadId } = body.data;
    // The lease keeps the expired-upload job away while the photo is read and saved.
    const { rows: [upload] } = await pool.query<{ byteLength: number }>(`UPDATE delivery_photo_uploads SET processing_until = $4
      WHERE id = $1 AND order_id = $2 AND account_id = $3 AND expires_at > $5 RETURNING byte_length AS "byteLength"`,
    [photoUploadId, orderId, ctx.accountId, new Date(ctx.now.getTime() + PHOTO_SAVE_LEASE_MS), ctx.now]);
    if (!upload) { prepared.set(action.id, "DELIVERY_PHOTO_INVALID"); continue; }
    const key = await actions.savePhoto(orderId, ctx.accountId, photoUploadId, upload.byteLength);
    if (key === "UNAVAILABLE") storageDown = true;
    prepared.set(action.id, key);
  }
  return prepared;
}
/**
 * One delivery action from the phone's queue (#616, DLV-3), run with the same rules as its online route. A refusal is kept in `offline_delivery_issues`
 * so the shop and Admin can see it: nothing is dropped, and Admin settles an order with a forced move. A photo that is to be removed once the batch commits is pushed to `cleanup`.
 */
export async function applyOfflineDelivery(client: PoolClient, actions: DeliveryActions, action: SyncAction, ctx: {
  accountId: string; now: Date; maxAgeSeconds: number; clockSuspect: boolean; prepared: PreparedPhotos; cleanup: { orderId: string; uploadId: string }[];
}): Promise<DeliveryOutcome> {
  const { accountId, now, clockSuspect } = ctx;
  const at = new Date(Math.min(Date.parse(action.createdAt), now.getTime()));
  let suspect = clockSuspect;
  const outcome = await run();
  // Only the order's own deliverer can leave an issue on it; an order that has moved on has nothing left to settle.
  if (outcome.status === "rejected" && outcome.code !== "NOT_FOUND" && outcome.code !== "ORDER_STATUS_CHANGED" && outcome.code !== "VALIDATION_FAILED") {
    const orderId = (action.payload as { orderId?: string } | null)?.orderId;
    if (orderId) await client.query(`INSERT INTO offline_delivery_issues (action_id, order_id, account_id, action, code, clock_suspect, created_at)
      SELECT $1, o.id, $3, $4, $5, $6, $7 FROM orders o WHERE o.id = $2 AND o.deliverer_id = $3 ON CONFLICT DO NOTHING`, [action.id, orderId, accountId, action.type, outcome.code, outcome.clockSuspect, now]);
  }
  return outcome;

  async function run(): Promise<DeliveryOutcome> {
    const rejected = (code: SyncActionCode, status: "rejected" | "retry" = "rejected"): DeliveryOutcome => ({ status, code, clockSuspect: suspect });
    const kind = kinds[action.type];
    if (action.type === "delivery_call_attempt") {
      const body = DeliveryCallAttemptPayload.safeParse(action.payload);
      if (!body.success) return rejected("VALIDATION_FAILED");
      if (ctx.now.getTime() - Date.parse(action.createdAt) > ctx.maxAgeSeconds * 1000) return rejected("ACTION_TOO_OLD");
      // A doubted clock cannot back-date the wait: the attempt counts from when the server heard of it.
      const refused = await actions.callAttempt(client, body.data.orderId, accountId, clockSuspect ? now : at);
      return refused ? rejected(refused) : { status: "applied", result: { orderId: body.data.orderId, status: "arrived" }, clockSuspect: suspect };
    }
    const body = kind ? bodySchemas[kind].safeParse(action.payload) : null;
    if (!kind || !body?.success) return rejected("VALIDATION_FAILED");
    const { orderId, ...rest } = body.data;
    if (ctx.now.getTime() - Date.parse(action.createdAt) > ctx.maxAgeSeconds * 1000) return rejected("ACTION_TOO_OLD");
    // The photo was saved before this transaction; storage trouble asks the phone to send the action again, with nothing recorded.
    const photoKey = ctx.prepared.get(action.id) ?? "UNAVAILABLE";
    if (photoKey === "UNAVAILABLE") return rejected("UNAVAILABLE", "retry");

    if (kind === "failed" && !suspect) {
      // The wait runs from the call attempt, so a doubted attempt doubts the failure too.
      const { rowCount } = await client.query(`SELECT 1 FROM sync_actions WHERE account_id = $1 AND clock_suspect AND action::jsonb ->> 'type' = 'delivery_call_attempt'
        AND action::jsonb -> 'payload' ->> 'orderId' = $2`, [accountId, orderId]);
      suspect = !!rowCount;
    }
    const checked = await actions.check(client, kind, orderId, accountId, rest, now, false, { at, clockSuspect: suspect });
    if (typeof checked === "string") return rejected(checked);
    // Refusals about the order and the handover code come first, as online; a photo that could not be saved is refused after them.
    if (photoKey === "DELIVERY_PHOTO_INVALID") return rejected("DELIVERY_PHOTO_INVALID");
    const done = await actions.apply(client, kind, orderId, accountId, rest, photoKey, now, false);
    if (typeof done === "string") return rejected(done);
    ctx.cleanup.push({ orderId, uploadId: done.uploadId });
    return { status: "applied", result: { orderId, status: done.status }, clockSuspect: suspect };
  }
}

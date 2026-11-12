import type { Pool, PoolClient } from "pg";
import type { CompleteDeliveryBody, FailDeliveryBody, OrderStatus, ProofExceptionBody } from "@ygo/contracts";
import { InvalidDeliveryPhotoError, type DeliveryPhotoStorage } from "./adapters/delivery-photos";
import { checkHandoverCode, ITEMS_CHECK_SECONDS, recordDeliverySale } from "./delivery";
import { moveOrder } from "./orders";

const PHOTO_SAVE_LEASE_MS = 5 * 60_000;
const PROOF_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

export type DeliveryKind = "delivered" | "proof_exception" | "failed";
type Body = CompleteDeliveryBody | ProofExceptionBody | FailDeliveryBody;
/** A delivery made offline (#616): when the phone made it, and whether that time is doubted. The wait for a failed delivery is then measured on the phone's own times. */
export type Offline = { at: Date; clockSuspect: boolean };
type Refusal = "NOT_FOUND" | "ORDER_STATUS_CHANGED" | "ITEM_CHECK_WAIT" | "DELIVERY_PHOTO_INVALID" | "PROOF_EXCEPTION_CALL_REQUIRED" | "DELIVERY_FAILURE_CALL_REQUIRED"
  | "DELIVERY_FAILURE_WAIT" | "DELIVERY_CLOCK_SUSPECT" | "HANDOVER_CODE_WRONG" | "HANDOVER_CODE_LOCKED";

/**
 * The deliverer's actions at the door, shared by the online routes and the offline sync (#616) so one set of rules decides both.
 * Each one runs in two steps with the photo read and saved between them, so no order row stays locked while storage is slow.
 * `commit` is true for the routes, which end each step with COMMIT; the sync batch keeps one transaction and commits once.
 */
export function deliveryActions({ secret, photos, failureWaitSeconds, photoSaveTimeoutMs }: { secret: string; photos?: DeliveryPhotoStorage; failureWaitSeconds: number; photoSaveTimeoutMs: number }) {
  /** Locks the arrived order of this deliverer and the upload they chose, for the second step. */
  async function lockArrived(client: PoolClient, orderId: string, accountId: string, uploadId: string, now: Date) {
    const { rows: [order] } = await client.query<{ status: OrderStatus; role: "owner" | "staff" }>(
      `SELECT o.status, m.role FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
       WHERE o.id = $1 AND o.deliverer_id = $2 AND m.account_id = $2 FOR UPDATE OF o`, [orderId, accountId]);
    if (!order) return "NOT_FOUND" as const;
    if (order.status !== "arrived") return "ORDER_STATUS_CHANGED" as const;
    const upload = await client.query("SELECT 1 FROM delivery_photo_uploads WHERE id = $1 AND order_id = $2 AND account_id = $3 AND expires_at > $4 FOR UPDATE", [uploadId, orderId, accountId, now]);
    if (!upload.rowCount) return "DELIVERY_PHOTO_INVALID" as const;
    return order;
  }

  return {
    /** Removes a used upload's file and row; when either step fails the row stays and the cleanup job retries it. */
    async removeUpload(db: Pool, orderId: string, accountId: string, uploadId: string) {
      if (!photos) return;
      try {
        await photos.deleteUpload(orderId, accountId, uploadId);
        await db.query("DELETE FROM delivery_photo_uploads WHERE id = $1", [uploadId]);
      } catch { /* kept for the cleanup job */ }
    },

    /** Records the first call attempt at `at`; a later one changes nothing. */
    async callAttempt(client: PoolClient, id: string, accountId: string, at: Date): Promise<Refusal | undefined> {
      const { rows: [order] } = await client.query<{ status: OrderStatus }>(
        `SELECT o.status FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id
         WHERE o.id = $1 AND o.deliverer_id = $2 AND m.account_id = $2 FOR UPDATE OF o`, [id, accountId]);
      if (!order) return "NOT_FOUND";
      if (order.status !== "arrived") return "ORDER_STATUS_CHANGED";
      await client.query("UPDATE orders SET delivery_call_attempt_at = COALESCE(delivery_call_attempt_at, $2) WHERE id = $1", [id, at]);
      return undefined;
    },

    /** Step 1: the checks, then the hold on the photo upload. Returns the refusal, or the photo's size. */
    async check(client: PoolClient, kind: DeliveryKind, id: string, accountId: string, body: Body, now: Date, commit: boolean, offline?: Offline): Promise<Refusal | { byteLength: number }> {
      const { rows: [order] } = await client.query<{ id: string; status: OrderStatus; statusChangedAt: Date; handoverCodeHash: string | null; handoverCodeSalt: string | null; handoverCodeAttempts: number; handoverCodeBlockedUntil: Date | null; itemsCheckedAt: Date | null; callAttemptAt: Date | null }>(
        `SELECT o.id, o.status, o.status_changed_at AS "statusChangedAt", o.handover_code_hash AS "handoverCodeHash", o.handover_code_salt AS "handoverCodeSalt",
          o.handover_code_attempts AS "handoverCodeAttempts", o.handover_code_blocked_until AS "handoverCodeBlockedUntil", o.items_checked_at AS "itemsCheckedAt",
          o.delivery_call_attempt_at AS "callAttemptAt"
         FROM orders o JOIN shop_members m ON m.shop_id = o.shop_id AND m.account_id = $2
         WHERE o.id = $1 AND o.deliverer_id = $2 FOR UPDATE OF o`, [id, accountId]);
      if (!order) return "NOT_FOUND";
      if (order.status !== "arrived") return "ORDER_STATUS_CHANGED";
      if (kind === "failed") {
        if (!order.callAttemptAt) return "DELIVERY_FAILURE_CALL_REQUIRED";
        // Offline, a doubted clock never finalises a failed delivery: the goods go back into stock, so Admin looks at it first.
        if (offline?.clockSuspect) return "DELIVERY_CLOCK_SUSPECT";
        if ((offline?.at ?? now).getTime() < order.callAttemptAt.getTime() + failureWaitSeconds * 1000) return "DELIVERY_FAILURE_WAIT";
      } else if (!order.itemsCheckedAt && now.getTime() < order.statusChangedAt.getTime() + ITEMS_CHECK_SECONDS * 1000) return "ITEM_CHECK_WAIT";
      const { rows: [upload] } = await client.query<{ byteLength: number; expiresAt: Date }>(
        `SELECT byte_length AS "byteLength", expires_at AS "expiresAt" FROM delivery_photo_uploads
         WHERE id = $1 AND order_id = $2 AND account_id = $3`, [body.photoUploadId, id, accountId]);
      if (!upload || upload.expiresAt <= now) return "DELIVERY_PHOTO_INVALID";
      if (kind === "proof_exception") {
        // A deliverer who cannot get the code must have tried to reach the Customer first (no wait, unlike a failed delivery).
        if (!order.callAttemptAt) return "PROOF_EXCEPTION_CALL_REQUIRED";
      } else if (kind === "delivered") {
        const refusal = await checkHandoverCode(client, order, (body as CompleteDeliveryBody).handoverCode, now, secret, commit);
        if (refusal) return refusal;
      }
      const leased = await client.query("UPDATE delivery_photo_uploads SET processing_until = $2 WHERE id = $1", [body.photoUploadId, new Date(now.getTime() + PHOTO_SAVE_LEASE_MS)]);
      if (leased.rowCount !== 1) return "DELIVERY_PHOTO_INVALID";
      if (commit) await client.query("COMMIT");
      return { byteLength: upload.byteLength };
    },

    /** Reads, transcodes and stores the photo; a save stopped by the timeout is awaited, so cleanup never meets one in progress. */
    async savePhoto(orderId: string, accountId: string, uploadId: string, byteLength: number): Promise<string | "UNAVAILABLE" | "DELIVERY_PHOTO_INVALID"> {
      if (!photos) return "UNAVAILABLE";
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), photoSaveTimeoutMs);
      try { return await photos.save(orderId, accountId, uploadId, byteLength, stop.signal); }
      catch (error) {
        if (error instanceof InvalidDeliveryPhotoError || (error as { name?: string }).name === "NoSuchKey") return "DELIVERY_PHOTO_INVALID";
        return "UNAVAILABLE";
      } finally { clearTimeout(timer); }
    },

    /** Step 2: moves the order and records what was done. */
    async apply(client: PoolClient, kind: DeliveryKind, id: string, accountId: string, body: Body, photoKey: string, now: Date, commit: boolean): Promise<Refusal | { status: OrderStatus; uploadId: string }> {
      const order = await lockArrived(client, id, accountId, body.photoUploadId, now);
      if (typeof order === "string") return order;
      const actor = { id: accountId, role: order.role };
      const kept = new Date(now.getTime() + PROOF_KEPT_MS);
      if (kind === "failed") {
        if (!await moveOrder(client, { id, status: order.status }, "delivery_failed", actor, now, (body as FailDeliveryBody).reason)) return "ORDER_STATUS_CHANGED";
        await client.query("UPDATE orders SET delivery_photo_key = $2, delivery_photo_expires_at = $3, failed_delivery_reason = $4 WHERE id = $1", [id, photoKey, kept, (body as FailDeliveryBody).reason]);
      } else {
        if (!await moveOrder(client, { id, status: order.status }, "delivered", actor, now)) return "ORDER_STATUS_CHANGED";
        await client.query(`UPDATE orders SET delivery_photo_key = $2, delivery_photo_expires_at = $3, delivery_payment = $4, proof_exception = $5,
          proof_exception_reason = $6, handover_code_attempts = 0, handover_code_blocked_until = NULL WHERE id = $1`,
        [id, photoKey, kept, (body as CompleteDeliveryBody).payment, kind === "proof_exception", kind === "proof_exception" ? (body as ProofExceptionBody).reason : null]);
        await recordDeliverySale(client, id, accountId, now);
      }
      if (commit) await client.query("COMMIT");
      return { status: kind === "failed" ? "delivery_failed" : "delivered", uploadId: body.photoUploadId };
    },
  };
}
export type DeliveryActions = ReturnType<typeof deliveryActions>;

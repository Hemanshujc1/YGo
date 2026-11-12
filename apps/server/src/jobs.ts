import { and, desc, eq, isNotNull, lt, lte, ne, notInArray, or } from "drizzle-orm";
import type { Clock } from "./adapters/clock";
import type { DeliveryPhotoStorage } from "./adapters/delivery-photos";
import { withTransaction, type Database } from "./db";
import { expireUnansweredOrders } from "./order-expiry";
import { expireUnconfirmedOrders } from "./order-confirm-expiry";
import { expireUncollectedPickups } from "./pickup-expiry";
import { reconcileStock } from "./stock-reconciliation";
import { jobRuns, refreshTokens, sessions } from "./schema";
import { REFRESH_TTL_MS } from "./tokens";

export const jobMaxAgeHours = {
  "backup-nightly": 26,
  "cleanup-sessions": 26,
  "expire-confirmations": 0.25,
  "expire-orders": 0.25,
  "expire-pickups": 0.25,
  "reconcile-stock": 26,
  "snapshot-weekly": 8 * 24,
} as const;
// Run history kept by cleanup-sessions (#520): the every-minute expire-orders job writes ~1,440 rows a day.
export const JOB_RUN_OK_KEEP_DAYS = 30;
export const JOB_RUN_FAILED_KEEP_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
export type JobName = keyof typeof jobMaxAgeHours;

export async function cleanupDeliveryProofs(database: Database, clock: Clock, photos: DeliveryPhotoStorage): Promise<void> {
  const { rows } = await database.pool.query<{ id: string; key: string }>(
    `SELECT id, delivery_photo_key AS key FROM orders
     WHERE delivery_photo_key IS NOT NULL AND delivery_photo_expires_at <= $1`, [clock.now()]);
  for (const order of rows) {
    try {
      await photos.deleteProof(order.key);
      await database.pool.query(`UPDATE orders SET delivery_photo_key = NULL, delivery_photo_expires_at = NULL
        WHERE id = $1 AND delivery_photo_key = $2`, [order.id, order.key]);
    } catch {
      // Keep the key when storage or the database is unavailable; the next job retries it.
    }
  }
}

export async function cleanupDeliveryUploads(database: Database, clock: Clock, photos: DeliveryPhotoStorage): Promise<void> {
  const { rows } = await database.pool.query<{ id: string }>("SELECT id FROM delivery_photo_uploads WHERE expires_at <= $1 AND (processing_until IS NULL OR processing_until <= $1)", [clock.now()]);
  for (const { id } of rows) {
    // One transaction per upload, so the row lock lasts through the storage deletes and a delivery
    // saving this photo at the same moment waits for it.
    try {
      await withTransaction(database.pool, async (client) => {
        const { rows: [upload] } = await client.query<{ orderId: string; accountId: string }>(
          `SELECT order_id AS "orderId", account_id AS "accountId" FROM delivery_photo_uploads WHERE id = $1 AND expires_at <= $2 AND (processing_until IS NULL OR processing_until <= $2) FOR UPDATE SKIP LOCKED`, [id, clock.now()]);
        if (!upload) return;
        const stagedKey = `delivery-proofs/${upload.orderId}/${id}.jpg`;
        const referenced = await client.query("SELECT 1 FROM orders WHERE delivery_photo_key = $1 LIMIT 1", [stagedKey]);
        if (!referenced.rowCount) await photos.deleteStagedProof(upload.orderId, id);
        await photos.deleteUpload(upload.orderId, upload.accountId, id);
        await client.query("DELETE FROM delivery_photo_uploads WHERE id = $1", [id]);
        await client.query("COMMIT");
      });
    } catch {
      // Keep this upload row until both storage deletes and row cleanup succeed.
    }
  }
}

export function isJobName(name: string): name is JobName {
  return Object.hasOwn(jobMaxAgeHours, name);
}

// Deletes old job_runs rows. Per job it always keeps the latest finished row and the latest ok row,
// whatever their age: job-check.ts reads exactly those two. A running row only goes once it is
// older than the ok limit (a crashed run); a recent one may still be running.
export async function deleteOldJobRuns(database: Database, now: Date): Promise<void> {
  const okBefore = new Date(now.getTime() - JOB_RUN_OK_KEEP_DAYS * DAY_MS);
  const failedBefore = new Date(now.getTime() - JOB_RUN_FAILED_KEEP_DAYS * DAY_MS);
  await database.db.transaction(async (tx) => {
    for (const name of Object.keys(jobMaxAgeHours)) {
      const [latest] = await tx.select({ id: jobRuns.id }).from(jobRuns)
        .where(and(eq(jobRuns.jobName, name), ne(jobRuns.status, "running")))
        .orderBy(desc(jobRuns.finishedAt)).limit(1);
      const [success] = await tx.select({ id: jobRuns.id }).from(jobRuns)
        .where(and(eq(jobRuns.jobName, name), eq(jobRuns.status, "ok")))
        .orderBy(desc(jobRuns.finishedAt)).limit(1);
      const keep = [latest?.id, success?.id].filter((id): id is string => id !== undefined);
      await tx.delete(jobRuns).where(and(
        eq(jobRuns.jobName, name),
        keep.length > 0 ? notInArray(jobRuns.id, keep) : undefined,
        or(
          and(eq(jobRuns.status, "ok"), lt(jobRuns.finishedAt, okBefore)),
          and(eq(jobRuns.status, "failed"), lt(jobRuns.finishedAt, failedBefore)),
          and(eq(jobRuns.status, "running"), lt(jobRuns.startedAt, okBefore)),
        ),
      ));
    }
  });
}

export async function runJob(
  database: Database, name: string, clock: Clock,
  backupNightly?: () => Promise<void>,
  snapshotWeekly?: () => Promise<void>,
  deliveryPhotos?: DeliveryPhotoStorage,
): Promise<void> {
  if (!isJobName(name)) throw new Error("Unknown job name");
  const now = clock.now();
  const [run] = await database.db.insert(jobRuns).values({
    jobName: name,
    startedAt: now,
    status: "running",
  }).returning({ id: jobRuns.id });
  if (!run) throw new Error("Could not record job start");

  let detail: string | null = null;
  try {
    if (name === "backup-nightly") {
      if (!backupNightly) throw new Error("Backup runner is missing");
      await backupNightly();
    } else if (name === "snapshot-weekly") {
      if (!snapshotWeekly) throw new Error("Snapshot runner is missing");
      await snapshotWeekly();
    } else if (name === "expire-orders") {
      await expireUnansweredOrders(database.pool, clock);
    } else if (name === "expire-confirmations") {
      await expireUnconfirmedOrders(database.pool, clock);
    } else if (name === "expire-pickups") {
      await expireUncollectedPickups(database.pool, clock);
    } else if (name === "reconcile-stock") {
      // Report only (#67): the differences it found are rows in stock_reconciliation_issues, never a change to stock.
      const differing = await reconcileStock(database.pool, clock);
      detail = differing === 0 ? "no differences found" : `${differing} ${differing === 1 ? "listing differs" : "listings differ"}`;
    } else {
      await database.db.transaction(async (tx) => {
        // ON DELETE CASCADE removes every refresh token of an expired session.
        await tx.delete(sessions).where(lte(sessions.expiresAt, now));
        await tx.delete(refreshTokens).where(and(
          isNotNull(refreshTokens.replacedAt),
          lt(refreshTokens.replacedAt, new Date(now.getTime() - REFRESH_TTL_MS)),
        ));
      });
      if (deliveryPhotos) {
        await cleanupDeliveryUploads(database, clock, deliveryPhotos);
        await cleanupDeliveryProofs(database, clock, deliveryPhotos);
      }
      // Its own transaction after the session cleanup, so a failure here cannot undo that work.
      await deleteOldJobRuns(database, now);
    }
    await database.db.update(jobRuns).set({ status: "ok", finishedAt: clock.now(), detail })
      .where(eq(jobRuns.id, run.id));
  } catch (error) {
    await database.db.update(jobRuns).set({
      status: "failed",
      finishedAt: clock.now(),
      errorText: name === "backup-nightly" ? "backup failed" : name === "snapshot-weekly" ? "snapshot failed" :
        name === "expire-orders" ? "expiry failed" : name === "expire-confirmations" ? "confirmation expiry failed" : name === "expire-pickups" ? "pickup expiry failed" : name === "reconcile-stock" ? "reconcile failed" : "cleanup failed",
    }).where(eq(jobRuns.id, run.id));
    throw error;
  }
}

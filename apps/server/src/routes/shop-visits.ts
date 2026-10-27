import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  CreateVisitPhotoUploadBody, ErrorEnvelope, OnboardingFee, RecordOnboardingFeeBody,
  RecordShopVisitBody, ShopApplicationParams, ShopOnboarding, ShopVisit, ShopVisitParams,
  VisitPhotoAccess, VisitPhotoUpload,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { InvalidVisitPhotoError, VisitPhotoLocationMissingError, type VisitPhotoStorage } from "../adapters/visit-photos";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { deriveKeys } from "../tokens";

const visitsSql = `SELECT v.id, to_char(v.visit_date, 'YYYY-MM-DD') AS "visitDate",
  to_char(v.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",
  v.actor_id AS "actorId", json_build_object('pan', v.pan, 'fssai', v.fssai,
    'ownerPhone', v.owner_phone, 'ownerEmail', v.owner_email,
    'alarmPermission', v.alarm_permission, 'testerOptIn', v.tester_opt_in) AS checks, v.notes,
  CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'latitude', p.latitude,
    'longitude', p.longitude, 'capturedAt', p.captured_at) END AS photo
  FROM shop_visits v LEFT JOIN visit_photos p ON p.visit_id = v.id`;
const feesSql = `SELECT id, actor_id AS "actorId",
  to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt",
  status, amount::text, to_char(payment_date, 'YYYY-MM-DD') AS "paymentDate", reference, reason
  FROM onboarding_fees`;
function fee(row: OnboardingFee): OnboardingFee {
  if (row.status === "waived") return { id: row.id, actorId: row.actorId, recordedAt: row.recordedAt, status: row.status, reason: row.reason };
  return row;
}

/** Lock the sent shop before its owner, matching the existing shop write order. */
async function shop(client: PoolClient, id: string) {
  const found = await client.query("SELECT 1 FROM shops WHERE id = $1 AND state <> 'draft' FOR UPDATE", [id]);
  return Boolean(found.rowCount);
}

export function registerShopVisitRoutes(app: FastifyInstance, { pool, clock, secret, photos }: {
  pool: Pool; clock: Clock; secret: string; photos?: VisitPhotoStorage;
}): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 503: ErrorEnvelope };
  const base = "/v1/admin/shop-applications/:id";

  app.post(`${base}/visit-photo-upload`, { schema: { params: ShopApplicationParams, body: CreateVisitPhotoUploadBody, response: { 201: VisitPhotoUpload, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const body = request.body as CreateVisitPhotoUploadBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      if (!await shop(client, id)) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (!photos) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
      const expiresAt = new Date(clock.now().getTime() + 15 * 60_000);
      let upload: VisitPhotoUpload;
      try { upload = await photos.createUpload(body); }
      catch { return reply.code(503).send({ error: { code: "UNAVAILABLE" } }); }
      await client.query("INSERT INTO visit_photo_uploads (id, shop_id, actor_id, byte_length, expires_at) VALUES ($1, $2, $3, $4, $5)",
        [upload.id, id, who.accountId, body.byteLength, expiresAt]);
      await client.query("COMMIT");
      return reply.code(201).send(upload);
    });
  });

  app.post(`${base}/visits`, { schema: { params: ShopApplicationParams, body: RecordShopVisitBody, response: { 201: ShopVisit, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const body = request.body as RecordShopVisitBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      if (!await shop(client, id)) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      const pending = await client.query<{ byte_length: number; expires_at: Date }>(
        "SELECT byte_length, expires_at FROM visit_photo_uploads WHERE id = $1 AND shop_id = $2 AND actor_id = $3 FOR UPDATE",
        [body.photoUploadId, id, who.accountId]);
      const upload = pending.rows[0];
      if (!upload || upload.expires_at <= clock.now()) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["photo"] } });
      const owner = await client.query<{ id: string; phone: string | null }>(`SELECT a.id, a.phone FROM accounts a
        JOIN shop_members m ON m.account_id = a.id WHERE m.shop_id = $1 AND m.role = 'owner' FOR NO KEY UPDATE OF a`, [id]);
      const account = owner.rows[0];
      if (!account?.phone) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["checks.ownerPhone"] } });
      if (!photos) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
      let photo: Awaited<ReturnType<VisitPhotoStorage["validate"]>>;
      try { photo = await photos.validate(body.photoUploadId, upload.byte_length); }
      catch (error) {
        if (error instanceof VisitPhotoLocationMissingError) return reply.code(400).send({ error: { code: "VISIT_PHOTO_LOCATION_MISSING" } });
        if (error instanceof InvalidVisitPhotoError || (error as { name?: string }).name === "NoSuchKey") {
          return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["photo"] } });
        }
        return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
      }
      const now = clock.now();
      // Recheck after storage I/O; an upload that expired while being read cannot be consumed.
      if (upload.expires_at <= now) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["photo"] } });
      const inserted = await client.query<{ id: string }>(`INSERT INTO shop_visits
        (shop_id, actor_id, visit_date, recorded_at, pan, fssai, owner_phone, owner_email, alarm_permission, tester_opt_in, notes)
        VALUES ($1, $2, $3, $4, true, true, true, true, true, true, $5) RETURNING id`,
        [id, who.accountId, body.visitDate, now, body.notes ?? null]);
      const visitId = inserted.rows[0]?.id;
      if (!visitId) throw new Error("Visit insert returned no ID");
      await client.query(`INSERT INTO visit_photos (id, visit_id, object_key, latitude, longitude, captured_at)
        VALUES ($1, $2, $3, $4, $5, $6)`, [body.photoUploadId, visitId, photo.key, photo.latitude, photo.longitude, photo.capturedAt]);
      await client.query("UPDATE accounts SET phone_visit_confirmed_at = $1, email_visit_confirmed_at = $1 WHERE id = $2", [now, account.id]);
      await client.query("DELETE FROM visit_photo_uploads WHERE id = $1", [body.photoUploadId]);
      await client.query(`INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason)
        VALUES ($1, 'shop.visit', $2, 'shop', 'Recorded in-person visit')`, [who.accountId, id]);
      const saved = await client.query<ShopVisit>(`${visitsSql} WHERE v.id = $1`, [visitId]);
      await client.query("COMMIT");
      return reply.code(201).send(saved.rows[0]);
    });
  });

  app.get(`${base}/visits/:visitId/photo`, { schema: { params: ShopVisitParams, response: { 200: VisitPhotoAccess, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id, visitId } = request.params as { id: string; visitId: string };
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      if (!await shop(client, id)) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      const result = await client.query<{ object_key: string }>(`SELECT p.object_key FROM visit_photos p
        JOIN shop_visits v ON v.id = p.visit_id WHERE v.shop_id = $1 AND v.id = $2 FOR SHARE OF p`, [id, visitId]);
      const photo = result.rows[0];
      if (!photo) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (!photos) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
      try { return { downloadUrl: await photos.downloadUrl(photo.object_key) }; }
      catch { return reply.code(503).send({ error: { code: "UNAVAILABLE" } }); }
    });
  });

  app.post(`${base}/onboarding-fees`, { schema: { params: ShopApplicationParams, body: RecordOnboardingFeeBody, response: { 201: OnboardingFee, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const body = request.body as RecordOnboardingFeeBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      if (!await shop(client, id)) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (!body.reason && (await client.query("SELECT 1 FROM onboarding_fees WHERE shop_id = $1 LIMIT 1", [id])).rowCount) {
        return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["reason"] } });
      }
      const inserted = await client.query<{ id: string }>(`INSERT INTO onboarding_fees
        (shop_id, actor_id, recorded_at, status, amount, payment_date, reference, reason)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, [id, who.accountId, clock.now(), body.status,
        body.status === "paid" ? body.amount : null, body.status === "paid" ? body.paymentDate : null,
        body.status === "paid" ? body.reference : null, body.reason ?? null]);
      await client.query(`INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason)
        VALUES ($1, 'shop.onboarding_fee', $2, 'shop', $3)`, [who.accountId, id, body.reason ?? "Recorded onboarding fee payment"]);
      const saved = await client.query<OnboardingFee>(`${feesSql} WHERE id = $1`, [inserted.rows[0]?.id]);
      const row = saved.rows[0];
      if (!row) throw new Error("Fee insert returned no record");
      await client.query("COMMIT");
      return reply.code(201).send(fee(row));
    });
  });

  app.get(`${base}/onboarding`, { schema: { params: ShopApplicationParams, response: { 200: ShopOnboarding, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const { id } = request.params as { id: string };
    const owner = await pool.query<{ phone_verified: boolean; phone_visit_confirmed_at: Date | null; email_visit_confirmed_at: Date | null }>(
      `SELECT a.phone_verified, a.phone_visit_confirmed_at, a.email_visit_confirmed_at FROM shops s
       JOIN shop_members m ON m.shop_id = s.id AND m.role = 'owner' JOIN accounts a ON a.id = m.account_id
       WHERE s.id = $1 AND s.state <> 'draft'`, [id]);
    const account = owner.rows[0];
    if (!account) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    const visits = await pool.query<ShopVisit>(`${visitsSql} WHERE v.shop_id = $1 ORDER BY v.recorded_at DESC, v.id DESC`, [id]);
    const fees = await pool.query<OnboardingFee>(`${feesSql} WHERE shop_id = $1 ORDER BY recorded_at DESC, id DESC`, [id]);
    return { visits: visits.rows, fees: fees.rows.map(fee), ownerPhoneState: account.phone_verified ? "sms_verified" : account.phone_visit_confirmed_at ? "visit_confirmed" : "unverified",
      ownerEmailConfirmedAt: account.email_visit_confirmed_at?.toISOString() ?? null };
  });
}

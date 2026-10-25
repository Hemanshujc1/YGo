import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  CorrectShopApplicationBody,
  ErrorEnvelope,
  MyShopApplicationResponse,
  SaveShopApplicationBody,
  SendShopApplicationBody,
  ShopApplication,
  ShopApplicationParams,
  ShopApplicationsResponse,
  type AddressPoint,
  type ShopApplicationField,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { withTransaction } from "../db";
import { pointFrom, pointJson } from "../points";
import { deriveKeys, mobileSignedIn } from "../tokens";

/**
 * Reads an application with the Owner's phone and email, and once sent, the
 * Area now holding its pincode: it follows an Admin Area edit (owner decision
 * on #280). A pincode later dropped from every Area reads as no Area.
 */
const applicationSql = `SELECT s.id, s.state, s.shop_name AS "shopName", s.address, s.pincode,
  ${pointJson("s.location")} AS location, s.owner_name AS "ownerName", s.entity_type AS "entityType", s.pan, s.fssai_number AS "fssaiNumber",
  to_char(s.fssai_expiry, 'YYYY-MM-DD') AS "fssaiExpiry", s.service_radius_metres AS "serviceRadiusMetres",
  s.upi_id AS "upiId", ar.name AS "areaName", a.phone AS "ownerPhone", a.email AS "ownerEmail",
  s.submitted_at AS "submittedAt"
  FROM shops s
  JOIN shop_members m ON m.shop_id = s.id AND m.role = 'owner'
  JOIN accounts a ON a.id = m.account_id
  LEFT JOIN area_pincodes p ON p.pincode = s.pincode AND s.state <> 'draft'
  LEFT JOIN areas ar ON ar.id = p.area_id`;

type ApplicationRow = Omit<ShopApplication, "submittedAt"> & { submittedAt: Date | null };

function fromRow(row: ApplicationRow): ShopApplication {
  return { ...row, submittedAt: row.submittedAt?.toISOString() ?? null };
}

/**
 * The application whose `column` (`s.id` or the Owner's `m.account_id`) is
 * `value`, or null; `lock` locks the shop's row for a change.
 */
async function application(client: Pool | PoolClient, column: "s.id" | "m.account_id", value: string, lock = false): Promise<ShopApplication | null> {
  const row = await client.query<ApplicationRow>(`${applicationSql} WHERE ${column} = $1${lock ? " FOR UPDATE OF s" : ""}`, [value]);
  return row.rows[0] ? fromRow(row.rows[0]) : null;
}

/**
 * Whether an Area holds `pincode`. A paused Area still counts: it keeps its pincodes (#214).
 * Waits out an Admin Area save, so a pincode it removes can't be sent or
 * corrected into; plain reads don't wait.
 */
async function inArea(client: PoolClient, pincode: string): Promise<boolean> {
  await client.query("LOCK TABLE area_pincodes IN SHARE MODE");
  return Boolean((await client.query("SELECT 1 FROM area_pincodes WHERE pincode = $1", [pincode])).rowCount);
}

const columns: Record<Exclude<ShopApplicationField, "location">, string> = {
  shopName: "shop_name",
  address: "address",
  pincode: "pincode",
  ownerName: "owner_name",
  entityType: "entity_type",
  pan: "pan",
  fssaiNumber: "fssai_number",
  fssaiExpiry: "fssai_expiry",
  serviceRadiusMetres: "service_radius_metres",
  upiId: "upi_id",
};

/** Whether a corrected `value` equals the stored one; a location by its latitude and longitude. */
function unchanged(field: string, value: unknown, stored: unknown): boolean {
  if (field !== "location") return value === stored;
  const point = value as AddressPoint;
  const was = stored as AddressPoint | null;
  return was !== null && point.latitude === was.latitude && point.longitude === was.longitude;
}

/** The `SET` list and values for each field given; `null` empties one. */
function assignments(body: SaveShopApplicationBody): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (field === "location") {
      const point = value as AddressPoint | null;
      values.push(point?.latitude ?? null, point?.longitude ?? null);
      sets.push(`location = ${pointFrom(`$${values.length - 1}`, `$${values.length}`)}`);
    } else {
      values.push(value);
      sets.push(`${columns[field as keyof typeof columns]} = $${values.length}`);
    }
  }
  return { sets, values };
}

export function registerShopRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  /** Locks the Owner's shop for a change; answers its id and state, or nothing before Start. */
  async function ownShop(client: PoolClient, accountId: string) {
    const row = await client.query<{ id: string; state: string }>(
      `SELECT s.id, s.state FROM shops s JOIN shop_members m ON m.shop_id = s.id
       WHERE m.account_id = $1 AND m.role = 'owner' FOR UPDATE OF s`,
      [accountId],
    );
    return row.rows[0];
  }

  app.get("/v1/me/shop-application", { schema: { response: { 200: MyShopApplicationResponse, ...response } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    return { application: await application(pool, "m.account_id", who.accountId) };
  });

  // Start creates the Draft and makes the account its Owner, in one go (ACC-5).
  app.post("/v1/me/shop-application", { schema: { response: { 201: ShopApplication, ...response } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    return withTransaction(pool, async (client) => {
      // One start at a time per account, so two can't both pass the check below.
      const account = await client.query<{ name: string | null; phone: string | null }>(
        "SELECT name, phone FROM accounts WHERE id = $1 FOR NO KEY UPDATE",
        [who.accountId],
      );
      const { name, phone } = account.rows[0] ?? {};
      if (!name || !phone) return reply.code(403).send({ error: { code: "PROFILE_REQUIRED" } });
      const linked = await client.query("SELECT 1 FROM shop_members WHERE account_id = $1", [who.accountId]);
      if (linked.rowCount) return reply.code(409).send({ error: { code: "SHOP_APPLICATION_EXISTS" } });
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO shops (owner_name, created_at) VALUES ($1, $2) RETURNING id",
        [name, clock.now()],
      );
      const shopId = inserted.rows[0]?.id;
      if (!shopId) throw new Error("Shop insert returned no ID");
      await client.query("INSERT INTO shop_members (account_id, shop_id, role) VALUES ($1, $2, 'owner')", [who.accountId, shopId]);
      const saved = await application(client, "s.id", shopId);
      await client.query("COMMIT");
      return reply.code(201).send(saved);
    });
  });

  // Save draft takes any valid pincode; only Send checks its Area (owner decision on #275).
  app.patch("/v1/me/shop-application", { schema: { body: SaveShopApplicationBody, response: { 200: ShopApplication, ...response } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const { sets, values } = assignments(request.body as SaveShopApplicationBody);
    return withTransaction(pool, async (client) => {
      const shop = await ownShop(client, who.accountId);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "draft") return reply.code(409).send({ error: { code: "SHOP_APPLICATION_SENT" } });
      if (sets.length) {
        await client.query(`UPDATE shops SET ${sets.join(", ")} WHERE id = $${values.length + 1}`, [...values, shop.id]);
      }
      const saved = await application(client, "s.id", shop.id);
      await client.query("COMMIT");
      return reply.code(200).send(saved);
    });
  });

  // Send saves every field and submits in one transaction (owner decision on #278).
  app.post("/v1/me/shop-application/send", { schema: { body: SendShopApplicationBody, response: { 200: ShopApplication, ...response } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const body = request.body as SendShopApplicationBody;
    const { sets, values } = assignments(body);
    return withTransaction(pool, async (client) => {
      const shop = await ownShop(client, who.accountId);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "draft") return reply.code(409).send({ error: { code: "SHOP_APPLICATION_SENT" } });
      if (!await inArea(client, body.pincode)) return reply.code(409).send({ error: { code: "PINCODE_NOT_IN_AREA" } });
      const next = values.length + 1;
      await client.query(
        `UPDATE shops SET ${sets.join(", ")}, state = 'submitted', submitted_at = $${next} WHERE id = $${next + 1}`,
        [...values, clock.now(), shop.id],
      );
      const saved = await application(client, "s.id", shop.id);
      await client.query("COMMIT");
      return reply.code(200).send(saved);
    });
  });

  // Admin sees only sent applications: a Draft answers NOT_FOUND (owner decision on #280).
  app.get("/v1/admin/shop-applications", { schema: { response: { 200: ShopApplicationsResponse, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const rows = await pool.query<ApplicationRow>(`${applicationSql} WHERE s.state <> 'draft' ORDER BY s.submitted_at, s.id`);
    return { applications: rows.rows.map(fromRow) };
  });

  app.get("/v1/admin/shop-applications/:id", { schema: { params: ShopApplicationParams, response: { 200: ShopApplication, ...response } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const found = await application(pool, "s.id", (request.params as { id: string }).id);
    if (!found || found.state === "draft") return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    return found;
  });

  // Each changed field is logged by name with the reason, never its values (Q5 on #40).
  app.patch("/v1/admin/shop-applications/:id", { schema: { params: ShopApplicationParams, body: CorrectShopApplicationBody, response: { 200: ShopApplication, ...response } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { id } = request.params as { id: string };
    const { reason, ...fields } = request.body as CorrectShopApplicationBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const old = await application(client, "s.id", id, true);
      if (!old || old.state === "draft") return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      // Compared after the contract's clean-up, so "abcde1234f" for "ABCDE1234F" is no change.
      const changed = Object.fromEntries(Object.entries(fields).filter(
        ([field, value]) => value !== undefined && !unchanged(field, value, old[field as ShopApplicationField]),
      )) as SaveShopApplicationBody;
      const names = Object.keys(changed).map((field) => field === "location" ? "location" : columns[field as keyof typeof columns]);
      // A correction that changes nothing writes no record (as on #213).
      if (!names.length) return reply.code(200).send(old);
      // A corrected pincode must be in an Area; the shop then reads as in it (owner decision on #275).
      if (changed.pincode && !await inArea(client, changed.pincode)) return reply.code(409).send({ error: { code: "PINCODE_NOT_IN_AREA" } });
      const { sets, values } = assignments(changed);
      await client.query(`UPDATE shops SET ${sets.join(", ")} WHERE id = $${values.length + 1}`, [...values, id]);
      await client.query(
        `INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason)
         SELECT $1, 'shop.correct.' || field, $2, 'shop', $3 FROM unnest($4::text[]) AS field`,
        [who.accountId, id, reason, names],
      );
      const saved = await application(client, "s.id", id);
      await client.query("COMMIT");
      return reply.code(200).send(saved);
    });
  });

  // Admin moves each step by a click, with a fixed reason; opening it moves nothing (Q3 on #40).
  for (const [path, from, to, action, reason] of [
    ["start-review", "submitted", "under_review", "shop.start_review", "Started review"],
    ["approve", "under_review", "approved", "shop.approve", "Approved"],
  ] as const) {
    app.post(`/v1/admin/shop-applications/:id/${path}`, { schema: { params: ShopApplicationParams, response: { 200: ShopApplication, ...response } } }, async (request, reply) => {
      const who = await adminSignedIn(request, reply, auth);
      if (!who) return reply;
      const { id } = request.params as { id: string };
      return withAdminTransaction(pool, who.accountId, reply, async (client) => {
        const old = await application(client, "s.id", id, true);
        if (!old || old.state === "draft") return reply.code(404).send({ error: { code: "NOT_FOUND" } });
        if (old.state !== from) return reply.code(409).send({ error: { code: "SHOP_STATE_CHANGE_REFUSED" } });
        await client.query("UPDATE shops SET state = $1 WHERE id = $2", [to, id]);
        await client.query(
          "INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, $2, $3, 'shop', $4)",
          [who.accountId, action, id, reason],
        );
        await client.query("COMMIT");
        return reply.code(200).send({ ...old, state: to });
      });
    });
  }
}

import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  ErrorEnvelope,
  MyShopApplicationResponse,
  SaveShopApplicationBody,
  SendShopApplicationBody,
  ShopApplication,
  type AddressPoint,
  type ShopApplicationField,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { pointFrom, pointJson } from "../points";
import { deriveKeys, mobileSignedIn } from "../tokens";

/** Reads an application with its Area and the Owner's phone and email. */
const applicationSql = `SELECT s.id, s.state, s.shop_name AS "shopName", s.address, s.pincode,
  ${pointJson("s.location")} AS location, s.owner_name AS "ownerName", s.entity_type AS "entityType", s.pan, s.fssai_number AS "fssaiNumber",
  to_char(s.fssai_expiry, 'YYYY-MM-DD') AS "fssaiExpiry", s.service_radius_metres AS "serviceRadiusMetres",
  s.upi_id AS "upiId", ar.name AS "areaName", a.phone AS "ownerPhone", a.email AS "ownerEmail",
  s.submitted_at AS "submittedAt"
  FROM shops s
  JOIN shop_members m ON m.shop_id = s.id AND m.role = 'owner'
  JOIN accounts a ON a.id = m.account_id
  LEFT JOIN areas ar ON ar.id = s.area_id`;

/** The application whose `column` (`s.id` or the Owner's `m.account_id`) is `value`, or null. */
async function application(client: Pool | PoolClient, column: "s.id" | "m.account_id", value: string): Promise<ShopApplication | null> {
  const row = await client.query<Omit<ShopApplication, "submittedAt"> & { submittedAt: Date | null }>(
    `${applicationSql} WHERE ${column} = $1`,
    [value],
  );
  const found = row.rows[0];
  return found ? { ...found, submittedAt: found.submittedAt?.toISOString() ?? null } : null;
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
      // Waits out an Admin Area save, so the pincode can't move to another
      // Area while this Send lands; Sends and serviceability reads don't wait.
      await client.query("LOCK TABLE area_pincodes IN SHARE MODE");
      // A paused Area still counts: it keeps its pincodes (#214).
      const area = await client.query<{ areaId: string }>(`SELECT area_id AS "areaId" FROM area_pincodes WHERE pincode = $1`, [body.pincode]);
      const areaId = area.rows[0]?.areaId;
      if (!areaId) return reply.code(409).send({ error: { code: "PINCODE_NOT_IN_AREA" } });
      const next = values.length + 1;
      await client.query(
        `UPDATE shops SET ${sets.join(", ")}, state = 'submitted', area_id = $${next}, submitted_at = $${next + 1}
         WHERE id = $${next + 2}`,
        [...values, areaId, clock.now(), shop.id],
      );
      const saved = await application(client, "s.id", shop.id);
      await client.query("COMMIT");
      return reply.code(200).send(saved);
    });
  });
}

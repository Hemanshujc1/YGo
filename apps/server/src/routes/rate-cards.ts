import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  ErrorEnvelope,
  PublishRateCardBody,
  PublishedRateCardResponse,
  RATE_CARD_KEYS,
  RateCardResponse,
  ResolveRateCardQuery,
  type RateCardKey,
  type RateCardValues,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { deriveKeys } from "../tokens";

type StoredCard = { version: number; scopeType: "global" | "category" | "shop"; scopeId: string | null; values: RateCardValues };

async function latest(client: Pool | PoolClient, type: StoredCard["scopeType"], id: string | null, version?: number): Promise<StoredCard | undefined> {
  const result = await client.query<StoredCard>(
    `SELECT version::int, scope_type AS "scopeType", scope_id AS "scopeId", values
       FROM rate_card_versions
      WHERE scope_type = $1 AND scope_id IS NOT DISTINCT FROM $2 AND ($3::bigint IS NULL OR version <= $3)
      ORDER BY version DESC LIMIT 1`,
    [type, id, version ?? null],
  );
  return result.rows[0];
}

/** Resolve the effective immutable card used by pricing, agreements and Admin. */
export async function resolveRateCard(pool: Pool, shopId: string, categoryId?: string, version?: number): Promise<RateCardResponse | undefined> {
  const target = await pool.query("SELECT 1 FROM shops WHERE id = $1", [shopId]);
  if (!target.rowCount) return undefined;
  if (categoryId) {
    const category = await pool.query("SELECT 1 FROM categories WHERE id = $1", [categoryId]);
    if (!category.rowCount) return undefined;
  }
  const cards = (await Promise.all([
    latest(pool, "global", null, version),
    categoryId ? latest(pool, "category", categoryId, version) : undefined,
    latest(pool, "shop", shopId, version),
  ])).filter((card): card is StoredCard => card !== undefined);
  const values: RateCardResponse["values"] = {};
  for (const card of cards) {
    for (const key of RATE_CARD_KEYS) {
      if (card.values[key] !== undefined) {
        values[key] = { value: card.values[key], source: { type: card.scopeType, id: card.scopeId, version: card.version } };
      }
    }
  }
  const required: RateCardKey[] = ["commission", "deliveryFee", "deliveredContributionFloor", "minimumCart", "statementGraceDays"];
  const pickup = values.pickup?.value as RateCardValues["pickup"] | undefined;
  if (pickup?.enabled) required.push("pickup");
  const missing = required.filter((key) => values[key] === undefined || (key === "pickup" && pickup?.contributionFloor === null));
  const current = await pool.query<{ version: number }>("SELECT COALESCE(MAX(version), 0)::int AS version FROM rate_card_versions WHERE $1::bigint IS NULL OR version <= $1", [version ?? null]);
  return { version: current.rows[0]?.version ?? 0, values, missing, complete: missing.length === 0 };
}

export function registerRateCardRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope };

  app.get("/v1/admin/rate-cards/effective", { schema: { querystring: ResolveRateCardQuery, response: { 200: RateCardResponse, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const { shopId, categoryId, version } = request.query as { shopId: string; categoryId?: string; version?: number };
    const card = await resolveRateCard(pool, shopId, categoryId, version);
    return card ?? reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });

  app.post("/v1/admin/rate-cards/publish", { schema: { body: PublishRateCardBody, response: { 201: PublishedRateCardResponse, ...errors } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth);
    if (!who) return reply;
    const { scope, values, reason } = request.body as PublishRateCardBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      const scopeId = "id" in scope ? scope.id : null;
      if (scope.type !== "global") {
        const table = scope.type === "category" ? "categories" : "shops";
        const exists = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [scopeId]);
        if (!exists.rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      }
      const inserted = await client.query<{ version: number }>(
        `INSERT INTO rate_card_versions (actor_id, scope_type, scope_id, values, reason, published_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING version::int`,
        [who.accountId, scope.type, scopeId, JSON.stringify(values), reason, clock.now()],
      );
      const version = inserted.rows[0]?.version;
      if (!version) throw new Error("Rate-card publication returned no version");
      await client.query(
        "INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'rate_card.publish', $2, 'rate_card', $3)",
        [who.accountId, scopeId ?? who.accountId, reason],
      );
      await client.query("COMMIT");
      return reply.code(201).send({ version });
    });
  });
}

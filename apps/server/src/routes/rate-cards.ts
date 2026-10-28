import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import type { RateCardDraft } from "@ygo/contracts";
import {
  ErrorEnvelope, PublishRateCardBody, PublishedRateCardResponse, RATE_CARD_KEYS, RateCardResponse,
  ResolveRateCardQuery, type RateCardKey, RateCardValues,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { adminSignedIn, withAdminTransaction } from "../admin";
import { deriveKeys } from "../tokens";

// Versions stay decimal strings, as pg returns bigint, so no value is rounded (#355).
type StoredCard = { version: string; scopeType: "global" | "category" | "shop"; scopeId: string | null };
type LeafKind = "money" | "percentage" | "integer" | "boolean" | "text";
type Leaf = { field: string; kind: LeafKind; value: string | number | boolean };

function flatten(values: RateCardValues): Leaf[] {
  const leaves: Leaf[] = [];
  const add = (field: string, kind: LeafKind, value: string | number | boolean | null | undefined) => {
    if (value !== null && value !== undefined) leaves.push({ field, kind, value });
  };
  const commission = values.commission;
  if (commission) {
    add("commission.formula", "text", commission.formula); add("commission.fixedAmount", "money", commission.fixedAmount);
    add("commission.percentage", "percentage", commission.percentage); add("commission.minimum", "money", commission.minimum);
    add("commission.maximum", "money", commission.maximum); add("commission.base", "text", commission.base);
  }
  const delivery = values.deliveryFee;
  if (delivery) {
    add("deliveryFee.amount", "money", delivery.amount); add("deliveryFee.platformPercentage", "percentage", delivery.split.platformPercentage);
    add("deliveryFee.shopPercentage", "percentage", delivery.split.shopPercentage);
  }
  const small = values.smallCartFee;
  if (small) {
    add("smallCartFee.enabled", "boolean", small.enabled); add("smallCartFee.threshold", "money", small.threshold);
    add("smallCartFee.amount", "money", small.amount); add("smallCartFee.cap", "money", small.cap);
    add("smallCartFee.platformPercentage", "percentage", small.split.platformPercentage); add("smallCartFee.shopPercentage", "percentage", small.split.shopPercentage);
  }
  add("deliveredContributionFloor", "money", values.deliveredContributionFloor); add("minimumCart", "money", values.minimumCart);
  const pickup = values.pickup;
  if (pickup) {
    add("pickup.enabled", "boolean", pickup.enabled); add("pickup.customerFee", "money", pickup.customerFee);
    add("pickup.shopFee", "money", pickup.shopFee); add("pickup.cap", "money", pickup.cap); add("pickup.contributionFloor", "money", pickup.contributionFloor);
  }
  const counter = values.counterBillCharge;
  if (counter) { add("counterBillCharge.enabled", "boolean", counter.enabled); add("counterBillCharge.amount", "money", counter.amount); }
  add("statementGraceDays", "integer", values.statementGraceDays); add("balanceLimit", "money", values.balanceLimit);
  add("bargainMinimumCommission", "money", values.bargainMinimumCommission);
  add("maximumShopDiscountPercentage", "percentage", values.maximumShopDiscountPercentage);
  return leaves;
}

function inflate(leaves: Array<{ field: string; value: string | number | boolean }>): RateCardValues {
  const value = new Map(leaves.map((leaf) => [leaf.field, leaf.value]));
  const text = (field: string) => value.get(field) as string;
  const nullable = (field: string) => value.has(field) ? text(field) : null;
  const hasRule = (key: string) => leaves.some((leaf) => leaf.field.startsWith(`${key}.`));
  const values: RateCardValues = {};
  if (hasRule("commission")) values.commission = {
    formula: text("commission.formula") as "fixed" | "percentage" | "fixed_plus_percentage" | "higher_of" | "lower_of",
    fixedAmount: nullable("commission.fixedAmount"), percentage: nullable("commission.percentage"),
    minimum: nullable("commission.minimum"), maximum: nullable("commission.maximum"),
    base: text("commission.base") as "before_shop_discount" | "after_shop_discount",
  };
  if (hasRule("deliveryFee")) values.deliveryFee = {
    amount: text("deliveryFee.amount"), split: { platformPercentage: text("deliveryFee.platformPercentage"), shopPercentage: text("deliveryFee.shopPercentage") },
  };
  if (hasRule("smallCartFee")) values.smallCartFee = {
    enabled: value.get("smallCartFee.enabled") as boolean, threshold: text("smallCartFee.threshold"), amount: text("smallCartFee.amount"),
    cap: nullable("smallCartFee.cap"), split: { platformPercentage: text("smallCartFee.platformPercentage"), shopPercentage: text("smallCartFee.shopPercentage") },
  };
  if (value.has("deliveredContributionFloor")) values.deliveredContributionFloor = text("deliveredContributionFloor");
  if (value.has("minimumCart")) values.minimumCart = text("minimumCart");
  if (hasRule("pickup")) values.pickup = {
    enabled: value.get("pickup.enabled") as boolean, customerFee: text("pickup.customerFee"), shopFee: nullable("pickup.shopFee"),
    cap: nullable("pickup.cap"), contributionFloor: nullable("pickup.contributionFloor"),
  };
  if (value.has("counterBillCharge.enabled")) values.counterBillCharge = { enabled: false, amount: text("counterBillCharge.amount") };
  if (value.has("statementGraceDays")) values.statementGraceDays = value.get("statementGraceDays") as number;
  if (value.has("balanceLimit")) values.balanceLimit = text("balanceLimit");
  if (value.has("bargainMinimumCommission")) values.bargainMinimumCommission = text("bargainMinimumCommission");
  if (value.has("maximumShopDiscountPercentage")) values.maximumShopDiscountPercentage = text("maximumShopDiscountPercentage");
  return values;
}

async function latest(client: Pool | PoolClient, type: StoredCard["scopeType"], id: string | null, version?: string): Promise<StoredCard | undefined> {
  const result = await client.query<StoredCard>(
    `SELECT version, scope_type AS "scopeType", scope_id AS "scopeId" FROM rate_card_versions
      WHERE scope_type = $1 AND scope_id IS NOT DISTINCT FROM $2 AND ($3::bigint IS NULL OR version <= $3)
      ORDER BY version DESC LIMIT 1`, [type, id, version ?? null]);
  return result.rows[0];
}

async function valuesFor(pool: Pool, version: string): Promise<RateCardValues> {
  const rows = await pool.query<{ field: string; money: string | null; percentage: string | null; integer: number | null; boolean: boolean | null; text: string | null }>(
    `SELECT field, trim_scale(money_value)::text AS money, trim_scale(percentage_value)::text AS percentage, integer_value AS integer,
      boolean_value AS boolean, text_value AS text FROM rate_card_values WHERE version = $1`, [version]);
  return inflate(rows.rows.map((row) => ({ field: row.field, value: row.money ?? row.percentage ?? row.integer ?? row.boolean ?? String(row.text) })));
}

/**
 * Resolve the effective immutable card used by pricing, agreements and Admin.
 * A draft replaces the card at its own scope as if published right after `version`, and is never saved (#357).
 */
export async function resolveRateCard(pool: Pool, shopId: string, categoryId?: string, version?: string, usage = { usesPickup: false, usesBargain: false }, draft?: RateCardDraft): Promise<RateCardResponse | undefined> {
  const current = await pool.query<{ version: string; next: string }>(
    "SELECT COALESCE(MAX(version), 0) AS version, COALESCE(MAX(version), 0)::numeric + 1 AS next FROM rate_card_versions WHERE $1::bigint IS NULL OR version = $1", [version ?? null]);
  if (version !== undefined && current.rows[0]?.version === "0") return undefined;
  version = current.rows[0]?.version ?? "0";
  const next = current.rows[0]?.next ?? "1";
  if (!(await pool.query("SELECT 1 FROM shops WHERE id = $1", [shopId])).rowCount) return undefined;
  const scopes: Array<[StoredCard["scopeType"], string | null]> = [["global", null]];
  if (categoryId) {
    const category = await pool.query<{ parentId: string | null }>(`SELECT parent_id AS "parentId" FROM categories WHERE id = $1`, [categoryId]);
    if (!category.rowCount) return undefined;
    // A child category inherits its parent's card field by field: global → parent → child → shop (#357).
    const parentId = category.rows[0]?.parentId;
    if (parentId) scopes.push(["category", parentId]);
    scopes.push(["category", categoryId]);
  }
  scopes.push(["shop", shopId]);
  const cards = (await Promise.all(scopes.map(async ([type, id]) => {
    if (draft && draft.scope.type === type && ("id" in draft.scope ? draft.scope.id : null) === id) return { version: next, scopeType: type, scopeId: id, values: draft.values };
    const card = await latest(pool, type, id, version);
    return card && { ...card, values: await valuesFor(pool, card.version) };
  }))).filter((card) => card !== undefined);
  const values: RateCardResponse["values"] = {};
  for (const card of cards) {
    for (const key of RATE_CARD_KEYS) if (card.values[key] !== undefined) values[key] = { value: card.values[key], source: { type: card.scopeType, id: card.scopeId, version: card.version } };
  }
  const required: RateCardKey[] = ["commission", "deliveryFee", "deliveredContributionFloor", "minimumCart", "statementGraceDays"];
  if (usage.usesPickup) required.push("pickup");
  if (usage.usesBargain) required.push("bargainMinimumCommission");
  const pickup = values.pickup?.value as RateCardValues["pickup"] | undefined;
  const missing = RATE_CARD_KEYS.filter((key) => {
    const entry = values[key];
    if (!entry) return required.includes(key);
    if (!RateCardValues.shape[key].safeParse(entry.value).success) return true;
    return key === "pickup" && (usage.usesPickup || pickup?.enabled === true) && pickup?.contributionFloor == null;
  });
  return { version: draft ? next : version, values, missing, complete: missing.length === 0 };
}

export function registerRateCardRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const errors = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope };
  app.get("/v1/admin/rate-cards/effective", { schema: { querystring: ResolveRateCardQuery, response: { 200: RateCardResponse, ...errors } } }, async (request, reply) => {
    if (!await adminSignedIn(request, reply, auth)) return reply;
    const { shopId, categoryId, version, usesPickup, usesBargain } = request.query as { shopId: string; categoryId?: string; version?: string; usesPickup: boolean; usesBargain: boolean };
    const card = await resolveRateCard(pool, shopId, categoryId, version, { usesPickup, usesBargain });
    return card ?? reply.code(404).send({ error: { code: "NOT_FOUND" } });
  });
  app.post("/v1/admin/rate-cards/publish", { schema: { body: PublishRateCardBody, response: { 201: PublishedRateCardResponse, ...errors } } }, async (request, reply) => {
    const who = await adminSignedIn(request, reply, auth); if (!who) return reply;
    const { scope, values, reason } = request.body as PublishRateCardBody;
    return withAdminTransaction(pool, who.accountId, reply, async (client) => {
      // Publication numbers must commit in order for historical reads to stay immutable.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('rate_card.publish'))");
      const scopeId = "id" in scope ? scope.id : null;
      if (scope.type !== "global") {
        const table = scope.type === "category" ? "categories" : "shops";
        if (!(await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [scopeId])).rowCount) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      }
      const inserted = await client.query<{ version: string }>(
        "INSERT INTO rate_card_versions (actor_id, scope_type, scope_id, reason, published_at) VALUES ($1, $2, $3, $4, $5) RETURNING version",
        [who.accountId, scope.type, scopeId, reason, clock.now()]);
      const version = inserted.rows[0]?.version; if (!version) throw new Error("Rate-card publication returned no version");
      for (const leaf of flatten(values)) {
        const slots = { money: null, percentage: null, integer: null, boolean: null, text: null } as Record<LeafKind, string | number | boolean | null>;
        slots[leaf.kind] = leaf.value;
        await client.query(`INSERT INTO rate_card_values (version, field, money_value, percentage_value, integer_value, boolean_value, text_value)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`, [version, leaf.field, slots.money, slots.percentage, slots.integer, slots.boolean, slots.text]);
      }
      await client.query("INSERT INTO admin_actions (actor_id, action, target_id, target_type, reason) VALUES ($1, 'rate_card.publish', $2, 'rate_card', $3)", [who.accountId, scopeId ?? who.accountId, reason]);
      await client.query("COMMIT"); return reply.code(201).send({ version });
    });
  });
}

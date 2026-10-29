import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import {
  AGREEMENT_VERSION,
  AcceptShopAgreementBody,
  CommissionRule,
  ErrorEnvelope,
  RATE_CARD_KEYS,
  RateCardValues,
  ShopAgreementResponse,
  type CategoryCommission,
} from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { withTransaction } from "../db";
import { deriveKeys, mobileSignedIn } from "../tokens";
import { resolveRateCard } from "./rate-cards";

/** The Owner's shop, locked when `lock`; undefined for an account that owns none. */
export async function ownerShop(client: Pool | PoolClient, accountId: string, lock = false) {
  const row = await client.query<{ id: string; state: string }>(
    `SELECT s.id, s.state FROM shops s JOIN shop_members m ON m.shop_id = s.id
     WHERE m.account_id = $1 AND m.role = 'owner'${lock ? " FOR UPDATE OF s" : ""}`, [accountId]);
  return row.rows[0];
}

/** The newest publication that can change this shop's card: global, any category, or this shop; "0" before any. */
export async function affectingVersion(client: Pool | PoolClient, shopId: string): Promise<string> {
  const row = await client.query<{ version: string }>(
    `SELECT COALESCE(MAX(version), 0)::text AS version FROM rate_card_versions
     WHERE scope_type IN ('global', 'category') OR (scope_type = 'shop' AND scope_id = $1)`, [shopId]);
  return row.rows[0]?.version ?? "0";
}

/** Compares two commission rules value by value; the resolver's key order is not fixed. */
function sameRule(a: unknown, b: unknown): boolean {
  const left = (a ?? {}) as Record<string, unknown>;
  const right = (b ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => (left[key] ?? null) === (right[key] ?? null));
}

/** What S19 shows: the shop's card, each category whose commission differs, and the last acceptance. */
async function agreement(pool: Pool, shopId: string): Promise<ShopAgreementResponse> {
  // Every card below is read as of this version, so a publish landing mid-read never pairs one card with another's number.
  const version = await affectingVersion(pool, shopId);
  const asOf = version === "0" ? undefined : version;
  const card = await resolveRateCard(pool, shopId, undefined, asOf);
  if (!card) throw new Error("Shop vanished while reading its agreement");
  const rateCard = Object.fromEntries(RATE_CARD_KEYS.flatMap((key) => {
    const parsed = RateCardValues.shape[key].safeParse(card.values[key]?.value);
    return parsed.success && parsed.data !== undefined ? [[key, parsed.data]] : [];
  })) as RateCardValues;
  // A child category inherits its parent's card, so a card on either can change its commission (#357).
  const categories = await pool.query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM categories c LEFT JOIN categories parent ON parent.id = c.parent_id
     WHERE c.active AND COALESCE(parent.active, true) AND EXISTS (SELECT 1 FROM rate_card_versions v
       WHERE v.scope_type = 'category' AND v.scope_id IN (c.id, c.parent_id))
     ORDER BY lower(c.name), c.id`);
  const categoryCommissions: CategoryCommission[] = [];
  for (const category of categories.rows) {
    const commission = CommissionRule.safeParse((await resolveRateCard(pool, shopId, category.id, asOf))?.values.commission?.value);
    if (commission.success && !sameRule(commission.data, rateCard.commission)) {
      categoryCommissions.push({ categoryId: category.id, name: category.name, commission: commission.data });
    }
  }
  const last = await pool.query<{ agreementVersion: number; rateCardVersion: string; acceptedAt: Date }>(
    `SELECT agreement_version AS "agreementVersion", rate_card_version::text AS "rateCardVersion", accepted_at AS "acceptedAt"
     FROM shop_agreement_acceptances WHERE shop_id = $1
     ORDER BY accepted_at DESC, rate_card_version DESC, agreement_version DESC LIMIT 1`, [shopId]);
  const row = last.rows[0];
  const accepted = row ? { ...row, acceptedAt: row.acceptedAt.toISOString() } : null;
  return {
    agreementVersion: AGREEMENT_VERSION, rateCardVersion: version, rateCard, missing: card.missing, categoryCommissions, accepted,
    current: accepted !== null && accepted.agreementVersion === AGREEMENT_VERSION && accepted.rateCardVersion === version,
  };
}

/**
 * S19 (ONB-5, #362): the Owner reads the agreement with the shop's rate card
 * from Approved on, and accepts it. A newer card affecting the shop asks for
 * acceptance again; the server never accepts a card the Owner did not see.
 */
export function registerShopAgreementRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope };

  app.get("/v1/me/shop-agreement", { schema: { response: { 200: ShopAgreementResponse, ...response } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const shop = await ownerShop(pool, who.accountId);
    if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
    if (shop.state !== "approved" && shop.state !== "live") return reply.code(409).send({ error: { code: "SHOP_NOT_APPROVED" } });
    return agreement(pool, shop.id);
  });

  app.post("/v1/me/shop-agreement", { schema: { body: AcceptShopAgreementBody, response: { 200: ShopAgreementResponse, ...response } } }, async (request, reply) => {
    const who = await mobileSignedIn(request, reply, auth);
    if (!who) return reply;
    const body = request.body as AcceptShopAgreementBody;
    return withTransaction(pool, async (client) => {
      const shop = await ownerShop(client, who.accountId, true);
      if (!shop) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (shop.state !== "approved" && shop.state !== "live") return reply.code(409).send({ error: { code: "SHOP_NOT_APPROVED" } });
      if (body.agreementVersion !== AGREEMENT_VERSION) return reply.code(409).send({ error: { code: "AGREEMENT_OUTDATED" } });
      // Holds off a publish until this commits, so the version checked is the one stored.
      await client.query("LOCK TABLE rate_card_versions IN SHARE MODE");
      if (await affectingVersion(client, shop.id) !== body.rateCardVersion) return reply.code(409).send({ error: { code: "RATE_CARD_CHANGED" } });
      // The shop has no pickup or Bargain switch yet, so only the card's own pickup rule adds a requirement;
      // #65 and #78 pass the shop's switches here when they add them.
      if (!(await resolveRateCard(pool, shop.id, undefined, body.rateCardVersion))?.complete) return reply.code(409).send({ error: { code: "RATE_CARD_INCOMPLETE" } });
      await client.query(
        `INSERT INTO shop_agreement_acceptances (shop_id, account_id, agreement_version, rate_card_version, accepted_at)
         VALUES ($1, $2, $3, $4, $5)`, [shop.id, who.accountId, body.agreementVersion, body.rateCardVersion, clock.now()]);
      await client.query("COMMIT");
      return reply.code(200).send(await agreement(pool, shop.id));
    });
  });
}

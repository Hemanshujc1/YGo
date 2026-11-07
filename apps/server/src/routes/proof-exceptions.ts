import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { ErrorEnvelope, ProofException, ProofExceptionParams, ProofExceptionPhotoAccess, ProofExceptionsQuery, ProofExceptionsResponse } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import type { DeliveryPhotoStorage } from "../adapters/delivery-photos";
import { PRIVATE_READ_SECONDS } from "../adapters/file-storage";
import { adminWebSignedIn, withAdminWebTransaction } from "../admin";
import { listProofExceptions, proofExceptionCounts, proofPhotoOf, reviewProofException } from "../proof-exceptions";
import { deriveKeys } from "../tokens";

/**
 * A28 Proof exception (DLV-4, #60). Admin sees every one; an Area Manager sees and reviews only the shops assigned to them,
 * and another shop's order answers NOT_FOUND, as on the application screens (#299). Marking reviewed does nothing else.
 */
export function registerProofExceptionRoutes(app: FastifyInstance, { pool, clock, secret, photos }: { pool: Pool; clock: Clock; secret: string; photos?: DeliveryPhotoStorage }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };
  const response = { 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 503: ErrorEnvelope };
  const scope = (who: { accountId: string; role: string }) => (who.role === "area_manager" ? who.accountId : null);

  app.get("/v1/admin/proof-exceptions", { schema: { querystring: ProofExceptionsQuery, response: { 200: ProofExceptionsResponse, ...response } } }, async (request, reply) => {
    const who = await adminWebSignedIn(request, reply, auth);
    if (!who) return reply;
    const query = request.query as ProofExceptionsQuery;
    const [page, counts] = await Promise.all([listProofExceptions(pool, scope(who), query), proofExceptionCounts(pool, scope(who))]);
    return { ...page, counts };
  });

  app.post("/v1/admin/proof-exceptions/:orderId/review", { schema: { params: ProofExceptionParams, response: { 200: ProofException, ...response } } }, async (request, reply) => {
    const who = await adminWebSignedIn(request, reply, auth);
    if (!who) return reply;
    const { orderId } = request.params as ProofExceptionParams;
    return withAdminWebTransaction(pool, who, reply, async (client) => {
      const reviewed = await reviewProofException(client, scope(who), orderId, who.accountId, clock.now());
      if (!reviewed) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      await client.query("COMMIT");
      return reply.code(200).send(reviewed);
    });
  });

  // The photo of a customer's door and goods: a short private link, only for who may see the order, and every one issued is logged (#560).
  app.get("/v1/admin/proof-exceptions/:orderId/photo", { schema: { params: ProofExceptionParams, response: { 200: ProofExceptionPhotoAccess, ...response } } }, async (request, reply) => {
    const who = await adminWebSignedIn(request, reply, auth);
    if (!who) return reply;
    const { orderId } = request.params as ProofExceptionParams;
    return withAdminWebTransaction(pool, who, reply, async (client) => {
      const now = clock.now();
      const proof = await proofPhotoOf(client, scope(who), orderId, now);
      if (!proof) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      if (!proof.key) return reply.code(404).send({ error: { code: "PHOTO_EXPIRED" } });
      if (!photos) return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
      let downloadUrl: string;
      try { downloadUrl = await photos.downloadUrl(proof.key); }
      catch { return reply.code(503).send({ error: { code: "UNAVAILABLE" } }); }
      await client.query("INSERT INTO proof_photo_views (order_id, viewed_by, viewed_at) VALUES ($1, $2, $3)", [orderId, who.accountId, now]);
      await client.query("COMMIT");
      return reply.code(200).send({ downloadUrl, expiresAt: new Date(now.getTime() + PRIVATE_READ_SECONDS * 1000).toISOString() });
    });
  });
}

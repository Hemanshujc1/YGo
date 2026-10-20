import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { Account, ChangeNameBody, ErrorEnvelope, SetProfileBody } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { deriveKeys, signedIn } from "../tokens";

interface ProfileOptions {
  pool: Pool;
  clock: Clock;
  secret: string;
}

export function registerProfileRoutes(app: FastifyInstance, { pool, clock, secret }: ProfileOptions): void {
  const keys = deriveKeys(secret);
  const auth = { pool, clock, keys };

  app.get(
    "/v1/me",
    { schema: { response: { 200: Account, 401: ErrorEnvelope } } },
    async (request, reply) => {
      const who = await signedIn(request, reply, auth);
      if (!who) return reply;
      const result = await pool.query<Account>("SELECT id, email, name, phone FROM accounts WHERE id = $1", [who.accountId]);
      return reply.code(200).send(result.rows[0]);
    },
  );

  app.put(
    "/v1/me/profile",
    { schema: { body: SetProfileBody, response: { 200: Account, 400: ErrorEnvelope, 401: ErrorEnvelope, 409: ErrorEnvelope } } },
    async (request, reply) => {
      const who = await signedIn(request, reply, auth);
      if (!who) return reply;
      const { name, phone } = request.body as SetProfileBody;
      try {
        const result = await pool.query<Account>(
          `UPDATE accounts SET name = $1, phone = $2
           WHERE id = $3 AND (phone IS NULL OR phone = $2)
           RETURNING id, email, name, phone`,
          [name, phone, who.accountId],
        );
        if (!result.rows[0]) return reply.code(400).send({ error: { code: "VALIDATION_FAILED", fields: ["phone"] } });
        return reply.code(200).send(result.rows[0]);
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          return reply.code(409).send({ error: { code: "PHONE_IN_USE" } });
        }
        throw error;
      }
    },
  );

  app.patch(
    "/v1/me",
    { schema: { body: ChangeNameBody, response: { 200: Account, 401: ErrorEnvelope, 403: ErrorEnvelope } } },
    async (request, reply) => {
      const who = await signedIn(request, reply, auth);
      if (!who) return reply;
      const { name } = request.body as ChangeNameBody;
      const result = await pool.query<Account>(
        `UPDATE accounts SET name = $1 WHERE id = $2 AND name IS NOT NULL AND phone IS NOT NULL
         RETURNING id, email, name, phone`,
        [name, who.accountId],
      );
      if (!result.rows[0]) return reply.code(403).send({ error: { code: "PROFILE_REQUIRED" } });
      return reply.code(200).send(result.rows[0]);
    },
  );
}

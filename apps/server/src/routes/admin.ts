import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { Account, AdminAccount, AdminAccountsResponse, CreateAdminBody, ErrorEnvelope, SetThemeBody, type AdminRole } from "@ygo/contracts";
import type { Clock } from "../adapters/clock";
import { ADMIN_WEB_MEMBERS, adminSignedIn, adminWebSignedIn } from "../admin";
import { deriveKeys } from "../tokens";

// Where each role's membership lives and the action that records its creation (#343).
const created: Record<AdminRole, { table: string; action: string }> = {
  admin: { table: "admin_memberships", action: "admin.create" },
  area_manager: { table: "area_manager_memberships", action: "area_manager.create" },
};

export function registerAdminRoutes(app: FastifyInstance, { pool, clock, secret }: { pool: Pool; clock: Clock; secret: string }): void {
  const auth = { pool, clock, keys: deriveKeys(secret) };

  // The signed-in Admin or Area Manager and their role (#343). /v1/me stays mobile-only (#246); the theme column is shared (#263).
  app.get(
    "/v1/admin/me",
    { schema: { response: { 200: AdminAccount, 401: ErrorEnvelope, 403: ErrorEnvelope } } },
    async (request, reply) => {
      const who = await adminWebSignedIn(request, reply, auth);
      if (!who) return reply;
      const result = await pool.query<Account>("SELECT id, email, name, phone, theme FROM accounts WHERE id = $1", [who.accountId]);
      return reply.code(200).send({ ...result.rows[0], role: who.role });
    },
  );

  app.put(
    "/v1/admin/me/theme",
    { schema: { body: SetThemeBody, response: { 200: Account, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope } } },
    async (request, reply) => {
      const who = await adminWebSignedIn(request, reply, auth);
      if (!who) return reply;
      const { theme } = request.body as SetThemeBody;
      const result = await pool.query<Account>(
        "UPDATE accounts SET theme = $1 WHERE id = $2 RETURNING id, email, name, phone, theme",
        [theme, who.accountId],
      );
      return reply.code(200).send(result.rows[0]);
    },
  );

  app.get(
    "/v1/admin/accounts",
    { schema: { response: { 200: AdminAccountsResponse, 401: ErrorEnvelope, 403: ErrorEnvelope } } },
    async (request, reply) => {
      if (!await adminSignedIn(request, reply, auth)) return reply;
      const accounts = await pool.query<AdminAccount>(
        `SELECT a.id, a.email, a.name, a.phone, a.theme, m.role FROM accounts a JOIN ${ADMIN_WEB_MEMBERS} m ON m.account_id = a.id ORDER BY a.email`,
      );
      return reply.code(200).send({ accounts: accounts.rows });
    },
  );

  app.post(
    "/v1/admin/accounts",
    { schema: { body: CreateAdminBody, response: { 201: AdminAccount, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 409: ErrorEnvelope } } },
    async (request, reply) => {
      const who = await adminSignedIn(request, reply, auth);
      if (!who) return reply;
      const { email, name, phone, role, reason } = request.body as CreateAdminBody;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Recheck under the write transaction so membership removal cannot race creation.
        const member = await client.query("SELECT 1 FROM admin_memberships WHERE account_id = $1 FOR KEY SHARE", [who.accountId]);
        if (!member.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(403).send({ error: { code: "FORBIDDEN" } });
        }
        const existing = await client.query<{ email: string; phone: string | null }>(
          "SELECT email, phone FROM accounts WHERE email = $1 OR phone = $2 LIMIT 1",
          [email, phone],
        );
        if (existing.rows[0]) {
          await client.query("ROLLBACK");
          return reply.code(409).send({ error: { code: existing.rows[0].email === email ? "EMAIL_IN_USE" : "PHONE_IN_USE" } });
        }
        const inserted = await client.query<Account>(
          "INSERT INTO accounts (email, name, phone) VALUES ($1, $2, $3) RETURNING id, email, name, phone, theme",
          [email, name, phone],
        );
        const account = inserted.rows[0];
        if (!account) throw new Error("Admin insert returned no account");
        const { table, action } = created[role];
        await client.query(`INSERT INTO ${table} (account_id) VALUES ($1)`, [account.id]);
        await client.query(
          "INSERT INTO admin_actions (actor_id, action, target_id, reason) VALUES ($1, $2, $3, $4)",
          [who.accountId, action, account.id, reason],
        );
        await client.query("COMMIT");
        request.log.info({ action }, "Admin action recorded");
        return reply.code(201).send({ ...account, role });
      } catch (error) {
        await client.query("ROLLBACK");
        if ((error as { code?: string; constraint?: string }).code === "23505") {
          const constraint = (error as { constraint?: string }).constraint;
          if (constraint === "accounts_email_unique") return reply.code(409).send({ error: { code: "EMAIL_IN_USE" } });
          if (constraint === "accounts_phone_unique") return reply.code(409).send({ error: { code: "PHONE_IN_USE" } });
        }
        throw error;
      } finally {
        client.release();
      }
    },
  );
}

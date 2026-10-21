import { Email, PersonName, Phone } from "@ygo/contracts";
import type { Pool } from "pg";

export const BOOTSTRAP_REASON = "Initial Admin bootstrap";

export type BootstrapFields = { email: string; name: string; phone: string };

/** The lock serializes all bootstrap commands before either existence check. */
export async function bootstrapAdmin(pool: Pool, fields: BootstrapFields): Promise<void> {
  const email = Email.safeParse(fields.email);
  const name = PersonName.safeParse(fields.name);
  const phone = Phone.safeParse(fields.phone);
  if (!email.success || !name.success || !phone.success) throw new Error("Invalid email, name or phone.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, $2))", ["admin.bootstrap", 181]);
    const members = await client.query("SELECT 1 FROM admin_memberships LIMIT 1");
    if (members.rowCount) throw new Error("An Admin already exists; use Admin web.");
    const previous = await client.query("SELECT 1 FROM admin_actions WHERE action = 'admin.bootstrap' LIMIT 1");
    if (previous.rowCount) throw new Error("Bootstrap was already used; use a deliberate recovery procedure.");
    const duplicate = await client.query("SELECT 1 FROM accounts WHERE email = $1 OR phone = $2 LIMIT 1", [email.data, phone.data]);
    if (duplicate.rowCount) throw new Error("Email or phone is already in use.");
    const account = await client.query<{ id: string }>(
      "INSERT INTO accounts (email, name, phone) VALUES ($1, $2, $3) RETURNING id",
      [email.data, name.data, phone.data],
    );
    const id = account.rows[0]?.id;
    if (!id) throw new Error("Account insert returned no ID.");
    await client.query("INSERT INTO admin_memberships (account_id) VALUES ($1)", [id]);
    await client.query(
      "INSERT INTO admin_actions (actor_id, action, target_account_id, reason) VALUES (NULL, 'admin.bootstrap', $1, $2)",
      [id, BOOTSTRAP_REASON],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

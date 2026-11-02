import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { expect, inject, it } from "vitest";

// As in visit-migration.test.ts: bills made before 0045 get when they were numbered (#497).
it("stamps bills numbered before 0045: Admin's numbering time, else arrival, and none for a held bill", async () => {
  const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
  const previous = await mkdtemp(join(tmpdir(), "ygo-bill-migration-"));
  const url = new URL(inject("databaseUrl"));
  const admin = new pg.Client({ connectionString: url.href });
  const name = `ygo_upgrade_${randomUUID().replaceAll("-", "")}`;
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.href });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    await client.connect();
    await cp(migrations, previous, { recursive: true });
    const journalPath = join(previous, "meta/_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((entry) => Number(entry.tag.slice(0, 4)) < 45);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle({ client }), { migrationsFolder: previous });

    const shopId = randomUUID();
    await client.query(`INSERT INTO shops (id, state, shop_name, address, pincode, location, owner_name, entity_type, pan,
        fssai_number, fssai_expiry, upi_id, submitted_at, created_at)
      VALUES ($1, 'live', 'Sai General Stores', 'Paud Road', '411038', ST_SetSRID(ST_MakePoint(73.8, 18.5), 4326)::geography,
        'Asha', 'proprietorship', 'ABCDE1234F', '11223344556677', '2099-01-01', 'asha@upi', now(), now())`, [shopId]);
    const bill = async (reference: string, number: number | null) => (await client.query<{ id: string }>(`INSERT INTO counter_bills (shop_id, actor_id, client_id,
        reference, reference_clash, number, held_reason, payment, total, checked_total, clock_suspect, made_at, received_at)
      VALUES ($1, gen_random_uuid(), gen_random_uuid(), $2, false, $3, $4, 'cash', '21', '21', false, '2030-01-01T00:00:00Z', '2030-01-01T00:00:00Z') RETURNING id`,
    [shopId, reference, number, number === null ? "not_listed" : null])).rows[0]?.id as string;
    const onArrival = await bill("0000-0001", 1);
    const byAdmin = await bill("0000-0002", 2);
    const held = await bill("0000-0003", null);
    await client.query(`INSERT INTO counter_bill_resolutions (bill_id, actor_id, action, note, stock_moved, created_at)
      VALUES ($1, gen_random_uuid(), 'numbered', 'Sold at the counter', false, '2030-01-04T00:00:00Z')`, [byAdmin]);

    await migrate(drizzle({ client }), { migrationsFolder: migrations });
    const stamped = (await client.query<{ id: string; numbered_at: Date | null }>("SELECT id, numbered_at FROM counter_bills")).rows;
    expect(Object.fromEntries(stamped.map((row) => [row.id, row.numbered_at?.toISOString() ?? null]))).toEqual({
      [onArrival]: "2030-01-01T00:00:00.000Z", [byAdmin]: "2030-01-04T00:00:00.000Z", [held]: null });
    // The bill is kept as recorded again once the backfill is done.
    await expect(client.query("UPDATE counter_bills SET numbered_at = now()")).rejects.toThrow(/refused/);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(previous, { recursive: true, force: true });
  }
});

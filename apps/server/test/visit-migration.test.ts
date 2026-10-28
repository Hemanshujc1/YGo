import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { expect, inject, it } from "vitest";

it("upgrades existing accounts without promoting visit confirmation or changing SMS verification", async () => {
  const migrations = fileURLToPath(new URL("../migrations", import.meta.url));
  const previous = await mkdtemp(join(tmpdir(), "ygo-visit-migration-"));
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
    // Recreate the pre-0016 schema even as later migrations are added.
    journal.entries = journal.entries.filter((entry) => Number(entry.tag.slice(0, 4)) < 16);
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle({ client }), { migrationsFolder: previous });
    await client.query(`INSERT INTO accounts (email, phone_verified) VALUES
      ('unverified@test.example', false), ('sms@test.example', true)`);
    await migrate(drizzle({ client }), { migrationsFolder: migrations });
    expect((await client.query(`SELECT email, phone_verified, phone_visit_confirmed_at, email_visit_confirmed_at
      FROM accounts ORDER BY email`)).rows).toEqual([
      { email: "sms@test.example", phone_verified: true, phone_visit_confirmed_at: null, email_visit_confirmed_at: null },
      { email: "unverified@test.example", phone_verified: false, phone_visit_confirmed_at: null, email_visit_confirmed_at: null },
    ]);
    await migrate(drizzle({ client }), { migrationsFolder: migrations });
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(previous, { recursive: true, force: true });
  }
});

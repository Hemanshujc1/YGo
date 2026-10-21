import { bootstrapAdmin } from "./bootstrap";
import { loadDatabaseUrl } from "./config";
import { connectDatabase } from "./db";

let database: ReturnType<typeof connectDatabase> | undefined;
try {
  const values: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key || !["--email", "--name", "--phone"].includes(key) || !value || key in values) {
      throw new Error("Expected --email, --name and --phone once each.");
    }
    values[key] = value;
  }
  const email = values["--email"];
  const name = values["--name"];
  const phone = values["--phone"];
  if (!email || !name || !phone) throw new Error("Expected --email, --name and --phone once each.");
  database = connectDatabase(loadDatabaseUrl());
  await bootstrapAdmin(database.pool, { email, name, phone });
  console.log("Initial Admin created.");
} catch (error) {
  // Never print input values, database URLs, driver errors or account details.
  const safe = error instanceof Error && [
    "Expected --email, --name and --phone once each.",
    "Invalid email, name or phone.",
    "Bootstrap was already used; use a deliberate recovery procedure.",
    "An Admin already exists; use Admin web.",
    "Email or phone is already in use.",
  ].includes(error.message);
  console.error(safe ? (error as Error).message : "Admin bootstrap failed.");
  process.exitCode = 1;
} finally {
  await database?.close();
}

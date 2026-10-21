import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  phone: text("phone").unique(),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  role: text("role").notNull().default("customer"),
});

// Admin authority is independent of the account's customer role and of tokens.
export const adminMemberships = pgTable("admin_memberships", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const adminActions = pgTable(
  "admin_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetAccountId: uuid("target_account_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("admin_actions_action_nonempty", sql`btrim(${table.action}) <> ''`),
    check("admin_actions_reason_valid", sql`btrim(${table.reason}) <> '' AND char_length(${table.reason}) <= 500`),
    check("admin_actions_actor_valid", sql`(${table.action} = 'admin.bootstrap' AND ${table.actorId} IS NULL AND ${table.reason} = 'Initial Admin bootstrap') OR (${table.action} <> 'admin.bootstrap' AND ${table.actorId} IS NOT NULL)`),
    uniqueIndex("admin_actions_one_bootstrap_idx").on(table.action).where(sql`${table.action} = 'admin.bootstrap'`),
  ],
);
export const loginCodes = pgTable("login_codes", {
  email: text("email").primaryKey(),
  codeHash: text("code_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  wrongTries: integer("wrong_tries").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

export const loginCodeHistory = pgTable(
  "login_code_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("login_code_history_email_expires_at_idx").on(table.email, table.expiresAt)],
);
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["mobile", "admin_web"] }).notNull().default("mobile"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check("sessions_kind_valid", sql`${table.kind} IN ('mobile', 'admin_web')`)],
);

// Every refresh token a session has been issued, as a keyed hash. The one with
// no replaced_at is current; the database allows one per session (#153, Q3).
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    replacedAt: timestamp("replaced_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("refresh_tokens_session_generation_idx").on(table.sessionId, table.generation),
    uniqueIndex("refresh_tokens_one_current_idx").on(table.sessionId).where(sql`${table.replacedAt} IS NULL`),
  ],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobName: text("job_name").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status", { enum: ["running", "ok", "failed"] }).notNull(),
    errorText: varchar("error_text", { length: 200 }),
  },
  (table) => [index("job_runs_job_name_started_at_idx").on(table.jobName, table.startedAt)],
);

export const emailCodeSends = pgTable(
  "email_code_sends",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    address: text("address").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("email_code_sends_email_sent_at_idx").on(table.email, table.sentAt),
    index("email_code_sends_address_sent_at_idx").on(table.address, table.sentAt),
  ],
);

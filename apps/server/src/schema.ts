import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  phone: text("phone").unique(),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  role: text("role").notNull().default("customer"),
});
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
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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

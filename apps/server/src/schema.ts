import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
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
    targetId: uuid("target_id").notNull(),
    targetType: text("target_type").notNull().default("account"),
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

export const categories = pgTable("categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id").references((): AnyPgColumn => categories.id),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
}, (table) => [
  check("categories_name_valid", sql`btrim(${table.name}) <> '' AND char_length(${table.name}) <= 100`),
  uniqueIndex("categories_root_name_idx").on(sql`lower(${table.name})`).where(sql`${table.parentId} IS NULL`),
  uniqueIndex("categories_child_name_idx").on(table.parentId, sql`lower(${table.name})`).where(sql`${table.parentId} IS NOT NULL`),
]);

export const masterProducts = pgTable("master_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  brand: text("brand"),
  categoryId: uuid("category_id").notNull().references(() => categories.id),
  baseUnit: text("base_unit").notNull(),
  classification: text("classification").notNull(),
  image256Key: text("image_256_key"),
  image512Key: text("image_512_key"),
  image1024Key: text("image_1024_key"),
  active: boolean("active").notNull().default(true),
  published: boolean("published").notNull().default(false),
}, (table) => [
  check("master_products_name_valid", sql`btrim(${table.name}) <> '' AND char_length(${table.name}) <= 200`),
  check("master_products_brand_valid", sql`${table.brand} IS NULL OR (btrim(${table.brand}) <> '' AND char_length(${table.brand}) <= 100)`),
  check("master_products_unit_valid", sql`${table.baseUnit} IN ('each', 'kg', 'l')`),
  check("master_products_classification_valid", sql`${table.classification} IN ('counted', 'measured')`),
  check("master_products_unit_classification_valid", sql`(${table.classification} = 'counted' AND ${table.baseUnit} = 'each') OR (${table.classification} = 'measured' AND ${table.baseUnit} IN ('kg', 'l'))`),
  check("master_products_published_image_valid", sql`NOT ${table.published} OR (${table.image256Key} IS NOT NULL AND ${table.image512Key} IS NOT NULL AND ${table.image1024Key} IS NOT NULL)`),
  uniqueIndex("master_products_name_brand_idx").on(sql`lower(${table.name})`, sql`coalesce(lower(${table.brand}), '')`),
  index("master_products_category_id_idx").on(table.categoryId),
]);
// An Admin-named group of pincodes (#214). A paused Area takes no new orders but
// keeps its pincodes, so no other Area can take them.
export const areas = pgTable("areas", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  paused: boolean("paused").notNull().default(false),
}, (table) => [
  check("areas_name_valid", sql`btrim(${table.name}) <> '' AND char_length(${table.name}) <= 100`),
  uniqueIndex("areas_name_idx").on(sql`lower(${table.name})`),
]);

// The pincode is the key, so the database keeps each pincode in one Area at most.
export const areaPincodes = pgTable("area_pincodes", {
  pincode: text("pincode").primaryKey(),
  areaId: uuid("area_id").notNull().references(() => areas.id),
}, (table) => [index("area_pincodes_area_id_idx").on(table.areaId)]);

// "Leave my number" from a pincode no active Area serves. One row per account
// and pincode; a repeat replaces the phone and the time.
export const waitlistEntries = pgTable("waitlist_entries", {
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  pincode: text("pincode").notNull(),
  phone: text("phone").notNull(),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull(),
}, (table) => [primaryKey({ columns: [table.accountId, table.pincode] })]);

// A PostGIS point in metres on the spheroid (ADR-0002). Drizzle has only
// geometry, so routes read and write it with SQL.
const geographyPoint = customType<{ data: string }>({ dataType: () => "geography(Point,4326)" });

// A Customer's confirmed places (#217), at most 10 per account, gone with the
// account. One Home and one Work each; the point is null for a place typed as
// a pincode with location refused.
export const savedAddresses = pgTable("saved_addresses", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  flat: text("flat").notNull(),
  areaLine: text("area_line"),
  pincode: text("pincode").notNull(),
  point: geographyPoint("point"),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull(),
}, (table) => [
  check("saved_addresses_label_valid", sql`${table.label} IN ('home', 'work', 'other')`),
  index("saved_addresses_account_id_saved_at_idx").on(table.accountId, table.savedAt.desc()),
  uniqueIndex("saved_addresses_home_work_idx").on(table.accountId, table.label).where(sql`${table.label} <> 'other'`),
]);

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

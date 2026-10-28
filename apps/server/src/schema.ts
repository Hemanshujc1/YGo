import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  bigint,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const identityChallenges = pgTable("identity_challenges", {
  nonce: text("nonce").primaryKey(),
  provider: text("provider").notNull(),
  address: text("address").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used: boolean("used").notNull().default(false),
}, (table) => [index("identity_challenges_expiry_idx").on(table.expiresAt), index("identity_challenges_address_idx").on(table.address)]);

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  phone: text("phone").unique(),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  // In-person confirmation is independent of SMS verification (ACC-14).
  phoneVisitConfirmedAt: timestamp("phone_visit_confirmed_at", { withTimezone: true }),
  emailVisitConfirmedAt: timestamp("email_visit_confirmed_at", { withTimezone: true }),
  role: text("role").notNull().default("customer"),
  // System, Light or Dark, shared by both mobile apps (#195).
  theme: text("theme").notNull().default("system"),
}, (table) => [
  check("accounts_theme_valid", sql`${table.theme} IN ('system', 'light', 'dark')`),
  check("accounts_phone_confirmation_valid", sql`${table.phoneVisitConfirmedAt} IS NULL OR ${table.phone} IS NOT NULL`),
]);

// Admin authority is independent of the account's customer role and of tokens.
export const adminMemberships = pgTable("admin_memberships", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// An Area Manager has no Area: Admin assigns shops to them (#343). Never also an Admin.
export const areaManagerMemberships = pgTable("area_manager_memberships", {
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
export const packs = pgTable("packs", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id").notNull().references(() => masterProducts.id),
  quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
  barcode: text("barcode"),
  active: boolean("active").notNull().default(true),
}, (table) => [
  check("packs_quantity_positive", sql`${table.quantity} > 0 AND ${table.quantity} <> 'NaN'::numeric`),
  check("packs_barcode_valid", sql`${table.barcode} IS NULL OR ${table.barcode} ~ '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13})$'`),
  uniqueIndex("packs_product_quantity_idx").on(table.productId, table.quantity),
  uniqueIndex("packs_barcode_idx").on(table.barcode),
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

// A shop, from its Draft application on (#40). Fields stay empty while a
// Draft; once sent, every ONB-3 field is set. Its Area is read from the
// pincode, so it follows an Admin Area edit (owner decision on #280). Numbers
// only: no identity document image and no bank detail (ONB-3).
export const shops = pgTable("shops", {
  id: uuid("id").primaryKey().defaultRandom(),
  state: text("state").notNull().default("draft"),
  shopName: text("shop_name"),
  address: text("address"),
  pincode: text("pincode"),
  location: geographyPoint("location"),
  ownerName: text("owner_name"),
  entityType: text("entity_type"),
  pan: text("pan"),
  fssaiNumber: text("fssai_number"),
  fssaiExpiry: date("fssai_expiry"),
  serviceRadiusMetres: integer("service_radius_metres").notNull().default(2000),
  upiId: text("upi_id"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  // The Area Manager Admin assigned the shop to, paid on it (#299); none means Admin's own shop.
  areaManagerId: uuid("area_manager_id").references(() => areaManagerMemberships.accountId),
}, (table) => [
  index("shops_area_manager_id_idx").on(table.areaManagerId),
  check("shops_state_valid", sql`${table.state} IN ('draft', 'submitted', 'under_review', 'approved')`),
  check("shops_entity_type_valid", sql`${table.entityType} IN ('proprietorship', 'partnership_firm', 'llp', 'company')`),
  check("shops_service_radius_valid", sql`${table.serviceRadiusMetres} BETWEEN 500 AND 5000 AND ${table.serviceRadiusMetres} % 500 = 0`),
  check("shops_sent_complete", sql`${table.state} = 'draft' OR (${table.shopName} IS NOT NULL AND ${table.address} IS NOT NULL
    AND ${table.pincode} IS NOT NULL AND ${table.location} IS NOT NULL AND ${table.ownerName} IS NOT NULL
    AND ${table.entityType} IS NOT NULL AND ${table.pan} IS NOT NULL AND ${table.fssaiNumber} IS NOT NULL
    AND ${table.fssaiExpiry} IS NOT NULL AND ${table.upiId} IS NOT NULL
    AND ${table.submittedAt} IS NOT NULL)`),
]);

// An account's link to a shop, as Owner or Staff. The account is the key, so
// an account holds one shop link at most (ACC-4), and an account with a shop
// can't be deleted from under it.
export const shopMembers = pgTable("shop_members", {
  accountId: uuid("account_id").primaryKey().references(() => accounts.id),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  role: text("role").notNull(),
}, (table) => [
  check("shop_members_role_valid", sql`${table.role} IN ('owner', 'staff')`),
  index("shop_members_shop_id_idx").on(table.shopId),
]);

// One immutable publication number covers every scope, so an order or agreement can name
// exactly which configuration it used. A publication stores the complete snapshot for one
// scope; an omitted key clears that override and inherits from the broader scope (#44).
export const rateCardVersions = pgTable("rate_card_versions", {
  version: bigint("version", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  actorId: uuid("actor_id").notNull().references(() => accounts.id),
  scopeType: text("scope_type").notNull(),
  scopeId: uuid("scope_id"),
  reason: text("reason").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
}, (table) => [
  check("rate_card_versions_scope_valid", sql`(${table.scopeType} = 'global' AND ${table.scopeId} IS NULL) OR (${table.scopeType} IN ('area', 'category', 'shop') AND ${table.scopeId} IS NOT NULL)`),
  check("rate_card_versions_reason_valid", sql`btrim(${table.reason}) <> '' AND char_length(${table.reason}) <= 500`),
  index("rate_card_versions_scope_idx").on(table.scopeType, table.scopeId, table.version.desc()),
]);

// Each immutable scope snapshot is decomposed into exact typed leaves. Money and
// percentages remain PostgreSQL NUMERIC; no financial value is hidden in JSON (#44, ADR-0002).
export const rateCardValues = pgTable("rate_card_values", {
  version: bigint("version", { mode: "number" }).notNull().references(() => rateCardVersions.version, { onDelete: "cascade" }),
  field: text("field").notNull(),
  moneyValue: numeric("money_value", { precision: 12, scale: 2 }),
  percentageValue: numeric("percentage_value", { precision: 7, scale: 4 }),
  integerValue: integer("integer_value"),
  booleanValue: boolean("boolean_value"),
  textValue: text("text_value"),
}, (table) => [
  primaryKey({ columns: [table.version, table.field] }),
  check("rate_card_values_one_value", sql`num_nonnulls(${table.moneyValue}, ${table.percentageValue}, ${table.integerValue}, ${table.booleanValue}, ${table.textValue}) = 1`),
]);

// Shop-owned pack settings and base-unit inventory (#43, CAT-1, CAT-2, CAT-4).
export const shopListings = pgTable("shop_listings", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  packId: uuid("pack_id").notNull().references(() => packs.id),
  onlinePrice: numeric("online_price", { precision: 12, scale: 2 }).notNull(),
  counterPrice: numeric("counter_price", { precision: 12, scale: 2 }).notNull(),
  mrp: numeric("mrp", { precision: 12, scale: 2 }).notNull(),
  lowStockLevel: numeric("low_stock_level", { precision: 12, scale: 3 }).notNull().default("0"),
  available: boolean("available").notNull().default(true),
  minimumOrderQuantity: numeric("minimum_order_quantity", { precision: 12, scale: 3 }),
  quantityStep: numeric("quantity_step", { precision: 12, scale: 3 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("shop_listings_shop_pack_idx").on(table.shopId, table.packId),
  check("shop_listings_prices_valid", sql`${table.onlinePrice} >= 0 AND ${table.onlinePrice} <> 'NaN'::numeric AND ${table.counterPrice} >= 0 AND ${table.counterPrice} <> 'NaN'::numeric AND ${table.mrp} >= 0 AND ${table.mrp} <> 'NaN'::numeric AND ${table.onlinePrice} <= ${table.mrp} AND ${table.counterPrice} <= ${table.mrp} AND ${table.lowStockLevel} >= 0 AND ${table.lowStockLevel} <> 'NaN'::numeric`),
  check("shop_listings_measured_rules_pair", sql`((${table.minimumOrderQuantity} IS NULL) AND (${table.quantityStep} IS NULL)) OR (${table.minimumOrderQuantity} > 0 AND ${table.minimumOrderQuantity} <> 'NaN'::numeric AND ${table.quantityStep} > 0 AND ${table.quantityStep} <> 'NaN'::numeric)`),
]);

export const shopQuantityPriceOptions = pgTable("shop_quantity_price_options", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id").notNull().references(() => shopListings.id),
  name: text("name").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
  price: numeric("price", { precision: 12, scale: 2 }).notNull(),
}, (table) => [
  uniqueIndex("shop_quantity_price_options_quantity_idx").on(table.listingId, table.quantity),
  check("shop_quantity_price_options_valid", sql`${table.quantity} > 0 AND ${table.quantity} <> 'NaN'::numeric AND ${table.price} >= 0 AND ${table.price} <> 'NaN'::numeric`),
]);

// Inventory is the append-only source of on-hand stock; the opening row is idempotent for offline sync.
export const stockMovements = pgTable("stock_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  listingId: uuid("listing_id").notNull().references(() => shopListings.id),
  actorId: uuid("actor_id").notNull(),
  clientId: uuid("client_id").notNull(),
  kind: text("kind").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("stock_movements_kind_valid", sql`${table.kind} IN ('opening')`),
  check("stock_movements_quantity_valid", sql`${table.quantity} >= 0 AND ${table.quantity} <> 'NaN'::numeric`),
  uniqueIndex("stock_movements_client_id_idx").on(table.listingId, table.clientId),
  uniqueIndex("stock_movements_one_opening_idx").on(table.listingId).where(sql`${table.kind} = 'opening'`),
]);

// Pending uploads bind the server-declared size to a shop and actor. They are
// disposable; durable visits never depend on their lifecycle (#321, DEL-10).
export const visitPhotoUploads = pgTable("visit_photo_uploads", {
  id: uuid("id").primaryKey(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  actorId: uuid("actor_id").notNull(),
  byteLength: integer("byte_length").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  check("visit_photo_uploads_size_valid", sql`${table.byteLength} BETWEEN 1 AND 10000000`),
  index("visit_photo_uploads_expiry_idx").on(table.expiresAt),
]);

// Actor IDs deliberately have no account FK: deleting personal details must
// preserve the nameless actor and evidence history (DEL-12), like admin_actions.
export const shopVisits = pgTable("shop_visits", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  actorId: uuid("actor_id").notNull(),
  visitDate: date("visit_date").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  pan: boolean("pan").notNull(),
  fssai: boolean("fssai").notNull(),
  ownerPhone: boolean("owner_phone").notNull(),
  ownerEmail: boolean("owner_email").notNull(),
  alarmPermission: boolean("alarm_permission").notNull(),
  testerOptIn: boolean("tester_opt_in").notNull(),
  notes: text("notes"),
}, (table) => [
  check("shop_visits_date_valid", sql`isfinite(${table.visitDate}) AND ${table.visitDate} <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`),
  check("shop_visits_checks_complete", sql`${table.pan} AND ${table.fssai} AND ${table.ownerPhone} AND ${table.ownerEmail} AND ${table.alarmPermission} AND ${table.testerOptIn}`),
  check("shop_visits_notes_valid", sql`${table.notes} IS NULL OR char_length(${table.notes}) <= 500`),
  index("shop_visits_shop_recorded_idx").on(table.shopId, table.recordedAt.desc()),
]);

// Photo and GPS data may be purged a year after closure without deleting the
// visit's date, actor or checks, which have the shop's eight-year clock (DEL-10).
export const visitPhotos = pgTable("visit_photos", {
  id: uuid("id").primaryKey(),
  visitId: uuid("visit_id").notNull().unique().references(() => shopVisits.id),
  objectKey: text("object_key").notNull().unique(),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  // Camera-local EXIF text, without inventing a timezone.
  capturedAt: text("captured_at"),
}, (table) => [
  check("visit_photos_key_valid", sql`btrim(${table.objectKey}) <> ''`),
  check("visit_photos_latitude_valid", sql`${table.latitude} BETWEEN -90 AND 90`),
  check("visit_photos_longitude_valid", sql`${table.longitude} BETWEEN -180 AND 180`),
]);

export const onboardingFees = pgTable("onboarding_fees", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopId: uuid("shop_id").notNull().references(() => shops.id),
  actorId: uuid("actor_id").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }),
  paymentDate: date("payment_date"),
  reference: text("reference"),
  reason: text("reason"),
}, (table) => [
  check("onboarding_fees_status_valid", sql`(${table.status} = 'waived' AND ${table.reason} IS NOT NULL AND ${table.amount} IS NULL AND ${table.paymentDate} IS NULL AND ${table.reference} IS NULL) OR (${table.status} = 'paid' AND ${table.amount} IS NOT NULL AND ${table.paymentDate} IS NOT NULL AND ${table.reference} IS NOT NULL)`),
  check("onboarding_fees_amount_valid", sql`${table.amount} IS NULL OR (${table.amount} > 0 AND ${table.amount} <> 'NaN'::numeric)`),
  check("onboarding_fees_date_valid", sql`${table.paymentDate} IS NULL OR (isfinite(${table.paymentDate}) AND ${table.paymentDate} <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)`),
  check("onboarding_fees_reference_valid", sql`${table.reference} IS NULL OR (btrim(${table.reference}) <> '' AND char_length(${table.reference}) <= 500)`),
  check("onboarding_fees_reason_valid", sql`${table.reason} IS NULL OR (btrim(${table.reason}) <> '' AND char_length(${table.reason}) <= 500)`),
  index("onboarding_fees_shop_recorded_idx").on(table.shopId, table.recordedAt.desc()),
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

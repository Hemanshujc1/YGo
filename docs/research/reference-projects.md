# Reference projects: what they contain and what they teach YGo

Scope: read-only review of `/Users/hemanshu/Desktop/YGo/References` (VaayuGO, Usthaan, Images). Paths below are relative to that directory unless absolute.
Legend: **[V]** verified in files, **[I]** inference, **[D]** verified in official docs (URL given).
Caveat: the `PROJECT_OVERVIEW.md` / `project-overview.md` files in Usthaan read as auto-generated summaries; I treat them as secondary and prefer package.json / source.

---

## 1. Per-repo findings

### 1.1 VaayuGO (closest analogue to YGo Phase 1)

**Purpose [V]** `VaayuGO/README.md`: full-stack delivery/marketplace for customer, shopkeeper, admin roles; includes an optional "Xerox" print-service module (`VaayuGO/Docs/implementation.md`).

**Stack [V]**
- Client: React 19, Vite 7, Tailwind 4, React Router 7, Axios, jsPDF (`VaayuGO/client/package.json`). Plain JS (no TypeScript), web only.
- Server: Node + Express 5, Sequelize 6 on MySQL (mysql2), bcryptjs, jsonwebtoken, Nodemailer, Multer + Sharp, pdf-lib, node-cron, decimal.js, helmet (`VaayuGO/server/package.json`). CommonJS.
- Two independent npm projects (`client/`, `server/`), no workspace/monorepo tooling, no shared package. README says `npm run install-all` / root `npm run dev`, but **no root package.json exists** in the folder [V] (file listing).

**Architecture [V]** Controller -> Service -> Model (`server/controllers`, `services`, `models`, `routes`, `middlewares`, `cron`). Single Express app mounting `/api/auth|admin|shop|products|public|orders|files|contact|cart|discounts|xerox` (`server/index.js`). Cron jobs in-process (`server/cron/*`).

**Data model [V]** (`server/models/*.js`, associations in `models/index.js`; a schema dump is in `Docs/Database.json`)
- `User` (role enum customer/shopkeeper/admin; email unique; mobile; address+`location` as free strings; `is_verified`, `is_blocked`, OTP fields).
- `Shop` (owner_id -> User, status pending/approved/rejected/suspended, `is_open`, opening/closing/break times as HH:mm strings, `closed_days` JSON, ratings). `User.hasOne(Shop)` so one shop per owner.
- `Product` (shop_id, price, `stock_quantity`, `is_available`, images JSON), `Category`, `ShopCategory` (M:N).
- `Order` (customer_id, shop_id, totals as FLOAT, status enum pending/accepted/out_for_delivery/delivered/failed/cancelled, payment_status/method cod|online, `delivery_otp`, failure/cancel reasons, `delivery_attempt`, delivery_slot_id/date, settlement_id), `OrderItem` (price_at_time snapshot).
- Money engine: `DeliveryRule` (per location/category/shop: delivery fee split shop/platform, `commission_percent`, min order, small-order fee and split, `min_platform_revenue`, free-delivery threshold), `DiscountRule` (PERCENTAGE/FLAT; creator ADMIN/SHOP; target GLOBAL/LOCATION/CATEGORY/SHOP/PRODUCT), `OrderRevenueLog` (per-order immutable breakdown: subtotal, discounts, delivery shares, commission, `shop_final_settlement`, `platform_net_revenue`), `Settlement` (weekly per shop: COD collected, online collected, commission, penalties, `net_payout`), `Penalty` (polymorphic target customer/shop), `DeliverySlot` (start/end/cutoff), `Location` (named zone).
- Xerox: `XeroxConfiguration`, `BindingOption`, `XeroxDocument`; `Product.is_xerox_service`/`xerox_metadata`.

**Auth [V]** Email+password (bcrypt), JWT in `localStorage`, `authenticateToken` + `authorizeRole(roles)` middleware (`server/middlewares/authMiddleware.js`, `client/src/context/AuthContext.jsx`). Email OTP (6 digit) for verification and password reset, 5 min expiry (`server/services/AuthService.js`).

**Order / payment / delivery flow [V]** (`server/services/OrderService.js`)
- `createOrderTransaction` runs in a DB transaction: resolves rule by priority shop > category > location (`RuleEngineService.js`), computes discounts, commission per item, delivery/small-order splits, platform-revenue floor (caps platform discount), adds pending customer penalties, writes Order + OrderItems + OrderRevenueLog.
- Status guards: accepted only from pending; out_for_delivery only from accepted; delivered only from out_for_delivery **and requires matching 4-digit `delivery_otp`**; failed -> retry next slot (`delivery_attempt`); cancelled by customer/shop/admin; `final_status_locked`.
- Payment: enum has `online` but **no payment-gateway code or dependency found** (no razorpay/stripe etc. in package.json). COD is the real path. [V by absence in package.json; I that online is unfinished]
- Delivery: the shop delivers; there is **no rider/delivery-staff entity or app** [V: no model; grep for rider/agent/worker found nothing]. `delivery_rating` is on the order/shop only.
- Settlement: weekly cron Monday 02:00 (`server/cron/settlementCron.js`) sums delivered, unsettled `OrderRevenueLog`s per shop; `Docs/SettlementPage.md` and `Docs/VaayuGo_Metrics - Sheet1.csv` define admin columns/metrics.

**Geo / search [V]** No lat/long, no distance query anywhere in server code. "Nearby" = `Location` zone name matched to `User.location` string (`OrderService.js`). So geo search is a **gap**.

**Repo ops [V]** `Docs/../ProductionSetup.md`: Vercel (client), DigitalOcean droplet with Nginx+Certbot, PM2, local MySQL. No Docker, no CI, no tests (`server` test script is a stub).

### 1.2 Usthaan (large, older, multi-repo platform; mostly an architecture lesson)

| Repo | Purpose | Stack (from package.json) |
|---|---|---|
| `usthaan-ts-types` | Central domain-type package, generated JSON schemas, runtime validation, versioned schema publishing | TypeScript 4.8, mocha, aws-sdk/@aws-sdk/client-s3, `jsonschema` (per its overview) |
| `usthaan-lekha` | Offline-first accounting/billing/inventory/POS app for store owners | Angular 12, Ionic 5, Capacitor 6, Electron 33, PouchDB 9 (`usthaan-lekha/package.json`) |
| `usthaan-sthaan` | Multi-tenant customer storefront front-end (Nx monorepo) | Angular 11, Ionic 5, Nx (`@nrwl/workspace` 9.2.3), Jest, Cypress, Cashfree JS |
| `usthaan-media-ingestion-service` | Image upload to S3 | Node/TypeScript 5.3, Express-based internal pkg, multer, jimp, aws-sdk v2, bunyan |

**Architecture [V]**
- Backend services are **not in the folder**; `usthaan-sthaan/project-overview.md` lists external APIs (`/auth`, `/browse`, `/*-cart`, `/order`, `/store-order`, `/delivery`, `/subscriptions`, `/media`) and many private `usthaan-*` npm packages (auth-entities, cart/order/delivery service types, delivery-charges-calculator, promotion-lib, gst types). [V that these are listed in the overview; I that they are private since not present]
- `usthaan-sthaan`: tenant by subdomain (`README.md`: `store_r3.localhost.com`), apps `mukhya` (+ `mukhya-e2e`) and `store-theme1`, one lib `contact-info-page-lib` (`apps/`, `libs/`). PWA service worker noted in README.
- `usthaan-lekha`: PouchDB locally, syncs to CouchDB per its overview (`PROJECT_OVERVIEW.md`); README TODO lists "encrypt the database" unchecked. Per-vertical modules (jewellery, clinic, tailoring, education) in the same app: a symptom of scope creep [I].
- `usthaan-media-ingestion-service`: single `POST /api/v1/image`, headers `IngestionService-MediaType` / `-MediaOwner`, returns path immediately then uploads to S3 asynchronously with retry; bucket rollover when full; path `bucket/store_id/type/<ts>/raw/<ts>.ext` (`README.md`, `deploy/configs.json`: ECS/CloudFormation, ap-south-1). Test fixtures validate size/mime. [V]

**Data model (ts-types) [V]** `usthaan-ts-types/src/core-types/*.ts` (~70 files), each entity versioned by suffix (`Order10`, `Order11`, `Order12`) with a `schema: "Order_1_0"` literal field.
- Order split: `Order10` (user-level, payment attempts, delivery address) contains `StoreOrder10[]` (per-store, items, status). This is a **multi-store cart -> one order -> N store orders** model (`order-types.ts`). Platform fee per store modelled as a sales bill + credit note (`store_charges`, `adjusted_store_bill`).
- Statuses: `OrderStatus10` CREATED/IN_PROGRESS/CANCELLED/COMPLETED; `StoreOrderStatus10` IN_PROGRESS/COMPLETED/CANCELLED/COMPLETED_AND_STORE_PAID; `OrderItemStatus10` APPROVAL_PENDING ... READY_FOR_PICKUP, PICKED_UP, DELIVERED, STORE_CANCELLED, USER_CANCELLED. Per-item status with notes and audit (`status_updated_by`).
- Delivery: `DeliveryHandler10` = SELF | USTHAAN (`store-types.ts`) - exactly YGo's phase 1 vs later split. `OrderDeliveryTrackEntry` has assigned_to/agent_username/assignment_history and UNASSIGNED/ASSIGNED/PICKED_UP/DELIVERED (`order-delivery-types.ts`). `OrderFulfilmentMechanism10` DELIVERY|PICKUP|BOTH. `Shipment` types include `ProofOfDelivery10` PHOTO|OTP|NONE and attempt statuses (`shipment-types.ts`).
- Delivery charges by area/pincode with free-delivery minimum (`store-types.ts`: `AreaDeliveryCharge10`, `FixedOrderDeliveryCharges10`, `OrderDeliveryArea10`). So geo is **pincode-based**, not radius-based. `GeoLocation10` (lat/long) exists in `misc-types.ts` for tracking.
- Commission: `CommissionType` PERCENTAGE | FIXED | LUMPSUM, `item_wise` flag, tiered values (`commission-types.ts`).
- Payments: `PaymentStatus10` PENDING/SUCCESS/FAILED, `PaymentOption10` CASH_ON_DELIVERY|PREPAID, gateways CCAVENUE|CASHFREE, multiple payment attempts per order (`payment-types.ts`, `order-types.ts`).
- Inventory: shared vs individual inventory, `InventoryReservation10`, moving stock (`inventory-types.ts`, `moving-stock-types.ts`).
- Authorization: entities tiered L0/L1 per store/chain/user (`authorization-entities-level-types.ts`); store chains with CHAIN_LEAD/CHAIN_PART/INDIVIDUAL.
- Many unrelated verticals (clinic, rental, jewellery, education, tailoring, GST return schemas) - most irrelevant to YGo.

**Auth [V/I]** Sthaan overview: phone/OTP login, 2FA authenticator, invited users (overview only; auth service source absent). Ingestion service uses private `usthaan-auth-guard`.

**Shared-code approach [V]** (the key lesson)
1. TypeScript types are the source; build step converts to JSON Schema (`build-scripts/type-to-schema.ts`), publishes schemas to S3 with `latestMarkers.json` (default version + per-service overrides), and `src/validate.ts` fetches/caches schemas for runtime validation. Services pin versions independently.
2. Frontends use Nx workspace libs.
3. Everything else shared through private npm packages across ~15 repos.
Trade-off [I]: strong contract versioning and non-TS consumers supported, but heavy tooling (S3 deploy of schemas, marker merging, Jenkins) and entities proliferate versions (`Order10/11/12`, `StoreOrder10..13`).

**Deployment/ops [V]** Jenkins Groovy pipelines (`JenkinsBuild/Deploy/Publish.groovy`) in each repo; ingestion service on AWS ECS via CloudFormation/CDK (`deploy/`). Dated stack (Angular 11/12, Node 10 mentioned in lekha README, Nx 9) - do not copy versions.

---

## 2. Reusable patterns, pitfalls, gaps vs YGo needs

### Reusable patterns
1. **Immutable per-order revenue snapshot** (VaayuGO `OrderRevenueLog`): store every computed amount at order time so later rule changes never alter history; settlements aggregate the snapshots. Fits commissions and weekly payouts. [V pattern; I fit]
2. **Rule resolution by specificity** shop > category > location (`RuleEngineService.js`); Usthaan adds commission scopes in admin UI (`Images/ADMIN` Pricing screen: global/area/category/shop overrides + price simulator).
3. **Decimal money** (`decimal.js`) and `price_at_time` on items (VaayuGO). Counter-pattern: `Order` totals still stored as FLOAT (pitfall below).
4. **OTP at delivery handover** with attempt count and failure reasons (`OrderService.js` ~L340-375) matches YGo's OTP-delivery need; Usthaan's `ProofOfDelivery` enum (PHOTO|OTP|NONE) suggests making proof type configurable.
5. **Order -> per-shop sub-order split** (Usthaan `Order`/`StoreOrder`) if multi-shop carts are ever wanted; VaayuGO is single-shop-per-order (`Order.shop_id`) which is simpler.
6. **`DeliveryHandler` SELF|PLATFORM + assignment track entry with history** for the phase 1 -> later delivery-partner migration.
7. **Role-guarded API** (`authorizeRole`) and role-segmented route trees (`client/src/App.jsx`: `/shop/*`, `/admin/*`).
8. **Versioned, validated shared contracts** (ts-types). A lighter variant for YGo is inference: one shared package of schemas/types used by all apps and the backend.
9. **Media upload as separate concern**: validate type/size/resolution, return stable path, store by owner (ingestion service). Pre-signed or direct-to-object-store approaches are alternatives [I].
10. **Offline billing** (Lekha; also in the Shopkeeper UI mocks "Offline mode - Queued 3"). PouchDB<->CouchDB replication provides one-way/two-way sync with retry and deterministic conflict winner [D: https://pouchdb.com/guides/replication.html]. Counter-evidence: Lekha README lists DB encryption as unfinished.

### Pitfalls observed [V]
- Plain `Math.random()` for OTPs and OTP **logged to console** and stored unhashed (`AuthService.js` L45, L137-149). Use CSPRNG, hash, rate-limit, expire.
- `server/.env` and `client/.env` exist in the folder (values not read here beyond key names). `.gitignore` lists `.env`, but confirm they were never committed. JWT in `localStorage`; CORS defaults to `*`.
- `sequelize.sync()` plus an inline `ALTER TABLE` patch at boot (`server/index.js`); no migrations. `Docs/improvements.md` documents an onboarding bug (unverified user rows block re-registration).
- FLOAT for money columns on `Order`; DECIMAL in logs. Inconsistent.
- Location as free-text string matched by name; shop->location resolved via the owner's `User.location`. No geography.
- Cron in the API process (duplicate runs if scaled horizontally); weekly settlement loops over `Shop.is_active` (field not in the `Shop` model shown, which has `status`/`is_open`) - likely bug [V inconsistency; I impact].
- Unlimited `50mb` JSON body limit; uploads on local disk.
- Zero tests (VaayuGO). Usthaan has mocha/jest/cypress but old versions.
- Usthaan: version-suffixed entity explosion; verticals in one codebase; private package web makes the system unreadable from outside.

### Gaps relative to YGo needs
| YGo need | VaayuGO | Usthaan | Gap |
|---|---|---|---|
| Multi-role apps (admin, shop, delivery/worker, customer) | 3 roles, web only, `role` enum on User | store/chain/user, tiers | No worker/staff role in either; need staff-of-shop and later platform delivery partner |
| Inventory | `stock_quantity` only; no decrement logic found in order flow (grep) | rich (reservation, moving stock) | Need atomic stock decrement/reservation, low-stock |
| Billing (counter/POS) | PDF invoices client-side | Lekha is a full billing app | Counter billing + online orders sharing stock (UI mock shows it) |
| OTP delivery | Order delivery OTP exists | PROOF types | Phone/SMS OTP provider not present; email only |
| Geo/nearby | none | pincode areas | Need lat/long + radius query (2-3 km) |
| Commissions | rule engine + revenue log | commission types | Good base in VaayuGO |
| Payments | COD only in practice | Cashfree/CCAvenue enums | Gateway, refunds, COD reconciliation |
| Mobile | none (web) | Ionic/Capacitor (old) | All mobile work is new |

---

## 3. Domain vocabulary candidates

| Term | Usage in references | Ambiguity / note |
|---|---|---|
| Shop | VaayuGO `Shop` (1:1 owner); mocks "Shop Partner" | Usthaan says **Store**. Pick one. Mocks use both "shop" and "store" ("Nearby stores", "Nearby shops") |
| Store / Store chain / Branch | Usthaan `Store`, `StoreChain`; mocks "Main Branch" | Branch concept implies multi-outlet shops; VaayuGO has none |
| Shopkeeper / Owner / Manager / Counter staff | VaayuGO role `shopkeeper`; mocks "Owner / Manager / Counter Staff view" | "Shopkeeper" is role and a person; staff roles are a sub-division |
| Customer / User | VaayuGO `customer`; Usthaan `User` = customer | Usthaan "user" means shopper; VaayuGO `User` table holds all roles. Overloaded |
| Order | VaayuGO one shop; Usthaan `Order` (user-level) vs `StoreOrder` | Overloaded; decide whether a customer order can span shops |
| Order status | VaayuGO pending/accepted/out_for_delivery/delivered/failed/cancelled; mocks Placed/Accepted/Preparing/Ready/Assigned/Out for delivery/Delivered/Expired/Rejected by shop | Mocks add Preparing/Ready/Assigned/Expired; VaayuGO has no "ready" |
| Delivery slot | VaayuGO `DeliverySlot`; mocks Instant / Scheduled / Self-pickup | "Slot" vs "mode" |
| Fulfilment | Usthaan `OrderFulfilmentMechanism` DELIVERY/PICKUP/BOTH | Matches mock "Self-pickup" |
| Delivery handler | Usthaan SELF/USTHAAN | Good name for phase split |
| Delivery staff / Delivery partner / Agent / Worker | mocks "Delivery Staff App", "delivery partner" (customer UI), Admin "Partners"; Usthaan `assigned_to`, `agent_username` | Heavily overloaded: "Partner" in admin mocks = **Area Partner** (commissioned local manager), in customer mock = delivery rider. Avoid "partner" unqualified |
| Area / Location / Zone / Service area | VaayuGO `Location`; Usthaan `OrderDeliveryArea` (pincodes); mock Admin "Areas" | Name vs polygon vs pincode vs radius undefined |
| Commission | VaayuGO `commission_percent`; mock scopes Global/Area/Category/Shop with minimum | Base (items after discounts, before platform coupons per mock text) is a decision |
| Platform earning / Net revenue | `platform_net_revenue`; mock "Platform earning (E)" | Define formula once |
| Settlement | VaayuGO weekly; mock "weekly settlement runs every Sunday", ledger, record payment, "Mark settled" | VaayuGO pays shop out; mock has shops **owing** platform (COD) - opposite direction |
| COD limit | mock only: shop balance owed vs limit, auto-pause at 100% | New concept absent from code |
| Fine / Penalty | VaayuGO `Penalty` (customer or shop); mock "Fines", "Waive fine" | Same thing, two names |
| Coupon / Discount rule | VaayuGO `DiscountRule`; Usthaan `promo-types` | Shop-funded vs platform-funded vs "sponsorship" |
| Bargain | mock badge "Bargain", "Bargain accepted", "Rejected bargains" | Unknown feature (price negotiation?) - needs clarification |
| Never Rejects / Never Delayed / Sponsored / Newly Launched | mock shop badges | Likely derived trust badges and paid placement |
| Master catalog / Master product | mock Admin "Master products", shop "From Master Catalog", approval queue | VaayuGO has per-shop products only |
| Counter bill / Counter price / Online price | mocks | Two price channels per product |
| KYC | mock Admin shops | no equivalent in code |
| Task | mock Admin "Tasks" | Admin to-do queue |
| Brand name | files say VaayuGO / uSthaan; mocks say **WhyUGO** ("Kyun jaana? Ghar baithe aayega.") | Brand in images differs from "YGo"; do not carry names |

---

## 4. UI inspiration (Images/)

All 24 per-screen PNGs plus 2 showcase boards are AI-generated mock-ups (file names `ChatGPT Image Oct 5, 2026 ...`) [V], so they express intent, not implemented behaviour.

**Shared design language [V from images]**: deep teal/green primary with a bright cyan/mint accent in dark mode, white or near-black surfaces, rounded cards, pill chips and status badges, soft pastel tinted icon tiles (orange/blue/green/purple), consistent light and dark variants of every screen, bold sans-serif headings with the green "UGO" wordmark treatment, Rupee pricing, Indian context (Kirana, COD, UPI). `VaayuGO/client/ColorPalette.md` is a different palette (black + electric cyan) - the two do not agree.

**Admin web (7 screens, `Images/ADMIN`)**: left sidebar (Dashboard, Areas, Shops, Orders, Tasks, Catalog, Pricing, Coupons, Fines, Settlements, Complaints, Partners, Reports, Content, Users & Roles, Audit Log, Settings); top bar with global search, area filter, date filter, theme toggle, notifications, user menu.
- Dashboard: 8 KPI tiles (orders today, accepted %, delivered %, platform earning, outstanding balances, shops live, active customers, open tasks), open-task list with priority chips, stacked revenue chart (commission/delivery share/fines/coupons funded), area performance, top shops by outstanding balance with COD-limit bars, recent events, footer strip (onboarding fees, sponsorship receipts, next settlement run).
- Orders & Tasks: status tab bar with counts, dense table, side task queue, order detail panel with a status stepper; note "no live tracking for customers" in admin.
- Shops & KYC: application pipeline tabs, table, right drawer with owner details, map, KYC checklist progress, approve/request changes/reject/suspend.
- Catalog & Approval Queue: master product list, approval detail (name, category, images, barcode/GTIN, unit options), brands, search synonyms, category availability per area.
- Pricing/Coupons/Simulator: commission scope radios, overrides table, delivery slabs/extra charges/coupons/fines tabs, a live price simulator producing a breakdown.
- Settlements: summary tiles, per-shop statement table with COD-limit progress, ledger, record payment / mark settled actions.
- Complaints & Area Partners: split list/detail/timeline, action buttons (resolve, escalate, apply/waive fine, block customer, suspend shop), partner payouts, area pause switch, audit-log footer.

**Customer mobile (12 screens: `Images/Customer`, `Customer/part 2`)**: bottom tabs Home / Search / Orders / Cart or Account. Splash, set-location (map + radius copy "within 3 km"), home (location chip with distance, banner, category tiles, nearby shop cards with rating/ETA/fee/badges, popular products with discount tags), search (recent chips, category row, filter chips Fast Delivery/Under 100/Top Rated, results split Products/Shops, "Exclude" chip), store page (hero, open/close time, min order, free-delivery threshold, category chips, sticky cart bar), product page (pack size selector, **compare price at nearby shops**), cart & checkout (fulfilment Instant/Scheduled/Self-pickup, coupon, "pay with 500 note" toggle, itemised bill incl. small-order charge, COD/UPI/Card), order tracking (map, stepper, rider call/chat; later variant timeline with an "OTP appears after item check" notice).

**Shopkeeper mobile (5 + showcase, `Images/Shopkeeper`)**: bottom tabs Home / Orders / Catalog / (Customers) / More. Dashboard with status chips (Open now, Online sync, Queued), KPI tiles, "Action needed" cards with Accept / Partial / Reject and an acceptance countdown, quick actions (Orders, Add Product, Counter Bill, Staff, Reports), store performance, "You owe" COD balance, explainer videos. New order detail (loud alert, editable quantities, preparation time chips, partial acceptance). Catalog & inventory (online vs counter price, stock, low-stock/pending-approval filters, toggle, barcode scan, bulk upload, from master catalog, expiry discount). Counter billing (offline queue, manual item, payment mode Cash/UPI/Unpaid, PDF share, "No GST breakup in Phase 1"). Reports & settlement (sales by channel donut, top items, ledger summary).

**Delivery staff app (showcase board 2 only)**: Today's orders (pending/completed), order detail with Navigate, turn-by-turn map, 4-digit OTP entry, delivery proof photo, earnings chart.

---

## 5. Stack-relevant observations (evidence only; no recommendation)

- Evidence that UI targets mobile-first for customer/shopkeeper/delivery and web for admin (images). VaayuGO proved web-only React; Usthaan used Ionic/Capacitor hybrid (old versions) - evidence both for and against hybrid wrapping [I].
- Geo: radius search (2-3 km) is shown in mocks; neither repo implements it. Options: PostgreSQL+PostGIS (`ST_DWithin` uses spatial indexes; geography units are meters) [D: https://postgis.net/docs/ST_DWithin.html]; other DBs with native geo; or geohash/H3 in app code (not verified here). Trade-off: PostGIS is a SQL-native fit with VaayuGO's relational model; JSON-document stores (Usthaan Pouch/Couch) would need separate geo handling.
- Relational vs document: VaayuGO's settlement/commission/ledger needs joins and transactions (V: Sequelize transaction); Usthaan used documents with nested arrays and versioned schemas. Evidence leans relational for money flows [I].
- Monorepo: Usthaan Nx workspace vs Turborepo as in the brief. Turborepo is a build system using package.json scripts and one `turbo.json`, supports npm/yarn/pnpm workspaces [D: https://turborepo.dev/docs]. Neither repo shows a combined Next.js + React Native monorepo; Nx is evidence of precedent only.
- Offline: PouchDB/CouchDB sync gives replication with retry and deterministic conflict winner [D: https://pouchdb.com/guides/replication.html]; alternative is an outbox queue plus server idempotency keys (not evidenced in refs). Stock correctness across offline counter bills and online orders is the hard part [I].
- Shared contracts: ts-types shows a typed-schema-to-runtime-validation path; a simpler in-monorepo shared package achieves part of it [I].
- Background work: VaayuGO in-process node-cron vs a job queue/scheduler; evidence of duplicate-run risk only [I].
- Not verified: Next.js, React Native/Expo, specific backend frameworks - not used by any reference; no library capability claims made about them.

---

## 6. Open questions for the requirements interview

1. Name: shop vs store; and which term for shop staff, delivery staff, and the "Area Partner" in the mocks?
2. Can one customer order contain items from multiple shops, or strictly one shop per order?
3. Phase 1 delivery: who is the "worker" (shop employee with their own login)? Does the Delivery app exist in Phase 1 or only for later platform riders?
4. How is "nearby" defined: radius from shop, polygons, pincodes, or admin-drawn areas? Hard 2-3 km cap?
5. Payments in Phase 1: COD only (as VaayuGO and the mock settlement imply), UPI at delivery, or an online gateway with refunds?
6. Money direction: does the platform collect COD cash via shops (shops owe platform, COD limit, auto-pause as in mocks), or pay shops out weekly (VaayuGO)? Settlement cadence?
7. Commission base and scopes: after shop discounts? before platform coupons? minimum per order? override by area/category/shop? Who funds coupons and "sponsorship"?
8. Delivery fee and small-order fee: who keeps them (shop/platform split as VaayuGO) and are they distance- or slab-based?
9. Inventory: single stock count shared between online and counter billing? Reserve stock at order placement or at acceptance? Partial acceptance semantics (mock "Partial")?
10. Is there a platform master catalog with approval queue (mocks) or per-shop products only (VaayuGO)? Loose/weighted items (0.5 kg steps)?
11. What is "Bargain" and "Never Rejects / Never Delayed / Sponsored" - Phase 1 features or aspirational?
12. OTP: SMS/WhatsApp provider, login OTP vs delivery-handover OTP, when is the handover OTP revealed (mock: after item check)?
13. Offline requirements: counter billing offline only, or whole shopkeeper app? Expected conflict handling?
14. Tax/invoicing: GST needed at launch (mock says no GST breakup in Phase 1)? Invoice/PDF requirements?
15. Compliance/KYC: shop KYC fields, regulated goods (pharmacy appears in mocks), age/prescription rules?
16. Languages and low-end device targets for shopkeepers? Dark mode required (mocks show both themes)?
17. Brand/design: mocks say "WhyUGO"; confirm YGo naming, palette, and whether these mock-ups are a binding design direction.
18. Scale and hosting expectations (India-region, single city pilot?) and tolerance for managed cloud vs self-hosted (VaayuGO used a single droplet).

# PRD — WhyUGO: Hyperlocal Shop-Ordering Platform (Phase 1)

## Status
[ ] Draft  [ ] In Review  [x] Approved
Last updated: 2026-10-05 | Author: AI-assisted, for the founder | Version: 1.1 (v1.0 approved 2026-10-05; v1.1 adds iOS in Phase 1 and light/dark themes) | Related: Section 0 (no separate Vision Doc; decided)

### How to read this document (for coding agents)
- **shall** = mandatory in Phase 1. **should** = build if time allows (see cut line in 4.3).
- **Default:** values are starting values. Every Default is an admin-panel setting unless marked *(fixed)*. All settings are listed in Appendix C.
- Currency is INR (₹). Store money as integer paise. Time zone is IST (UTC+5:30) everywhere.
- IDs: `J-xx` journeys, `FR-<AREA>-nn` functional requirements, `NFR-xx`, `OQ-xx` open questions.
- **If something is not specified, do not assume.** Ask the founder, or use the default listed in Section 11 (Open Questions) until answered.
- Brand name is **WhyUGO**; tagline is **"Kyun jaana? Ghar baithe aayega."** Store both as settings (`app.name`, `app.tagline`); never hard-code them in code or screens.
- Where an older and newer decision conflicted, the newer one is used. See Appendix F.

---

## 0. Vision & Positioning
- **What:** A hyperlocal ordering platform connecting customers to shops within 3 km (groceries, fruits and vegetables, stationery and print, hardware, and other local categories chosen by admin). Customers discover everything nearby, compare by shop, and order in the app. Shops deliver with their own staff in Phase 1.
- **Core wedge (primary):** "Discover everything nearby." **Secondary:** a free-to-start digital storefront and billing tool for local shops (online and offline billing together).
- **Positioning:** Defend local shops against Zepto, Blinkit and Swiggy. Compete on affordable local prices, loose and unbranded items (spices, grains, sold by weight), bargaining like a real local shop, and trust (ratings, badges, area partners who are locals).
- **Ambition:** India-wide platform. **Phase 1 is a pilot:** 3-4 small areas or villages, 50-80 shops, 100-400 customers at launch, 3-4 categories, about 50 orders per day.
- **Pause rule (fixed):** 50+ orders/day in month 2 means keep scaling. 20-50 means diagnose problems. Under 20 means stop adding features and diagnose.
- **Brand:** WhyUGO. Tagline: "Kyun jaana? Ghar baithe aayega." (the only Hinglish copy; it appears on splash, store listing and share cards). The UI itself stays English-only, minimal text, icons first, with short explainer videos.

## 1. User Problem
Villagers and small-town residents depend on local shops but cannot see what is in stock, what it costs, or who is open without visiting or phoning. Large quick-commerce apps don't serve them, or serve them with higher prices and no loose items. Local shopkeepers lose customers to those apps, have no online presence, keep paper or ad-hoc records, and cannot afford heavy software. The platform gives customers one place to discover and order from nearby shops, and gives shops simple tools (catalogue, billing, orders, delivery) at pilot-friendly cost.

## 2. Personas and Roles

| # | Role | Who | Goals | Pain points | Context of use |
|---|---|---|---|---|---|
| R1 | **Customer** | Resident within 3 km of listed shops | Find items nearby, fair price, bargain, trust the shop, get delivery or pick up | Can't see stock/price, no trust, cash-only | Android phone, low-medium data, English UI |
| R2 | **Shop Owner** | Owner of one business, 1+ branches | More customers, simple tools, fair fees | Low tech skill, offline power/network cuts, cash handling | Phone and sometimes a PC at counter |
| R3 | **Shop Manager** | Trusted staff of owner | Run orders, stock, prices | Same as owner | Phone/tablet |
| R4 | **Counter Staff** | Billing/cashier | Fast billing, stock update | Poor connectivity | Phone/tablet, offline often |
| R5 | **Delivery Staff** | Shop's own worker | Clear route, easy proof of delivery | Unclear address, change for cash | Own phone, outdoors, offline gaps |
| R6 | **Super Admin** | Founder | Configure everything, control money flow, monitor | Needs total control without code changes | Web admin panel |
| R7 | **Operations/Support** | Ops helper | Onboard shops, approve catalogue, call shops, handle complaints | Volume, follow-ups | Web admin panel (limited) |
| R8 | **Area Partner** | Local friend/partner for an area | Grow area, resolve disputes, earn share | Needs area-limited view | Web admin panel (area-scoped) |

**Rules (fixed):** Roles are permission sets stored in the database (role → permissions). Adding or editing a role needs no code change. Manager and Counter Staff can be limited to specific branches. Finance and Catalog-manager roles are *not* built in Phase 1 (they stay inside Super Admin and Ops).

### 2.1 Permission matrix (✔ = allowed, ◐ = limited as noted, ✖ = not allowed)

| Capability | R1 | R2 Owner | R3 Mgr | R4 Counter | R5 Deliv. | R6 Admin | R7 Ops | R8 Partner |
|---|---|---|---|---|---|---|---|---|
| Browse, order, rate | ✔ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ |
| Shop profile, KYC, UPI ID, branches | ✖ | ✔ | ✖ | ✖ | ✖ | ✔ | ◐ view/edit KYC | ◐ view own area |
| Manage staff accounts | ✖ | ✔ | ✖ | ✖ | ✖ | ✔ | ✖ | ✖ |
| Products, stock, prices, discounts, bargain floors | ✖ | ✔ | ✔ | ◐ stock only | ✖ | ✔ | ◐ catalogue only | ✖ |
| Accept/reject/partial orders, set prep time | ✖ | ✔ | ✔ | ◐ view | ✖ | ✔ | ◐ view | ◐ view own area |
| Assign orders to delivery staff | ✖ | ✔ | ✔ | ✖ | ✖ | ✔ | ✖ | ✖ |
| Counter (offline) billing | ✖ | ✔ | ✔ | ✔ | ✖ | ✖ | ✖ | ✖ |
| Delivery app: own assigned orders, OTP, photo | ✖ | ✖ | ✖ | ✖ | ✔ | ✖ | ✖ | ✖ |
| Shop balance and statements | ✖ | ✔ | ✖ | ✖ | ✖ | ✔ | ✔ view | ◐ own area view |
| Master catalogue, categories, approve new items | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ | ✖ |
| Create shop application (assisted onboarding) | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✔ | ◐ own area, pending Ops approval |
| Commission, floors, slabs, charges, coupons, fines config | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✖ | ✖ |
| Waive/reduce a fine | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✖ | ◐ own area, up to `fine.partner_waive_limit` |
| Pause/resume an area | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✖ | ✔ own area |
| Complaints and disputes | ◐ raise | ◐ raise/respond | ✖ | ✖ | ✖ | ✔ | ✔ | ✔ own area first |
| Flag/block customers and shops | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ◐ flag only | ◐ flag only |
| Mark payments received, settlements, partner payouts | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✖ | ✖ |
| Users, roles, audit log, system settings | ✖ | ✖ | ✖ | ✖ | ✖ | ✔ | ✖ | ✖ |
| Reports | ✖ | ◐ own shop | ◐ own shop | ✖ | ✖ | ✔ all | ◐ ops reports | ◐ own area |

## 3. Business Goals

| # | Goal | Target |
|---|---|---|
| BG-1 | Month-1 platform revenue (including onboarding fees) | **Base ₹1.2-1.5 lakh. Stretch ₹2 lakh.** |
| BG-2 | Shops live in launch week | 50-80 |
| BG-3 | Customers in launch week | 100-400 |
| BG-4 | Orders per day (month 1) | about 50 |
| BG-5 | Platform earning per delivered order | at least the floor (Default ₹20); expected average about ₹48 |
| BG-6 | Shops never owe more than the COD limit | Outstanding balance under `cod.balance_limit` (Default ₹5,000) |
| BG-7 | Phase 1 built and in pilot | within 1 month by one developer using AI agents |

Revenue sources in Phase 1: onboarding fee (₹1,000 per shop, non-refundable, 1 year), commission, platform delivery share, platform share of extra charges, auto shortfall charges, shop top-ups, fines, sponsored listings (collected by the founder directly; recorded in the system).

## 4. Release Scope

### 4.1 Applications (React Native single codebase for Android + iOS mobile apps; React for web)
All three mobile apps (Customer, Shop, Delivery) ship on **both Android and iOS** in Phase 1. Every app supports **light and dark themes**.
1. **Customer Mobile App** (**Android and iOS** from one React Native codebase).
2. **Admin Web Panel** (also used by Ops and Area Partners with scoped permissions).
3. **Shopkeeper Mobile App** (Owner, Manager, Counter Staff).
4. **Delivery Worker App** (Delivery Staff; may be a mode inside the same mobile codebase, separate login role).
5. **Shopkeeper Web App** (lowest priority).

### 4.2 Build priority if time runs short (fixed)
Customer app → Admin panel → Shop app → Delivery app → Shop web.

### 4.3 Cut line
1. First cut: Shop web app (shop uses mobile app only).
2. Second cut (only if needed): Delivery app as a separate app. Fallback is a "Delivery mode" screen inside the Shop app with the same OTP/photo flow.
3. iOS launch may trail Android by up to 2 weeks if App Store review or testing delays it; iOS is not cut (same codebase, same features).
4. Everything else in this PRD marked **shall** must ship. Items marked **should** are cut before any **shall** item.

### 4.4 Technology decisions already made (fixed)
Backend NestJS (Node, TypeScript) + PostgreSQL. React Native (mobile). React (web). Socket.IO + push notifications for realtime. AWS or cheaper. Google Maps with strict quota. Email OTP login. Budget under ₹10-20k per year. Detailed architecture belongs in the ADR, not here.

---

## 5. User Journeys (intent level; steps alternate U = user, S = system)

**J-01 Customer first order**
1. U installs app, enters email. S sends OTP. U verifies, enters name, phone, and accepts Terms.
2. U drops a map pin, adds landmark text, tags the address (Home/Work/Other).
3. S shows home screen: nearby open shops (within 3 km straight line), categories, search bar.
4. U opens a shop, adds items to cart (one shop per cart).
5. U goes to checkout, picks Instant / Scheduled / Self-pickup, optionally selects a coupon and cash-note info.
6. S verifies road distance and recalculates the full price. U sees breakdown and total payable (COD).
7. U places order. S notifies shop. U sees live status until delivered.
8. U checks items, gets OTP, shares with worker, order is delivered. U rates the shop.

**J-02 Bargain**
1. U opens a bargain-enabled item and taps Bargain, enters price per unit for chosen quantity.
2. S compares with the shop's hidden floor price. If at or above floor, S accepts. Otherwise S rejects and records the offer.
3. U sees the accepted price in the cart. Commission is later computed on that price.

**J-03 Scheduled order**
1. U chooses Scheduled at checkout, picks a day (today or tomorrow) and a delivery shift for the area.
2. S auto-approves, shows the shop a "review asap" task. Shop confirms or rejects before the cutoff.
3. S informs U of confirmation or rejection early.

**J-04 Print order**
1. U picks a print-enabled shop, uploads files, selects options, sees price.
2. S places order. Shop accepts and must call U to confirm what is to be printed.
3. Shop prints, packs, delivers (or U picks up). S deletes files after delivery.

**J-05 Repeat grocery list**
1. U opens a past order or saved list and taps Reorder.
2. S re-prices items at the same shop, flags changed prices and out-of-stock items. U edits and orders.

**J-06 Shop onboarding**
1. Owner (or Ops/Area Partner on their behalf) enters shop details, location pin, categories, hours, KYC fields, UPI ID, accepts Terms.
2. Ops verifies. Founder collects ₹1,000. Ops marks fee paid. Admin approves. Shop goes live.
3. Shop selects products from the master catalogue or uploads CSV/Excel; sets prices, units, stock.

**J-07 Shop handles an order**
1. S pushes loud alert and alarm. Shop taps Accept, Partial, or Reject within the timer.
2. If partial, S asks customer to confirm the new total.
3. Shop sets or accepts prep time, packs, assigns a delivery staff member.

**J-08 Delivery and OTP**
1. Worker sees the order, customer pin, landmark, cash-note info, taps Start.
2. At the door worker taps Arrived and uploads a photo (GPS and time stamped).
3. Customer app starts a 1-minute item check timer; customer taps Items OK or the timer ends; S shows OTP.
4. Worker enters OTP. S marks Delivered. Worker app works offline and syncs.

**J-09 Failed delivery**
1. Worker cannot reach customer or customer refuses. Worker records reason and photo.
2. S marks Delivery Failed, counts toward customer refusal rules, shop keeps goods.

**J-10 Weekly settlement (Sunday)**
1. S generates each shop's statement. Shop sees "you owe ₹X".
2. Shop pays the founder by UPI. Admin records payment. S marks orders settled (oldest first).
3. S computes area partner share on settled earnings. Founder pays partner manually and records it.

**J-11 Complaint**
1. U or shop raises a complaint. S routes to the Area Partner, who resolves or escalates to Admin.
2. Admin may fine, waive, refund (manual), flag, or block.

**J-12 Area pause**
1. Admin or Area Partner pauses an area with a reason and expected resume time.
2. S shows a banner; instant orders blocked; scheduled orders allowed for after resume time.

**J-13 Offline billing**
1. Counter Staff creates a bill offline, stock reduces locally.
2. When online, S syncs; conflicts resolved per FR-OFF rules.

**J-14 Admin configures money rules**
1. Admin edits commission, floors, slabs, charges, coupons or fines at global, area, category or shop scope.
2. S validates, versions the change, writes an audit entry, applies it to new orders only.

**J-15 Shop hits the COD limit**
1. S warns the shop at 80% of the limit and pauses the shop's new orders at 100%.
2. Shop pays; Admin records payment; shop is auto-resumed.

---

## 6. Functional Requirements

### 6.1 Accounts, Authentication, Security (ACC)
- **FR-ACC-01** The system shall support email + one-time-code (OTP) login for all roles. No passwords. OTP is 6 digits, valid 10 minutes, max 5 wrong attempts then 30-minute lock, max 5 OTP requests per hour per email.
- **FR-ACC-02** Customer signup shall collect: email (verified by OTP), full name, phone (10-digit Indian mobile format check only; **not verified**), and acceptance of Terms and Privacy Policy.
- **FR-ACC-03** Phone numbers shall be stored and shown to shops/delivery staff only for the orders they serve (Default: masked in shop views 30 days after delivery).
- **FR-ACC-04** Customers shall save multiple addresses. Each address has: tag (Home/Work/Other + optional custom label), map pin (lat/lng), landmark text (required), house/flat text (optional).
- **FR-ACC-05** Shop staff (Manager, Counter, Delivery) shall be created by the Owner with name, phone and **their own personal email** (both required, same as customers; phone is stored but not verified). Staff log in on their own phone with email OTP.
- **FR-ACC-06** Customers, shopkeepers and delivery staff shall accept Terms before first use; acceptance (user, document version, timestamp, app version) shall be stored. New versions require re-acceptance.
- **FR-ACC-07** The system shall enforce role-based access control from the matrix in 2.1, checked server-side on every API call. Area Partner data access shall be limited to their assigned areas.
- **FR-ACC-08** Admin-panel users shall have an inactivity timeout (Default 30 minutes). Mobile sessions shall persist (Default 90 days refresh).
- **FR-ACC-09** The system shall write an audit log (who, what, old value, new value, time, IP/device) for every admin setting change, money-affecting action, fine, waiver, block, payment record and role change. Audit entries are read-only.
- **FR-ACC-10** Customers shall be able to delete their account **inside the app** (required by Apple and Google) and by request; personal data is removed or anonymised within 30 days except records required for settlement and disputes (anonymised).
- **FR-ACC-11** The system shall detect and flag (not auto-block) duplicate accounts (same device ID, same phone, or same address pin) and suspected fake location (mock-location flag, GPS pin far from device GPS at order time, impossible GPS jumps). Flags go to the Admin review queue.
- **FR-ACC-12** For Apple and Google app review, Admin shall be able to create a **reviewer demo account** (fixed email and fixed OTP, restricted to demo data, can be switched off). It is not usable by real users.
- **FR-ACC-13** Theme: every app and the admin panel shall support **Light, Dark, and System** (Default System), saved per user, switchable in settings. All colours come from semantic design tokens.

### 6.2 Shop Onboarding and Shop Profile (ONB)
- **FR-ONB-01** A shop application shall be creatable by the Owner (self), Ops, Admin, or an Area Partner (own area; pending Ops approval).
- **FR-ONB-02** Application fields (Default KYC set, editable by Admin): owner name, phone, email, shop name, address, map pin, category/categories, shop front photo, GSTIN (optional), UPI ID, Terms acceptance. No ID document upload in Phase 1 (see OQ-05).
- **FR-ONB-03** Statuses: Draft → Submitted → Under Review → Approved/Rejected → Live → Suspended → Closed. Only Admin can move to Live. Live requires: KYC complete, onboarding fee marked paid (Admin may waive with a reason).
- **FR-ONB-04** Onboarding fee: Default ₹1,000, valid 1 year, non-refundable, collected by the founder directly; Ops/Admin records amount, date, reference. Renewal after 1 year uses the same flow (shop is paused if expired; Default grace 7 days).
- **FR-ONB-05** A business (Owner) may have multiple **branches**. Each branch is a separate listing with its own location, hours, stock, prices, staff assignment, delivery area, and rating; the Owner login, KYC and balance are shared.
- **FR-ONB-06** Shops shall set opening hours per day, holidays (date ranges), and a manual Open/Closed switch with an optional "closed now" note. Customers see "Closed now" and the next opening time.
- **FR-ONB-07** Shops shall be able to set a default prep time (minutes) and update it per order; customers see an ETA (prep time + delivery estimate).
- **FR-ONB-08** Shops shall be able to opt in to the Print service at onboarding or later (FR-PRT).
- **FR-ONB-09** Shops shall share a public shop link and QR code; opening it in the customer app goes to the shop page; if the app is not installed it goes to the Play Store listing.
- **FR-ONB-10** The shop app shall show short explainer videos (links configurable in admin) for key tasks: accept order, add products, bill a customer, deliver an order.

### 6.3 Catalogue, Inventory, Pricing by Shop (CAT)
- **FR-CAT-01** The master catalogue shall be created and maintained by Admin/Ops: category tree, product (name, brand, description, image, barcode(s), default unit options). Admin sets which categories are enabled per area.
- **FR-CAT-02** A shop shall create its own listing by choosing master products and setting: price, stock, unit pack options, availability. A shop may submit a new product not in the master catalogue; it is **hidden from customers until Admin/Ops approves**.
- **FR-CAT-03** Bulk upload shall be supported by CSV and Excel (.xlsx) with a downloadable template. Validation shall report row-level errors without losing valid rows. Images may be uploaded as a ZIP matched by product code. Other easy methods: barcode scan, search-and-add from master catalogue.
- **FR-CAT-04** Units: shops define sale packs per product, each with label, quantity, unit (kg, g, L, ml, piece, dozen, bunch, pack) and price (examples: "12 bananas for ₹X", "100 g", "1 kg"). For loose items shops set price per unit and a **minimum order quantity and step** (example: min 100 g, step 50 g).
- **FR-CAT-05** Shops can set separate **online price** and **counter price** per product (Default: same).
- **FR-CAT-06** Stock shall be tracked per branch per product. Online stock and counter stock share one quantity. Orders reserve stock when accepted. Out-of-stock items are not orderable.
- **FR-CAT-07** Shops may set MRP (shown struck through when higher than selling price) and a selling price. Selling price is the shop's own; platform never changes it.
- **FR-CAT-08** Expiry: shops may enter an expiry date per product listing. Shopkeepers and customers see the expiry date. Shops can set a **near-expiry discount** (percent or flat) that auto-applies when days to expiry ≤ N (shop-set). It behaves as the shop's selling price reduction (shop-funded).
- **FR-CAT-09** Shops can set a **shop-wide discount** (percent or flat, with optional minimum cart value, optional validity dates). Shop-funded.
- **FR-CAT-10** Barcode/QR scanning with the device camera shall match **existing barcodes only** (EAN/UPC) against the master catalogue. No label generation in Phase 1.
- **FR-CAT-11** Admin shall manage a **search synonyms/transliteration table** (for example aata = ata = atta) and brand list.

### 6.4 Discovery and Search (DSC)
- **FR-DSC-01** Home screen shall show: nearby shops, categories, search bar (in that order).
- **FR-DSC-02** Shops are listed when the straight-line distance from the customer's selected address to the shop is ≤ `distance.list_radius_km` (Default 3 km). At checkout the system shall verify road distance via the maps provider and use it for delivery slabs (see FR-CRT-04). If the maps quota is exhausted or the call fails, fall back to straight-line distance × `distance.road_factor` (Default 1.3).
- **FR-DSC-03** Shop ordering (fixed): sponsored shops first (by slot rank), then by rating (higher first), then by distance (nearer first). Sponsored cards carry a "Sponsored" label.
- **FR-DSC-04** Search shall return products and shops together. Product results show "product @ shop" cards (price, pack, shop name, distance, ETA, open/closed), ordered by the same rule as FR-DSC-03. No cross-shop price comparison screen in Phase 1.
- **FR-DSC-05** Search shall tolerate spelling variants and use the synonym table (FR-CAT-11). English letters only in UI; Hindi/regional words typed in English letters (transliteration) shall match.
- **FR-DSC-06** Voice search shall use the phone's built-in speech recognition and then run the same text search.
- **FR-DSC-07** Customers shall be able to **exclude brands** in search (example: no Tata). Default: excluded brands persist in the customer's settings until removed.
- **FR-DSC-08** Closed shops remain visible, marked "Closed now". Scheduled orders remain possible if the shop accepts scheduled orders and the shift falls within shop hours.
- **FR-DSC-09** The shop page shall show: name, rating and count, trust badges, open/closed with a **closing-time countdown** when ≤ 60 minutes remain (Default), categories, products, ETA, minimum order value, free-delivery threshold.
- **FR-DSC-10** Additional filters and sorting beyond FR-DSC-03 are **not** in Phase 1 (see OQ-08).

### 6.5 Cart and Checkout (CRT)
- **FR-CRT-01** One shop (branch) per cart. Adding an item from another shop asks "Replace cart?".
- **FR-CRT-02** Minimum order value (Default ₹150, scope-able) shall be checked on **S** (item subtotal after shop-funded discounts and accepted bargains; see Appendix A). Below it, checkout is disabled with "Add ₹X more".
- **FR-CRT-03** Fulfilment options: **Instant**, **Scheduled** (FR-SCH), **Self-pickup**. Self-pickup has no delivery fee; commission, floor and min-order rules still apply.
- **FR-CRT-04** Delivery fee shall come from the slab table (Appendix A.5) using road distance and mode. It is free when S ≥ `delivery.free_threshold` (Default ₹400).
- **FR-CRT-05** The checkout shall show: items, bargains, shop discounts, delivery fee, extra charges (each named), small-order/shortfall charge if any, coupon saving, round-off, **total payable in cash on delivery**. Commission is never shown to customers.
- **FR-CRT-06** Customers may enter optional **cash-note info** ("I will pay with ₹500 note"). It is shown to the delivery worker.
- **FR-CRT-07** The coupon list shall show **only coupons that can apply** to this cart (rules + floor check, Appendix A.6). Coupons are never auto-applied; the customer selects one. At most one platform coupon per order (Default). A coupon trimmed by the floor rule applies at the reduced amount, and the UI shows the actual saving; a coupon whose applicable amount would be ₹0 is not shown.
- **FR-CRT-08** The server shall recompute the full price at order placement and reject stale client prices with a clear message and refreshed totals.
- **FR-CRT-09** Payment is **cash on delivery only** in Phase 1. No payment gateway.
- **FR-CRT-10** Customer cancellation: free until the shop accepts. After acceptance only with shop consent (request → shop approves/declines). After a partial fulfilment proposal, the customer must confirm the new total or cancel (see FR-ORD-05).
- **FR-CRT-11** Repeat list: customers can reorder a past order or a saved list from the **same shop**; the system re-prices every item, flags changed prices and unavailable items, and lets the customer edit before checkout.

### 6.6 Bargaining (BRG)
- **FR-BRG-01** Bargaining shall be available only on items the shop has **enabled** for bargaining. The shop sets a **hidden floor price per pack** (never sent to customer apps).
- **FR-BRG-02** The customer enters an offered price for the item at the chosen quantity. The system auto-responds: accept if offer ≥ floor, otherwise reject. Rejection text shall not reveal the floor.
- **FR-BRG-03** Limits (Default): 3 offers per item per customer per day; an accepted price is valid for 30 minutes and for that quantity; changing quantity requires a new offer.
- **FR-BRG-04** An accepted bargain replaces the shop's selling price for that item in the cart. The cost is **borne by the shop only**; commission is on the bargained price.
- **FR-BRG-05** Bargain price is still subject to the platform floor rule (Appendix A.4); the system may add a shortfall charge or shop top-up rather than reject the bargain.
- **FR-BRG-06** The shop shall see a **rejected offers report** (item, offered price, date, count) to help it adjust prices.
- **FR-BRG-07** Bargains may stack with shop discounts and a platform coupon, subject to the floor rule.

### 6.7 Orders (ORD)
- **FR-ORD-01** Order statuses and transitions are defined in Appendix B. No other statuses are allowed.
- **FR-ORD-02** On placement the shop shall get a push notification plus an in-app **loud alarm** (voice alert) with a large **Accept** button, repeating until acted on. **On iOS**, background alarms are limited: the shop gets a time-sensitive push with a custom sound plus the in-app alarm while the app is open; the 60-second Ops call task is the backstop (OQ-16).
- **FR-ORD-03** If the shop has not accepted within `order.accept_alert_seconds` (Default 60), the system shall create a **"Call this shop" task** for Ops and keep alerting the shop. If not accepted within `order.expire_seconds` (Default 180), the order auto-expires and the customer is notified; counts as a no-response event (FR-FIN).
- **FR-ORD-04** Shops shall be able to Accept, Partially accept (remove or reduce items), or Reject (with reason from a list).
- **FR-ORD-05** On partial acceptance, the system recomputes the price (Appendix A) and asks the customer to confirm the new total within `order.partial_confirm_minutes` (Default 5); no response = cancelled without penalty to either party.
- **FR-ORD-06** After accept, the shop sets or confirms prep time; the customer sees the ETA.
- **FR-ORD-07** The shop assigns the order to one of its delivery staff; one worker may carry **several orders at once**.
- **FR-ORD-08** Customers see status changes only; **no live tracking** of the delivery person. Status "Out for delivery" is the final in-flight status they see. The customer's pinned location is shared with the assigned worker.
- **FR-ORD-09** A call button (masked call not required; plain phone dial) shall let the customer call the shop and the worker call the customer and shop.
- **FR-ORD-10** No returns or refunds in Phase 1. Wrong/missing items go through the complaint flow (FR-FIN-05).
- **FR-ORD-11** Self-pickup orders: shop marks Ready; customer gets a pickup code (OTP) to show at the counter; shop enters it to mark Delivered.
- **FR-ORD-12** Each order stores an immutable **price snapshot** (every line, discount, fee, split, formula inputs, settings versions used) at placement and at each recomputation.

### 6.8 Delivery Worker App (DLV)
- **FR-DLV-01** The worker sees assigned orders: items count, shop, customer name, phone, address text, landmark, map pin, navigation button (opens maps), cash-note info.
- **FR-DLV-02** Flow: Start → Arrived (photo with GPS and time stamp) → customer item check (1 minute) → OTP entry → Delivered. See Appendix B.3.
- **FR-DLV-03** The OTP is shown **only in the customer's app**, after the customer taps **Items OK** or the check timer ends (whichever first). Default timer 60 seconds (`delivery.check_seconds`).
- **FR-DLV-04** Failed delivery: worker must try the call button at least once, wait `delivery.wait_minutes` (Default 5), then mark Delivery Failed with a reason (customer unreachable / refused / wrong address) and photo.
- **FR-DLV-05** The worker app shall **work offline**: cached assigned orders, ability to capture photo, record arrival and OTP result; actions queue and sync when online. OTP verification offline uses a server-issued hash and expiry carried with the order (see OQ-09 for the default).
- **FR-DLV-06** Delivery staff see only their own assigned orders and no financial data.

### 6.9 Scheduled Delivery, Shifts, Pause (SCH)
- **FR-SCH-01** Admin shall define **delivery shifts per area** (name, start, end, days of week). Example: morning, afternoon, night.
- **FR-SCH-02** Customers can book a scheduled order up to **1 day ahead** (today's later shifts or tomorrow) (`schedule.max_days_ahead`, Default 1).
- **FR-SCH-03** Scheduled orders are **auto-approved** on placement (status Scheduled-Confirmed-Pending-Review) and the shop gets a "review asap" task to Confirm or Reject. Default: shop may reject until `schedule.reject_cutoff_hours` (Default 2) before the shift start; after that, a rejection or no-show counts as accept-then-cancel (fine). If the shop does nothing, the order stays confirmed.
- **FR-SCH-04** Scheduled delivery fee uses the scheduled slab column (Appendix A.5).
- **FR-SCH-05** Admin or Area Partner can **pause an area** (reason, expected resume time). While paused: banner shown, new instant orders blocked, scheduled orders allowed for times after the resume time, in-flight orders continue.
- **FR-SCH-06** Shops can mark themselves closed at any time; in-flight orders still must be completed.

### 6.10 Print / Xerox Service (PRT)
- **FR-PRT-01** Any shop (stationery or general) may opt in at onboarding or later and configures its own options and prices: paper size (Default A4; others if shop enables), single/double side, black-and-white/colour, binding types, lamination, price per page per combination, binding price, lamination price, minimum charge.
- **FR-PRT-02** Customers upload files: PDF, DOC, DOCX, JPG, PNG, up to `print.max_file_mb` (Default 20 MB) each and `print.max_files` (Default 10) per order. Page count is auto-detected for PDF; for other types the customer enters it.
- **FR-PRT-03** The customer chooses copies and options; the price is computed from the shop's table and goes through the same pricing engine (category "Print", commission, floor, delivery or pickup).
- **FR-PRT-04** After the shop accepts, the shop must **call the customer to confirm** what will be printed; the app asks the shop to confirm completion of the call before status moves to Printing.
- **FR-PRT-05** If the customer refuses the printed job: 2nd occurrence → fine; 3rd → block of the customer ID (counts per customer across all shops). Fine amount = print cost capped at `print.refusal_fine_cap` (Default ₹100), paid to the shop. Admin can waive.
- **FR-PRT-06** Uploaded files shall be **deleted** from storage when the order reaches Delivered (immediately) or Cancelled/Expired/Rejected/Failed (within 24 hours). A small non-blocking line in the upload screen says files are deleted after delivery. No sensitive-document warning.
- **FR-PRT-07** Files are accessible only to the order's shop staff and Admin (for disputes) while retained; access is via short-lived signed links.

### 6.11 Counter Billing and Shop Operations (BIL)
- **FR-BIL-01** The shop app shall support **offline and online billing** in Phase 1: create a bill (items from the catalogue or manual item), quantity, price, discount, customer name/phone optional, payment mode (Cash, UPI, or Unpaid; no customer credit ledger in Phase 1), reduce stock, and share the bill as a PDF via the phone's share sheet. No printer or hardware integration.
- **FR-BIL-02** Bills show the shop's name, GSTIN if provided, items, totals; prices are tax-inclusive; no tax breakup in Phase 1 (see OQ-06).
- **FR-BIL-03** Online (platform) and counter sales shall appear in one sales report with a channel split.
- **FR-BIL-04** Shops shall have a customer list (for their own orders and counter customers) visible only to them.
- **FR-BIL-05** Shop reports (Default set): daily/weekly sales by channel, top items, acceptance rate and average accept time, delays, rejected bargain offers, ratings, balance statement.
- **FR-BIL-06** Shop Owner shall manage staff (add, deactivate, assign branch and role).

### 6.12 Pricing and Revenue Engine (PRC) — formulas are in Appendix A
- **FR-PRC-01** One central server-side pricing function shall compute every price. Apps never compute money; they only display server results.
- **FR-PRC-02** Discount layers shall apply in this fixed order: MRP → shop selling price (including near-expiry reduction) → accepted bargain → shop-wide discount → **S** (commission base) → platform coupon.
- **FR-PRC-03** Commission = higher of (rate % × S) or minimum amount per order; defaults 15% and ₹15; scope resolution most-specific-wins: shop > category > area > global.
- **FR-PRC-04** Platform commission for platform-funded coupons is computed on S **before** the coupon (the coupon is the platform's cost); for shop-funded discounts it is computed on S **after** them.
- **FR-PRC-05** Platform minimum earning per order ("floor", Default ₹20) shall always hold. The engine resolves shortfalls in the order defined in Appendix A.4: shortfall charge to customer → top-up charged to shop (only if shop discounts/bargain caused it) → reject.
- **FR-PRC-06** Extra charges shall be fully admin-defined (name, label, type fixed/%, amount, applies-to delivery/pickup/both, conditions, shop share and platform share as fixed or %, scope, active dates, on/off) and applied automatically when conditions match.
- **FR-PRC-07** Delivery fee slabs (mode × distance band × fee × platform share %) shall be admin-editable. Only Super Admin can edit delivery charges.
- **FR-PRC-08** Coupons: Admin creates coupons with: code/name, type (% with max cap, or flat), minimum S, valid dates, applicable categories/shops/areas, per-user limit, total usage limit, first-order-only flag, active flag. Funding is always the platform in Phase 1.
- **FR-PRC-09** Configuration changes shall be versioned and apply only to orders placed after the change. Each order references the setting versions it used.
- **FR-PRC-10** A "price simulator" screen in the admin panel shall let Admin enter a cart (S, mode, distance, category, shop, coupon) and see the full breakdown and platform earning, using live settings.

### 6.13 Settlement, Balances, Area Partners (STL)
- **FR-STL-01** Each delivered order shall create a ledger entry: platform earning E (Appendix A.7) owed by the shop. Fines, fine waivers, top-ups, and recorded payments are ledger entries. Balance owed = sum of entries.
- **FR-STL-02** Shops shall see a live **"You owe ₹X"** balance and a statement in the app (orders, earnings, fines, payments).
- **FR-STL-03** Weekly settlement runs **Sunday**. The statement covers all Delivered orders up to Sunday 00:00 IST. The shop pays the founder by UPI/cash; Admin records payments (amount, date, UPI reference, note). Partial payments are allowed and allocated to the **oldest unsettled** ledger entries first. An order is "settled" when fully covered.
- **FR-STL-04** COD limit: when balance owed ≥ 80% of `cod.balance_limit` the shop gets a warning; at ≥ 100% (Default ₹5,000, scope-able by shop) the shop is **auto-paused** (no new orders; in-flight orders continue). When payment brings the balance below the limit Admin's payment record auto-resumes the shop.
- **FR-STL-05** Area partner earning per settlement period = `partner.percent` (admin-set per partner) × (sum of E of newly settled orders in their area + fines newly settled in their area). Fines are counted as platform revenue **before** the partner percent is applied.
- **FR-STL-06** If a fine already counted is later waived or reversed, the amount is deducted from the partner's next period (negative carry-forward allowed).
- **FR-STL-07** Partner payouts are **manual**: Admin pays by UPI and records the payout. The system keeps partner ledger and statement. Shops and partners provide a UPI ID only (no bank details).
- **FR-STL-08** Platform revenue dashboard: onboarding fees, commission, delivery share, extras, shortfall charges, top-ups, fines, sponsorship receipts, minus coupons funded, minus partner shares.
- **FR-STL-09** Sponsorship charges and onboarding fees are collected by the founder outside the system; the system records receipts (amount, date, reference, shop).

### 6.14 Fines, Complaints, Abuse (FIN)
- **FR-FIN-01** Fine rules are configurable in a table (type, trigger, amount fixed or %, auto/manual, strike threshold). Defaults are in Appendix E.
- **FR-FIN-02** Strikes: first occurrence of a type in the rolling window is a **warning**, later occurrences are fined. Repeat offenders are auto-paused and flagged for the Area Partner to call.
- **FR-FIN-03** Weekly cap on fines per shop (Default ₹200).
- **FR-FIN-04** Fines are ledger entries added to the shop's balance owed and count as platform revenue.
- **FR-FIN-05** Complaints: raised by customer or shop, with order, type, text, optional photo. Routed to the Area Partner, who resolves or escalates to Admin. The partner notifies the Admin only when escalating. Target response time: `complaint.partner_hours` (Default 24).
- **FR-FIN-06** Shops can dispute a fine with a note; the Area Partner decides in 24 hours; Admin can override. Area Partner and Admin can waive or reduce a fine (partner limited by `fine.partner_waive_limit`, Default ₹50 per fine).
- **FR-FIN-07** Customer abuse: repeated refused COD deliveries trigger a **flag** at `abuse.refusal_flag` (Default 2) and a candidate **block** at `abuse.refusal_block` (Default 3) for Admin decision; blocking is manual. Platform team controls these thresholds.
- **FR-FIN-08** Admin shall be able to block/unblock customers and suspend/unsuspend shops with a reason, logged in audit.

### 6.15 Ratings and Trust (RAT)
- **FR-RAT-01** After Delivered (or picked up) the customer is prompted for a 1-5 star rating of the shop and optional comment. Skipping is allowed.
- **FR-RAT-02** A shop's rating is the average of ratings in the last `rating.window_days` (Default 90); it is shown only when count ≥ `rating.min_count` (Default 3).
- **FR-RAT-03** Trust badges (Default): **Never Rejects** = zero shop rejections/expiries/cancels after accept in the last 30 days with at least 10 orders; **Never Delayed** = zero orders delivered later than ETA + `badge.late_minutes` (Default 10) in the last 30 days with at least 10 orders. Thresholds are admin settings.

### 6.16 Sponsored Listings (SPN)
- **FR-SPN-01** Sponsorship is a **data record plus an admin on/off switch** in Phase 1: shop/branch, area, category, slot rank (1-3), start, end, amount received, status.
- **FR-SPN-02** Maximum `sponsor.slots` (Default 3) per category per area. Default price guidance ₹1,500/month per slot; first month free or discounted for early shops. Price is a note, not enforced.
- **FR-SPN-03** Sponsored shops rank first (by slot rank) and show a "Sponsored" label. Ends automatically at the end date.

### 6.17 Notifications (NOT)
- **FR-NOT-01** Channels in Phase 1: push notifications and email. In-app alarm for shops (FR-ORD-02). **WhatsApp is Phase 2.**
- **FR-NOT-02** Events and recipients (all shall exist; copy kept short, English):

| Event | Customer | Shop | Worker | Ops/Admin | Partner |
|---|---|---|---|---|---|
| Order placed | push | push + alarm | | | |
| Order accepted/partial/rejected/expired | push | | | expired: task | |
| Partial total confirm | push | | | | |
| Prep time/ETA set | push | | | | |
| Assigned | | | push | | |
| Out for delivery / Items-check start | push | | | | |
| Delivered | push + rating | push | | | |
| Failed delivery | push | push | | flag | |
| Scheduled order placed/confirmed/rejected | push | push + task | | | |
| Balance warning/pause/resume | | push + email | | | |
| Fine added/waived/disputed | | push | | | disputed: push |
| Complaint raised/escalated | push | push | | escalated: push | push |
| Area paused/resumed | banner/push | push | | | push |
| New shop application | | | | task | push (own area) |
| Settlement statement ready (Sunday) | | push + email | | | push (own) |
| OTP codes | email | email | email | email | email |

### 6.18 Admin Web Panel (ADM)
- **FR-ADM-01** Modules (shall exist): Dashboard; Areas and delivery shifts; Categories and master catalogue (with approval queue); Shops (applications, KYC, status, fees, branches); Orders (search, monitor, intervene); **Tasks** (call-this-shop, review queues, flags); Complaints; Customers (flags, blocks); Pricing (commission, floor, slabs, charges); Coupons; Fines and strikes; Settlements and payments; Area partners (profile, percent, statements, payouts); Sponsorships; Search synonyms and brands; Reports; Content (Terms, Privacy Policy, explainer video links, banners); Users and roles; Audit log; System settings.
- **FR-ADM-02** Every setting in Appendix C shall be editable here with scope (global/area/category/shop), validation, effective-from time, and audit entry.
- **FR-ADM-03** **Custom reports**: the admin picks a dataset (orders, shops, customers, settlements, fines, coupons, complaints), filters (date range, area, category, shop, status), group-by, metrics (count, sum, average), and can save the report and export CSV. A set of default reports ships: daily orders and revenue, revenue by area, shop performance, acceptance/delay report, outstanding balances, coupon usage, fines, area partner earnings.
- **FR-ADM-04** Area Partner and Ops see the same panel with menus and data limited by role and area.
- **FR-ADM-05** Daily dashboard numbers: orders, accepted %, delivered %, platform earning, outstanding balances, shops live, active customers, open tasks.

### 6.19 Offline Behaviour (OFF)
- **FR-OFF-01** Shop app and Delivery app shall work offline for the actions listed in 6.8 and 6.11 and queue actions with timestamps and a client-generated ID for idempotent sync.
- **FR-OFF-02** Conflict rules (Default): orders and money records — **server wins**; stock and product edits — **last write wins** by client timestamp; counter bills created offline are always accepted and reduce stock (stock may go negative and is flagged).
- **FR-OFF-03** The apps shall show a clear offline indicator and the number of queued actions.
- **FR-OFF-04** The customer app needs connectivity to order; it shall cache the last viewed shops and cart and show a retry state when offline.

---

## 7. Non-Functional Requirements

| ID | Area | Requirement |
|---|---|---|
| NFR-01 | Performance | API p95 < 500 ms for reads and < 800 ms for order placement; search p95 < 800 ms; push to shop within 5 s of placement; app cold start < 4 s on a mid-range Android phone |
| NFR-02 | Scale | Launch 80 shops, 400 customers, about 100 orders/day; architecture should not block growth to 5-10k orders/day (no sharding in Phase 1) |
| NFR-03 | Availability | Target 99.5% monthly; planned maintenance outside 7:00-22:00 IST |
| NFR-04 | Devices | Android 8.0+ (API 26) and iOS (minimum version set by the React Native version chosen in the ADR, about iOS 15+); phone portrait first; low-bandwidth friendly (images compressed, thumbnails ≤ 100 KB, lists paginated) |
| NFR-05 | Security | TLS everywhere; encrypted storage for PII at rest; signed short-lived links for files; rate limits on auth and search; server-side authorization on every call; secrets not in the app |
| NFR-06 | Privacy / Compliance | Privacy Policy and consent at signup; account deletion; data minimisation; follow India's DPDP Act 2023 principles; print files deleted per FR-PRT-06; display seller details and price breakup as required for e-commerce in India; legal review before public launch (see Risks) |
| NFR-07 | Data protection | Daily automated DB backup, retention Default 14 days, restore tested once before launch; media in object storage with versioning off to save cost |
| NFR-08 | Observability | Crash reporting in all apps; server error logging; alert on order-placement failure rate |
| NFR-09 | Accessibility / UX | English only; minimal text; icon + label; tap targets ≥ 48 dp (Android) / 44 pt (iOS); text contrast WCAG 2.1 AA in **both light and dark themes**; large Accept button; voice alerts for shops |
| NFR-10 | Cost | Total infra + services under ₹10-20k per year, **plus the Apple Developer Program fee (about ₹9k per year, founder-approved)**; paid telephony and SMS are excluded in Phase 1 |
| NFR-11 | Maintainability | All business numbers come from settings, not code; one pricing function; automated tests for pricing (all Appendix A.8 examples) and order state transitions |
| NFR-12 | Auditability | Money-affecting data is append-only (ledger); corrections are new entries |
| NFR-13 | Time | All timestamps stored in UTC, displayed in IST |

## 8. Out of Scope (Phase 1)
- Live tracking of delivery person; own delivery partners (later phase); online payments or payment gateway; refunds and returns; WhatsApp notifications; AI features; cross-shop price comparison view; referrals; GST invoices from the platform (GST registration happens after Phase 1); billing hardware; integration with shops' existing billing software; street food vendors (until licensed); multiple languages; additional search filters/sorting; sponsored-listing payment collection in-app; ID proof document verification; SMS OTP; phone verification; masked calling; IVR/auto phone calls; multiple coupons per order.

## 9. Dependencies

| Dependency | Type | Team / System | Status |
|---|---|---|---|
| Google Maps Platform (maps, geocoding, distance, directions deep link) with quota cap | External | Google | To set up; billing account and quota alerts needed |
| Push notifications (FCM) | External | Google Firebase | To set up |
| Cloud hosting (AWS or cheaper), object storage, email sending | External | AWS or alternative | To choose in ADR |
| Crash reporting (free tier) | External | e.g. Sentry | To set up |
| Google Play developer account | External | Google | To create (one-time fee) |
| Apple Developer Program (about ₹9k per year), a Mac for builds, APNs push via FCM, TestFlight | External | Apple | Founder has a Mac; account to create (OQ-17) |
| Domain name and email sender domain | External | Registrar / email provider | To buy |
| Reference code: Lekha (offline POS), Sthaan storefront, media ingestion service, shared types, VaayuGO (reference only, not copied) | Internal | Founder repos | Available; reuse decisions in ADR |
| Area partners (friends) and ops helper | Internal | People | Identified for pilot |
| Legal: terms, privacy policy, business entity | External | Founder / advisor | Entity not registered yet |

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| One developer, one month, wide scope (5 apps, offline, print, bargaining, scheduling) | High | High | Fixed build priority and cut line (4.2, 4.3); freeze scope; build pricing engine and order flow first |
| Shops don't accept orders in time | Medium | High | Loud alarm, Ops call task, fines with warnings, trust badges, area partners |
| Month-1 revenue below ₹2 lakh | High | Medium | Base case ₹1.2-1.5 lakh; sponsorship in month 2; track weekly; pause rules |
| COD cash risk (shops owe platform) | Medium | High | ₹5k limit with auto-pause, live balance, weekly Sunday settlement, onboarding fee |
| Offline sync conflicts and data loss | Medium | High | Idempotent actions, server-wins for orders/money, last-write-wins for stock, tests |
| Google Maps cost overrun | Medium | Medium | Strict quota and billing alerts, straight-line fallback, cache results |
| Email-only OTP friction for villagers and staff | Medium | Medium | Short onboarding video; Ops helps with first login; revisit OTP channel (SMS) if friction is high |
| Early OTP or fake-delivery abuse | Medium | Medium | OTP only after item check, photo + GPS stamp, complaint flow, flags |
| Fraud: fake accounts, fake location, coupon abuse | Medium | Medium | Flags and review queue, per-user coupon limits, floor rule protects revenue |
| No registered business entity; legal and tax exposure (e-commerce rules, GST later) | Medium | High | Get legal advice before public launch; register entity before scaling |
| iOS adds App Store review time, platform limits (background alarms, permissions text, account deletion rules) and extra testing | Medium | Medium | Same codebase; submit early via TestFlight; reviewer demo account (FR-ACC-12); iOS may trail Android by up to 2 weeks |
| Pricing mistakes (money logic) | Medium | High | One server function, simulator, worked-example tests, price snapshots, audit log |
| Dependence on friends as area partners | Medium | Medium | Written role and share percent, admin override, scoped access |

## 11. KPIs and Success Metrics

| Metric | Baseline | Target | Timeline |
|---|---|---|---|
| Shops live | 0 | 50-80 | Launch week |
| Customers registered | 0 | 100-400 | Launch week |
| Orders per day | 0 | about 50 | Month 1; 50+ keep scaling, 20-50 diagnose, under 20 stop features (month 2) |
| Platform revenue (incl. onboarding fees) | ₹0 | ₹1.2-1.5 lakh base; ₹2 lakh stretch | Month 1 |
| Avg platform earning per delivered order | n/a | ≥ ₹20 on every order; avg about ₹48 | Month 1 |
| Shop accept time under 60 s | n/a | ≥ 80% of orders | Month 1 |
| On-time delivery (within ETA + 10 min) | n/a | ≥ 90% | Month 1 |
| Order success rate (delivered / placed) | n/a | ≥ 85% | Month 1 |
| Average shop rating | n/a | ≥ 4.0 | Month 2 |
| Shops over COD limit at any Sunday | n/a | 0 | Every week |
| Crash-free sessions | n/a | ≥ 99% | Month 1 |
| Repeat customers (2+ orders) | n/a | ≥ 30% | Month 2 |

## 12. Open Questions
Each has a **default to use until answered**, so development is never blocked.

| ID | Question | Owner | Due | Status | Default until answered |
|---|---|---|---|---|---|
| OQ-01 | App name and branding | Founder | n/a | **Resolved** | WhyUGO; tagline "Kyun jaana? Ghar baithe aayega." Logo and colours still to be designed (Figma step) |
| OQ-02 | Exact launch categories (3-4) and exact launch villages/areas | Founder | Before data entry | Open | Admin-configured; seed 3 categories: Groceries, Fruits and Vegetables, Stationery and Print |
| OQ-03 | How delivery staff without email log in | Founder | n/a | **Resolved** | Each staff member uses their own personal email plus phone number, like customers; email OTP login |
| OQ-04 | Maps provider quota numbers and monthly spend cap | Founder | Before launch | Open | Set a hard monthly cap in Google console; straight-line × 1.3 fallback |
| OQ-05 | Any ID-proof document in shop KYC | Founder | Before onboarding | Open | None in Phase 1 (fields in FR-ONB-02 only) |
| OQ-06 | Tax handling on counter bills (GST breakup) | Founder | Before billing build | Open | Tax-inclusive prices, optional GSTIN printed, no breakup |
| OQ-07 | When to register a business entity | Founder | Before public launch | Open | Not needed for development |
| OQ-08 | Extra search filters and sorting | Founder | Phase 2 | Open | None beyond FR-DSC-03 |
| OQ-09 | Offline OTP verification method for the delivery worker | Developer | Before delivery app build | Open | Server issues a hashed OTP + expiry with the order; app verifies offline and syncs |
| OQ-10 | Free-delivery rule: shop's own delivery share when free | Founder | n/a | **Resolved (default accepted)** | Free means customer pays ₹0 and both shares are ₹0; the shop bears its own cost |
| OQ-11 | Shop opt-out from free-delivery threshold and shop-set delivery charges | Founder | n/a | **Resolved (default accepted)** | No opt-out; only Super Admin sets delivery charges |
| OQ-12 | Capacity limit per delivery shift | Founder | Phase 2 | Open | No capacity limit |
| OQ-13 | Shop-wide discount type and caps (percent/flat limits) | Founder | Before shop app build | Open | Percent up to 50% or flat up to 50% of cart; shop may set validity dates |
| OQ-14 | Auto small-order fee cap and label | Founder (admin setting) | Anytime | Open | Cap ₹15 (`floor.auto_charge_cap`), label "Small order fee" |
| OQ-15 | Launch coupon list | Founder (admin setting) | Anytime | Open | No coupons at launch except those Admin creates |
| OQ-16 | Reliable new-order alarm for shops on iPhone (iOS limits background sound) | Founder | n/a | **Resolved (default accepted)** | Pilot shops are advised to use Android phones; iOS shops get time-sensitive push + in-app alarm; Ops call task at 60 s |
| OQ-17 | Apple account type: individual (founder's name shown as seller) or organisation (needs a registered entity) | Founder | n/a | **Resolved (default accepted)** | Individual account now; move to an organisation account after the entity is registered |

## Next Step
→ Once approved, run skill 3: agile_3_design_brief (input: approved PRD). The database design can start from Appendix D (entities) and Appendix A/C.

---

# Appendix A — Pricing and Revenue Engine (normative)

## A.1 Symbols
- `X` MRP. `Y` shop selling price per pack (after near-expiry reduction). `B` accepted bargain price per pack (B ≤ Y). `Z` shop-wide discount amount. `A` platform coupon amount applied. `F` delivery fee charged to customer. `S` commission base.
- `floor` = minimum platform earning per order (`floor.min_earning`, Default ₹20).

## A.2 Item side (shop-funded)
1. Line price per pack: `p = B` if a bargain is accepted for that line, else `p = Y`. Line subtotal `L = p × quantity`.
2. Cart subtotal `T = Σ L`.
3. Shop-wide discount `Z` (if any and its minimum cart value is met): percent → `Z = floor_to_rupee(T × pct)`; flat → `Z = flat`; never more than `T`. Allocate `Z` to lines pro rata to `L` (remainder to the largest line).
4. **`S = T − Z`** (also `S = Σ S_line`).
5. Minimum order check: `S ≥ min_order_value` (Default ₹150).

## A.3 Commission (charged to the shop)
- For each line: `commission_line = round(rate(line) × S_line)` where `rate(line)` resolves most-specific-first: shop > category > area > global (Default 15%).
- `commission = max(Σ commission_line, min_amount)` where `min_amount` resolves shop > area > global (Default ₹15).
- Commission uses `S` **before** any platform coupon (platform coupons are the platform's cost).

## A.4 Floor resolution (always in this order)
1. Delivery fee `F` from A.5; platform delivery share `P_del`. Extra charges (A.5b) give platform shares `P_x`.
2. `E0 = commission + P_del + Σ P_x`.
3. If `E0 ≥ floor` → go to A.6 (coupon).
4. Else `shortfall = floor − E0`. Add an automatic **shortfall charge** to the customer: `sc = min(shortfall, floor.auto_charge_cap)` (Default cap ₹15; label "Small order fee"). 100% to the platform. `E1 = E0 + sc`.
5. If `E1 < floor`: `remaining = floor − E1`.
   - If the shop applied any discount or an accepted bargain on this order → **shop top-up** `= remaining`, charged to the shop as extra commission. `E1 = floor`.
   - Else → **reject** the order with "Order value too low". (This only happens if settings are misconfigured or min order is set too low.)
6. If a shortfall step was needed, no platform coupon applies (A.6 gives 0).

## A.5 Delivery fee slabs (Default; all editable by Super Admin only)

| Mode | 0-1 km | 1-2 km | 2-3 km |
|---|---|---|---|
| Instant | ₹15 | ₹20 | ₹25 |
| Scheduled | ₹10 | ₹15 | ₹20 |
| Self-pickup | ₹0 | ₹0 | ₹0 |

- Distance = road distance at checkout (A fallback is in FR-DSC-02). Bands are by `≤ 1.0 km`, `≤ 2.0 km`, `≤ 3.0 km`.
- **Platform share %** per band: Default 40%. `P_del = round_to_rupee(F × platform_pct)`; shop share `= F − P_del`. Defaults: Instant platform ₹6 / ₹8 / ₹10, shop ₹9 / ₹12 / ₹15. Scheduled platform ₹4 / ₹6 / ₹8, shop ₹6 / ₹9 / ₹12.
- **Free delivery:** if `S ≥ delivery.free_threshold` (Default ₹400) then `F = 0`, `P_del = 0`, shop share `= 0` (OQ-10).

### A.5b Extra charges
- Each charge has: label, type (fixed ₹ or % of `S`), applies to (delivery / pickup / both), conditions (min/max `S`, time window, area, category, shop), shop share and platform share (each fixed ₹ or %; they must add up to the charge amount; the admin form rejects otherwise), scope, active dates, on/off.
- Amount is rounded to the nearest whole rupee. All applicable charges are added to what the customer pays.

## A.6 Platform coupon
- `A_nominal`: percent → `min(floor_to_rupee(S × pct), max_cap)`; flat → flat amount. Never more than `S`.
- `A_max = floor_to_rupee(E1 − floor)` where `E1` is the earning after A.4 (never below 0).
- **`A = min(A_nominal, A_max)`**. If `A = 0` the coupon is hidden for this cart. If `0 < A < A_nominal` the coupon applies at `A` and the UI shows the actual saving.
- One platform coupon per order (Default). Coupon eligibility rules (minimum `S`, dates, scope, user limits) are checked first.

## A.7 Totals and platform earning
- **Customer pays (COD)** `= S − A + F + Σ extra charges + sc + round_off`.
- **Round-off:** the payable is rounded to the nearest ₹1 (0.50 up); the round-off belongs to the shop and does not affect platform earning.
- **Platform earning** `E = commission + top_up + P_del + Σ P_x + sc − A`.
- **What the shop owes the platform for the order is exactly `E`** (the shop collects all cash; the platform's coupon funding is netted out). `E ≥ floor` always.
- Shop keeps: `S − commission − top_up + shop delivery share + Σ shop shares + round_off`.

## A.8 Worked examples (must be automated tests)

| # | Case | Steps | Result |
|---|---|---|---|
| E1 | S ₹500, instant 1-2 km (F ₹20, P_del ₹8), coupon 40% up to ₹50 | commission 75.00; E0 = 83.00 ≥ 20; A_nominal 50; A_max = 63; A = 50 | Customer pays ₹470; E = ₹33.00 |
| E2 | S ₹150, instant 0-1 km (F ₹15, P_del ₹6), flat coupon ₹50 | commission max(22.50, 15) = 22.50; E0 = 28.50; A_max = 8; A = 8 (coupon trimmed) | Customer pays ₹157; E = ₹20.50 |
| E3 | Item ₹100 × 2, bargain to ₹90 each, shop-wide 10% off, scheduled 1-2 km (F ₹15, P_del ₹6) | T = 180; Z = 18; S = 162; commission 24.30; E0 = 30.30 | Customer pays ₹177; E = ₹30.30 |
| E4 | Promo shop commission 8% / min ₹8, min order ₹100, S ₹100, self-pickup, cap ₹15 | commission 8; E0 = 8; shortfall 12; sc = 12; E1 = 20 | Customer pays ₹112; E = ₹20.00 |
| E5 | As E4 but cap ₹5 and a shop discount applied | sc = 5; E1 = 13; remaining 7 | Shop top-up ₹7; customer pays ₹105; E = ₹20.00 |
| E5b | As E5 but no shop discount or bargain | remaining 7 and no discount | Order rejected |
| E6 | S ₹420, instant 2-3 km | free delivery (S ≥ 400); commission 63 | Customer pays ₹420; E = ₹63.00 |

## A.9 Rounding and storage
- Store money as integer paise. Commission and earning are kept in paise. Customer-facing discounts, delivery, extra charges and coupons are whole rupees (floor for discounts and coupons, nearest for charges). Item prices may have paise. Payable is rounded to the nearest ₹1 with a visible round-off line.

---

# Appendix B — Order State Machine

## B.1 Statuses

| Status | Meaning | Terminal |
|---|---|---|
| PLACED | Instant or pickup order waiting for the shop | No |
| SCHEDULED_PENDING_REVIEW | Scheduled order, auto-approved, shop asked to review | No |
| AWAITING_CUSTOMER_CONFIRM | Shop made a partial acceptance, waiting for customer | No |
| ACCEPTED | Shop accepted (stock reserved) | No |
| SCHEDULED_CONFIRMED | Scheduled order confirmed (by shop, or default after review) | No |
| PREPARING | Shop is packing/printing | No |
| READY | Packed; pickup orders wait here for the customer | No |
| ASSIGNED | Assigned to a delivery worker | No |
| OUT_FOR_DELIVERY | Worker started | No |
| ARRIVED | Worker at door, photo uploaded, customer item check running | No |
| DELIVERED | OTP verified (or pickup code verified) | Yes |
| REJECTED_BY_SHOP | Shop rejected | Yes |
| EXPIRED | Shop did not respond in time | Yes |
| CANCELLED_BY_CUSTOMER | Includes declined/ignored partial total | Yes |
| CANCELLED_BY_SHOP | After accept (fine rules apply) | Yes |
| DELIVERY_FAILED | Customer unreachable or refused | Yes |

## B.2 Transitions

| From | To | Actor | Condition / side effects |
|---|---|---|---|
| PLACED | ACCEPTED | Shop | Reserve stock; set prep time |
| PLACED | AWAITING_CUSTOMER_CONFIRM | Shop | Partial acceptance; recompute price (A) |
| PLACED | REJECTED_BY_SHOP | Shop | Reason required |
| PLACED | EXPIRED | System | No action in `order.expire_seconds` (Default 180); "call this shop" task created at `order.accept_alert_seconds` (Default 60) |
| PLACED | CANCELLED_BY_CUSTOMER | Customer | Free until accepted |
| AWAITING_CUSTOMER_CONFIRM | ACCEPTED | Customer | Confirms new total |
| AWAITING_CUSTOMER_CONFIRM | CANCELLED_BY_CUSTOMER | Customer/System | Declines or no reply in `order.partial_confirm_minutes` (Default 5) |
| (scheduled placed) | SCHEDULED_PENDING_REVIEW | System | Auto-approve; task to shop |
| SCHEDULED_PENDING_REVIEW | SCHEDULED_CONFIRMED | Shop/System | Shop confirms, or cutoff passes with no action |
| SCHEDULED_PENDING_REVIEW | REJECTED_BY_SHOP | Shop | Allowed until `schedule.reject_cutoff_hours` (Default 2) before shift; later is treated as cancel-after-accept |
| SCHEDULED_CONFIRMED | PREPARING | System | At shift start minus prep time |
| ACCEPTED | PREPARING | Shop | Starts packing (or auto when prep timer starts) |
| ACCEPTED/PREPARING | CANCELLED_BY_SHOP | Shop | Fine rules; customer notified; stock released |
| ACCEPTED/PREPARING | CANCELLED_BY_CUSTOMER | Customer | Only with shop consent |
| PREPARING | READY | Shop | |
| READY | ASSIGNED | Shop | Delivery orders; select worker (one worker may hold several orders) |
| READY | DELIVERED | Shop | Pickup orders: customer shows pickup code; shop enters it |
| ASSIGNED | OUT_FOR_DELIVERY | Worker | Start |
| OUT_FOR_DELIVERY | ARRIVED | Worker | Photo with GPS + time required |
| ARRIVED | DELIVERED | Worker | Enters OTP shown to the customer |
| ARRIVED | DELIVERY_FAILED | Worker | After `delivery.wait_minutes` (Default 5) and at least one call attempt |
| DELIVERED | (ledger) | System | Create earning ledger entry E; request rating |
| EXPIRED / REJECTED / CANCELLED / FAILED | (cleanup) | System | Release stock; delete print files (within 24 h); no earning; no commission |

## B.3 Delivery proof (detail)
1. Worker taps **Arrived**; the app requires a photo; GPS and time are attached automatically.
2. The customer app shows the order items list and a countdown (`delivery.check_seconds`, Default 60) with a button **Items OK**.
3. The OTP appears in the customer app when the customer taps Items OK or the countdown ends, whichever first.
4. The customer reads out the OTP; the worker enters it. Correct OTP → DELIVERED. 5 wrong entries → locked for 5 minutes, task for Ops.
5. Problems with items are reported through the complaint flow (no return or refund).

---

# Appendix C — Admin Settings (all editable; scope = G global, A area, C category, S shop)

| Key | Meaning | Scope | Default |
|---|---|---|---|
| `commission.percent` | Commission % of S | G/A/C/S | 15% |
| `commission.min_amount` | Minimum commission per order | G/A/S | ₹15 |
| `floor.min_earning` | Platform minimum earning per order | G/A/S | ₹20 |
| `floor.auto_charge_cap` | Max automatic shortfall charge to customer | G/A | ₹15 |
| `order.min_value` | Minimum S for an order | G/A/S | ₹150 |
| `delivery.slabs` | Mode × distance band → fee and platform % | G/A | See A.5 (platform 40%) |
| `delivery.free_threshold` | S at or above this → free delivery | G/A/S | ₹400 |
| `distance.list_radius_km` | Shop listing radius (straight line) | G/A | 3 |
| `distance.road_factor` | Fallback multiplier for road distance | G | 1.3 |
| `charges.*` | Extra charge definitions (A.5b) | G/A/C/S | none |
| `coupon.*` | Coupon definitions (FR-PRC-08) | G | none |
| `coupon.max_per_order` | Max platform coupons per order | G | 1 |
| `bargain.offers_per_day` | Offers per item per customer per day | G | 3 |
| `bargain.valid_minutes` | Accepted bargain validity | G | 30 |
| `order.accept_alert_seconds` | Create Ops call task | G/A | 60 |
| `order.expire_seconds` | Auto-expire unaccepted orders | G/A | 180 |
| `order.partial_confirm_minutes` | Customer time to confirm partial total | G | 5 |
| `schedule.max_days_ahead` | Scheduled booking window | G/A | 1 |
| `schedule.reject_cutoff_hours` | Last time a shop can reject a scheduled order (before shift) | G/A | 2 |
| `shifts` | Delivery shifts per area | A | Admin defined |
| `delivery.check_seconds` | Customer item-check timer | G | 60 |
| `delivery.wait_minutes` | Wait before marking delivery failed | G | 5 |
| `cod.balance_limit` | Shop outstanding limit before pause | G/S | ₹5,000 |
| `cod.warn_percent` | Warning at % of limit | G | 80% |
| `fees.onboarding` | Onboarding fee | G | ₹1,000 / year |
| `fees.onboarding_grace_days` | Grace after expiry | G | 7 |
| `fine.rules` | Fine table (Appendix E) | G/A/S | Appendix E |
| `fine.weekly_cap` | Max fines per shop per week | G/S | ₹200 |
| `fine.partner_waive_limit` | Max a partner can waive per fine | G | ₹50 |
| `abuse.refusal_flag` / `abuse.refusal_block` | Refused-COD counts | G | 2 / 3 |
| `complaint.partner_hours` | Partner response target | G | 24 |
| `partner.percent` | Share of settled platform earnings | per partner | Admin set |
| `rating.window_days` / `rating.min_count` | Rating window and min count to display | G | 90 / 3 |
| `badge.*` | Trust badge thresholds | G | See FR-RAT-03 |
| `sponsor.slots` | Sponsored slots per category per area | G/A | 3 |
| `print.max_file_mb` / `print.max_files` | Upload limits | G | 20 / 10 |
| `print.refusal_fine_cap` | Cap on print refusal fine | G | ₹100 |
| `search.synonyms` | Synonym/transliteration table | G | Admin defined |
| `phone.mask_after_days` | Mask customer phone in shop views | G | 30 |
| `theme.default` | Default theme for new users | G | System |
| `app.name` / `app.tagline` | Brand name and tagline | G | WhyUGO / "Kyun jaana? Ghar baithe aayega." |
| `app.support_contacts`, `app.video_links` | Support contacts and explainer videos | G | Placeholder |
| `backup.retention_days` | DB backup retention | G | 14 |

---

# Appendix D — Data Entities (for database design; fields are indicative)

User, Role, Permission, RolePermission, UserRole(scope: area/shop/branch), Session, OtpCode, TermsDocument, TermsAcceptance, Area, AreaPartnerAssignment, DeliveryShift, Category, MasterProduct, ProductBarcode, Brand, SearchSynonym, Shop (business), Branch, BranchHours, BranchHoliday, ShopApplication/KycField, OnboardingFeePayment, ShopProduct (price, online price, counter price, expiry, near-expiry rule, bargain flag + hidden floor), ProductPack, StockLevel, StockMovement, ShopDiscount, Customer, Address, Cart, CartItem, BargainOffer, Order, OrderItem, OrderPriceSnapshot, OrderStatusHistory, DeliveryAssignment, DeliveryProof (photo, GPS, time), OtpDelivery, PrintJob, PrintFile, CounterBill, CounterBillItem, Coupon, CouponRedemption, ExtraChargeRule, DeliverySlab, SettingValue (versioned, scoped), LedgerEntry, Payment (received), Settlement, PartnerStatement, PartnerPayout, Fine, FineRule, Complaint, Rating, TrustBadge, Sponsorship, Flag (fraud/abuse), Block, Task (call-this-shop, review queues), Notification, AuditLog, SavedReport, ExcludedBrand, SavedList.

---

# Appendix E — Fine Rules (Default)

| Trigger | Fine | Notes |
|---|---|---|
| Accepts, then cancels or reports out of stock | ₹30 | Also applies to late scheduled-order rejection (after cutoff) |
| No response to an order (expired) | Warning; ₹10 from the 3rd in a rolling week | |
| Late packing (beyond prep time + 10 min) | ₹10 | |
| Wrong or missing item (verified by Area Partner) | Item value + ₹20 | Paid to the customer outside the system; recorded as a ledger entry |
| Repeated late delivery | Warning; then ₹10 | |
| Customer refuses a completed print job | 2nd time: fine (print cost, capped ₹100, to the shop); 3rd time: block | Counted per customer |

- First occurrence of a type in a rolling 7-day window is a warning unless the rule says otherwise. Weekly cap ₹200 per shop. Repeat offenders are auto-paused and flagged to the Area Partner. Shops can dispute; Area Partner decides within 24 h; Admin can override and waive.

---

# Appendix F — Decisions Log (conflicts resolved: newer wins)

| Topic | Older | Used now |
|---|---|---|
| Commission | 12% or ₹12 | **15% or ₹15** (admin-configurable) |
| Delivery fee | ₹7 split 4/3 | **Slab table in A.5**, platform share default 40% |
| Instant vs scheduled fee | Flat ₹15 / ₹10 | **Per distance band** (A.5) |
| Pilot size | 10k+ users; 50 shops and 10-20 customers | **50-80 shops, 100-400 customers** in launch week |
| Login | Email only at launch | **Email OTP for everyone; phone collected, not verified** |
| Month-1 revenue | ₹2 lakh | **₹1.2-1.5 lakh base, ₹2 lakh stretch** |
| Onboarding fee | "Deposit" | **Non-refundable** annual fee; fines go to balance owed |
| Backend | Supabase vs NestJS | **NestJS + PostgreSQL** |
| iOS | Android first, iOS only if month 1 succeeds | **Android and iOS both in Phase 1** (iOS may trail by up to 2 weeks) |
| Theme | Light only | **Light and dark** (system default) |
| Brand | Undecided; an earlier name from another chat was not this project's | **WhyUGO** |
| Delivery staff login | Staff might lack email | **Personal email + phone for every staff member** |
| Maps | Undecided | **Google Maps with strict quota** |
| Auto-call to shop | Phone call | **Alarm + Ops "call this shop" task** (no telephony) |
| Billing-software integration | Wanted | **Out of Phase 1**; master catalogue + CSV/Excel instead |
| Coupon below floor | Invalid | **Trimmed to what the floor allows; hidden when ₹0** (A.6) |

## Defaults chosen by the PRD author (founder to confirm or edit)
These were not decided explicitly and are all admin settings or easy to change: one coupon per order; 3 bargain offers per item per day; bargain valid 30 minutes; order auto-expiry 180 s; partial-confirm 5 min; scheduled-order reject cutoff 2 h; rating shown after 3 ratings; badge thresholds; phone masking after 30 days; DB backup retention 14 days; excluded brands persist in settings; 20 MB per print file; payout of partners and shops is manual by UPI; shops are advised to use Android in the pilot because of iOS alarm limits. (Free-delivery handling and no opt-out were confirmed by the founder.)

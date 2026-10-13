# YGo

Hyperlocal commerce platform connecting customers with local shops within roughly 2-3 km. In Phase 1 each shop delivers with its own staff.

This document carries the domain: what the product does and what the words mean. **Technical and stack decisions live in `docs/adr/`** — one record per stack ticket, indexed in `docs/adr/README.md` — and are not repeated here beyond the few places a platform limit changes a product rule.

`docs/product/revenue-system-spec.md` is authoritative for pricing and settlement. `docs/product/prd-phase1-reference.md` is an earlier PRD for the same product under a retired brand: a reference input only, overridden by this document and by any closed decision.

## Language

**Shop**: A local business that sells to customers. Never "store".
**Owner**: The person who owns a shop and has full access to it.
**Staff**: A person working for one shop. One role, not several. Staff handle orders, manage stock, run counter billing, add products from the master catalog, and deliver when their `can deliver` flag is set.
**`can deliver`**: A per-staff flag, not a role. It reveals the delivery screens in the Shopkeeper app and puts the person in the delivery-assignment list.
**Customer**: A person ordering from shops. Never "user".
**Admin**: The platform operator.
**Area Manager**: The operator of exactly one Area. Onboards and supports the shops in it, and is paid a share of the platform commission earned there. The mockups use a retired term for this role; use Area Manager everywhere in current requirements and implementation.
**Area**: An admin-named container of one or more pincodes, used for administration. Never "zone".
**Service radius**: A shop's own delivery distance. Serviceability is distance from the shop, not Area membership.
**Area pause**: An admin switch that stops new orders in an Area while live orders finish. Separate from a shop's open/closed toggle.
**Location**: Only a geographic location, such as an address or map coordinate.
**Order**: A customer's purchase from exactly one shop. Delivery fee, stock, coupon and handover OTP are per order.
**Cart**: A customer's items for one shop. A customer can hold one cart per shop and checks out one shop at a time.
**Bargain**: A customer's offer of a price per unit for a chosen quantity on a bargain-enabled product, matched instantly against the shop's hidden floor price.
**Floor price**: The Owner's hidden minimum price per unit for a bargain-enabled product. Never shown to customers.
**Slot**: An owner-defined delivery time window with a maximum order capacity, used by Scheduled delivery.
**Master product**: An admin-owned catalog entry: name, brand, category, image, optional barcode, and its packs. Shops list it; they do not create it.
**Pack**: A canonical sellable size of a master product ("1 kg", "12 bananas"), defined on the master product. A shop chooses which packs it stocks and prices each one. Price, stock, bargain toggle and floor price all sit on the shop's pack row.
**Quantity-price option**: A shop's own priced quantity on its listing ("2 pav for Rs 6"), carrying a quantity in the master's base unit. Additional to packs, never a replacement for them, and it holds no stock of its own.
**Reservation**: Stock held for an accepted order. Available stock is on-hand minus reserved. A reservation becomes a decrement on delivery or pickup and is released on any other terminal state.
**Commission**: The platform's share of a delivered order's eligible product value. Delivered orders only; pickup orders and counter bills carry none.
**Booking fee**: A fee on a completed self-pickup order, charged to the customer and optionally to the shop. Never called a delivery fee.
**Contribution floor**: The minimum platform contribution an order must produce to be placeable. Configured per fulfilment route.
**Statement**: A shop's weekly record of what it owes the platform. Money flows from shop to platform, never the reverse except by authorised manual adjustment.
**Shopkeeper app**: The mobile surface for Owner and Staff. "Shopkeeper" is only a surface name.

## Retired and banned terms

**Store**, **Zone**: retired. Use Shop and Area.
**Billing staff**, **Delivery staff**: retired as roles. There is one Staff role plus the `can deliver` flag.
**Partner**: banned outright, bare or qualified. The mockups used it for both the area manager and the delivery rider. Use **Area Manager**. A future platform-managed rider network will get its own name when it is in scope.

## Surfaces (Phase 1)

Customer Mobile, Shopkeeper Mobile and Admin Web. Shopkeeper Web and a separate Delivery Staff app are deferred; the delivery screens are a tab inside the Shopkeeper app.

## Platforms, devices, language and themes

**Both Android and iOS are in scope from day one, from one codebase.** Nothing in the design, the component layer or the native surface may assume Android only. The two platforms differ only in their release gates: the **Google Play release gates the soft launch** because of the fourteen-day closed test, while the **Apple submission does not** and goes in as soon as the Apple account clears. The Apple individual enrolment is the one unverified item, costs 99 USD a year, has been reported to fail at the payment step from India, and should be started early so it is a known cost or a known problem rather than a surprise.

**The acceptance alarm is constrained on both platforms, not only on iOS.** iOS limits background audio. Android has since January 2025 granted the full-screen intent by default only to alarm-clock and calling apps, and an audio foreground service needs a Play Console declaration, so neither platform will reliably ring until someone acts. The floor, present on both, is a high-importance notification channel with ALARM usage and a custom sound — a time-sensitive push on iOS — plus the in-app looping alarm whenever the app is open, with the founder phoning the shop as the stage-one backstop. On Android a full-screen alarm is an **enhancement** whose permission is requested during the in-person onboarding and may be refused, never a requirement for correctness. **Pilot shops are therefore still advised to run the Shopkeeper app on an Android phone**, but the advantage is now the possibility of that alarm rather than a guarantee of it; iOS is supported at the counter, not recommended. The Customer app is unaffected.

**Every surface is English only in Phase 1**, with no Devanagari in the interface and **every string externalised from day one** so that Hindi is later a translation pass and never a hunt for hardcoded text. The search layer is separate and already matches Hindi typed in English letters through the synonym table.

**Android 10 is the floor**, covering roughly 95% of Indian Android traffic by web-traffic sampling, which skews new; the real figure is lower and wants a sanity check against the phones seen on the shop visits. **The iOS minimum is 16.4**, set by the toolchain rather than chosen. Mobile is **phone and portrait only** on entry-level hardware, 2 GB RAM and slow storage assumed, with no tablet layout and no landscape. **Admin Web is desktop-first** on an evergreen browser, usable down to tablet width, with no phone layout.

A shop needs **no dedicated device, no device binding and no install limit**: Owner and Staff each sign in on their own phone, each with its own offline cache and queue. The one documented expectation, not an enforced rule, is that the phone kept at the counter permits notifications and sound, because that is the device the acceptance alarm must reach.

**Light and dark both ship**, following the system setting with a per-account override and no pinning to light. Colour is expressed **only** through semantic tokens, with no literal colour value in any screen. Every surface is checked in both themes, including the ones easily missed: maps, delivery proof photos, the capture screen, empty states, the alarm screen and every error state. **The counter bill and order receipt PDFs stay light in both themes** — a shared, saved and sometimes printed document is not a screen, and the theme stops at the app's edge.

Formats are fixed: **Indian digit grouping** (1,00,000), **two decimals on every money amount without exception** because measured units produce genuine paise, **dd/mm/yyyy** dates, **12-hour time with am/pm**, and **Asia/Kolkata as the only display timezone with everything stored in UTC**. System font scaling is honoured to **130%** and tested there; nothing pins its own font size.

Accessibility commits to **AA text contrast and 48 x 48 dp minimum tap targets, in both themes**, verified during design and again during implementation. Systematic screen-reader and TalkBack testing, a full audit and any certification are **deferred, and stated as deferred**. **No claim of full WCAG 2.1 AA conformance is made anywhere without the verification that would support it**, whatever the reference PRD's wording implies.

## Roles and permissions

Two roles per shop: **Owner** and **Staff**.

Only the Owner can change online or counter prices, create or edit coupons, set bargain floor prices, see settlements, ledger, COD balance owed or revenue reports, add or deactivate staff, or change shop settings (opening hours, service radius, fulfilment modes, minimum order).

Staff can accept, partially accept or reject orders, set preparation time, mark ready, assign a deliverer, adjust stock and mark items out of stock, create counter bills, add products from the master catalog, and deliver when flagged. Staff see all shop orders plus a "My deliveries" list.

One staff account belongs to exactly one shop. The Owner invites staff by phone number; staff log in by OTP; the Owner deactivates rather than deletes, so order history keeps a real actor. There is no cap on staff count. Admin can view and suspend shop accounts and change any shop setting, but does not create staff.

Admin web has a separate **Area Manager** role scoped to one Area.

## Fulfilment modes

Three modes: **Instant delivery**, **Scheduled delivery**, **Self-pickup**. Each shop toggles each mode on or off; Admin can force a mode off.

Scheduled delivery uses owner-defined slots, each with a maximum order capacity. Customers book an available slot for **same-day and next-day delivery**, with bookings allowed up to **one day ahead**. Next-day includes next-morning slots, so an order placed at night can take a slot the following morning. A slot at capacity disappears from the picker.

One serviceability rule covers every mode: a shop is listed and orderable only when the customer is inside that shop's service radius. There is no self-pickup exception for shops further away. Self-pickup carries no delivery fee.

**The platform maximum service radius is 5 km**, with each shop's own radius configurable below it at the 2-3 km the product describes. The maximum is not a product limit so much as a query bound: the nearby-shops search can only use its spatial index against a constant distance, so it filters on 5 km first and compares each shop's own radius afterwards. Raising the maximum is a one-line change and a slightly slower filter.

## Service area

Two layers. An **Area** is administrative: shop approval, category availability, reporting and pausing. **Serviceability** is distance from the shop, which is what "within 2-3 km" means in the product.

Each shop belongs to exactly one Area, derived from its pincode and editable by Admin. The customer feed is driven by distance. A customer whose location falls in no active Area sees "not serviceable yet" and can leave a phone number; those captures guide expansion.

## Bargain

A toggle the Owner turns on per shop pack, with a hidden floor price for that pack. The floor is an absolute amount, never a percentage, and is never sent to a customer app. The customer offers a price for a chosen quantity, limited to three offers per item per day. **The system decides instantly** against the floor: at or above it accepts, below it rejects, with no shopkeeper in the loop. An accepted price is pinned to that quantity in the cart and expires in 30 minutes if the order is not placed; the pin holds a price, never stock. Rejected offers are recorded for the Owner. A bargained line takes no coupon or other discount, and a shop accepts it in full or removes it entirely. Bargain is online only, never in counter billing. Commission is computed on the accepted price.

## Shop types

Grocery and kirana is the pilot focus. There is no second fixed shop type: every other type is an admin-defined category, so adding one needs no code change. Pharmacy and restaurants are out of scope, as is everything else in the excluded list below.

## Shop onboarding, excluded goods and suspension

A shop moves **Draft → Submitted → Under Review → Approved → Live → Suspended → Closed**, and **only Admin moves a shop to Live**. In stage one the founder holds both the Ops and the Admin hands, but the two records stay separate so the flow survives the arrival of Ops staff. **Live requires KYC complete, a recorded physical visit, and the onboarding fee paid or waived with a reason.** The visit is a hard precondition, stored as a geotagged shop-front photo with a timestamp and visit date; a shop can reach Approved without one but never Live.

Onboarding collects **PAN as a hard gate**, entity type (proprietorship, or registered firm, LLP or company), the **FSSAI number** shown on the shop page, shop name, address with pincode and map pin, owner name, phone and email, service radius, and the shop's **UPI VPA**. No bank details: the platform never pays the shop. **The VPA is not test-verified** — the customer app shows no QR, the shop's own staff show it at handover, so a typo surfaces in a day when the shop's money does not arrive, and no platform-side check could catch a staff member showing a personal QR anyway.

**The onboarding fee is waived for the entire pilot cohort**, as a recorded waiver with a reason rather than by removing the fee from the design. It is charged at stage two from the shops that continue. The pilot asks these shops to be unpaid testers, to hold a closed-test opt-in for fourteen days and to accept a commission invoice from an unregistered platform; a cash demand on top of that competes with the first statement, which is the collection that matters.

**Excluded in Phase 1, and nothing age-restricted at all**: prescription medicines and pharmacy of any kind, alcohol, tobacco, nicotine, pan masala and gutkha, prepared and restaurant food, raw meat, fish and poultry, live animals, fireworks, weapons and ammunition, pesticides and agro-chemicals, fuel, LPG and cylinders, lottery and gambling, adult products, and infant milk substitutes and feeding bottles. Excluding every age-restricted good is the point: there is no age gate, no ID capture and no deliverer judging anyone's age at a door. Non-prescription medicine stays out too.

**Enforcement is contractual, not technical.** The master catalog holds no excluded category, so nothing excluded is listable or orderable, and the onboarding agreement names the list with suspension as the consequence. A keyword denylist on counter-bill manual-line text **flags for Admin review and never blocks**, because blocking is bypassed by typing "item" and false-positives on "cigarette lighter". The manual line is an accepted hole.

**Auto-pause** and **suspension** are distinct. Auto-pause is mechanical and clears when its cause does: expired FSSAI, an expired fee past its grace period, or the balance limit reached. Suspension is an Admin judgement with a recorded reason, on these grounds: selling an excluded category, diverting payment or disputing money a customer has paid, materially false listings or prices, upheld safety or expiry complaints, repeated unresponsiveness to accepted orders, non-payment of a statement past its grace period, or KYC documents found invalid. A suspended shop leaves the customer feed and is not deleted, takes no new orders, and lets **in-flight orders run to completion**; **counter billing, inventory and catalog tools keep working**, because the till is the shop's own offline business. The outstanding statement stays due, reinstatement is Admin-only with a recorded reason, the owner sees the reason, and suspension attaches to **the shop and not the owner's account**.

## Search synonyms

An admin-managed global mapping of typed terms to catalog terms, applied to customer search only. Seeded with Hindi and transliterated terms for roughly the top 200 grocery items (kanda to onion, atta to flour). No automatic learning.

## Admin action record

An append-only record of **admin actions** is written from day one. There is no UI for it in Phase 1. Shop-side actions are not in it: they are stamped on the records they change instead, as order status history, stock movements and counter bills (see Order lifecycle).

## Order lifecycle

Seventeen statuses, eight of them terminal, listed with their transitions in #9. A terminal status is locked: later corrections are statement adjustments, never status edits. Deliverer assignment is a field on the order, not a status. `PICKED_UP` is distinct from `DELIVERED` because the two routes earn differently.

The shop is alerted at 120 seconds and the order auto-expires at 600 seconds, both configurable. Expiry charges nothing and fines nothing; it records a reliability event.

**Partial acceptance** reduces a quantity or removes a line. Never a substitution, never an addition. Reasons come from a fixed list. The server recomputes the whole price from the rule versions in the original snapshot, so the minimum cart can legitimately fail. **The customer must explicitly confirm a changed total within a configurable five-minute default; silence cancels the order and never counts as consent.**

Cancellation is free for the customer before acceptance, needs the shop's consent between acceptance and ready, and is impossible in the app once the order is ready. The shop may cancel after acceptance with a reason. Admin may force any transition with a reason.

A failed delivery is one attempt and terminal, after at least one call attempt, a configured wait, a photo and a reason from a fixed list. Goods return to on-hand stock, not merely unreserved. An uncollected pickup order expires at a configurable cutoff with no booking fee charged to anyone.

A scheduled order is auto-approved at placement and the shop gets a review task; it may reject until a configurable cutoff, and inaction leaves the order confirmed. Slots stay owner-defined and capacity-capped.

**Stock is reserved at acceptance**, never at placement or in the cart, and released on every terminal state except delivery and pickup, which convert it to a decrement. Online orders and counter bills share one quantity, held as an append-only movement log. **A counter bill is never blocked by a reservation**: it decrements freely, available stock may go negative, and the shop gets an alert naming the affected online orders.

Every status change records actor, role, timestamp, reason code and the client id of any offline-queued action. The same stamp goes on stock movements and counter bills, which is the shop's accountability trail; there is no separate audit surface in Phase 1.

## Catalog

Admin owns **master products**, their base unit and their canonical **packs**; a shop lists packs and sets its own price, counter price, MRP, stock, availability, low-stock threshold, bargain toggle and floor. A shop cannot create a free-text product that sells online: it submits a request, which is sellable at the counter immediately and hidden from the customer feed until approved.

A shop may also define its own **quantity-price options** on its listing: name, measurement unit, quantity and a total price for that quantity, several per listing ("2 pav for Rs 6", "12 pav for Rs 34"). This is how a quantity discount is expressed, instead of duplicate products. Every option carries a quantity in the master's base unit, so price per base unit stays computable across shops, and **stock is tracked in the base unit only** — an option deducts its quantity, and no option holds stock of its own.

Units are **`each`** (count) or **`measured`** (price per unit with a shop-set minimum and step, so a line is always a count of steps). **Money precision and quantity precision are separate concerns**: a money amount carries two decimals and a quantity carries three, because 0.250 kg is a real quantity while a third decimal of a rupee is not a real price. Quantity times unit price therefore produces more decimals than money has, and that collapses **once per line, rounded half-up to two decimals, with the rounded line total stored rather than recomputed** — which is the difference between a bill that adds up and an argument at a counter. **There is no reweighing at packing**: the selected quantity and price are fixed at checkout and written into the immutable placement snapshot, which is what settlement aggregates. A shop that cannot pack to the selected quantity uses partial acceptance.

Two category levels, the second optional, with per-Area availability on the top level. Seed categories are Groceries, Fruits and Vegetables, Stationery. The print and xerox service is out of Phase 1 and will be reconsidered only if time allows.

In Phase 1: a plain expiry date per listing with no automatic pricing behaviour, a shop-wide discount (shop-funded), barcode scanning against existing EAN or UPC codes only, and an admin CSV importer. Out: near-expiry automatic discounts, shop-side bulk upload, multiple images, branches, label printing. A counter bill may carry a flagged **manual line** that touches no stock and offers one tap to create a pending product request.

## Counter billing and offline

A **counter bill** records catalog lines or a manual line, a bill-level discount, an optional customer name and phone, an optional **"customer agreed to receive offers from YGo"** consent tick stamped with the bill, date and shop, and a payment mode of **cash or UPI only**. Output is a PDF through the phone's share sheet, carrying a YGo download QR and short link; there is no printer. There is no unpaid mode and no customer credit ledger. Owner and Staff may bill; **only the Owner voids a bill**, within a configurable 24 hours, with a reason, as a new movement that returns stock and never edits the original. There is no partial return and no line edit. A manual line's text is checked against a small admin denylist that **flags the bill for review and never blocks it**.

Offline: **counter billing, stock adjustment, marking out of stock, and the delivery screens**. Online only: accepting, rejecting or partially accepting an order, marking ready, price and catalog edits, and anything about money owed. The device caches its own listings, stock and today's accepted orders, queues up to a configurable 500 actions or 72 hours, and then blocks new billing until it syncs.

Conflict rules: **orders and money records, the server wins**. A counter bill is a movement, not a value, so it applies as a delta to the log in any order it arrives. Only an absolute *set stock to N* can conflict, and those resolve by **server receipt order, never the client clock**; a device whose clock is outside a configurable skew stamps its queued actions as clock-suspect.

Stock is corrected per product with a **required reason code** (received, counted, damaged, expired, returned, correction); there is no stock-take screen. At zero or below a listing is **visible but not orderable**, never hidden, and a manual out-of-stock toggle stays independent of the count. Low stock is an in-app list, never a push. Negative stock offers two taps per affected order, partially accept it or fix the count, and **no order is ever auto-cancelled by a stock event**.

Bill numbers are **sequential per shop, unique, and never reused or skipped**. An offline bill shows a provisional local number and is assigned its final number by the server on sync, so no two bills in a shop can share one. A voided bill keeps its number; the void is a separate record.

Shop reports in Phase 1: sales today and this week with the online and counter split, top items, the balance statement, and rejected bargain offers.

## Accounts and sign-in

**Every role signs in with Google Sign-In, or an email OTP as the fallback.** No passwords. The **phone number is still the account identity**: signup collects phone and email, the code goes to the email, and the account is keyed by phone, so switching to SMS later is a configuration change and not a migration. Email is unique per account. **One account per phone number, carrying a set of roles**, with an app-level switch between the Customer and Shopkeeper surfaces; an Owner or Staff member may not place a customer order with their own shop.

Phone with an SMS OTP is the end state, not the soft-launch state: DLT registration needs a registered business, and the entity is registered only after the soft launch. SMS is therefore **built now behind a configuration flag** — one channel interface, two adapters, nothing above it knowing which channel sent the code — and the DLT header and template text is drafted during the soft launch.

The login OTP is 6 digits, valid 5 minutes, 5 wrong attempts then a 15-minute lock, 5 requests an hour per phone. It is generated with a CSPRNG, stored hashed, and **never logged and never in an API response**. Admin web times out after 30 minutes idle; mobile sessions persist 90 days by refresh. The access token lives in memory and the refresh token in the OS secure store, or an httpOnly cookie on web, **never in `localStorage`**; refresh tokens rotate on use and are revocable, so a deactivated Staff member loses access within minutes.

The **handover OTP** is 4 digits, generated at acceptance and carried with the order, revealed in the customer app at Items OK or when the check timer ends, 3 attempts then a cooldown and 6 in total. Offline it verifies against a per-order salted hash, and **the server re-validates every queued delivery on sync**, flagging a mismatch for Admin. The same OTP completes a self-pickup at the counter, without the timer or photo. The only fallback is **a photo plus a required reason**, which delivers the order but flags it as a **proof exception**, counted per shop and per deliverer.

Because the soft launch ships as a public Play release, **Play review is on the critical path**: the reviewer demo account, now keyed to an email address, in-app account deletion with the publicly reachable deletion-request page beside it, a published privacy policy and a completed Data safety declaration. DLT and SMS-provider onboarding is a blocker for the official launch, not the soft launch.

## Account deletion and data retention

A **Customer deletes their own account** from Settings, in two taps, with no reason required. An **Owner or Staff member requests deletion in the app and Admin processes it**; an Owner is blocked while the shop is Live or a statement is outstanding, and the app names which of the two is blocking. Staff deletion removes the person's identity and leaves the deactivated actor on their past transitions and bills.

**Deletion is blocked while any order is in a non-terminal status**, with that stated as the reason; where cancellation is still allowed the flow offers cancel-then-delete. There is no scheduled deletion that fires later.

**Access ends immediately** — sessions revoked and refresh tokens invalidated — with **no self-service undo**, an **Admin restore available within 7 days**, and anonymisation at the 30-day bound. **Hard-deleted**: phone, email, name, saved addresses and map pins, push tokens, waitlist captures, search history, bargain offer history, delivery proof photos and handover OTP hashes. **Anonymised in place**: order rows, keeping the order id, the placement snapshot's lines and amounts, the shop, the timestamps and the commission basis against a **stable opaque pseudonym**. Those anonymised financial records are retained **eight years**, covering both the income-tax and GST windows.

A **deleted phone number may sign up again immediately**, as a new account with no history; anonymised orders never reattach. The shop keeps every past order, with the customer shown as **"Deleted customer"**, name, phone and full address removed, and only the Area and distance band kept for reporting.

The walk-in name and phone on a counter bill belongs to someone who usually holds no account, so an account deletion never touches it. It is kept as the shop's own record; **only numbers carrying the consent tick are ever marketable**, and **no platform messaging reaches them before stage two**, when it goes out DLT-registered, DND-scrubbed and consent-only with an opt-out. The consent tick is built in Phase 1 because consent cannot be obtained retroactively.

A **public deletion-request page** on the marketing domain takes a phone number, the email on file and the request type, **deletes nothing directly**, verifies by emailing a code, and feeds an Admin queue worked inside the 30-day window. A number with no account gets the same neutral response, so the page cannot be used to discover who is a customer, and it accepts a free-text request from someone with no account at all. It must exist **before Play review**.

## Launch stages and tax posture

The launch has **two stages**. Stage one is a **soft launch of one to two weeks with no registered entity**: real shops, real customers, real orders, real money, email sign-in, and commission charged. Stage two follows if it works — entity and GST registration, then SMS OTP, the platform's own FSSAI licence, and the statutory outputs below.

Stage one ships as a **public Google Play release**, so the Play-review items above are launch blockers. A personal Play account created after 13 November 2023 cannot reach production until a closed test has run with **at least twelve testers continuously opted in for fourteen days**; the pilot shops are that cohort, tester opt-in is an onboarding step, and the count dropping below twelve restarts the clock.

**Customer-facing prices are tax-inclusive with no tax breakup.** No HSN sits on a master product and no line-level tax is displayed or computed. A shop's prices are already inclusive, and a breakup nobody can validate across hundreds of products would be a fabricated number on a customer's receipt.

**The shop is the seller of record and the platform is never a seller of goods.** Both customer documents — the online order receipt and the counter bill — are the shop's own sale, issued in the shop's name and address and carrying the shop's GSTIN only if it has one. The platform generates the online receipt; that does not make it the platform's sale. **The customer's bill carries nothing of the platform's** — no platform charge, no platform tax line, no commission. Commission exists only between the platform and the shop, on the weekly statement, and is accounted for separately from the shop's sales. This holds only while every rupee the customer pays is the shop's: disclosing any fee to a customer **as a YGo charge** would make it the platform's own supply at 18%, so Phase 1 has no such fee.

An order receipt shows the shop's identity, the lines from the order's immutable placement snapshot with quantity and price, shop-funded discounts and any accepted bargain price, the delivery fee and any disclosed small-cart or booking fee, the total, the collected payment method, and the order id and timestamp — every amount tax-inclusive, with no tax line.

Commission is charged from day one, but in stage one the weekly statement is a **commercial invoice and not a tax invoice**: no GST line, no GSTIN, and it says so on its face, because a shop that reads it as a tax invoice will claim input credit that does not exist. **No input tax credit is available to any shop on commission during stage one**, which belongs in the onboarding conversation rather than being discovered later. Every statutory output — the commission tax invoice, the GST line, TCS and TDS — sits behind a single **registered-entity flag** that flips at stage two. Nothing statutory is removed from the design; it is switched off.

PAN and entity type are collected at onboarding for a statutory reason, not a bureaucratic one. Section 194O makes the platform responsible for deducting 0.1% of facilitated sales even though the shop collects the money directly, so the exemption matters: an individual or HUF shop under Rs 5 lakh of platform sales in a financial year with PAN furnished is exempt, while a firm, LLP or company has no threshold at all. **Stage one therefore prefers proprietorship shops**; a non-proprietor shop needs a TAN in place first. The rest of the approval set is settled above in Shop onboarding, excluded goods and suspension.

Every statutory figure here needs a chartered accountant's confirmation before stage two, and again after each GST Council or Finance Act change. See `docs/research/financial-architecture-review.md`.

## Money

Customers pay by **cash or UPI at delivery**, to the deliverer, who is the shop's own staff. UPI uses the shop's own VPA: **the customer app never shows a QR** — the deliverer shows one from the Shopkeeper app at handover — so the money lands in the shop's account and the platform never touches customer funds. There is no online prepaid gateway in Phase 1. Staff record the collected method per order.

**The shop collects and the shop owes.** Every rupee the customer pays reaches the shop. The platform invoices what it earned and the shop pays the net on a weekly statement. "Shop payout" means the amount the shop retains, never a transfer from the platform. A period that nets in the shop's favour is settled by an authorised manual adjustment and an offline transfer.

Unpaid platform earnings accrue as a balance visible to the shop and to Admin, warning at 80% of the shop's limit and auto-pausing new orders at 100%. The limit is unset and auto-pause is off until an admin sets it.

Settlement runs weekly on Monday for the preceding Monday-to-Sunday period, aggregating an **immutable pricing snapshot** written at each order's placement. Adjustments are new ledger entries; a snapshot is never rewritten. The shop pays manually and an admin records the payment.

Because nothing is prepaid and UPI is collected at handover, **there is no refund flow**. Cancellation is free before acceptance and allowed until the shop marks the order ready. A refusal at the door marks the order undelivered and charges no commission. Anything owed after delivery is an admin adjustment on the next statement, with the shop returning cash directly.

Area Managers are paid a configurable share of the commission **actually collected** in their Area, in the weekly run but as a separate platform expense, never netted into a shop's statement.

## Pricing engine

`docs/product/revenue-system-spec.md` is authoritative for pricing and settlement mechanics and governs where it and a mockup disagree. In Phase 1 the data model is complete while the admin UI is reduced to global, category and shop scopes.

Commission is computed per line on delivered orders, with the configured default base being eligible product value after shop-funded discounts and after any accepted bargain price, before platform-funded promotion value, excluding fees and taxes. **Pickup earns no product commission** — only an optional disclosed customer booking fee and an optional fixed shop booking fee, both on completed pickup, both shipping disabled, under pickup's own contribution rule. **Counter bills earn no commission** and carry no per-bill charge during the pilot, because charging per bill would give a shop reason to omit sales and corrupt the inventory the feature exists to keep accurate; a flat subscription is the preferred later alternative.

The contribution floor is the ordinary viability guard, with a configurable minimum commission governing Bargain orders so an accepted offer is always honoured. When an order is not viable the published order is: reject an ineligible platform-funded promotion, apply only eligible disclosed fees within caps, offer a larger basket or pickup, then disable delivery checkout with a clear reason. Any exception below the floor is explicitly authorised and recorded with a reason.

Delivery fees carry configurable platform and shop shares. Both a minimum cart and a small-cart fee exist, disclosed before checkout. Coupons are funded by the platform, the shop or an explicit split, one per order, with platform funding capped at the contribution surplus above the floor. There is no fines engine; Admin applies manual statement adjustments instead.

**No rate, fee, floor, split, limit or booking fee is hardcoded.** An admin must configure the required values before a shop can receive orders; a shop with incomplete pricing configuration stays out of the customer feed and cannot accept orders, while its counter billing, inventory and catalog tools keep working.

## Downstream obligations

These are unresolved and belong to named tickets. Do not invent rules for them here.

- **Offline sync transport, idempotency and replay**: Offline sync approach (#20). The policy — what works offline, the queue limits and the conflict rules — is settled in Counter billing and offline above.
- **The SMS or WhatsApp OTP provider**: not chosen. Its onboarding blocks the official launch, not the soft launch.
- **Account recovery when a customer loses access to their email**: derivable as an Admin email change with a recorded reason and no self-service path until SMS is live, but it has not been separately confirmed.
- **Retention rules for shop data**, as distinct from customer data: still unowned. Customer deletion and retention is settled in Account deletion and data retention above.
- **Amazon SES production access**, in the Mumbai region. **This is a soft-launch blocker and was not previously listed as one.** Every sign-in code goes by email until the entity is registered, and a new SES account is sandboxed per region: it can send only to addresses it has already verified, capped at 200 messages a day. Until production access is granted, no shopkeeper and no customer can receive a login code. Approval is reported to take about a day and a verified sending domain helps, so it is cheap — but only if it is started before launch week rather than during it.
- **The six-month AWS account clock.** A new AWS account gets a credit-based Free plan of 100 US dollars on sign-up and up to 100 more for completing set-up tasks. At six months, or when the credits run out, **AWS suspends the account, holds the data for ninety days, and then erases it permanently**; the plan cannot be extended. Unused credits carry over on upgrade, so upgrading early costs nothing and forgetting costs the account. The rule is settled (ADR-0005): **development stays on the Free plan, and the account is upgraded before any real shop or customer data is stored or the pilot goes live, whichever comes first.** What remains outstanding is the pair of reminders, set the day the account is opened — one for credit exhaustion, one for the six-month date — and a payment instrument that can take a recurring rupee charge, which the RBI e-mandate rules make a real failure mode rather than a formality.
- **Which services the Free plan blocks: unverifiable in advance.** Amazon's own guidance says a Free plan account is limited from reaching a subset of services and never says which. So the Free-plan-during-development rule is confirmed only by hitting a wall, and any refusal is the signal to upgrade immediately rather than something to design around. The likeliest wall is Amazon SES production access, which is on the launch path.
- **Whether AWS credits reduce the GST base: unresolved, and it decides what is payable in cash from month one.** The running cost is approved at a provisional 4,000 to 4,500 rupees a month and the verified figure is about 44 US dollars including 18 per cent GST (ADR-0005). No Amazon document says whether a credit is applied before or after tax, so the plan assumes the worse case — **credits cover service charges and the GST is paid in cash, about 590 rupees a month during the credit period**. The first real invoice settles it. GST stays unclaimable until the entity is GST-registered in stage two.
- **A five-page public website**, discovered while resolving the web surfaces (ADR-0006) and previously owned by nobody: a landing page, a privacy policy, terms, the #26 account-deletion request page and a support contact page. It is **not marketing polish for later**. Google Play requires a public privacy policy URL, #26 requires the deletion-request page before Play review, and Amazon SES production access is commonly refused when the sending domain has no real site behind it — which makes this a dependency of email sign-in and therefore of the soft launch. It must be live on the real domain well before launch week.
- **A domain name and the brand spelling**: researched, **deferred by the owner on 13 Oct 2026** because the company name is not settled, and tracked in #27. It is needed for the sending domain that makes email sign-in deliverable, for the TLS certificate and for the web apps, and it is the one launch cost **AWS credits do not cover** — roughly 700 to 1,300 rupees a year on renewal, where the renewal price rather than the heavily discounted first year is the figure to compare. Every short form of the name is already registered; ADR-0005 lists what is available and recommends `ygonow.in`. The spelling itself is unresolved: this repository is `YGo` and the owner has also written "YUGO", and customers see that difference in the app listing name, the sender address and the domain. **This is now the longest lead-time item on the launch path and it sets the earliest possible pilot date.** Once a name exists, four things must happen in sequence — purchase and DNS delegation, then DKIM, SPF and DMARC, then the five-page public site live on it, then SES production access for `ap-south-1`, which is discretionary, takes days and can fail once. That chain is about **two to three weeks** and cannot be compressed, and until it completes no shopkeeper and no customer can receive a sign-in code. The build is unaffected and proceeds in parallel.
- **The Apple individual developer enrolment**: not started. It is the only platform item that cannot be solved by writing code, it has been reported to fail at the payment step from India, and it gates the iOS submission rather than the soft launch.
- **Four toolchain facts the mobile stack assumes and nobody has verified**, each recorded in ADR-0001: that Expo SDK 57 targets Android API 36, which Play requires of new apps and which first bites at the soft launch submission; that Xcode personal-team provisioning can install a build on a real iPhone without the paid Apple enrolment, which is what would let iOS run on hardware early; whether the twelve-tester closed test is required per app or per developer account, which decides whether two listings cost two fourteen-day waits; and whether a Google Cloud billing account can be opened without a registered entity, which maps need and which MapLibre is the fallback for.
- **A food-regulatory adviser's review of the excluded-goods list**, and the platform's own FSSAI Central licence as an e-commerce food business: both belong to stage two, and neither exists yet. The seller-level FSSAI requirement for shops selling through an operator is unsettled across sources.
- **Caps on the shop-wide discount**: Commission, fees and coupon funding (#15) owns the rule; nothing is set.
- **Notification events and recipients**: derivable from the #9 state machine, but no ticket owns them.
- **Every pricing rate, fee, floor, delivery split, credit limit and booking fee**: deliberately unset, to be configured per shop after testing real baskets during the pilot.
- **Re-inviting a deactivated staff phone number**: now derivable from the one-account-per-phone rule above, since re-inviting reattaches the Staff role to the existing account, but it has not been separately confirmed.
- **Whether Complaints needs its own decision ticket** beyond the triage that put the admin module in Phase 1.
- **Date for the catalog and synonym seed package.** The founder owns it: roughly 300 to 500 grocery and kirana master products with quantity-price options, brands and transliterated synonyms, prepared with AI assistance, loaded through the admin importer, prioritising what the pilot shops sell, and validated before live ordering opens. The deadline is set against the pilot launch date, which is itself unset. It gates the pilot and is the only critical-path item that is not code.

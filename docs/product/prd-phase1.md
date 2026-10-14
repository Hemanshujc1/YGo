# YGo Phase 1 — Product Requirements

- **Status**: Approved by the owner on 13 Oct 2026 as the Phase 1 specification (Draft 5). Draft 4 plus the three parts a build specification needs and the PRD did not have: user stories (section 10), implementation decisions (section 11) and testing decisions (section 12). No requirement in sections 1 to 8 changed except ADM-11, which now lists two things ACC-3 and ACC-14 already required. No owner decision is open: D-15, on what an Area Manager may do, was settled the same day (ADM-12). Section 9 lists what changed.
- **Owner**: Hemanshu (founder, sole developer)
- **Decision map**: [YGo Phase 1 decision map](https://github.com/Hemanshujc1/YGo/issues/1)

## How to read this document

This PRD says **what Phase 1 must do and how we will know it worked**. It does not restate every rule. Three documents hold the detail and win where this one is silent or disagrees:

| For | Read | Authority |
|---|---|---|
| What the words mean and every product rule | [`CONTEXT.md`](../../CONTEXT.md) | Authoritative for product behaviour |
| Pricing, discounts, commission and settlement arithmetic | [`revenue-system-spec.md`](revenue-system-spec.md) | Authoritative for money |
| Stack and architecture | [`docs/adr/`](../adr/README.md) | Authoritative for technical choices |

`prd-phase1-reference.md` is an older PRD under a retired brand. It is a reference only; nothing in it binds.

Three conventions:

- Each requirement carries an id (`ORD-3`) and its section links the ticket that decided it.
- **"Configurable" always means an admin setting with no value hardcoded.**
- **"(D-n)"** after a rule points to the owner decision in section 8 that set it. No owner decision is open in this draft.

This document is also the **Phase 1 specification** that implementation tickets are cut from. Its parts sit here:

| Part of a specification | Where |
|---|---|
| Problem and solution | Section 1 |
| User stories | Section 10 |
| Requirements the stories point to | Section 5 and section 6 |
| Implementation decisions | Section 11 |
| Testing decisions | Section 12 |
| Out of scope | Section 4.2 |
| Risks, unchecked facts and owner decisions | Sections 7 and 8 |

Work that has to happen before launch but is not something the software does — the domain, the pilot Area, the legal pages, Play testing — lives in the **launch checklist** in 3.3 and nowhere else.

## 1. Problem and product

A customer who wants something from a shop two streets away has to walk there or phone and hope. The shop has no way to be found by nearby customers who do not already know it, and usually keeps stock and sales in a notebook.

YGo lets a customer order from local shops within roughly 2 to 3 km and have the shop's own staff deliver it, and gives the shop a counter billing and stock tool that works without internet. The platform earns a commission on delivered orders. It never holds customer money and never sells goods itself.

## 2. Who uses it

| Role | Surface | What they do |
|---|---|---|
| **Customer** | Customer app | Finds nearby shops, orders, pays the shop at the door |
| **Owner** | Shopkeeper app | Everything in the shop, including prices, money views, staff and settings; may deliver the shop's own orders |
| **Staff** | Shopkeeper app | Orders, stock, counter billing; delivers when flagged `can deliver` |
| **Admin** | Admin web | Runs the platform. In stage one this is the founder |
| **Area Manager** | Admin web, scoped to one Area | Onboards and supports shops in that Area. First item cut if time runs short |

## 3. Launch plan

### 3.1 Two stages

**Stage one — soft launch.** One to two weeks, **12 to 20 shops in one Area**, no registered business entity. Real shops, real customers, real money, commission charged. Shipped as a public Google Play release. Sign-in is by Google, Apple on iOS, or an emailed code.

**Stage two — official launch.** Only if stage one passes. Entity and GST registration, sign-in by SMS, the platform's own food licence, the tax outputs, the onboarding fee, and growth toward 50 to 80 shops.

### 3.2 What decides stage two

Judged at the end of week two. All four must hold. There is no revenue target, because the first rate card is a starting guess that the pilot exists to correct.

| # | Measure | Bar |
|---|---|---|
| G-1 | Placed orders that end delivered or picked up | at least 80% |
| G-2 | Placed **instant and pickup** orders that the shop accepts within 2 minutes of placement | at least half |
| G-3 | Shops paying their first weekly statement within the grace period | at least 80% |
| G-4 | Money disputes caused by the app's own arithmetic | none |

Scheduled orders are left out of G-2 because they are approved automatically and would flatter the figure. G-2 is counted over every placed instant and pickup order, so one that the shop rejects or lets expire counts as not accepted in time. G-3 needs the statement grace period to be set, which is why it is one of the values a shop cannot go Live without (MNY-13).

The soft launch **ends at two weeks with a decision**: continue to stage two, fix and rerun, or stop. It is not allowed to drift, because each extra week as an unregistered platform adds exposure for less new information.

### 3.3 Launch checklist

The build is one track. Everything below is outside the code, gates the launch, and cannot be hurried by writing code faster. None of it is a software requirement, so none of it becomes an implementation ticket.

| # | Item | Who | Gates |
|---|---|---|---|
| L-1 | **Company name, spelling and domain** ([Domain name and brand spelling](https://github.com/Hemanshujc1/YGo/issues/27)). Then DNS, then email authentication, then L-2, then L-4. About two to three weeks in sequence. **Until the chain finishes nobody can receive a sign-in code.** This sets the earliest launch date | Owner | Stage one |
| L-2 | **Public website live on the real domain**: landing, privacy policy, terms, account-deletion request, support | Build, after L-1 | Play review, L-4 |
| L-3 | **Legal text written**: privacy policy, terms, and the shop onboarding agreement. The agreement must name the excluded goods and suspension, show the shop's rate card, say that no input tax credit exists on commission in stage one, and state the shop's duty to repay a customer when a complaint is upheld. The agreement gives the seven days for that repayment. The privacy policy must state the 30-day deletion promise, the 90-day backup period, and that a blocked customer's phone number and email are kept in an unreadable form while the block lasts | Owner | Play review, every shop going Live |
| L-4 | **Permission from Amazon to send email to anyone** in the Mumbai region. Discretionary, takes days, can fail once | Owner, after L-2 | Stage one |
| L-5 | **Google Play closed test**: twelve testers opted in continuously for fourteen days, the Data safety declaration, and the reviewer demo account. Whether two apps mean two fourteen-day waits is unverified (V-3) | Owner | Public release |
| L-6 | **Apple developer enrolment.** Reported to fail at payment from India | Owner | iOS release only |
| L-7 | **The pilot Area and its 12 to 20 shops chosen** | Owner | Stage one |
| L-8 | **Seed catalog**: 300 to 500 grocery products with packs, brands and Hindi-in-English search terms, loaded before ordering opens | Owner | Stage one |
| L-9 | **The first rate card**, worked out in the price simulator from the pilot shops' own price lists and shown to each shop before it goes Live (MNY-13) | Owner | Every shop going Live |
| L-10 | **Shop visits**: geotagged photo, PAN, FSSAI number and expiry, tester opt-in, alarm permission, and confirming the Owner's phone and email belong to the person in the shop | Owner | Every shop going Live |
| L-11 | **Cloud account**: billing alarms before the first resource, upgrade off the free plan before any real data, the two reminders, one timed restore drill | Owner | Stage one |
| L-12 | **Support mailbox** on the brand domain, read daily | Owner, after L-1 | Stage one |

Stage two only: the SMS provider and its registration; an accountant's check of the tax figures, including whether the bill reference and bill number scheme (BIL-5) satisfies invoice numbering for a GST-registered shop; a food-regulation adviser's check of the excluded list; the platform's food licence.

### 3.4 If time runs short

Cut in this order, and nothing else before these:

1. Area Manager accounts and payouts
2. Split-funded coupons (shop-funded and platform-funded coupons stay)
3. Pickup booking fees (they ship switched off anyway)
4. Scheduled delivery
5. The iOS release, which may follow Android

**Never cut:** the order journey, pricing and the price simulator, offline counter billing, delivery proof, weekly statements, Bargain, ratings, account deletion.

## 4. Scope

### 4.1 Surfaces

| Surface | Phase 1 |
|---|---|
| Customer app, Android and iOS | Yes |
| Shopkeeper app, Android and iOS, with delivery screens as a tab | Yes |
| Admin web, desktop-first | Yes |
| Public website, five pages | Yes — see L-2 |
| Shopkeeper web, separate delivery app | No |

### 4.2 Out of Phase 1

Online prepayment and any payment gateway; refunds and any payment from the platform to a customer; platform-managed delivery riders; live map tracking; chat or masked calling; price comparison across shops; wishlist; trust badges; sponsored listings; a fines engine; substitutions; a second delivery attempt; reweighing at packing; shop bulk upload; near-expiry auto-discounts; multiple product images; shop branches; label printing; printers; customer credit at the counter; the print and xerox service; Hindi interface; tablet and landscape layouts; an audit-log screen; reports beyond those listed in 5.14; written reviews; SMS and WhatsApp messages; pharmacy, restaurants and every age-restricted good; shop-profit protection; per-Area category availability; Area-level pricing scopes in the admin screens; promotion stacking.

## 5. Requirements

### 5.1 Accounts and sign-in — [Login and handover OTP](https://github.com/Hemanshujc1/YGo/issues/18), [Roles and staff](https://github.com/Hemanshujc1/YGo/issues/5)

- **ACC-1** Every role signs in with Google or a 6-digit emailed code. On iOS, Sign in with Apple is offered beside Google, because Apple requires it. No passwords.
- **ACC-2** An account is created at first sign-in. Signing in proves the email; the app then requires a name and a phone number before anything else. The name is the person's own, typed once, shown to the shop and the deliverer on that person's orders, and the customer can change it in Account. One account per phone number and one per email.
- **ACC-3** **In stage one the phone number is claimed, not verified**, and the account records it as unverified. A number already in use is refused and the person is pointed to support. **This is accepted for customers in stage one only** (D-1), within these limits: an unverified number never grants access to a shop, never proves on its own who someone is, and never moves an account or its history to another person; Admin sees the state of every number (ACC-14); and the acceptance lapses at the stage-two review. If SMS is not ready at that review, whether ordering on unverified numbers continues is decided there and recorded; the app has no default, and Admin has a switch that stops new customer sign-ups (D-11).
- **ACC-4** Every account starts as a Customer and may carry more roles, with a switch between the Customer and Shopkeeper sides. An account holds at most one active shop link at a time, as Owner or as Staff.
- **ACC-5** The Owner role is attached when the account starts a shop application and carries no power until Admin moves that shop to Live, with one exception: from Approved the Owner may set up listings, prices and opening stock, so the shop is ready the moment it goes Live. Counter sales and every other stock operation open at Live. Admin confirms at the visit that the account's phone and email belong to the person in the shop, which makes the Owner's number **visit-confirmed** (ACC-14).
- **ACC-6** The Owner invites Staff by phone number. The invited person completes the link by entering a one-time **join code** shown in the Owner's app. A phone number alone never grants access to a shop.
- **ACC-7** Re-inviting a deactivated person reactivates the same link, so their history stays attached. Only the Owner can do it.
- **ACC-8** Admin and Area Manager accounts are created by an Admin and are never open to sign-up.
- **ACC-9** An Owner or Staff member cannot place a customer order with their own shop.
- **ACC-10** Sign-in by SMS is built behind a switch and stays off until stage two. When it is switched on, every account, Owners included, confirms its phone number by SMS at next sign-in and the number becomes **SMS-verified** (ACC-14). A number its holder cannot confirm is released.
- **ACC-11** A deactivated Staff member loses access within minutes.
- **ACC-12** A lost email is recovered only by Admin. For an Owner: a PAN, FSSAI or visit-record match. For a Customer, because the phone number is unverified, a call is not enough (D-1): Admin calls the number on file **and** the caller gives two details from the account's own order history; a notice goes to the old email address; and the checks made are recorded. An account with no completed order cannot be recovered; Admin releases its phone number and the person signs up again. Every session is revoked. This is a known weak point until SMS arrives.
- **ACC-13** A reviewer demo account exists for Play and App Store review.
- **ACC-14** Every phone number is in one of three states, recorded on the account and visible to Admin. They are never treated as the same thing.

  | State | Who has it | What it rests on | What it is good for |
  |---|---|---|---|
  | **Unverified** | Every Customer and Staff member in stage one, and an Owner before the visit | The person typed it. Nobody checked | Reaching the person, and one account per number. Nothing else (ACC-3) |
  | **Visit-confirmed** | An Owner whose shop has had its visit | Admin confirmed in person that the number belongs to the person in the shop, recorded with the visit (L-10) | The Owner role. It is a person's word and a record, not a code sent to the phone |
  | **SMS-verified** | Nobody in stage one. Every account once SMS is switched on | A code sent to the number and entered | Signing in by phone, and retiring the weak points in ACC-12 and R-13 |

  A Staff member's access rests on the join code (ACC-6), not on the state of their number.

### 5.2 Shop onboarding — [Shop KYC and regulated goods](https://github.com/Hemanshujc1/YGo/issues/17)

- **ONB-1** A shop moves Draft → Submitted → Under Review → Approved → Live → Suspended → Closed. The Owner starts the application in the Shopkeeper app; Admin may correct any field. Only Admin moves a shop to Live.
- **ONB-2** Live requires: details complete, a recorded visit in person with a geotagged shop-front photo, the onboarding fee paid or waived with a reason, and a complete rate card (MNY-13). The fee is waived for the whole pilot.
- **ONB-3** Collected: PAN (required), entity type, FSSAI number **and its expiry date**, shop name, address, pincode, map pin, owner name, phone, email, service radius, UPI id. **Numbers only — no photo or scan of any identity document is stored.** No bank details.
- **ONB-4** Counter billing and stock tools open when the shop goes Live, not before. A Live shop whose rate card becomes incomplete stays out of the customer feed, and its counter billing and stock tools still work. A Suspended shop keeps them (ONB-7); a Closed shop does not (DEL-11).
- **ONB-5** The Owner accepts an onboarding agreement that names the excluded goods, states suspension as the consequence, and shows the shop's rate card. Acceptance is stored with the agreement version, the rate card version and the time.
- **ONB-6** Auto-pause is mechanical and clears by itself when its cause does. Its causes are an expired FSSAI, an onboarding fee expired past its grace period, and the balance limit reached (MNY-9). The fee cause cannot arise in the pilot, where the fee is waived. The Owner enters a renewed FSSAI expiry date in the Shopkeeper app; the pause lifts as soon as it is saved, and Admin can correct the date (D-17).
- **ONB-7** Suspension is an Admin judgement with a recorded reason, never automatic, on these grounds: selling an excluded category; diverting payment or disputing money a customer has paid; materially false listings or prices; upheld safety or expiry complaints; repeated unresponsiveness to accepted orders; a statement unpaid past its grace period; a repayment to a customer unpaid past its seven days (TRU-4); KYC details found invalid. A suspended shop leaves the feed, takes no new orders, finishes its in-flight orders, and **keeps its counter billing, stock and catalog tools**. Its statement stays due. The Owner is told and sees the reason. Suspension attaches to the shop, not to the Owner's account. Only Admin reinstates, with a reason.

### 5.3 Catalog — [Catalog model](https://github.com/Hemanshujc1/YGo/issues/10)

- **CAT-1** Admin owns master products and their packs. A shop chooses which packs it stocks and sets its own online price, counter price, MRP, stock, low-stock level and availability.
- **CAT-2** A shop may add its own quantity-price options ("2 for ₹6"). Stock is always held in the product's base unit.
- **CAT-3** A shop requests a product that is not in the catalog. It can sell it at the counter at once; customers see it only after Admin approves. Admin approves it, maps it to an existing product, or rejects it with a reason.
- **CAT-4** Units are counted or measured. A measured product has a minimum and a step. There is no reweighing at packing.
- **CAT-5** Two category levels. **Categories and master products are one global list.** Seeded with Groceries, Fruits and Vegetables, Stationery. Switching a category on or off per Area is out of Phase 1.
- **CAT-6** Barcode scanning against existing barcodes. Admin imports the catalog by CSV.
- **CAT-7** The catalog holds no excluded category, so **no customer can order an excluded good**. This does not hold at the counter: see CAT-8 and R-9.
- **CAT-8** A denylist of words is run over counter-bill typed lines, product-request names and quantity-price option names. A match flags the item for Admin and never blocks the shop. A request rejected as an excluded good is removed from that shop's counter list and can no longer be picked for a new bill or have stock added. Bills, stock movements and reports that already name it are kept unchanged (D-9).

### 5.4 Finding shops and products — [Service area](https://github.com/Hemanshujc1/YGo/issues/6)

- **DSC-1** A customer sees a shop, and can order from it, only when **both** are true: the customer's location is in an active Area, and it is inside that shop's own service radius. The Area is found from the pincode of the customer's location. The radius test is the same for all three fulfilment modes. The platform maximum radius is 5 km. The customer's Area and the shop's Area do not have to be the same one.
- **DSC-2** Shop cards show rating, estimated time and delivery fee. The shop page shows opening hours, minimum order and FSSAI number.
- **DSC-3** Search covers products and shops and matches Hindi typed in English letters ("kanda" finds onion) through one admin-managed list for the whole platform.
- **DSC-4** An out-of-stock item is shown but cannot be ordered. It is never hidden.
- **DSC-5** A customer whose location is in no active Area sees "not serviceable yet" and can leave a phone number, **even if a Live shop is within range**. This is the known cost of building Areas from pincodes, accepted when the service area was decided.

### 5.5 Cart and checkout — [Order shape](https://github.com/Hemanshujc1/YGo/issues/3)

- **CRT-1** One cart per shop. One order is one shop. Checkout is one shop at a time.
- **CRT-2** Every figure in the cart comes from the server; the phone never works out a total. Every fee is shown before checkout. The server calculates again when the order is placed, and a changed total must be accepted by the customer.
- **CRT-3** One coupon per order. At most one shop-wide discount per order. **At most one promotion applies to an order: the shop-wide discount or one coupon, never both, whatever the coupon's funding** (D-7): where a coupon and the shop-wide discount both qualify, the one that takes more rupees off this order applies, the shop-wide discount on a tie; the customer is told which, and a coupon that was not applied is not counted as used. This holds for platform-funded, shop-funded and split-funded coupons alike (D-13). The maximum in MNY-5 also binds a coupon an Owner creates (D-12).
- **CRT-4** When an order cannot be placed, the customer is told why and what to do: add items, choose pickup, drop a promotion, or pick another slot.
- **CRT-5** All prices include tax. No tax breakdown is shown anywhere.
- **CRT-6** The minimum cart is tested on product value before any discount, and counts bargained lines at their accepted price.

### 5.6 Bargain — [Mock feature triage](https://github.com/Hemanshujc1/YGo/issues/7)

- **BRG-1** The Owner switches Bargain on per pack and sets a hidden floor price, above zero and no higher than the pack's online price. The floor is never sent to a customer's phone. A quantity-price option cannot be bargained.
- **BRG-2** The customer offers a price for a chosen quantity. The system answers at once: at or above the floor is accepted, below is rejected. No shopkeeper is involved. An offer at or above the online price buys at the online price.
- **BRG-3** Three offers per pack, per customer, per calendar day, accepted or not.
- **BRG-4** An accepted price holds for that quantity for 30 minutes, whatever the shop changes meanwhile. It holds a price, not stock.
- **BRG-5** A bargained line takes no coupon or discount and is left out of every discount and coupon base. The shop accepts it whole or removes it. **An order containing a bargained line takes no coupon of any funding** (D-6). The customer is told to remove either the coupon or the bargained line. The shop-wide discount still applies to the order's other lines.
- **BRG-6** An accepted price is always honoured at checkout: an order with a bargained line is governed by the configured minimum commission and never refused for the delivered-order floor. The minimum cart still applies (CRT-6). The Owner sees rejected offers.

### 5.7 Orders — [Order lifecycle](https://github.com/Hemanshujc1/YGo/issues/9)

- **ORD-1** Seventeen statuses, eight final. The allowed transitions are those in the ticket **plus the ones its text requires and its table left out**: partial acceptance from any status before ready, the customer's confirmation returning the order to the status it came from, and cancellation of a scheduled order by the customer or the shop. A final status is locked; later corrections are statement adjustments.
- **ORD-2** For instant and pickup orders the shop is alerted again at 120 seconds and the order expires at 600 seconds. Both configurable. Expiry costs nobody anything. Neither timer applies to a scheduled order.
- **ORD-3** The shop may accept in part by reducing a quantity or removing a line, at any point before the order is ready. Never a substitute, never an addition.
- **ORD-4** **After a partial acceptance the customer must confirm the new total within five minutes, or ten for a scheduled order (FUL-5). Silence cancels the order.** Fees stand as quoted and none is added or raised. An order that now falls under the minimum cart is not rejected for it. One that falls below the contribution floor proceeds as a **recorded exception, provided the platform's contribution is not negative** (D-5). A platform-funded discount is cut back or removed in the new total so that it never exceeds what the platform earns on the order, and the customer sees that in the changed total with the reason. If contribution would still be negative the order is cancelled at no cost to the customer. Each exception is recorded on the order and listed for Admin.
- **ORD-5** For instant and pickup orders the customer cancels freely before acceptance, with the shop's agreement until the order is ready, and not at all in the app after that. Scheduled orders: see FUL-5.
- **ORD-6** Stock is reserved when an order is accepted, never in the cart and never while it waits for the shop. A scheduled order's automatic approval is its acceptance.
- **ORD-7** Every status change records who did it, in what role, when and why.
- **ORD-8** The order detail always shows a **call the shop** button.

### 5.8 Fulfilment — [Fulfilment modes](https://github.com/Hemanshujc1/YGo/issues/8)

- **FUL-1** Instant delivery, Scheduled delivery and Self-pickup. Each shop switches each on or off; Admin can force one off.
- **FUL-2** Scheduled delivery uses the Owner's own daily time slots, each with a maximum number of orders, for today and tomorrow. A place is taken when the order is placed and given back if the order is rejected or cancelled. The count is checked at placement, so the last place cannot be sold twice. A full slot disappears. Bookings for a slot close at its reject cutoff. Editing or removing a slot never cancels an order already in it.
- **FUL-3** A scheduled order is approved automatically when placed: stock is reserved, the place in the slot is taken and the handover code is generated at that moment. If the stock or the place is not there, the order is refused with the reason.
- **FUL-4** The shop is asked to review a scheduled order and may reject it until a configurable cutoff before the slot. Doing nothing leaves it confirmed. After the cutoff the shop can only cancel with a reason, which counts against its reliability.
- **FUL-5** The customer cancels a scheduled order freely until the same cutoff, which is shown on the slot and on the order. From then until the order is ready the shop must agree, and after that it cannot be cancelled in the app. **A changed total on a scheduled order must be confirmed within ten minutes**, configurable separately from the five minutes of other orders; silence cancels the order and releases its stock and its place in the slot (D-4).
- **FUL-6** Stock held for a scheduled order can still be sold at the counter (BIL-4). The shop then partially accepts the scheduled order like any other.
- **FUL-7** Self-pickup has no delivery fee and is completed with the same 4-digit code, at the counter, with no proof photo. It is paid for at the counter when collected (MNY-1). A pickup order that is never collected expires at a configurable cutoff, and nobody pays or is charged anything for it.

### 5.9 Delivery and proof — [Login and handover OTP](https://github.com/Hemanshujc1/YGo/issues/18)

- **DLV-1** The Owner, or a Staff member flagged `can deliver`, is assigned to a ready order and sees it under "My deliveries". The Owner needs no flag and no Staff account.
- **DLV-2** At the door: a proof photo, then the customer's 4-digit handover code, which is generated when the order is accepted and appears in the customer app after the item check.
- **DLV-3** The delivery screens work without internet. The server rechecks every offline delivery when the phone reconnects.
- **DLV-4** If the code cannot be used, a photo and a reason complete the delivery and mark it a **proof exception**, counted per shop and per deliverer.
- **DLV-5** A failed delivery needs one call attempt, a wait, a photo and a reason. It is final, and the goods go back into stock.
- **DLV-6** The deliverer shows the shop's UPI QR from the Shopkeeper app, or takes cash, and records which.
- **DLV-7** The assigned deliverer sees the customer's name and phone number for that order only.

### 5.10 Counter billing and stock — [Inventory and counter billing](https://github.com/Hemanshujc1/YGo/issues/11), [Tax and invoicing](https://github.com/Hemanshujc1/YGo/issues/16)

- **BIL-1** A counter bill has catalog lines or a typed manual line, a discount, optional customer name and phone, an optional consent tick for offers, and cash or UPI.
- **BIL-2** The bill is a PDF shared from the phone. No printer.
- **BIL-3** **Counter billing, stock changes and marking out of stock work with no internet**, for up to 500 actions or 72 hours, both configurable.
- **BIL-4** A counter sale is never blocked by stock held for an online order. If stock goes negative the shop is told which online orders are affected and fixes each in two taps. No order is ever cancelled automatically by stock.
- **BIL-5** Every bill has two identifiers.
  - The **bill reference** is made on the phone at the moment of sale, is unique and permanent, and is on every copy.
  - The **bill number** runs in sequence per shop with no gaps and no repeats. The server gives it when the bill reaches it, so a bill made offline gets its number later.
  - Numbers follow the order bills reach the server, not always the order of sale. Each bill keeps its sale time.
  - A bill shared before sync shows the reference and "number pending". Shared again later it shows both. Either one finds the bill.
  - A bill held back for attention has no number until it is resolved. Sending the same bill twice returns the same number.
  - A bill is held back only when the server cannot apply it as recorded: it names a product or pack no longer on the shop's list (removed, or rejected as an excluded good, while the phone was offline), it fails validation, it is older than the server's limit, or it depends on another held action, such as the void of a held bill. A total that disagrees (BIL-9), a suspect clock or a denylist match only flags the bill; it still gets its number. The sale stands either way, and Admin resolves a held bill by giving it the next number with a note.
- **BIL-6** Only the Owner voids a bill, within 24 hours, with a reason. The original is never edited and keeps its reference and number.
- **BIL-7** Every stock change needs a reason from a fixed list.
- **BIL-8** Counter bills carry no commission and no charge of any kind.
- **BIL-9** A counter bill's total is worked out on the phone and is the total on record. The server checks it on sync; a disagreement flags the bill for Admin and changes nothing.

### 5.11 Money — [Phase 1 payments](https://github.com/Hemanshujc1/YGo/issues/13), [Money direction and settlement](https://github.com/Hemanshujc1/YGo/issues/14), [Commission, fees and coupon funding](https://github.com/Hemanshujc1/YGo/issues/15)

- **MNY-1** The customer pays the shop, in cash or by UPI to the shop's own account, **at the handover: at the door for a delivery, at the shop's counter for a pickup**. Nothing is paid in advance on any route. For a pickup, Staff show the shop's UPI QR from the Shopkeeper app or take cash, and record which, exactly as a deliverer does (DLV-6). A pickup booking fee, where one is switched on, is part of the total the shop collects and is owed to the platform on the statement. The platform never touches customer money. There is no refund flow, and the platform pays no customer anything.
- **MNY-2** Commission is charged on delivered orders only, worked out per line. Pickup and counter bills carry none.
- **MNY-3** **No rate, fee, floor, split or limit is built in.** Admin sets every one, at global, category or shop level, and can see which level a value came from. A value set globally covers every shop without its own. Area-level settings exist in the data and have no screen in Phase 1.
- **MNY-4** An order must produce a minimum platform contribution to be placeable, set separately for delivery and pickup.
- **MNY-5** A shop-wide discount is either a percentage with an optional rupee cap, or a flat amount with a required minimum order. It may not exceed a maximum effective percentage, 20% by default, checked when the Owner saves it. The same maximum binds a shop-funded coupon and the shop-funded share of a split-funded one (D-12).
- **MNY-6** Shop-paid and platform-paid discounts are recorded as separate amounts everywhere.
- **MNY-7** The exact prices, rules and amounts of each order are frozen when it is placed and never rewritten.
- **MNY-8** Every Monday each shop gets a statement for the previous Monday to Sunday showing what it owes. The shop pays by hand; Admin records the payment.
- **MNY-9** The shop sees its running balance. It is warned at 80% of its limit and paused from new orders at 100%. The pause stays off until Admin sets a limit.
- **MNY-10** Admin has a **price simulator**: pick a shop, basket, route and promotion and see the customer total, what the shop keeps and what the platform earns. It runs the same calculation as real orders and can try a draft rule without saving it.
- **MNY-11** No screen, statement or document says or implies that a shop is selling at a profit. The platform does not know what a shop paid for its goods.
- **MNY-12** In stage one the statement is a commercial invoice, says on its face that it is not a tax invoice, and carries no GST. Tax outputs are built and switched off.
- **MNY-13** **A shop cannot go Live without a complete rate card**: the commission rule, the delivery fee and its shares, the delivered-order contribution floor, the minimum cart, the statement grace period, and — where the shop uses them — the pickup contribution rule and the Bargain minimum commission. An empty value is incomplete; a zero that was entered is complete. The first rate card is set before launch (L-9), not after real orders.
- **MNY-14** A change to a Live shop's rate card is told to the shop in the app and in person, **takes effect from the start of the next statement week, and never applies to an order already placed** (D-3). Admin cannot make one take effect mid-week. A mistake found mid-week is put right by a statement adjustment.
- **MNY-15** **There is one calculation, on the server.** The cart, the placed order, the recalculation after a partial acceptance, the simulator and the statement all use it. The only money worked out on a phone is a counter bill's total (BIL-9).

### 5.12 Notifications

- **NOT-1** Two channels: push and an in-app list. No SMS. No email except three about access to the account itself: the sign-in code, the code that confirms a request made on the public deletion page (DEL-9), and the notice sent to the old address when Admin changes an account's email (ACC-12).
- **NOT-2** A notification only reports something already recorded. Missing one never changes an outcome.
- **NOT-3** Two are loud: a new order for the shop, and the changed-total confirmation for the customer, which also shows as a banner that will not go away.
- **NOT-4** Admin receives no push. Admin works queues.
- **NOT-5** The new-order alarm rings as loudly as each phone allows. Shops are advised to keep an Android phone at the counter, and the founder phones the shop as the backstop.
- **NOT-6** The full list of who is told what is in `CONTEXT.md` under Notifications. It includes: the customer when a complaint is resolved, when a repayment is recorded as owed to them and when the shop marks it paid; the shop when a repayment is recorded against it, when a rate-card change is scheduled, when a complaint is upheld against it, when a shop-wide discount or a coupon it funds is paused because the cap was lowered, when it is suspended or reinstated, and when a product request is approved or rejected.

### 5.13 Ratings, complaints, refusals, support

- **TRU-1** After delivery or pickup the customer may give the shop 1 to 5 stars. **No written comment.** The average covers 90 days and shows after three ratings.
- **TRU-2** A customer raises a complaint from the screen of a **delivered or picked-up** order, **until the end of the third calendar day after the delivery or pickup**, with an optional photo and one of seven categories: missing item, wrong item, damaged, expired or unsafe, overcharged, behaviour, other (D-8). After that the app points to the support email, and Admin may open a late complaint for a serious safety issue with the reason recorded. The customer sees at once that it was received. It lands in an Admin queue. The shop is not told until it is upheld and has no reply in the app; Admin speaks to the shop outside the app before upholding anything that costs it money.
- **TRU-3** Admin resolves a complaint with a reason. An upheld complaint may reverse the commission on the affected lines, as a statement adjustment. **That adjustment is between the shop and the platform and pays the customer nothing.**
- **TRU-4** When a customer is owed money after an upheld complaint, Admin records the amount and **the shop pays the customer directly within seven calendar days** (D-10). Both sides see the amount, the due date and the status: owed, marked paid by the shop, confirmed by the customer, or disputed. A dispute or a missed date puts it in an Admin queue. Admin settles a dispute after speaking to both sides outside the app, as either paid or still owed, with a reason both sides see. Still owed keeps the original due date (D-19). The platform never holds or passes on the money, and nothing happens to the shop automatically. A repayment left unpaid past its date is a ground on which Admin may suspend the shop, as a judgement with a recorded reason (D-14). A repayment owed to a customer who deletes their account stays owed and stays in the Admin queue (DEL-2).
- **TRU-5** Refusals and failed deliveries are counted per customer. Two in 30 days flags the customer for Admin. Admin blocks or unblocks with a reason; nothing blocks automatically. A blocked customer cannot place a new order and sees the support email; an order in progress finishes. **A block survives account deletion** (D-2): while a block is active, a keyed hash of the phone number and of the email is kept, which cannot be read back, and a new sign-up matching either starts blocked. Unblocking destroys both. Nothing is kept for a customer who is not blocked.
- **TRU-6** Support is one email address on the brand domain, shown in both apps and on the website. There is no platform phone number.

### 5.14 Admin web

- **ADM-1** Areas and pincodes, with a pause switch per Area.
- **ADM-2** Shops: approval, the visit record, settings, suspension and reinstatement.
- **ADM-3** Catalog: master products, packs, categories, product requests, CSV import, search terms, the denylist.
- **ADM-4** Orders: live monitoring, detail, forced transitions with a reason.
- **ADM-5** Rate cards, coupons and the price simulator.
- **ADM-6** Statements, payments received, manual adjustments, shop balances and limits.
- **ADM-7** Queues: complaints, repayments disputed or overdue, orders that went ahead below the contribution floor, product requests, deletion requests with their age, flagged counter bills, flagged product requests, proof exceptions, flagged customers, orders unanswered at 120 seconds, and sync actions that failed.
- **ADM-8** A dashboard of tiles and nothing more: orders today by status, live shops, outstanding balances, open queue counts, and the four launch measures G-1 to G-4.
- **ADM-9** Area Managers and their payouts, as a share of commission actually collected in their Area, worked out weekly on the same Monday-to-Sunday week as statements (D-18).
- **ADM-12** An Area Manager works only inside their own Area (D-15). There they may see shops and applications, correct an application's fields, record the visit, see orders and the queues without acting on them, and see their own payout. They may not touch rate cards, coupons, statements, payments, suspension, customer blocks, the catalog or any setting, because each of those moves money or removes someone from the platform. Only Admin moves a shop to Live (ONB-1).
- **ADM-10** Every admin action is recorded from day one. There is no screen for the record in Phase 1.
- **ADM-11** Customers: look up, see the state of the phone number (ACC-14), block and unblock, change an email for recovery, restore a deleted account inside its window. The switch that stops new customer sign-ups (ACC-3) is here.

Shop reports in the Shopkeeper app: sales today and this week split online and counter, top items, the balance statement, rejected bargain offers.

### 5.15 Account deletion — [Account deletion and data retention](https://github.com/Hemanshujc1/YGo/issues/26)

- **DEL-1** A Customer deletes their account in two taps. An Owner or Staff member requests it and Admin processes it.
- **DEL-2** Deletion is refused while an order is in progress, or for an Owner while the shop is Live or a statement is unpaid. The app says which. **An outstanding repayment (TRU-4) does not refuse a Customer's deletion**: the debt and its record are kept, are never marked settled because of the deletion, and are anonymised with the order on the clocks in DEL-5.
- **DEL-3** **Day 0, the account is closed.** The person cannot sign in, shops see "Deleted customer", and the personal details are sealed where only an Admin restore can reach them.
- **DEL-4** **For 7 days Admin can restore it**, with its addresses and order history. A restore is refused if the phone number or email has been used for a new account since.
- **DEL-5** **When the 7 days end the personal details are erased and the orders anonymised, for good.** The one thing that outlives it is the unreadable marker of an active block (TRU-5). Order and money records are kept without identity for eight years.
- **DEL-6** Everything is complete within 30 days of the request. Where Admin processes the request, the 7 days start when Admin acts, so Admin must act within 23 days.
- **DEL-7** A deleted phone number may sign up again at once, as a new account with no history. Doing so inside the 7 days gives up the restore.
- **DEL-8** Copies inside backups age out within 90 days, and a restored backup has later deletions applied again before use.
- **DEL-9** A public web page accepts deletion requests and reveals nothing about who has an account.
- **DEL-10** **Shop records are kept on their own clocks**, counted from the shop's last financial record and not from the day it closed.

  | Class | What is in it | Kept |
  |---|---|---|
  | Mandatory | Commission invoices, weekly statements, ledger entries and adjustments; each order's frozen lines, amounts and commission basis; and the shop's **invoice identity**: legal name, address, entity type, PAN number, FSSAI number | Eight years |
  | The shop's own business record | Counter bills, the stock movement log, and the record that the visit happened, with its date and who made it | Eight years, on the same clock |
  | Removable | The Owner's and Staff's name, phone, email and push tokens; the UPI id; the shop-front photo; rejected bargain offers; search history; device and sync details | Personal details go on account deletion, as a customer's do. The photo goes one year after closure. The visit record stays |

- **DEL-11** A Closed shop is never purged while a statement, invoice or commission record exists. It leaves the feed, its listings stop selling, its counter billing stops, and anything outstanding stays due.
- **DEL-12** An Owner's deletion removes the Owner's personal details and **never the shop's invoice identity** inside the eight years, because an invoice has to name who it was issued to. A Staff member's deletion leaves a nameless deactivated actor on their past bills and status changes, and a later invitation is a new account.
- **DEL-13** The walk-in name and phone on a counter bill are the shop's own record and are untouched by any account deletion. Only numbers carrying the consent tick (BIL-1) may ever be messaged, and none before stage two.

## 6. Qualities the product must have

| # | Requirement |
|---|---|
| Q-1 | Runs on a 2 GB Android 10 phone and on iOS 16.4. Phone, portrait only |
| Q-2 | English only, with every piece of text held outside the code so Hindi is a later translation |
| Q-3 | Light and dark themes. Bills and receipts stay light |
| Q-4 | Indian number grouping, two decimals on every money amount, dd/mm/yyyy, 12-hour time, India time |
| Q-5 | Readable text contrast and 48 dp tap targets in both themes. No claim of full accessibility conformance |
| Q-6 | The same order with the same rules always produces the same total, and every total reconciles to the weekly statement to the paisa |
| Q-7 | An older installed app keeps working after a server update, or is told plainly to update |
| Q-8 | The service restarts itself, is watched from outside, is backed up independently, and a restore has been timed |
| Q-9 | No secret is ever committed. The repository is public |

### How this is tested

Settled here because no ticket owned it.

- **Money**: every worked example in the revenue specification is written down once as inputs and expected amounts, and run through the server's calculation. This is the test that protects G-4.
- **Counter bills**: a second set of examples is run through both the phone's arithmetic and the server's check of it, and the two must agree.
- **Orders**: every allowed transition and every forbidden one is tested, including the scheduled-order ones.
- **Offline**: sending the same queued bill twice must return the same bill number and change stock once. Bills from two phones arriving in either order must leave the same stock and an unbroken number sequence, though not necessarily the same numbers on the same bills.
- **Deletion**: after erasure, no phone number or email can be recovered from what remains, and a restored backup does not bring the person back.
- **Devices**: a written checklist run by hand on an entry-level Android phone and an iPhone, in both themes, before each release. No automated screen testing in Phase 1.

### Images

Settled here because no ticket owned it. Product images are resized into three fixed sizes when uploaded and kept on the phone after first download. Proof photos are shrunk on the phone before upload. Image traffic is the one running cost that grows with success, so no full-size image is ever sent to a customer's phone.

## 7. Risks

| # | Risk | What we do about it |
|---|---|---|
| R-1 | The name and domain are not chosen, and the two-to-three-week chain behind them has not started | Decide the name first. Nothing else on this list is as far from done |
| R-2 | One developer, wide scope | The cut order in 3.4. Build money and the order journey first |
| R-3 | Shops miss new orders because the alarm cannot be guaranteed on either phone platform | Android at the counter, alarm permission asked during the visit, founder phones the shop |
| R-4 | A shop does not pay its statement | Balance limit with auto-pause once set; G-3 measures it; suspension is available |
| R-5 | A money calculation is wrong | One calculation on the server, the simulator, the worked examples as tests, frozen order records |
| R-6 | Operating without a registered entity | Bounded to two weeks with a forced decision. Statement says it is not a tax invoice |
| R-7 | Account recovery depends on the founder knowing every shop | Holds at 12 to 20 shops. Retired by SMS sign-in in stage two |
| R-8 | The proof exception gets abused | Counted per shop and per deliverer, reviewed by Admin. Nothing acts on it automatically |
| R-9 | A shop sells an excluded item at the counter, through a typed line or a product it requested and nobody has reviewed yet | Accepted. Flagged for Admin, enforced by the agreement, not by the software |
| R-10 | The cloud account is suspended at six months if left on the free plan | L-11 |
| R-11 | Apple developer enrolment fails at payment from India | Start it now. It delays iOS only, not the launch |
| R-12 | One database server: up to about five minutes of recent orders could be lost in a failure | Accepted for Phase 1. Counter sales live on the phone first and are not exposed |
| R-13 | **Phone numbers are unverified in stage one.** A customer can order under someone else's number, and a block can be walked around with a new number and email | Shop access never rests on a phone number alone (ACC-5, ACC-6). Accepted for customers in stage one only (D-1), with a stricter recovery check (ACC-12). Retired by SMS in stage two; if SMS is late the owner decides at the review (D-11) |
| R-14 | **A customer who is owed money can only be repaid by the shop**, and the platform cannot make it pay | Repayment within seven days, tracked in the app (TRU-4). The agreement states the duty (L-3). Suspension by Admin judgement is the one lever (D-14) |
| R-15 | The first rate card is a guess made before any real order | Simulator against real price lists (L-9); revised during the pilot; changes never touch placed orders |
| R-16 | A counter bill made offline is handed over without its bill number | The reference on it is permanent and finds the bill. Checked with the accountant before stage two |

### Facts assumed but not yet checked

Each sits under a closed decision. Each is checked the first time the build touches it, and a wrong one is reported, not worked around.

| # | Assumption | First bites at |
|---|---|---|
| V-1 | The chosen Expo version meets Google Play's current Android target requirement | First Play upload |
| V-2 | An iPhone build can be installed with a free Apple account for early testing | First iOS build |
| V-3 | Whether the twelve-tester test is needed once or once per app. Two apps may mean two fourteen-day waits | Opening the closed test |
| V-4 | A Google maps billing account can be opened without a registered entity. A free map is the fallback | Maps setup |
| V-5 | Whether cloud credits also cover the 18% tax. Assumed not: about ₹590 a month in cash | First invoice |
| V-6 | That Apple accepts Google plus Sign in with Apple plus an emailed code as the sign-in set | First App Store submission |

## 8. Owner decisions

### 8.1 Settled on 13 Oct 2026

The ten questions raised by the consistency review were answered by the owner. Each answer is now a requirement.

| # | Question | Decision | Requirement |
|---|---|---|---|
| D-1 | May a pilot customer order under a phone number nobody has verified? | Yes, in stage one only, with stated limits and a stricter recovery check | ACC-3, ACC-12 |
| D-2 | What is kept so a block survives account deletion? | A keyed hash of the phone number and of the email, for as long as the block is active. Nothing readable | TRU-5, DEL-5 |
| D-3 | How much notice of a rate-card change? | Told in the app and in person; applies from the next statement week; never backwards | MNY-14 |
| D-4 | Cancelling a scheduled order, and confirming a changed total on one | Free until the published reject cutoff. Ten minutes to confirm a changed total, then the order is cancelled and its stock and slot place released | FUL-5 |
| D-5 | A partial acceptance leaves the order below the contribution floor | It proceeds as a recorded exception while the platform's contribution is not negative. A platform-funded discount never exceeds what the platform earns on the order | ORD-4 |
| D-6 | A coupon on an order that contains a bargained line | None, of any funding | BRG-5 |
| D-7 | A coupon together with a shop-wide discount | Only the better of the two applies, the shop-wide discount on a tie, whatever the coupon's funding. Widened on 13 Oct 2026 from shop-funded coupons to every coupon | CRT-3 |
| D-8 | Complaint categories, time limit, pickup | Seven categories; three calendar days from delivery or pickup; pickup included; a recorded Admin exception for a serious safety issue reported late | TRU-2 |
| D-9 | A product request rejected as an excluded good | Removed from the shop's counter list from then on; past records untouched | CAT-8 |
| D-10 | Compensation after an upheld complaint | The shop pays the customer directly within seven calendar days. The app tracks the amount and its status. The platform handles no money and nothing is penalised automatically | TRU-4 |

### 8.2 Where an answer met an earlier decision

None of these was overridden silently. Each is recorded here with how it was reconciled.

| Answer | Earlier decision it met | How it was reconciled |
|---|---|---|
| D-1 "only during the two-week pilot" | Sign-in by SMS waits on the entity and DLT registration, which the software cannot hurry, and stage one ends on a review and not on a clock | The acceptance covers stage one and lapses at the stage-two review. If SMS is not ready then, the owner decides at the review (D-11) |
| D-4 ten minutes | A changed total on any order must be confirmed within five minutes | Ten minutes applies to scheduled orders only, as its own setting. Instant and pickup stay at five. A scheduled order changed while the customer is asleep will be cancelled; that is the accepted cost |
| D-5 recorded exception | "Any exception below the floor is explicitly authorised and recorded with a reason" | This answer is the standing authorisation. Each case is recorded on the order automatically and listed for Admin, with no approval per order |
| D-5 "never exceed platform earnings" | The revenue specification lets Admin fund a deliberate, budgeted subsidy below the floor | Read as a rule for what the engine does on its own. The Admin-approved subsidy in the specification is left as written and is not used by anything in Phase 1 |
| D-6 no coupon on a bargained order | The earlier rule was per line: a bargained line takes no coupon, the other lines could | Tightened to the whole order for coupons. The shop-wide discount still applies to the other lines, as the specification's discount base already said |
| D-7 the better one applies | "One coupon per order" and "at most one shop-wide discount per order" each allowed one of the other | Both limits stand, and a third is added: at most one promotion per order, the shop-wide discount or one coupon |
| D-8 pickup included | Complaints were written as being "against a delivered order" | Widened to delivered and picked-up orders. An order that never reached the customer has nothing to complain of in the app; support email covers it |
| D-10 no automatic penalties | The draft said an unpaid repayment was a ground for suspension, which is not on the accepted list of grounds | The owner then added it to the list as a ground for Admin's judgement (D-14). Nothing about it is automatic |

### 8.3 Follow-up questions, settled on 13 Oct 2026

Four narrower questions came out of the answers above. The owner answered all four as recommended.

| # | Question | Decision | Requirement |
|---|---|---|---|
| D-11 | If SMS is not ready when stage one is reviewed, do customers keep ordering on unverified numbers? | Decided at that review and recorded. The app has no default; Admin has a switch that stops new customer sign-ups, so either answer needs no new release | ACC-3 |
| D-12 | Does the 20% maximum also bind a coupon an Owner creates? | Yes, the same maximum, checked when the coupon is saved | CRT-3, MNY-5 |
| D-13 | Is a split-funded coupon a shop offer or a platform offer beside a shop-wide discount? | Neither: no coupon of any funding sits beside a shop-wide discount, so the better of the two applies | CRT-3 |
| D-14 | Is a repayment left unpaid past seven days a ground for suspension? | Yes, as an Admin judgement with a recorded reason. Never automatic | TRU-4, R-14 |

Still the owner's, already known, and not blockers for the build: every value on the first rate card (L-9), and the balance limit for each shop.

### 8.4 Found while writing the user stories, settled on 13 Oct 2026

| # | Question | Decision | Requirement |
|---|---|---|---|
| D-15 | What may an Area Manager see and do in the Admin web? | Inside their own Area only: see shops and applications, correct an application's fields, record the visit, see orders and the queues without acting on them, and see their own payout. Nothing that moves money or removes someone from the platform | ADM-12 |

### 8.5 Found while reviewing the designs, settled on 14 Oct 2026

| # | Question | Decision | Requirement |
|---|---|---|---|
| D-16 | Does the customer give a name? | Yes, with the phone number at first sign-in. Shown to the shop and the deliverer on that person's orders; the customer can change it | ACC-2, DLV-7 |
| D-17 | Who updates an FSSAI expiry date after Live? | The Owner, in the app. An auto-pause for an expired FSSAI lifts when the new date is saved. Admin can correct it | ONB-6 |
| D-18 | How often are Area Manager payouts worked out? | Weekly, on the statement week | ADM-9 |
| D-19 | How does Admin settle a disputed repayment? | Paid or still owed, with a reason both sides see, after speaking to both outside the app. Still owed keeps its original due date. Suspension stays a separate judgement | TRU-4 |

**No owner decision is open.**

## 9. What changed in this revision

| Topic | What was wrong | Now |
|---|---|---|
| Offline bill numbers | "No gaps, including bills made offline" could not be true of a number the server assigns later, and the test demanded the same numbers in any arrival order | Two identifiers: a permanent reference from the phone, a gapless number from the server (BIL-5) |
| Accounts | "The phone number is the identity" while no phone number is verified; no statement of how any role is attached | Phone is claimed, not verified; shop access needs the visit or a join code (ACC-2 to ACC-10). Sign in with Apple added for iOS |
| Pilot pricing | Rates "unset until real baskets" while a shop without rates can take no orders | First rate card before launch, from the simulator; the required values listed (MNY-13, L-9) |
| Scheduled orders | "Stock is reserved at acceptance, not placement" against automatic approval at placement; no customer cancellation, shop cancellation or partial acceptance in the transition table | Automatic approval is the acceptance; slot rules stated; missing transitions added (FUL-2 to FUL-6, ORD-1) |
| Who calculates money | "One calculation" in the PRD, but two in the ADRs: SQL on the server and a TypeScript package on the phone | One, on the server. The shared package keeps counter-bill arithmetic and the test examples (MNY-15; ADR-0007 amended) |
| Deletion and restore | Details "hard-deleted" and "access ends at once" alongside a 7-day restore; re-signup allowed during the restore window; backups unaddressed | Closed on day 0, erased at day 7, done by day 30, out of backups by day 90; re-signup gives up the restore (DEL-3 to DEL-8) |
| Categories | Per-Area category availability in one ticket, deferred in two others; Area pricing scope missing from the admin screens | Categories are global; per-Area anything is out of Phase 1 (CAT-5, MNY-3) |
| Bargain and discounts | The minimum cart appeared to exclude bargained lines, so a bargain-only order could never check out | Bargained lines count toward the minimum cart and nothing else (CRT-6, BRG-1 to BRG-6) |
| Complaint notifications | In `CONTEXT.md`, absent from the PRD; the shop's lack of a reply was unstated | NOT-6, TRU-2 |
| Excluded goods | "Nothing excluded can be listed" overlooked that a product request is sellable at the counter before review | Claim narrowed to customer orders; denylist widened; hole stated (CAT-7, CAT-8, R-9) |
| Customer compensation | "If money is owed, a statement adjustment" read as though the customer were paid by it | Stated that it pays the customer nothing; the shop repays directly within seven days, tracked in the app (TRU-3, TRU-4) |
| Launch tasks | Mixed into the requirements and the open-items table | One checklist, 3.3 |
| Owner decisions D-1 to D-10 | Ten rules were recommendations only | All ten answered and written in, and the four follow-up questions D-11 to D-14 after them (section 8) |
| Launch measure G-2 | "Median time under 2 minutes" here, "half of all orders accepted within two minutes" in `CONTEXT.md`: two different sums when some orders are never accepted | One wording in both, counted over every placed instant and pickup order (3.2) |
| Area and radius | DSC-1 read as though the radius were the only test, and a glossary line said serviceability was "not Area membership", while DSC-5 turned away anyone outside an active Area | Both tests are required and said so, as the service-area decision always had it (DSC-1, DSC-5) |
| Phone number states | "Unverified" was the only state named, though an Owner's number is confirmed in person and SMS will verify all of them later | Three named states (ACC-14) |
| Shop records and pickup payment | Both were in `CONTEXT.md` only. "At the door" left pickup payment unstated | DEL-10 to DEL-13; MNY-1, FUL-7 |
| Suspension, auto-pause and email | The grounds for suspension and the onboarding-fee auto-pause were in `CONTEXT.md` only. "No email except the sign-in code" overlooked the deletion-page code and the recovery notice | ONB-6, ONB-7, NOT-1, NOT-6 |
| Specification parts | The PRD had requirements and no user stories, no list of what is built, and no statement of where tests attach | Sections 10, 11 and 12 |
| Sign-in in the ADRs | ADR-0004 said sessions come from an emailed code only, while ACC-1 also requires Google and Apple | ADR-0004 amended. All three methods end in the same session |
| Offline bill number in the ADRs | ADR-0003 still said a "provisional number" is replaced by the server's, against BIL-5 | ADR-0003 amended: a permanent reference, and a number added to it |
| Background jobs in the ADRs | ADR-0004 runs jobs from systemd timers and rejects scheduling inside the service. ADR-0008 said "in-process scheduling" | ADR-0008 amended to follow ADR-0004 |
| What tests need to replace | Only file storage and email had a stand-in for tests. Sign-in tokens, push, SMS and time had none, and the product is full of deadlines | Four more interfaces (11.3; ADR-0004 amended) |
| Customer name | The approved specification collected no customer name, though the shop and the deliverer need to know who is at the door and DEL-3 already removes a name on deletion | A name is collected with the phone number at first sign-in and shown on that person's orders (ACC-2, DLV-7). Owner decision, 14 Oct 2026, while reviewing the Customer designs |
| Admin's customer screen | The phone-number state and the sign-up switch were required by ACC-14 and ACC-3 and missing from the list of Admin screens | ADM-11 |
| Area Manager permissions | "Onboards and supports the shops" is the whole of what was decided. No list of screens exists | Settled as D-15 (ADM-12) |

## 10. User stories

Each story names the requirement that holds its rule. A story adds no rule of its own: where a story and a requirement differ, the requirement wins. "The shop" means the Owner or a Staff member.

### 10.1 Customer

1. As a Customer, I want to sign in with Google, with Apple on an iPhone, or with a code emailed to me, so that I never need a password (ACC-1).
2. As a Customer, I want to give my name and phone number once after my first sign-in, so that the shop and the deliverer know who I am and can reach me (ACC-2).
3. As a Customer, I want to be told plainly when my phone number is already in use and where to write for help, so that I am not left stuck (ACC-3).
4. As a Customer, I want to see only the shops that can serve my location, so that I never build a cart I cannot order (DSC-1).
5. As a Customer outside every active Area, I want to be told "not serviceable yet" and to leave my number, so that I know why I see no shops (DSC-5).
6. As a Customer, I want each shop card to show its rating, estimated time and delivery fee, so that I can choose between shops (DSC-2).
7. As a Customer, I want the shop page to show opening hours, the minimum order and the FSSAI number, so that I know the terms before I start (DSC-2).
8. As a Customer, I want to search products and shops with Hindi words typed in English letters, so that "kanda" finds onion (DSC-3).
9. As a Customer, I want an out-of-stock item shown and marked, so that I know the shop sells it (DSC-4).
10. As a Customer, I want to choose a pack or one of the shop's quantity-price options, so that I can buy "2 for ₹6" (CAT-2).
11. As a Customer, I want to buy loose goods in the shop's minimum and step, so that I can order 250 g (CAT-4).
12. As a Customer, I want a separate cart for each shop, so that one order is always one shop (CRT-1).
13. As a Customer, I want every fee and the total shown before I check out, so that nothing is added at the door (CRT-2).
14. As a Customer, I want to be asked to accept a total that changed between my cart and my order, so that I never pay a price I did not see (CRT-2).
15. As a Customer, I want to apply one coupon to an order, so that I can use an offer (CRT-3).
16. As a Customer, I want to be told which shop offer was applied when two qualify, and to keep the coupon that was not, so that I do not lose it (CRT-3).
17. As a Customer, I want to be told why an order cannot be placed and what to do about it, so that I can fix it (CRT-4).
18. As a Customer, I want every price to include tax, so that the price I see is the price I pay (CRT-5).
19. As a Customer, I want to offer a price on a pack that allows Bargain and get an answer at once, so that I do not wait for a shopkeeper (BRG-2).
20. As a Customer who has used three offers on a pack today, I want to be told that I can offer again tomorrow, so that I understand the refusal (BRG-3).
21. As a Customer, I want an accepted price held for 30 minutes and honoured at checkout, so that the bargain is real (BRG-4, BRG-6).
22. As a Customer with a bargained line and a coupon, I want to be told to remove one of them, so that I understand why the coupon does not apply (BRG-5).
23. As a Customer, I want to choose instant delivery, a scheduled slot or pickup, from what the shop offers, so that the order suits my day (FUL-1).
24. As a Customer, I want to see only the slots for today and tomorrow that still have a place, so that I cannot pick a full one (FUL-2).
25. As a Customer, I want a scheduled order confirmed at once or refused with the reason, so that I know where I stand (FUL-3).
26. As a Customer, I want to see until when I can cancel a scheduled order freely, on the slot and on the order, so that there is no surprise (FUL-5).
27. As a Customer, I want to follow my order's status, so that I know what is happening (ORD-1, NOT-6).
28. As a Customer, I want to cancel freely before the shop accepts and to ask the shop after that, so that a mistake is cheap to undo (ORD-5).
29. As a Customer, I want an order the shop never answers to expire at no cost, so that I can order elsewhere (ORD-2).
30. As a Customer, I want a loud notification and a banner that stays when the shop changes my order, so that I do not miss the deadline to confirm (ORD-4, NOT-3).
31. As a Customer, I want to see the new total and why it changed before I confirm, so that I agree to what I will pay (ORD-4).
32. As a Customer who does not confirm in time, I want the order cancelled at no cost, so that silence never commits me (ORD-4, FUL-5).
33. As a Customer, I want a call-the-shop button on every order, so that I can always reach a person (ORD-8).
34. As a Customer, I want my handover code to appear after I have checked the items, so that I give it only for the right goods (DLV-2).
35. As a Customer, I want to pay the shop in cash or by UPI at the door, so that I pay nothing before I have the goods (MNY-1, DLV-6).
36. As a Customer collecting an order, I want to pay at the counter and give my code, so that pickup works like delivery (FUL-7, MNY-1).
37. As a Customer who never collects a pickup order, I want it to expire and cost me nothing (FUL-7).
38. As a Customer, I want to give a shop 1 to 5 stars after delivery or pickup, so that others can judge it (TRU-1).
39. As a Customer, I want to raise a complaint from the order screen within three days, with a category and an optional photo, and to see at once that it was received (TRU-2).
40. As a Customer, I want to be told when my complaint is resolved (TRU-3, NOT-6).
41. As a Customer who is owed money, I want to see the amount, the due date and the status, and to confirm or dispute the shop's payment, so that I am not left chasing it alone (TRU-4).
42. As a Customer, I want one support email address shown in the app, so that I know where to write (TRU-6).
43. As a blocked Customer, I want to see the support email and to have my order in progress finish, so that I know what has happened (TRU-5).
44. As a Customer, I want a list of my notifications in the app, so that a push I missed is not lost (NOT-1, NOT-2).
45. As a Customer, I want to delete my account in two taps, or be told exactly why I cannot yet (DEL-1, DEL-2).
46. As a Customer who deleted by mistake, I want Admin to be able to restore my account for seven days (DEL-4).
47. As a former Customer, I want to sign up again with the same number as a new account (DEL-7).
48. As a person without the app, I want to request deletion on a public web page, so that I do not need to install anything (DEL-9).
49. As a Customer who lost access to my email, I want Admin to recover my account after checking it is mine (ACC-12).
50. As a Customer, I want light and dark themes and Indian number, date and time formats (Q-3, Q-4).
51. As a Customer on an old version, I want the app to keep working or tell me plainly to update (Q-7).
52. As a visitor, I want to read the privacy policy, the terms and the support contact on the website (L-2).

### 10.2 Owner

53. As an Owner, I want to start my shop's application in the Shopkeeper app by entering details and numbers only, so that I upload no identity document (ONB-1, ONB-3).
54. As an Owner, I want to see what state my application is in, so that I know what is left (ONB-1).
55. As an Owner, I want to read and accept an agreement that shows my rate card, so that I know what I will be charged before I go Live (ONB-5).
56. As an Owner, I want to set up my listings, prices and opening stock once my shop is Approved, and to have counter billing and stock from the day it goes Live even when it is out of the customer feed (ACC-5, ONB-4).
57. As an Owner, I want to choose which packs I stock and set each one's online price, counter price, MRP, stock, low-stock level and availability (CAT-1).
58. As an Owner, I want to add my own quantity-price options, so that my usual counter deals are online (CAT-2).
59. As an Owner, I want to request a product that is not in the catalog and sell it at my counter at once (CAT-3).
60. As an Owner, I want to be told when a product request is approved or rejected, with the reason (CAT-3, NOT-6).
61. As an Owner, I want to find products by scanning a barcode (CAT-6).
62. As an Owner, I want to switch instant delivery, scheduled delivery and pickup on or off for my shop (FUL-1).
63. As an Owner, I want to set my daily delivery slots and the most orders each can take, and to edit them without cancelling orders already booked (FUL-2).
64. As an Owner, I want to switch Bargain on for a pack and set a floor price no customer can see (BRG-1).
65. As an Owner, I want to see the offers that were rejected, so that I can judge my floor (BRG-6).
66. As an Owner, I want to run one shop-wide discount and to be stopped when it is above the maximum, at the moment I save it (MNY-5).
67. As an Owner, I want to create a coupon my shop pays for, under the same maximum (CRT-3, MNY-5).
68. As an Owner, I want to be told when my discount or coupon is paused because the maximum was lowered (NOT-6).
69. As an Owner, I want to invite Staff by phone number and show them a one-time join code, so that a number alone lets nobody into my shop (ACC-6).
70. As an Owner, I want to mark which Staff can deliver (DLV-1).
71. As an Owner, I want a Staff member I deactivate to lose access within minutes (ACC-11).
72. As an Owner, I want to re-invite someone who left and have their history stay attached (ACC-7).
73. As an Owner, I want prices, money views, staff and settings kept to me, with Staff limited to orders, stock and counter billing (section 2).
74. As an Owner, I want to void a counter bill within 24 hours with a reason, leaving the original unchanged (BIL-6).
75. As an Owner, I want to see my running balance and be warned at 80% of my limit, so that a pause never surprises me (MNY-9).
76. As an Owner, I want a statement every Monday showing what I owe for the week, and saying that it is not a tax invoice (MNY-8, MNY-12).
77. As an Owner, I want to be told of a rate-card change before it applies, and for it never to touch an order already placed (MNY-14).
78. As an Owner, I want to see sales today and this week, split online and counter, and my top items (5.14).
79. As an Owner, I want to be told when my shop is suspended or reinstated and to see the reason, and to keep my counter tools meanwhile (ONB-7).
80. As an Owner, I want an auto-pause to lift by itself when its cause is gone (ONB-6).
81. As an Owner, I want to be told when a complaint is upheld against my shop and a repayment recorded, and to mark it paid (TRU-4, NOT-6).
82. As an Owner, I want to request deletion of my account and be told what stands in the way (DEL-1, DEL-2).
83. As an Owner who also shops, I want to switch between the Customer side and the Shopkeeper side of one account (ACC-4).

### 10.3 The shop: Owner or Staff

84. As a Staff member, I want to join a shop by entering the join code the Owner shows me (ACC-6).
85. As the shop, I want a new order to ring as loudly as the phone allows, and again at 120 seconds, so that I do not miss it (ORD-2, NOT-3, NOT-5).
86. As the shop, I want to accept an order, reject it, or accept it in part by reducing a quantity or removing a line (ORD-3).
87. As the shop, I want to review a scheduled order and reject it before the cutoff, and to cancel it with a reason after (FUL-4).
88. As the shop, I want to agree or refuse when a customer asks to cancel an accepted order (ORD-5).
89. As the shop, I want to mark an order ready and assign it to the Owner or to a Staff member who can deliver (DLV-1).
90. As the shop, I want to complete a pickup with the customer's code at the counter and record cash or UPI (FUL-7, MNY-1).
91. As the shop, I want to make a counter bill from catalog lines or a typed line, with a discount, an optional customer name and phone, and cash or UPI (BIL-1).
92. As the shop, I want to share the bill as a PDF from my phone (BIL-2).
93. As the shop, I want billing, stock changes and marking out of stock to work with no internet (BIL-3).
94. As the shop, I want every bill to carry a permanent reference at once and its bill number when the phone has synced (BIL-5).
95. As the shop, I want a counter sale never blocked by stock held for an online order, and to be told which online orders it affects and fix each in two taps (BIL-4, FUL-6).
96. As the shop, I want every stock change to take a reason from a fixed list (BIL-7).
97. As the shop, I want to be told when a queued bill needs attention, so that no sale is silently lost (BIL-5).
98. As the shop, I want to be told plainly when the offline limit is reached and that I must reconnect before billing again, so that I know why billing stopped (BIL-3).
99. As an Owner or Staff member, I want to be stopped from placing a customer order with my own shop (ACC-9).

### 10.4 Staff who deliver

100. As a deliverer, I want my assigned orders under "My deliveries" (DLV-1).
101. As a deliverer, I want the customer's name and phone number for that order and no other (DLV-7).
102. As a deliverer, I want to take a proof photo and then enter the customer's code (DLV-2).
103. As a deliverer, I want the delivery screens to work without internet (DLV-3).
104. As a deliverer, I want to complete a delivery with a photo and a reason when the code cannot be used (DLV-4).
105. As a deliverer, I want to record a failed delivery after a call attempt, a wait, a photo and a reason (DLV-5).
106. As a deliverer, I want to show the shop's UPI QR or take cash, and record which (DLV-6).

### 10.5 Admin

107. As an Admin, I want to build Areas from pincodes and pause an Area (ADM-1).
108. As an Admin, I want to review a shop's application and correct any field (ONB-1).
109. As an Admin, I want to record the visit with a geotagged shop-front photo and confirm the Owner's phone and email in person (ONB-2, ACC-5).
110. As an Admin, I want to be the only one who moves a shop to Live, and to be stopped when its rate card is incomplete (ONB-1, MNY-13).
111. As an Admin, I want to waive the onboarding fee with a reason (ONB-2).
112. As an Admin, I want to set every rate, fee, floor, split and limit globally, per category or per shop, and see which level a value came from (MNY-3).
113. As an Admin, I want a rate-card change to a Live shop to start with the next statement week and never earlier (MNY-14).
114. As an Admin, I want a price simulator that runs the real calculation and can try a draft rule without saving it (MNY-10).
115. As an Admin, I want to create coupons paid for by the platform, by a shop, or split (ADM-5, CRT-3).
116. As an Admin, I want to manage master products, packs, categories, search terms and the denylist, and to import the catalog by CSV (ADM-3).
117. As an Admin, I want to approve a product request, map it to an existing product, or reject it with a reason (CAT-3).
118. As an Admin, I want a request rejected as an excluded good removed from that shop's counter list, with its past records kept (CAT-8).
119. As an Admin, I want denylist matches flagged to me without blocking the shop (CAT-8).
120. As an Admin, I want to watch live orders and force a transition with a reason (ADM-4).
121. As an Admin, I want to force a fulfilment mode off for a shop (FUL-1).
122. As an Admin, I want one place for every queue that needs me (ADM-7).
123. As an Admin, I want statements produced every Monday, and to record payments, make adjustments and set balance limits (ADM-6, MNY-8, MNY-9).
124. As an Admin, I want to resolve a complaint with a reason and reverse the commission on the affected lines (TRU-3).
125. As an Admin, I want to record what a shop owes a customer and see repayments that are disputed or overdue (TRU-4).
126. As an Admin, I want to open a late complaint for a serious safety issue, with the reason recorded (TRU-2).
127. As an Admin, I want to suspend and reinstate a shop with a recorded reason (ONB-7).
128. As an Admin, I want to look up a customer, see the state of their phone number, and block or unblock them with a reason (ADM-11, ACC-14, TRU-5).
129. As an Admin, I want a block to survive the customer deleting their account, without keeping anything readable (TRU-5).
130. As an Admin, I want to change an account's email after the recovery checks, with the checks recorded, every session revoked and a notice sent to the old address (ACC-12).
131. As an Admin, I want to restore a deleted account inside its seven days (DEL-4).
132. As an Admin, I want deletion requests listed with their age, so that I act inside 23 days (DEL-6, ADM-7).
133. As an Admin, I want a switch that stops new customer sign-ups (ACC-3).
134. As an Admin, I want to see orders that went ahead below the contribution floor (ORD-4, ADM-7).
135. As an Admin, I want counter bills whose total the server disagrees with, and sync actions that failed, flagged to me (BIL-9, ADM-7).
136. As an Admin, I want a dashboard of tiles including the four launch measures (ADM-8).
137. As an Admin, I want to create Admin and Area Manager accounts (ACC-8).
138. As an Admin, I want each Area Manager's payout worked out from the commission actually collected in their Area (ADM-9).
139. As an Admin, I want every admin action recorded from the first day (ADM-10).
140. As an Admin, I want sign-in by SMS and the tax outputs built and switched off, so that stage two needs no new release for them (ACC-10, MNY-12).

### 10.6 Others

141. As an Area Manager, I want to sign in to the Admin web and work only inside my own Area: see its shops and applications, correct an application, record a visit, watch its orders and queues, and see my payout (ADM-12).
142. As a store reviewer at Google or Apple, I want a demo account that lets me see the app working (ACC-13).

## 11. Implementation decisions

The ADRs hold the stack and are not repeated. This section says what is built on it. Nothing here names a file, because none exists yet.

### 11.1 What is built

Five deployables and seven shared packages, as ADR-0007 lists them: the Customer app, the Shopkeeper app, the Admin web, the public website and one server. The shared contract package holds the shape of every message between them.

### 11.2 Server modules

One service, split by domain. Each module below hides a lot of behaviour behind a small interface, and the rest of the server reaches it only through that interface.

| Module | What it owns | What the rest of the server asks of it |
|---|---|---|
| **Pricing engine** | Every money amount on an order: line prices, discounts, coupons, fees, commission, contribution, the floors, and what each side keeps. One implementation, in the database (MNY-15) | "Price this basket, for this shop, route and promotion, under the rules as of this moment." The cart, order placement, the recalculation after a partial acceptance, the simulator and the statement all ask the same question |
| **Rate cards** | Every configurable value, at global, category and shop level; which level a value came from; versions; completeness (MNY-13); the next-statement-week start (MNY-14) | "What are this shop's rules as of this moment, and where did each come from?" |
| **Order lifecycle** | The seventeen statuses and every allowed transition, who may make each, the reason, the record of each change (ORD-7), and the deadlines | "Move this order to this status, as this actor, for this reason." It refuses anything not allowed |
| **Stock ledger** | The movement log, the on-hand figure, reservation at acceptance, release, and the reconciliation check | "Record this movement." "What is on hand?" |
| **Counter billing** | Bills, the bill reference and bill number (BIL-5), voids, the server's check of the phone's total (BIL-9) | Reached only through sync |
| **Sync** | Applying a batch of queued actions once each, in order, with a result per action; quarantine; the changes a phone must pull (ADR-0003) | "Apply this batch." "What changed since this marker?" |
| **Statements and ledger** | The weekly statement, payments, adjustments, the running balance, the limit and its auto-pause, Area Manager payouts | "What does this shop owe?" "Record this adjustment." |
| **Accounts and sessions** | Sign-in by all three methods, phone number states (ACC-14), roles, the one shop link, join codes, session revocation, recovery | "Who is this, in what role, for which shop?" |
| **Shops** | The application states, the visit record, agreement acceptance, auto-pause and suspension, and whether a shop is in the feed | "May this shop take an order now, and if not, why?" |
| **Catalog and search** | Master products, packs, shop listings, quantity-price options, product requests, the denylist, CSV import, the search-term list | Listings for a shop; search results |
| **Serviceability** | Areas, pincodes, the two tests of DSC-1 | "Which shops can serve this location?" |
| **Promotions** | Shop-wide discounts and coupons, their funding, limits and the maximum (MNY-5). It decides which offers are eligible; the pricing engine does the arithmetic | "Which offers may apply to this basket?" |
| **Bargain** | Floors, offers, the daily limit, the 30-minute hold | "Answer this offer." |
| **Slots** | Daily slots, places, cutoffs (FUL-2 to FUL-5) | "Take a place." "Give it back." |
| **Delivery and proof** | Assignment, handover codes, proof photos, proof exceptions, failed deliveries | "Complete this handover." |
| **Trust** | Ratings, complaints, repayments, refusal counts, blocks and their unreadable markers | Queues for Admin; "is this customer blocked?" |
| **Deletion and retention** | Closing, sealing, restoring, erasing and anonymising accounts on their clocks; shop record clocks (DEL-10) | "Delete this account." The rest runs as timed jobs |
| **Notifications** | The in-app list and the push that reports it. It only ever reports something another module has already recorded (NOT-2) | "This happened; tell whoever should know." |
| **Admin record** | The append-only record of admin actions (ADM-10) | Written by every admin action |

Rules that cut across modules:

- **Every money amount is produced in the database**, never in the service's own code and never on a phone, the counter-bill total excepted (MNY-15, BIL-9).
- **Every deadline reads time through one clock interface** (11.3), in the service and in the jobs.
- **Timed work runs as jobs**, each started by a timer outside the service and leaving a record of its run (ADR-0004): order expiry and the re-alert, confirmation timeouts, pickup expiry, the bargain hold, the Monday statement, the balance check, FSSAI expiry, the deletion steps, stock reconciliation.
- **A placed order's prices, rules and amounts are written once and never rewritten** (MNY-7). A correction is a new record.
- **The server sends codes, never display text.** Every piece of text lives in the apps (Q-2).
- **Every request is scoped to the caller's role and shop** in the service, and an Area Manager's to their Area.
- **The first Admin account is created by a command run at deployment**, because no Admin exists yet to create it (ACC-8).

### 11.3 Things the server reaches, each behind one interface

Each has a real implementation and a local one. The local ones are what make the tests run with no account, no credentials and no cost.

| Interface | Real | Local |
|---|---|---|
| File storage | Cloud object storage | The filesystem |
| Mailer | The cloud email service | A local mail catcher |
| Identity verifier | Checks Google and Apple sign-in tokens | Accepts tokens the test made |
| Push sender | The push service | Records what would have been sent |
| SMS sender | None in stage one; the flow is built and switched off (ACC-10) | Records the code |
| Clock | The system's time | Set and moved forward by the test |

The first two are ADR-0008's. The other four were added by an amendment to ADR-0004.

### 11.4 The apps

- **Both mobile apps show what the server returned.** Neither works out an order total, a fee or a discount.
- **The Shopkeeper app has one offline module**: the queue of actions waiting to sync, the local copy of the shop's catalog and stock, the two limits (BIL-3), and counter-bill arithmetic in whole paise. Counter billing, stock and delivery screens are built on it and on nothing else for their writes.
- **The Customer app has no offline writes.** It needs a connection to order.
- **Role decides what the Shopkeeper app shows**: Owner, Staff, and the delivery tab for the Owner and for Staff who can deliver.
- **The Admin web and the public website** are static pages calling the same server. The public deletion page calls an endpoint that answers the same way whether or not an account exists (DEL-9).
- **Each app sends its version with every request**, and the server can tell a too-old app to update (Q-7).

### 11.5 What comes first

Money and the order journey are built first (R-2): rate cards, the pricing engine with the simulator, then placing, accepting and delivering an order, then the statement. The simulator is built with the engine and not after it, because it is how the first rate card is made (L-9) and how the engine is checked by eye.

## 12. Testing decisions

"How this is tested" in section 6 says **what** must be proven. This section says **where** the tests attach and what a good one looks like.

### 12.1 What a good test is

- **It tests what the product does, through the same door a real user's app uses**, and not how the code inside is arranged. A test that would still pass after the inside is rewritten is a good one. A test that breaks when a function is renamed is not.
- **It reads like a requirement.** Each test names the requirement id it proves.
- **It uses the real database.** The money rules and the stock rules live in the database, so a test that replaces the database tests nothing.
- **It never waits for real time.** It moves the clock.
- **It needs no account, key or network.** The local implementations in 11.3 are used throughout.

### 12.2 Where tests attach

Two places, plus a checklist run by hand.

| Seam | What goes through it | What is replaced |
|---|---|---|
| **The server's public API**, called exactly as the apps call it, against a real database | Everything in section 5 that the server decides: sign-in and roles, serviceability, the cart quote and every worked money example, order transitions and deadlines, slots, Bargain, sync and bill numbers, statements, complaints and repayments, deletion and retention, every Admin action. Timed jobs are started the way the timer starts them | Only the six interfaces in 11.3 |
| **The Shopkeeper app's offline module**, with its sync pointed at a real test server | Counter-bill arithmetic against the shared examples; the queue's order, limits and retry; the same bill sent twice; two phones syncing in either order | Nothing on the server side |
| **The device checklist**, by hand | Screens, themes, the alarm, the camera, the barcode scanner, a real bill shared as a PDF, on an entry-level Android phone and an iPhone | — |

No test attaches below these. In particular the pricing engine is tested through the quote that the cart and the simulator use, not by calling it directly, so that the examples prove what a customer would actually be charged.

### 12.3 The examples are written once

Every worked example in the revenue specification is written once as inputs and expected amounts, and the same file is used by the server's tests. The counter-bill examples are written once and used by both the phone's arithmetic and the server's check of it. A new money rule arrives with its example or it does not arrive.

### 12.4 Prior work to follow

There is none. The repository holds no code, and the reference projects have no tests worth copying and may not be copied from. The first tests written through each seam set the pattern for the rest, so the first ticket through each seam builds the test setup with it: a database made fresh for each run, the local implementations, and the clock.

### 12.5 What runs before anything merges

One command runs the checks, the type check, the tests and the builds for everything (ADR-0007). A change that fails it does not merge.

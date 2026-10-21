# Specs UI — YGo Phase 1

## Status

- [x] Draft
- [ ] In review
- [ ] Approved

Last updated: 14 Oct 2026 | Author: AI-assisted, for Hemanshu (owner) | Related: [Design Brief](design-brief-phase1.md), [Phase 1 PRD](prd-phase1.md), [Design system](../design/design-system.md), [`CONTEXT.md`](../../CONTEXT.md)

This page records what Claude Design delivered for the [Design Brief](design-brief-phase1.md). It is the screen-by-screen reference for every UI ticket. The brief was the input and is not edited to hold this output.

**Order of authority:** the PRD comes first, then the [design system](../design/design-system.md), then this page, then the mockups. If a mockup and this page disagree, build what this page says. If this page and the PRD disagree, the PRD wins, and the disagreement is a bug to report on this page.

**Where the mockups are:** four HTML exports and their PDFs, dated 14/10/2026:

- `YGo-customer-app-design`
- `YGo-shopkeeper-app-design`
- `YGo-admin-web-design`
- `YGo-design-system`

They are kept locally in `docs/design/` and are not in git. The repo is public and the files are large (about 15 MB of HTML and 31 MB of PDF). Ask the owner for a copy.

Every screen in every state is drawn in light and dark. Phones grow to fit their content, so long screens are drawn uncut; on a real phone they scroll. Search an export by screen id (for example, `S31`). A state is picked in the export's **Tweaks** panel.

## Screen inventory

| Surface | Screens | States | Ids |
|---|---|---|---|
| Customer app | 24 | 84 | C01–C26 (C12 and C13 were removed, and the gap is kept) |
| Shopkeeper app | 45 | 174 | S01–S45 |
| Admin web | 31 | each in all its states, 350 pages counting light and dark | A01–A31 |

All 100 screens are **Ready** (the status column the skill template asks for). Six screens carry a "wording to confirm" marker in the exports. The owner settled that wording on 14 Oct 2026 (see [Reason lists](#reason-lists)), so the lists below replace whatever the exports show.

Screen ids follow the order in which screens were drawn, not the order in which they are used. The tables below are in journey order.

**How to read the tables.** "States" lists the states drawn in the export. Light and dark are always both drawn, and are not repeated in the list. "PRD" is the requirement the screen carries; read it before building. "Ticket" is the GitHub issue that builds the screen.

## Screen details: Customer app

Tabs: Home, Search, Cart, Orders, Account.

### Sign-in

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **C01 Sign in** | First screen. It offers Google, Apple and a 6-digit emailed code, with no passwords. Apple is shown on iPhone only. The tapped button shows a spinner and the other buttons are disabled. Help shows the support email | default, loading | ACC-1 | [#36](https://github.com/Hemanshujc1/YGo/issues/36), [#34](https://github.com/Hemanshujc1/YGo/issues/34) |
| **C14 Enter email code** | Reached from C01 "Email me a code". Six boxes. A successful sign-in proves the email address, and the app goes to C02 next. It offers "Send a new code" and "Use a different email", and tells the customer to check spam | entering, checking, wrong code, could not send, signed in | ACC-1, ACC-2, NOT-1 | [#34](https://github.com/Hemanshujc1/YGo/issues/34) |
| **C02 Your name and phone number** | Asked once, after the first sign-in, before anything else. The name comes first, then the phone with a +91 prefix. The phone is claimed, not verified, in stage one. A number already in use is refused and points to the support email. The name can be changed later on C23. The only other action is Sign out | phone already in use, filled in, saving | ACC-2, ACC-3, D-16 | [#34](https://github.com/Hemanshujc1/YGo/issues/34) |

### Location

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **C15 Set location** | The pincode decides the Area. Each shop's own radius (up to 5 km) decides which shops can serve this location. A location outside every active Area goes to C03 | choose, finding, location off, confirm pin | DSC-1, DSC-5 | [#38](https://github.com/Hemanshujc1/YGo/issues/38) |
| **C03 Not serviceable yet** | Says so plainly and takes a phone number. This happens even when a Live shop is within range. No shop list is shown | default | DSC-5 | [#38](https://github.com/Hemanshujc1/YGo/issues/38) |

### Discover and product

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **C04 Home** | Lists only the shops that can serve this location. A card shows the rating (after 3 ratings), the estimated time and the delivery fee. A closed shop stays in the list and says when it opens | default | DSC-1, DSC-2 | [#47](https://github.com/Hemanshujc1/YGo/issues/47) |
| **C16 Search and shop list** | Finds products and shops. Hindi typed in English letters matches, so "kanda" finds Onion. Each result is a shop that can serve the customer, and says whether it has the item. **No price comparison across shops** | results, searching, no results, error | DSC-1 to DSC-4 | [#49](https://github.com/Hemanshujc1/YGo/issues/49), [#47](https://github.com/Hemanshujc1/YGo/issues/47) |
| **C05 Shop page** | Shows hours, minimum order and the FSSAI number at the top. Products follow. An out-of-stock product is shown and marked, never hidden | default | DSC-2, DSC-4, CAT-2, CAT-4 | [#47](https://github.com/Hemanshujc1/YGo/issues/47) |
| **C17 Product and pack choice** | Shows the packs this shop stocks. The shop's quantity-price options appear as a choice beside the single pack. Measured goods use the shop's minimum and step. An out-of-stock pack is visible and cannot be picked. **The cart total comes from the server** | packs, quantity price chosen, measured goods, loading, error, added | CAT-1, CAT-2, CAT-4, DSC-4, CRT-2 | [#47](https://github.com/Hemanshujc1/YGo/issues/47), [#50](https://github.com/Hemanshujc1/YGo/issues/50) |
| **C06 Bargain** | The customer offers a price on a pack and gets the answer at once. No shopkeeper is involved. Three offers per pack per day. An accepted price holds for 30 minutes, with a countdown. The hold is on the price, not on stock | accepted, rejected, limit reached | BRG-2 to BRG-4 | [#78](https://github.com/Hemanshujc1/YGo/issues/78) |

### Cart and checkout

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **C07 Cart and checkout** | One cart per shop. The fulfilment choices are instant, a scheduled slot (which shows its free-cancel cutoff) and pickup. A coupon can be added. Every fee is shown before the order is placed, and every figure comes from the server. The cart says which offer applied and keeps an unused coupon. The primary button reads "Place order · ₹482.00". Placing the order plays the one celebratory check-mark motion | default | CRT-1 to CRT-3, CRT-5, FUL-1, FUL-5 | [#50](https://github.com/Hemanshujc1/YGo/issues/50), [#52](https://github.com/Hemanshujc1/YGo/issues/52), [#74](https://github.com/Hemanshujc1/YGo/issues/74), [#65](https://github.com/Hemanshujc1/YGo/issues/65), [#70](https://github.com/Hemanshujc1/YGo/issues/70), [#63](https://github.com/Hemanshujc1/YGo/issues/63) |
| **C08 Cannot place yet** | Every refusal names the reason and offers the fix as a button | below minimum, coupon with bargain, total changed, slot full | CRT-2, CRT-4, CRT-6, BRG-5, FUL-2 | [#50](https://github.com/Hemanshujc1/YGo/issues/50), [#78](https://github.com/Hemanshujc1/YGo/issues/78), [#74](https://github.com/Hemanshujc1/YGo/issues/74) |

### Order

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **C09 Order waiting for shop** | Shown right after the order is placed. The customer can cancel for free until the shop accepts. If the shop does not answer in time, the order ends at no cost. Call the shop is always available | waiting, expired at no cost | ORD-2, ORD-5, ORD-8 | [#52](https://github.com/Hemanshujc1/YGo/issues/52), [#57](https://github.com/Hemanshujc1/YGo/issues/57) |
| **C18 Order list** | Active orders come first. Anything that needs the customer sits on top in the "needs you" treatment. A past order keeps its final status | list, empty, loading, error | ORD-1, ORD-4 | [#52](https://github.com/Hemanshujc1/YGo/issues/52) |
| **C19 Order detail** | Call the shop is in the top bar and is the first footer action in **every** state, including loading and error. Cancel is free before the shop accepts, and before a scheduled order's cutoff. After that the customer can only ask, and the shop must agree. Once the order is on the way, the app offers no cancel | being packed, cancel requested, on the way, scheduled, loading, error | ORD-1, ORD-5, ORD-8, FUL-5 | [#52](https://github.com/Hemanshujc1/YGo/issues/52), [#59](https://github.com/Hemanshujc1/YGo/issues/59), [#86](https://github.com/Hemanshujc1/YGo/issues/86) |
| **C10 Changed total** | Comes with a loud push, and a persistent banner stays on every screen until the customer answers. The screen shows the old figure struck through, the new figure, the reason and the deadline: 5 minutes, or 10 for a scheduled order. If the customer does not answer, the order is cancelled at no cost | default | ORD-3, ORD-4, NOT-3 | [#64](https://github.com/Hemanshujc1/YGo/issues/64) |
| **C11 At the door** | The customer checks the items first, then the 4-digit code appears. The customer pays the shop at handover, in cash or UPI. A pickup uses the same code at the counter | check items, code shown, pickup | DLV-2, MNY-1, FUL-7 | [#56](https://github.com/Hemanshujc1/YGo/issues/56), [#65](https://github.com/Hemanshujc1/YGo/issues/65) |

### After the order

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **C20 Rate and complaint** | Opens after delivery or pickup. A rating is 1 to 5 stars, with no written comment. A complaint can be raised until the end of the third calendar day: seven categories, an optional photo, and an acknowledgement at once. After that window the screen points to the support email | rate, rated, complaint form, sending, send failed, complaint received, window closed | TRU-1, TRU-2 | [#82](https://github.com/Hemanshujc1/YGo/issues/82), [#87](https://github.com/Hemanshujc1/YGo/issues/87) |
| **C21 Repayment owed** | After an upheld complaint, the shop pays the customer directly within 7 calendar days. Both sides see the amount, the due date and the status. YGo never holds the money. If disputed, Admin settles it as paid or still owed, and the customer sees Admin's reason (D-19) | owed, shop marked paid, confirmed, disputed, past due date, loading | TRU-3, TRU-4 | [#90](https://github.com/Hemanshujc1/YGo/issues/90) |

### Account

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **C22 Notifications** | The in-app list mirrors every push, so a missed push is never lost. An unread row carries the word "New" | list, empty, loading, error | NOT-1, NOT-2, NOT-3, NOT-6 | [#55](https://github.com/Hemanshujc1/YGo/issues/55) |
| **C23 Profile and theme** | The customer can change their name here. Email and phone are shown and cannot be edited; a change goes through support. Theme is System, Light or Dark. "Switch to shop" shows only when this account is linked to a shop; otherwise "Join a shop" opens S21. The support email is shown here | customer only, also linked to a shop, change name, loading, error | ACC-2, ACC-4, ACC-12, TRU-6, Q-3 | [#30](https://github.com/Hemanshujc1/YGo/issues/30), [#34](https://github.com/Hemanshujc1/YGo/issues/34), [#58](https://github.com/Hemanshujc1/YGo/issues/58) |
| **C24 Blocked customer** | Admin blocks with a reason, and nothing blocks automatically. A blocked customer cannot place a new order and sees the support email. An order already in progress finishes. The wording is plain and accuses no one | home, at checkout, order in progress | TRU-5, TRU-6 | [#72](https://github.com/Hemanshujc1/YGo/issues/72) |
| **C25 Delete account** | Two taps. Refused while an order is in progress, and the screen says which order. Money a shop owes the customer does not stop deletion and stays owed. The account closes at once, support can restore it for 7 days, then it is erased | confirm, confirm with money owed to you, deleting, blocked by order in progress, could not delete, account closed | DEL-1 to DEL-7, TRU-4 | [#92](https://github.com/Hemanshujc1/YGo/issues/92) |
| **C26 Update required** | The app is too old for the server. The screen says so plainly and offers one action. Nothing about the account changes. If an order is in progress, the screen says it is safe and keeps Call the shop reachable | required, required with an order in progress, opening store | Q-7 | [#30](https://github.com/Hemanshujc1/YGo/issues/30) |

## Screen details: Shopkeeper app

Tabs: Orders, Bill, Stock, Deliveries, More.

- **Deliveries** shows for the Owner and for Staff who can deliver.
- **Owner-only areas are absent for Staff, not disabled**: Money, Staff, Shop settings, price editing, coupons and the Bargain floor. The server enforces every permission.
- **Every screen that writes** also covers offline and waiting to sync.

### Onboarding and going Live

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **S17 Shop application** | The Owner starts it in the app. It takes numbers only: no photo or scan of any identity document, and no bank details. The Owner's name is typed here. Phone and email come from the account. Admin can correct any field later | filling in, sending, error, sent | ONB-1, ONB-3, ACC-5 | [#40](https://github.com/Hemanshujc1/YGo/issues/40) |
| **S18 Application status** | A step tracker: Draft, Submitted, Under review, Approved, Live. Each step says what happens next and who does it. Only Admin moves a shop to Live. When the shop is Approved, this screen opens S14 | draft, submitted, under review, approved, live, loading, error | ONB-1, ONB-2, ACC-5 | [#40](https://github.com/Hemanshujc1/YGo/issues/40), [#46](https://github.com/Hemanshujc1/YGo/issues/46) |
| **S19 Agreement and rate card** | The agreement names the excluded goods and says suspension is the consequence. It shows this shop's rate card, says there is no input tax credit on commission in stage one, and states the 7-day repayment duty. The acceptance is stored with both versions and the time | reading, rate card not ready, accepting, error, accepted | ONB-5, MNY-12, MNY-13, TRU-4, L-3 | [#46](https://github.com/Hemanshujc1/YGo/issues/46) |
| **S14 Approved, not yet Live** | A readiness checklist. "Get ready now" leads to S42 and S43. Counter billing, stock changes and online orders are locked, and each lock says what it is waiting for. They open at Live | default | ACC-5, ONB-1, ONB-2, ONB-4 | [#43](https://github.com/Hemanshujc1/YGo/issues/43), [#46](https://github.com/Hemanshujc1/YGo/issues/46) |
| **S42 Choose products and prices** (Owner) | The Owner picks the master-catalog packs that the shop stocks, and sets the online price, the counter price and the MRP. This screen opens from Approved onward. A product not in the catalog leads to S38 | catalog, set prices, added, not in catalog, loading, offline, error | CAT-1, CAT-4, ACC-5, CAT-3 | [#43](https://github.com/Hemanshujc1/YGo/issues/43) |
| **S43 Opening stock** (Owner) | The Owner counts opening stock from Approved onward. Stock is held in the base unit. Works offline and waits to sync | counting, saved offline, saved, error, no products yet, loading | ACC-5, ONB-4, BIL-3, BIL-7, CAT-2, CAT-4 | [#43](https://github.com/Hemanshujc1/YGo/issues/43) |

### Alerts and shop state

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **S01 New order alert** | A full-screen alert. It rings as loudly as the phone allows and rings again at 120 seconds; the order expires at 600 seconds. It shows over the lock screen where the phone permits. One tap opens the order. **No promise that an order cannot be missed** | default | ORD-2, NOT-3, NOT-5 | [#55](https://github.com/Hemanshujc1/YGo/issues/55), [#57](https://github.com/Hemanshujc1/YGo/issues/57) |
| **S02 Notification fallback** | Used where a full-screen alert is not allowed: some Android settings, and every iPhone. An ordinary notification carries the same facts. The system draws it; YGo owns the words and the one-tap target | default | ADR-0001, ORD-2, NOT-5 | [#55](https://github.com/Hemanshujc1/YGo/issues/55) |
| **S03 Shop home, alerts limited** | A permission fix panel, shown calmly before an order is missed. An order still waiting is pinned on top with its expiry | default | NOT-5, ORD-2 | [#55](https://github.com/Hemanshujc1/YGo/issues/55) |
| **S41 Shop notifications** | The Owner sees money, complaint, rate-card and suspension items. Staff see order and product items only. An unread row says "New" | Owner, Staff, none yet, loading, error, offline | NOT-1, NOT-2, NOT-6 | [#55](https://github.com/Hemanshujc1/YGo/issues/55) |
| **S35 Shop paused or suspended** | An auto-pause is mechanical and lifts by itself when its cause is fixed. For an expired FSSAI, the Owner enters the new expiry date, and orders restart as soon as it is saved (D-17). A suspension is YGo's decision and comes with a reason. Counter billing, stock and catalog keep working, and the statement stays due. A rate-card change notice gives the date the change takes effect | paused: FSSAI expired, paused: balance limit, suspended, rate card change notice, reinstated | ONB-6, ONB-7, MNY-9, MNY-14, NOT-6 | [#91](https://github.com/Hemanshujc1/YGo/issues/91), [#79](https://github.com/Hemanshujc1/YGo/issues/79), [#80](https://github.com/Hemanshujc1/YGo/issues/80) |

### Orders

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **S04 Orders** | Orders are grouped by who has to act. A scheduled order shows its review cutoff. A cancel request asks the shop to agree. A ready order gets a deliverer or a pickup code | default | FUL-4, ORD-5, DLV-1, FUL-7 | [#52](https://github.com/Hemanshujc1/YGo/issues/52), [#86](https://github.com/Hemanshujc1/YGo/issues/86), [#59](https://github.com/Hemanshujc1/YGo/issues/59) |
| **S05 New order detail** | Built for one hand: the main action is the biggest and lowest on the screen. Reject opens a reason picker. "Accept in part" can only reduce a quantity or remove a line, never add or swap. The server works out the new total, and the customer must confirm it (C10) | new order, accept in part | ORD-2, ORD-3, ORD-4 | [#52](https://github.com/Hemanshujc1/YGo/issues/52), [#64](https://github.com/Hemanshujc1/YGo/issues/64) |
| **S22 Scheduled order review** | The slot is booked and stock is reserved when the order is placed. The shop may reject until the cutoff; doing nothing keeps the order. After the cutoff, the shop can only cancel, with a reason, and that counts against its reliability | review before cutoff, reject sheet, after cutoff, loading, error | FUL-3, FUL-4, ORD-3, FUL-5 | [#86](https://github.com/Hemanshujc1/YGo/issues/86), [#74](https://github.com/Hemanshujc1/YGo/issues/74) |
| **S23 Customer cancel request** | After the shop accepts and before the order is ready, the customer can only ask to cancel. The shop agrees or keeps the order, the answer is recorded and the customer is told | request, sending, agreed, kept, error | ORD-5, FUL-5, ORD-7 | [#59](https://github.com/Hemanshujc1/YGo/issues/59) |
| **S24 Mark ready and assign** | Moves an order from Packing to Ready. A delivery order goes to the Owner or to Staff who can deliver, and shows in that person's My deliveries. A pickup order waits at the counter for the customer's code | packing, choose deliverer, assigned, pickup ready, error | ORD-1, DLV-1, FUL-7 | [#56](https://github.com/Hemanshujc1/YGo/issues/56), [#65](https://github.com/Hemanshujc1/YGo/issues/65) |
| **S25 Complete pickup** | Uses the same 4-digit code as delivery, with no photo. The customer pays at the counter in cash or by the shop's UPI QR, and the payment is recorded. A pickup never collected by the cutoff ends with nobody paying anything | enter code, wrong code, take payment, picked up, not collected | FUL-7, MNY-1, DLV-6 | [#65](https://github.com/Hemanshujc1/YGo/issues/65) |

### Delivery tab

All delivery screens work offline. The server rechecks them when the phone reconnects (`DLV-3`).

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **S26 My deliveries** | Lists only the orders assigned to this person. The tab is absent for other Staff | list, offline, empty, loading | DLV-1, DLV-3 | [#56](https://github.com/Hemanshujc1/YGo/issues/56), [#68](https://github.com/Hemanshujc1/YGo/issues/68) |
| **S27 Delivery detail** | Ready, then On the way, then Arrived: each is one big tap. Shows the address, and the customer's name and phone for this order only. No map or route | ready to take, on the way, arrived, loading, not on phone yet | ORD-1, DLV-2, DLV-3, DLV-7 | [#56](https://github.com/Hemanshujc1/YGo/issues/56) |
| **S28 Proof photo** | Step 1 of the handover, before the code. The viewfinder stays dark in both themes. The photo is shrunk on the phone and is saved even offline | camera, review, saved offline, camera blocked | DLV-2, DLV-3, Images | [#56](https://github.com/Hemanshujc1/YGo/issues/56), [#68](https://github.com/Hemanshujc1/YGo/issues/68) |
| **S09 Delivery handover** | Photo, then the customer's code. Built for outdoors and one hand: big targets, high contrast. The proof exception and failed delivery actions sit below the main path | default | DLV-2 to DLV-5, DLV-7 | [#56](https://github.com/Hemanshujc1/YGo/issues/56) |
| **S10 Record payment** | The deliverer shows the shop's UPI QR, which is always white, or takes cash, and records which way the customer paid. The same screen is used at the counter for a pickup | UPI, Cash | DLV-6, MNY-1, FUL-7 | [#56](https://github.com/Hemanshujc1/YGo/issues/56), [#65](https://github.com/Hemanshujc1/YGo/issues/65) |
| **S29 Proof exception** | When the code cannot be used, a photo and a reason complete the delivery. The delivery is marked a proof exception, counted, and reviewed by Admin (A28). Nothing happens automatically, and the screen says this plainly, not as a warning | photo and reason, saving, reason missing, recorded | DLV-4, R-8 | [#60](https://github.com/Hemanshujc1/YGo/issues/60) |
| **S30 Failed delivery** | Needs, in order: one call attempt, a wait, a photo and a reason. A failed delivery is final, and the goods go back into stock | waiting, ready to mark failed, marked failed | DLV-5, DLV-3 | [#60](https://github.com/Hemanshujc1/YGo/issues/60) |

### Counter bills

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **S31 New bill** | Lines come from the catalog by search or barcode (S44), or are typed by hand. Also takes a discount, an optional customer name and phone with a consent tick, and cash or UPI. Typed lines are checked against the denylist, which only flags a bill | empty, searching, lines added, scanning, typed line, customer and consent, saved | BIL-1, BIL-2, BIL-5, CAT-6, CAT-8 | [#53](https://github.com/Hemanshujc1/YGo/issues/53), [#69](https://github.com/Hemanshujc1/YGo/issues/69) |
| **S06 Counter bill, offline** | Works with no internet, up to 500 actions or 72 hours. The total is worked out on the phone and is the total on record. Offline is calm and visible, never shown as an error | offline, offline limit reached | BIL-1, BIL-3, BIL-5, BIL-9 | [#51](https://github.com/Hemanshujc1/YGo/issues/51), [#75](https://github.com/Hemanshujc1/YGo/issues/75) |
| **S07 Bill PDF, number pending** | The bill stays light in dark theme. Before sync it carries its permanent reference and "Number pending". Shared again after sync, it shows both. This is also the specimen for the Inter review in PDF | default | BIL-2, BIL-5, Q-3 | [#53](https://github.com/Hemanshujc1/YGo/issues/53), [#51](https://github.com/Hemanshujc1/YGo/issues/51) |
| **S08 Waiting to sync** | The sync queue view (design system 5.1). Only a bill held back uses warning, and it says what to do. A held-back bill keeps its sale | default | BIL-3, BIL-5, BIL-9, DLV-3 | [#75](https://github.com/Hemanshujc1/YGo/issues/75), [#48](https://github.com/Hemanshujc1/YGo/issues/48) |
| **S37 Void a bill** (Owner) | The Owner can void within 24 hours, with a reason. The original bill is never edited and keeps its reference and number; it is marked void. Voiding needs a connection. Staff see the bill without a void action | Owner within 24 h, void: reason, void: other reason, voided, older than 24 h, Staff view, offline, no bills yet, loading, error | BIL-6, BIL-5 | [#54](https://github.com/Hemanshujc1/YGo/issues/54) |

### Stock and products

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **S11 Stock** | A counter sale is never blocked. When stock goes below zero, the shop sees which online orders this affects and fixes each in two taps. Low stock and out of stock carry a word, not only a colour | default | BIL-4, BIL-7, CAT-3, DSC-4 | [#67](https://github.com/Hemanshujc1/YGo/issues/67), [#76](https://github.com/Hemanshujc1/YGo/issues/76) |
| **S12 Product, Owner** | Online price, counter price, MRP, stock, low-stock level, availability, quantity-price options and the Bargain floor. The floor never reaches a customer's phone and may not exceed the online price | default | CAT-1, CAT-2, BRG-1, BIL-7 | [#43](https://github.com/Hemanshujc1/YGo/issues/43), [#78](https://github.com/Hemanshujc1/YGo/issues/78) |
| **S13 Product, Staff** | Prices are read-only. Staff change stock with a reason from the fixed list. Price fields, the Bargain floor and quantity-price options are absent | default | Roles, BIL-7 | [#67](https://github.com/Hemanshujc1/YGo/issues/67) |
| **S38 Product request** (Owner) | A product not in the catalog can be sold at the counter at once; customers see it only after Admin approves it (A11). A request rejected as an excluded good leaves the counter list. The Request button is disabled offline, with the reason given | requests, new request, no requests, loading, error, offline | CAT-3, CAT-8, NOT-6, D-9 | [#62](https://github.com/Hemanshujc1/YGo/issues/62) |
| **S44 Barcode scan** | Opened from S31 or S11. Matches only barcodes that already exist. A barcode in the catalog but not in the shop's products can be added by the Owner only; Staff are told "Ask the Owner to add it". Works offline | scanning, found on the bill, found in stock, in catalog but not stocked, not in catalog, offline, camera not allowed | CAT-6, BIL-1, BIL-3, CAT-3 | [#53](https://github.com/Hemanshujc1/YGo/issues/53), [#67](https://github.com/Hemanshujc1/YGo/issues/67) |

### Money (Owner only, absent for Staff)

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **S15 Money** | The running balance owed to YGo. A warning shows at 80% of the limit, and orders pause at 100%. The weekly statement says it is not a tax invoice. Also lists any repayment the shop owes a customer, with a "mark paid" action. Shows sales, never profit | default | MNY-8, MNY-9, MNY-11, MNY-12, TRU-4 | [#71](https://github.com/Hemanshujc1/YGo/issues/71), [#79](https://github.com/Hemanshujc1/YGo/issues/79), [#90](https://github.com/Hemanshujc1/YGo/issues/90) |
| **S39 Sales reports** | Only the reports PRD 5.14 lists: sales today and this week, split online and counter, and top items. Tiles and lists only | this week, no sales yet, loading, error, offline | 5.14, MNY-11 | [#88](https://github.com/Hemanshujc1/YGo/issues/88) |
| **S40 Rejected Bargain offers** | Offers that fell below the hidden floor, grouped by pack, so the Owner can judge the floor. No customer details are shown | offers, none this week, loading, error, offline | BRG-1, BRG-6, 5.14 | [#88](https://github.com/Hemanshujc1/YGo/issues/88), [#78](https://github.com/Hemanshujc1/YGo/issues/78) |

### Staff (Owner only)

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **S16 Staff** | The staff list with the "can deliver" flag. A phone number alone never lets anyone in. Re-inviting someone keeps their history | code shown, staff list | ACC-6, ACC-7, ACC-11, DLV-1 | [#58](https://github.com/Hemanshujc1/YGo/issues/58) |
| **S20 Invite staff** | The Owner enters a phone number and sets "can deliver". The app shows a one-time join code. A number already linked to another shop is refused, because a person is linked to one shop at a time | enter number, sending, already at another shop, re-invite, code shown | ACC-4, ACC-6, ACC-7 | [#58](https://github.com/Hemanshujc1/YGo/issues/58) |
| **S21 Join a shop** | The invited person opens this on their own phone, from C23 "Join a shop", and types the code | empty, checking, wrong code, expired code, joined | ACC-4, ACC-6 | [#58](https://github.com/Hemanshujc1/YGo/issues/58) |

### Account and settings

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **S36 More** | Role decides what is listed: Money, Staff and Shop settings appear for the Owner only. Everyone sees sync status, Theme (System, Light or Dark, after Notifications) and "Switch to Customer". Deletion is a request that Admin processes, and it is refused for an Owner while the shop is Live | Owner, Staff who can deliver, Staff counter only, delete request (Owner, shop Live), update required | ACC-4, BIL-3, Q-3, Q-7, DEL-1, DEL-2 | [#30](https://github.com/Hemanshujc1/YGo/issues/30), [#93](https://github.com/Hemanshujc1/YGo/issues/93), [#193](https://github.com/Hemanshujc1/YGo/issues/193) |
| **S32 Shop settings** (Owner) | Opening hours, delivery radius (up to 5 km), fulfilment modes, slots and offers. The minimum order comes from the rate card and is read-only. A mode that YGo has switched off says so | Owner, saving, could not save, Staff (no entry) | FUL-1, MNY-13, DSC-1 | [#65](https://github.com/Hemanshujc1/YGo/issues/65), [#63](https://github.com/Hemanshujc1/YGo/issues/63) |
| **S33 Delivery slots** (Owner) | The Owner's own slots for today and tomorrow, each with a maximum number of orders. A full slot disappears for customers. Bookings close at the reject cutoff. Editing or removing a slot never cancels an order already in it | slots, edit slot, could not save, no slots | FUL-2, FUL-4 | [#74](https://github.com/Hemanshujc1/YGo/issues/74) |
| **S34 Shop discount and coupon** (Owner) | A discount is a percentage with an optional cap, or a flat amount with a required minimum order. Above the maximum effective percentage (20% by default), it is stopped at save. A discount over a lowered maximum is paused | discount, above maximum, paused by lower maximum, new coupon | MNY-5, CRT-3, NOT-6, BRG-5 | [#63](https://github.com/Hemanshujc1/YGo/issues/63), [#70](https://github.com/Hemanshujc1/YGo/issues/70) |
| **S45 Shop coupons** (Owner) | Lists the shop's own coupons, which the shop pays for, with an editor. Opened from S32. The same maximum check applies | coupons, new coupon, above maximum, saved, paused by lower maximum, no coupons, offline | CRT-3, MNY-5, MNY-6, D-12, NOT-6, BRG-5 | [#70](https://github.com/Hemanshujc1/YGo/issues/70), [#77](https://github.com/Hemanshujc1/YGo/issues/77) |

## Screen details: Admin web

The left nav has these groups:

- Dashboard, Queues (with a count badge), Shops, Catalog, Orders
- Money: Rate cards, Coupons, Price simulator, Statements, Payments and adjustments, Balances and limits
- People and places: Customers, Admin accounts, Area Manager payouts, Areas

**Every action that changes something asks for a reason** and is recorded (`ADM-10`).

The **Area Manager** state, drawn on most screens, uses the Area Manager shell (design system 7.1). The Area Manager can:

- see their own Area only
- correct applications and record visits
- see the queues and orders without acting on them
- see their own payout

Everything else is absent or labelled "view only" (`ADM-12`).

### Overview and shops

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **A01 Dashboard** | Tiles only. Orders today, by treatment. Platform: Live shops, the amount owed by shops, open queue items with the oldest age. The launch measures G-1 to G-4, each against its bar | default | ADM-8, 3.2 | [#95](https://github.com/Hemanshujc1/YGo/issues/95) |
| **A02 Queues** | Everything waiting on Admin, oldest first, and every row shows its age. Filter chips carry counts. "Unanswered at 2 min" offers Call shop. Every other row opens its queue item page (A11, A22 and A26 to A31) | default | ADM-7 | [#95](https://github.com/Hemanshujc1/YGo/issues/95) |
| **A03 Shop and rate card** | Rate-card values, each with its source chip, plus the application and the visit. "Move to Live" is blocked by any empty rate-card value; a typed 0 counts as set | default | ADM-2, ONB-2, MNY-3, MNY-13 | [#44](https://github.com/Hemanshujc1/YGo/issues/44), [#46](https://github.com/Hemanshujc1/YGo/issues/46) |
| **A04 Shop, Area Manager view** | The Area Manager can correct a field and record a visit. "Going Live" lists what is outstanding and who does each step | default | ADM-12 | [#46](https://github.com/Hemanshujc1/YGo/issues/46), [#96](https://github.com/Hemanshujc1/YGo/issues/96) |
| **A06 Shops and applications** | Lists all shops, with applications on a tab | all shops, applications, no applications, loading, error, Area Manager | ADM-2, ONB-1 | [#40](https://github.com/Hemanshujc1/YGo/issues/40) |
| **A07 Application review** | Correct a field (with a reason), then approve | under review, submitted, correct a field, approve, approved, loading, error, Area Manager | ONB-1, ONB-3 | [#40](https://github.com/Hemanshujc1/YGo/issues/40) |
| **A08 Record visit** | Upload the shop-front photo. **The location is read from the photo file**, and a photo with no location is refused. Tick the checks made at the shop: PAN, FSSAI, the Owner's phone and email confirmed in person, the alarm allowed on the shop's phone, and the tester opt-in. Add notes | record visit, photo has no location, saving, visit recorded, error, Area Manager | ONB-2, ACC-14 | [#42](https://github.com/Hemanshujc1/YGo/issues/42) |
| **A09 Shop settings, suspend and reinstate** | Suspension needs a ground and a reason, and never happens automatically. Admin can correct the FSSAI expiry date (D-17) and switch fulfilment modes | live, suspend, suspended, reinstate, loading, error, Area Manager | ADM-2, ONB-6, ONB-7, FUL-1 | [#91](https://github.com/Hemanshujc1/YGo/issues/91), [#65](https://github.com/Hemanshujc1/YGo/issues/65) |
| **A25 Areas** | Areas and pincodes, with a pause switch for each Area | areas, new area, pause an Area, paused, no areas, loading, error, Area Manager | ADM-1, DSC-5 | [#38](https://github.com/Hemanshujc1/YGo/issues/38) |

### Catalog

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **A10 Products, packs and categories** | Master products and packs, in two category levels | products, edit product, saved, no results, loading, error | ADM-3, CAT-1, CAT-4, CAT-5 | [#39](https://github.com/Hemanshujc1/YGo/issues/39) |
| **A11 Product requests** | Approve, map to an existing product, or reject with a reason. A rejection as an excluded good removes the product from the shop's counter list | approve, map to existing, reject, approved, none waiting, loading, error | CAT-3, CAT-7 | [#62](https://github.com/Hemanshujc1/YGo/issues/62) |
| **A12 CSV import** | Three-step import. **A file with any problem row imports nothing**; the problem rows can be downloaded and fixed | choose file, checking, problems found, ready to import, imported, error | ADM-3, CAT-6 | [#41](https://github.com/Hemanshujc1/YGo/issues/41) |
| **A13 Search terms and denylist** | Search terms (so "kanda" finds Onion) and the denylist words. A denylist match only flags; it never blocks a sale | search terms, add term, term added, denylist, add word, no terms, loading, error | DSC-3, CAT-8 | [#49](https://github.com/Hemanshujc1/YGo/issues/49), [#69](https://github.com/Hemanshujc1/YGo/issues/69) |

### Orders

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **A14 Live orders** | Live monitoring with filters | live, filtered with none, loading, error, Area Manager | ADM-4 | [#66](https://github.com/Hemanshujc1/YGo/issues/66) |
| **A15 Order detail and forced transition** | Lines frozen at placement, with the total paid to the shop. Commission, fee share and floor, each with its source. A timeline of what happened. People, including the customer's name. The deliverer's last contact with the server. The forced transition modal lists only the moves the order's status allows | in progress, force a transition, forced, final order, loading, error, Area Manager | ADM-4, ORD-1, MNY-7 | [#66](https://github.com/Hemanshujc1/YGo/issues/66), [#89](https://github.com/Hemanshujc1/YGo/issues/89) |

### Money

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **A05 Price simulator** | Runs the same server calculation as real orders. A draft rule is tried in a Now versus Draft table and never saved. "Shop keeps" is explained as what remains after what the shop owes YGo, never as profit | default | MNY-10, MNY-15 | [#45](https://github.com/Hemanshujc1/YGo/issues/45) |
| **A16 Rate cards** | Global, category and shop values, each with its source. A change to a Live shop is scheduled from the start of a statement week | rate cards, change a value, change scheduled, loading, error | MNY-3, MNY-13, MNY-14 | [#44](https://github.com/Hemanshujc1/YGo/issues/44), [#80](https://github.com/Hemanshujc1/YGo/issues/80) |
| **A17 Coupons** | Platform coupons and split-funded coupons. Over the maximum is stopped at save | coupons, new coupon, over the maximum, no coupons, loading, error | MNY-5, MNY-6 | [#70](https://github.com/Hemanshujc1/YGo/issues/70), [#77](https://github.com/Hemanshujc1/YGo/issues/77) |
| **A18 Statements** | The weekly statement for Monday to Sunday, per shop. It is not a tax invoice | this week, statement open, no statements, loading, error | MNY-8, MNY-12 | [#71](https://github.com/Hemanshujc1/YGo/issues/71) |
| **A19 Payments and adjustments** | Record a payment that a shop made by hand. Make a manual adjustment with a reason | payments, record a payment, payment recorded, adjustments, make an adjustment, no payments, loading, error | ADM-6 | [#79](https://github.com/Hemanshujc1/YGo/issues/79) |
| **A20 Balances and limits** | The balance per shop and the limit set for each | balances, set a limit, limit saved, nothing owed, loading, error | ADM-6, MNY-9 | [#79](https://github.com/Hemanshujc1/YGo/issues/79) |

### People

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **A21 Customers** | Look up a customer. Shows the phone state and the refusal count. Block and unblock with a reason; nothing blocks automatically | search, customer found, block, blocked, not found, loading, error | ADM-11, ACC-14, TRU-5 | [#72](https://github.com/Hemanshujc1/YGo/issues/72) |
| **A22 Account recovery and deletion** | Change an email for recovery, only after the checks: for an Owner, a PAN, FSSAI or visit-record match; for a Customer, a completed order is needed. Restore a deleted account within 7 days. Act on deletion requests | change email, checks not done, no completed order, email changed, error, restore deleted, restore refused, deletion request | ADM-11, ACC-12, DEL-4, DEL-9 | [#83](https://github.com/Hemanshujc1/YGo/issues/83), [#92](https://github.com/Hemanshujc1/YGo/issues/92), [#93](https://github.com/Hemanshujc1/YGo/issues/93) |
| **A23 Admin and Area Manager accounts** | Created by an Admin only, never by sign-up. The created state says "They can sign in now" | accounts, new account, email in use, created, loading, error | ACC-8 | [#37](https://github.com/Hemanshujc1/YGo/issues/37) |
| **A24 Area Manager payouts** | A share of the commission actually collected in the Area, worked out **weekly on the statement week** (D-18) | payouts, change share, nothing collected, loading, error, Area Manager | ADM-9 | [#96](https://github.com/Hemanshujc1/YGo/issues/96) |

### Queue items

Every item uses the queue item page (design system 7.1). The Area Manager sees each one read-only.

| Screen | Purpose and behaviour | States | PRD | Ticket |
|---|---|---|---|---|
| **A26 Complaint review** | Uphold or reject. An upheld complaint creates the repayment owed (C21). The shop is not told until the complaint is upheld, and has no reply in the app | open, reject, upheld, loading, error, Area Manager | TRU-2, TRU-3 | [#87](https://github.com/Hemanshujc1/YGo/issues/87) |
| **A27 Repayment disputed or overdue** | Admin speaks to both sides outside the app first. The outcome is either "Paid: the customer received it" or "Still owed by the shop", and still owed keeps the original due date. Both sides see the reason. "Open suspension form" opens A09 pre-filled and suspends nothing by itself (D-19) | open, record outcome, outcome recorded, loading, error, Area Manager | TRU-4 | [#90](https://github.com/Hemanshujc1/YGo/issues/90) |
| **A28 Proof exception** | Mark reviewed. Nothing happens automatically | open, mark reviewed, reviewed, loading, error, Area Manager | DLV-4 | [#60](https://github.com/Hemanshujc1/YGo/issues/60) |
| **A29 Flagged bill** | Two cases. **Totals differ** (or a suspect clock, or a denylist match): the bill has its number and Admin marks it reviewed. **Held back:** the bill shows "Number pending" until Admin resolves it and gives it the next number with a note. The sale stands in both cases | totals differ, totals differ: mark reviewed, totals differ: reviewed, held back, held back: resolve, held back: resolved, loading, error, Area Manager | BIL-5, BIL-9, CAT-8 | [#75](https://github.com/Hemanshujc1/YGo/issues/75), [#69](https://github.com/Hemanshujc1/YGo/issues/69) |
| **A30 Below the contribution floor** | An order that went ahead below the floor, for example after accept in part. Mark reviewed | open, mark reviewed, reviewed, loading, error, Area Manager | MNY-4, ADM-7 | [#45](https://github.com/Hemanshujc1/YGo/issues/45), [#64](https://github.com/Hemanshujc1/YGo/issues/64) |
| **A31 Failed sync action** | An offline action the server rejected, for example a stock change to a product that was removed. Mark reviewed | open, mark reviewed, reviewed, loading, error, Area Manager | BIL-5, ADM-7 | [#75](https://github.com/Hemanshujc1/YGo/issues/75) |

## Rules for every screen

These apply everywhere and are not repeated in the tables. The full rules are in the [design system](../design/design-system.md).

**Interactions**

- One primary action per screen. On the Shopkeeper app, the main action is the biggest and lowest.
- Money is shown from the server, never worked out on the phone. The one exception is an offline counter bill (`BIL-9`). While prices load, the screen shows a loading state, never a guessed figure.
- A refusal names the reason and offers the fix as a button.
- A destructive action asks for a reason before it acts.
- An error keeps the button in place, turns its label into the retry, and says what failed.
- Offline uses the pending role and a cloud icon, never danger.
- The status pill uses the treatment for the person looking at it (design system section 6). The customer and the shop see different treatments for the same status.

**Accessibility notes for developers**

- Every control has a 48 by 48 hit area, even when it is drawn smaller (chips, checkboxes, radios). Build this with padding or hit-slop.
- Status is never shown by colour alone. Pills carry an icon and a word, and unread rows say "New".
- Every icon-only button has an accessible name, such as "Call the shop".
- Text survives the system's larger text sizes. Labels wrap; money and actions are never clipped.
- Every motion respects reduce motion on the phone and `prefers-reduced-motion` on the web.
- The QR, the bill and the PDF stay light in dark theme.
- Delivery screens stay readable in bright sun. They use high-contrast roles only.

## Design decisions

These are decisions that differ from, or extend, the PRD or the brief. The PRD has already been amended where a decision changes behaviour.

| Decision | Reason | Impact on dev |
|---|---|---|
| **The customer gives a name** at first sign-in, with the phone number (D-16, `ACC-2`, `DLV-7`) | The owner wants the shop and the deliverer to know whom they serve | C02 has a name field, C23 has "change name", and S27 and A15 show the name. GitHub issues #34 and #56 carry the name in their acceptance criteria |
| **The Owner enters a renewed FSSAI expiry** in the app, and the auto-pause lifts on save. Admin can correct it (D-17, `ONB-6`) | No one owned this update before | S35 has the date field and A09 has the correction |
| **Area Manager payouts are weekly**, on the statement week (D-18, `ADM-9`) | Matches the statement cycle | A24 groups payouts by statement week |
| **Admin settles a disputed repayment as paid or still owed**, with a reason both sides see. Suspension stays a separate step (D-19, `TRU-4`) | Admin needs a way to close a dispute without the app holding money | A27 has the outcome radio and a pre-filled link to suspension. C21 shows Admin's reason |
| **A bill is held back only when the server cannot apply it as recorded**: a removed product or pack, a validation failure, a bill too old for the server's limit, or a bill that depends on another held action. A total that differs, a suspect clock or a denylist match only flags the bill (`BIL-5`) | A sale that happened must never vanish, and numbers must stay in sequence | Sync gives a flagged bill its number at once. A held bill shows "Number pending" until Admin resolves it (A29) |
| **CSV import is all or nothing** (A12) | A partly imported catalog is harder to fix than a refused file | Validate every row first. Import inside one transaction. Offer the problem rows for download |
| **The visit photo is uploaded, and its location is read from the file** (A08) | The Admin web runs on a desktop and cannot take the photo itself | Read the photo's location metadata on the server and refuse a photo without it. Keep the coordinates with the visit record |
| **Order status wording** is the designer's, and differs between the Customer and Shopkeeper apps (design system section 6) | The wording describes who acts, from each person's view | It is display text and lives outside the code (`Q-2`) |
| **The dark-theme brand colour is `#A9BBF5`**, not indigo | Indigo is 1.71:1 on the dark background | Use the `brand` role. The owner confirmed this on 14 Oct 2026 |
| **C12 and C13 were removed** during review, and the ids are not reused | Removed at the owner's request | None. The gap in the numbering is deliberate |

## Reason lists

The owner settled these on 14 Oct 2026. They replace the drafts marked "wording to confirm" in the exports. They are display text and live outside the code (`Q-2`). In every list, choosing "Other" opens a required text field.

| Screen | List | Final wording |
|---|---|---|
| S19 | Goods the shop may not sell (agreement) | As drawn. It matches the excluded list in `CONTEXT.md` word for word, and the legal text (`L-3`) uses the same list |
| S37 | Why the bill is voided | Wrong item billed · Wrong price or quantity · Billed twice · Customer did not take the goods · Other |
| S22 | Why the shop rejects a scheduled order, or cancels it after the cutoff | Items not in stock · Cannot deliver in this slot · Shop closed at that time · Other |
| S29 | Why the code cannot be used | Customer cannot open the app · Customer's phone is not with them · Someone else is receiving the order · Other. There is deliberately no "code does not match" reason: a wrong code never lets the deliverer skip the check (`R-8`) |
| S30 | Why the delivery failed | No one at the address · Customer refused · Address not found · Other |
| A13 | Starting denylist (Admin edits it later; a match only flags) | **Alcohol:** daru, sharab, beer, whisky, rum, vodka, wine. **Tobacco and nicotine:** cigarette, bidi, tambaku, gutkha, gutka, pan masala, vape, hookah. **Medicine:** tablet, syrup, cough syrup, paracetamol, dolo, crocin, dawai. **Raw meat, fish and poultry:** chicken, mutton, fish, machhi, prawns. **Fireworks:** crackers, fatake, patakhe. **Fuel and gas:** LPG, gas cylinder, petrol, kerosene, rockel. **Pesticides:** pesticide, keetnashak. **Lottery:** lottery. **Infant milk:** infant formula, Lactogen, Nan Pro, feeding bottle |

Eggs and condoms are **allowed**: eggs do not count as poultry, and condoms do not count as adult products. Neither is on the denylist.

## Component inventory

The full list, with states, is in the [design system](../design/design-system.md). Mobile and web share tokens only, never components (ADR-0007).

| Component | New / existing | Reusable | Notes for dev |
|---|---|---|---|
| Button, text input, phone input, code input (4 and 6 digits), search | New | Yes, mobile | Section 5 of the design system. The code input stays disabled until the proof photo is taken (S09) |
| Quantity stepper (counted and measured), toggle, checkbox, radio, chip, star rating | New | Yes, mobile | A measured stepper uses the shop's minimum and step (`CAT-4`) |
| Status pill (five treatments), tag, badge | New | Yes, both | The treatment depends on the person looking at it |
| Card, list row, price rows and totals, sheet, dialog, toast, persistent banner | New | Yes, mobile | The changed-total banner stays on every screen until the customer answers (C10) |
| Empty state, skeleton, sync indicator (app, list, bill), countdown | New | Yes, mobile | Countdowns use tabular figures. Under one minute the border turns warning and never flashes |
| Photo tile, UPI QR, bill paper, full-screen alert | New | Yes, mobile | The QR and the bill stay light. The alert is best effort |
| Top bar, tab bar | New | Yes, mobile | Tabs are chosen by role |
| Step tracker, readiness checklist, permission fix panel, notification row, reason picker, shop state banner, sync queue view, viewfinder, join code, discount and coupon editor | New, from the screens | Yes, mobile | Section 5.1 of the design system |
| Web button, input, reason field, table, tile, source chip, scope notice, side nav, modal | New | Yes, web | Section 7 of the design system |
| Filter chips with counts, queue item page, Area Manager shell, Go-Live blocker, Now-versus-Draft table, three-step import, forced transition modal | New, from the screens | Yes, web | Section 7.1 of the design system |
| Google and Apple sign-in buttons | Existing (vendor kits) | — | Use each vendor's own button. Do not redraw them |
| Lucide icons | Existing library | Yes, both | Recorded in ADR-0001. Import each icon on its own |

## Open questions for dev and PM

| Question | Raised by | Status |
|---|---|---|
| **Wording of six reason and legal lists**, which carry a dashed marker in the exports (S19, S22, S29, S30, S37, A13) | Claude Design | Settled, 14 Oct 2026. See [Reason lists](#reason-lists) |
| **12 px** used for tab labels, tags and badges, while the type rule reserves 12 for captions | Design system review | Settled, 14 Oct 2026. They use a new Small label style, 13 / 18 at weight 500 (design system section 3) |
| **Lucide** as the icon set, which no ADR covers yet | Design system review | Settled, 14 Oct 2026. Recorded in ADR-0001 |
| **Dark `brand` `#A9BBF5`** | Claude Design | Settled, 14 Oct 2026. The owner confirmed it |
| **Inter** remains provisional until it has been reviewed on a phone, in the Admin web and in a PDF bill (S07 is the specimen) | Brief | Moved to build, 14 Oct 2026. The checks are acceptance criteria on #30, #37 and #53. Fallback: Noto Sans |
| **Brand name, logo and app icon** | Brief | Blocked on [#27](https://github.com/Hemanshujc1/YGo/issues/27) |
| **Issues #34 and #56** need the customer name added (D-16) | Design review | Settled, 14 Oct 2026. Both issues now include the name |
| **The real UPI QR** is generated from the shop's UPI id. The QR in the exports is a placeholder | Claude Design | Settled. This is build work |

## Next step

→ Review and approve this page. Then move the tokens into `@ygo/tokens` ([#30](https://github.com/Hemanshujc1/YGo/issues/30)) and start the UI tickets, with each ticket pointing to its screen ids here.

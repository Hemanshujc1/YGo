# Design Brief — YGo Phase 1

## Status

- [x] Draft
- [ ] Sent to Claude Design
- [ ] Design complete

Last updated: 13 Oct 2026 | Author: AI-assisted, for Hemanshu (owner) | Related: [Phase 1 PRD](prd-phase1.md), [`CONTEXT.md`](../../CONTEXT.md), [ADR-0001](../adr/0001-mobile-app-framework.md), [ADR-0007](../adr/0007-monorepo-and-shared-packages.md)

**The first deliverable is a design system, not screens.** Tokens, components and their states come first, for light and dark. Screens follow and are built only from those components.

**Where this brief and the PRD disagree, the PRD wins.** Requirement ids such as `ORD-4` point into the PRD. Read the requirement before designing the screen that carries it.

## 1. Context

YGo lets a customer order from local shops within roughly 2 to 3 km and have the shop's own staff deliver. It also gives the shop a counter billing and stock tool that works without internet. The customer pays the shop at the door or the counter, in cash or by UPI. The platform never holds money.

Phase 1 opens with a soft launch: one to two weeks, **12 to 20 hand-onboarded shops in one Area**, ending at two weeks with a decision to continue, fix and rerun, or stop (PRD 3.1, 3.2). Growth toward 50 to 80 shops belongs to stage two and only follows if stage one passes. It is built by one developer working with coding agents. Implementation tickets are ready. The design system is being made before any screen is built so that every developer and agent draws from one source and the three surfaces stay consistent.

## 2. Who we are designing for

| Persona | Surface | Goals | Pain points that shape the UI | Technical comfort |
|---|---|---|---|---|
| **Customer** | Customer app | Find a nearby shop, order, know the exact total before the door | Distrust of hidden fees. Must never miss a changed total. Pays nothing in advance | Uses consumer shopping apps. Often on a cheap Android phone |
| **Owner** | Shopkeeper app | Never miss an order. Bill fast at the counter. Know what is owed to the platform | Hands busy, customers waiting, patchy internet. Currently uses a notebook | Low to moderate. May never have used a business app |
| **Staff** | Shopkeeper app | Take orders, adjust stock, make counter bills, add products from the master catalog, deliver when flagged `can deliver` | Same counter pressure. Sees the prices needed to bill and to handle orders, and cannot edit them. Has no access to the Owner-only areas listed below | Low to moderate |
| **Deliverer** (the Owner, or Staff who can deliver) | Delivery tab in the Shopkeeper app | Complete a handover: proof photo, 4-digit code, record cash or UPI | Outdoors, one hand, bright sun, often offline | Low to moderate |
| **Admin** | Admin web | Run the platform through queues, rate cards and statements. In stage one this is the founder | Many queues, money accuracy, every action needs a reason | High |
| **Area Manager** | Admin web, one Area only | Onboard and support shops. Mostly reads; acts on very little (`ADM-12`) | Must see clearly what they cannot do | Moderate |

**Owner-only in the Shopkeeper app** (`CONTEXT.md`, Roles): changing online or counter prices, creating or editing coupons, setting Bargain floor prices, the statement, balance owed and reports, adding or deactivating Staff, and shop settings (opening hours, service radius, fulfilment modes, minimum order). Staff see a price wherever a bill or an order needs it, read-only. Design each of these areas as absent for Staff, not as a disabled control. Hiding is presentation only: the backend enforces every permission, and no screen may rely on a hidden control to protect anything.

## 3. Design goals

1. **Fast and legible at a shop counter.** A counter bill and an order acceptance are completed one-handed, with few taps, on a 2 GB Android phone.
2. **A new order is as hard to miss as the phone allows.** The alert is best effort, never guaranteed: it rings as loudly as each phone permits and repeats at 120 seconds (`ORD-2`, `NOT-3`, `NOT-5`). Where the full-screen alert is not permitted it falls back to an ordinary notification, on Android as on iOS (ADR-0001). Design the full-screen alert, the notification fallback, the state where notification or sound permission is denied with a plain way to turn it on, and the in-app view of an order still waiting. Each reaches the order in one tap. No screen or copy may promise that an order cannot be missed.
3. **The total is never a surprise.** Every fee is visible before checkout. A changed total shows the old figure, the new one and the reason, with the deadline to confirm (`CRT-2`, `ORD-4`).
4. **Offline is a visible, calm state.** The shopkeeper always knows what is saved on the phone, what is waiting to sync and what needs attention. It is never shown as an error.
5. **A refusal always says why and what to do next** (`CRT-4`).
6. **Plain over decorative.** Low clutter, one primary action per screen, generous tap targets.

**Tone:** trustworthy and plain. Short English sentences that will translate to Hindi later. Never playful about money, never alarming about recoverable states.

**Motion budget:** restrained. Motion confirms an action or explains a change of state, and nothing else.

- Press feedback about 150 ms. Screen and sheet transitions about 250 ms. Nothing longer than 400 ms.
- Allowed: press feedback, list insert and remove, sheet and screen transitions, skeleton loaders, one confirming moment on "order placed".
- Not allowed: looping decorative animation, parallax, particle or shader effects, anything that drops frames on the device floor.
- **Mobile:** every motion must be buildable with React Native Reanimated and must respect the system "reduce motion" setting.
- **Admin web:** the equivalent in lightweight CSS transitions on opacity and transform, with the same durations, and switched off under `prefers-reduced-motion`. No animation library on the web.

## 4. Platform and device targets

| Surface | Target |
|---|---|
| Customer app | Native, Android and iOS. Phone, portrait only |
| Shopkeeper app | Native, Android and iOS. Phone, portrait only. Delivery is a tab inside it, shown to the Owner and to Staff who can deliver |
| Admin web | Desktop-first web |

- Floor: a 2 GB Android 10 phone, and iOS 16.4 (`Q-1`).
- Built with React Native and Expo, styled with NativeWind over shared semantic tokens. The Admin web uses Tailwind over the same tokens.
- **Mobile and web share tokens only.** They share no components. Design the mobile component set and the web component set separately.
- No tablet or landscape layouts.

## 5. Brand and style constraints

**Brand name: provisional.** Write it **YGo** for now, never "WhyUGO", "YUGO" or "YGO". The company name, spelling and domain are not settled and are tracked in [issue #27](https://github.com/Hemanshujc1/YGo/issues/27). Until it closes:

- Do not finalise a logo, wordmark, app icon or any other brand asset.
- Show the name as plain text in the type family below, held in one replaceable place.
- Make no layout depend on the name's length or letterforms.

There is no tagline.

**Design system:** none exists. Define it from scratch.

**Palette (decided by the owner):**

| Name | Value | Notes |
|---|---|---|
| Primary teal | `#0F766E` | Primary action in light theme |
| Dark-theme teal | `#2DD4BF` | Primary action in dark theme |
| Saffron | `#F59E0B` | Accent: ratings, highlights |
| Indigo | `#1E3A8A` | Brand name text, secondary accent |
| Light background | `#F6F9F9` | |
| Dark background | `#0D1A20` | |

**Measured contrast for these values** (4.5:1 is the usual floor for body text):

| Pair | Ratio | Consequence |
|---|---|---|
| White on `#0F766E` | 5.47 | Fine for button labels |
| `#0F766E` on `#F6F9F9` | 5.17 | Fine for teal text and links in light theme |
| `#0D1A20` on `#2DD4BF` | 9.51 | Dark-theme buttons take dark labels |
| White on `#2DD4BF` | 1.86 | Never use white labels on the dark-theme teal |
| `#F59E0B` on white or `#F6F9F9` | 2.15 / 2.03 | Saffron cannot carry text or thin icons on a light surface |
| `#0D1A20` on `#F59E0B` | 8.25 | Saffron works as a fill behind dark text |
| `#1E3A8A` on `#F6F9F9` | 9.78 | Fine in light theme |
| `#1E3A8A` on `#0D1A20` | 1.71 | Indigo needs a lighter dark-theme value |

**What the system must define:**

- **Semantic colour roles, each with a light and a dark value.** Screens use role names only; no screen may contain a literal colour (ADR-0001). At minimum: background, surface, raised surface, border, text, muted text, primary, on-primary, accent, on-accent, success, warning, danger, info, disabled, and an offline or pending-sync role.
- **Order status colours.** There are seventeen order statuses, eight of them final (`ORD-1`). Group them into a small number of visual treatments and never rely on colour alone.
- **Typography: Inter**, approved by the owner as the proposed typeface and provisional until the design system has been reviewed on representative mobile, web and PDF outputs. One family for both mobile apps and the Admin web.
  - To verify in that review: the rupee sign renders correctly, tabular figures are present and line up, and text stays readable on small, low-density screens. Show specimens that make each of these checkable, including a bill or receipt as a PDF.
  - Why: it is drawn for small sizes on screens, has a tall x-height and open shapes that stay readable on low-density phones, includes the rupee sign, and has true tabular figures. It is open-licensed.
  - Weights: 400 for text, 500 for labels and buttons, 600 for headings and totals. No other weights, to keep the app small on the device floor.
  - Money, quantities, codes and timers use tabular figures so columns and countdowns do not shift.
  - Sizes: 16 for body, 14 for secondary text, 12 as the smallest size and for captions only. Money totals are never below 16. Define the remaining steps of the scale and the line heights.
  - Later Hindi: Noto Sans Devanagari as the companion. Line heights must leave room for its taller marks.
  - No second display family, and no brand typeface until issue #27 closes.
- **Spacing, radius, elevation, icon set and sizes.**
- **Formats** (`Q-4`): Indian digit grouping (₹1,25,000.00), two decimals on every money amount, dd/mm/yyyy, 12-hour time.
- **Text length.** All text lives outside the code (`Q-2`). Leave room for Hindi strings that run longer than the English.
- **Bills and receipts stay light in dark theme** (`Q-3`). They are shared as PDFs.

**Components, each with default, pressed, disabled, loading and error states:**

Button (primary, secondary, destructive, text), text input, code input (4-digit handover, 6-digit email), search field, quantity stepper (counted, and measured with minimum and step), toggle, chip and filter, badge and status pill, card, list row, price row and totals block, bottom sheet, dialog, toast, persistent banner, tab bar, top bar, empty state, skeleton, offline and sync indicator, countdown timer, star rating input, photo capture tile, QR display.

**Existing mockups:** the images in `References/Images/` are loose visual inspiration only and will be deleted once this system exists. Take **no screen, flow, feature, label or copy** from them. They show a retired brand name and several features that are out of Phase 1. The PRD and the GitHub issues are the only source for what a screen contains.

## 6. Screens and flows in scope

Every screen covers these states where they apply: **loading, empty, error, success**. Shopkeeper app screens that write also cover **offline** and **waiting to sync**. Every screen is delivered in light and dark.

### Customer app

| Journey | Screens | States and rules to cover |
|---|---|---|
| Sign-in | Sign in (Google, Apple on iOS, emailed 6-digit code), enter code, enter phone number | Phone number already in use, pointing to support (`ACC-3`). No passwords |
| Location | Set location, not serviceable yet with leave-your-number | Location outside every active Area (`DSC-5`) |
| Discover | Home, search, shop list, shop page | Shop card shows rating, estimated time, delivery fee. Shop page shows hours, minimum order, FSSAI number (`DSC-2`). No results. Shop closed |
| Product | Product and pack choice, quantity-price options, measured goods | Out of stock is shown and marked, never hidden (`DSC-4`) |
| Bargain | Offer a price, instant answer | Accepted with 30-minute hold timer, rejected, three offers used today (`BRG-2` to `BRG-4`) |
| Cart and checkout | Cart per shop, fulfilment choice (instant, scheduled slot, pickup), coupon, totals, place order | Cannot place, with reason and fix (`CRT-4`). Total changed since cart (`CRT-2`). Which offer applied (`CRT-3`). Coupon blocked by a bargained line (`BRG-5`). Slot shows its free-cancel cutoff (`FUL-5`) |
| Order | Order list, order detail with status and call-the-shop (`ORD-8`), changed-total confirmation, handover code, cancel | Waiting for shop, expired at no cost (`ORD-2`), persistent changed-total banner with countdown (`ORD-4`, `NOT-3`), code shown after the item check (`DLV-2`), pickup variant (`FUL-7`) |
| After the order | Rate 1 to 5 stars, raise a complaint, repayment owed | No written comment (`TRU-1`). Seven categories and optional photo (`TRU-2`). Owed, marked paid, confirmed, disputed (`TRU-4`) |
| Account | Notifications list, profile, theme, support email, switch to Shopkeeper side, delete account | Blocked customer (`TRU-5`). Deletion blocked with the reason (`DEL-2`). Update required (`Q-7`) |

### Shopkeeper app

| Journey | Screens | States and rules to cover |
|---|---|---|
| Onboarding | Shop application, application status, agreement with rate card | Numbers only, no document upload (`ONB-3`). Each application state (`ONB-1`) |
| Approved, not yet Live | Shop home for an Approved shop, set up listings, prices and opening stock | The Owner can set up listings, prices and opening stock. Counter billing and every other stock operation are shown as locked until Live, with the reason and what is still outstanding (`ACC-5`, `ONB-4`). At Live they open |
| Staff | Invite by phone with one-time join code, enter join code, staff list with `can deliver` flag | Deactivated, re-invited (`ACC-6`, `ACC-7`) |
| New order | Full-screen alert, notification fallback, permission prompt and permission-denied state, order detail, accept, reject, accept in part | Best effort, not guaranteed (`NOT-5`). Re-alert at 120 seconds, expiry at 600 (`ORD-2`). Reduce a quantity or remove a line only (`ORD-3`). Waiting for customer to confirm |
| Orders | Order list by status, scheduled order review, cancel request from customer, mark ready and assign deliverer, complete pickup with code | Scheduled cutoff (`FUL-4`). Pickup records cash or UPI (`FUL-7`) |
| Delivery tab | My deliveries, delivery detail, proof photo, enter code, show UPI QR or record cash | Works offline (`DLV-3`). Proof exception (`DLV-4`). Failed delivery (`DLV-5`) |
| Counter billing | New bill, barcode scan, typed manual line, discount, customer name and phone with consent tick, cash or UPI, bill PDF | Offline. "Number pending" (`BIL-5`). Offline limit reached (`BIL-3`). Bill needs attention. Void by Owner (`BIL-6`) |
| Stock and catalog | Product list, choose packs, prices and stock, quantity-price options, stock change with reason, product request, Bargain floor | Low stock, out of stock. Negative stock affecting online orders, fixed in two taps (`BIL-4`). Request pending, approved, rejected. Staff variant: prices shown read-only, no Bargain floor |
| Shop settings (Owner) | Fulfilment modes, delivery slots, shop-wide discount, shop coupon | Discount above the maximum, stopped at save (`MNY-5`). Paused discount |
| Money (Owner) | Running balance, weekly statement, reports, rejected bargain offers, repayment to mark paid | Warned at 80% of limit, paused at 100% (`MNY-9`). Statement says it is not a tax invoice (`MNY-12`). Nothing may imply profit (`MNY-11`) |
| Shop state | Auto-paused, suspended with reason, rate-card change notice | Counter tools stay available while suspended (`ONB-7`) |
| Account | Notifications list, switch to Customer side, sync queue status, update required | Role decides what is shown: Owner, Staff, delivery tab. Shop settings and Money are Owner-only |

### Admin web

| Area | Screens | Notes |
|---|---|---|
| Dashboard | Tiles only (`ADM-8`) | No charts beyond tiles |
| Queues | One place for every queue (`ADM-7`) | Each row shows its age |
| Shops | Applications, visit record, settings, suspend and reinstate | Live blocked while the rate card is incomplete (`MNY-13`) |
| Catalog | Master products, packs, categories, product requests, CSV import, search terms, denylist | |
| Orders | Live monitor, detail, forced transition with reason | |
| Money | Rate cards showing which level a value came from, coupons, price simulator, statements, payments, adjustments, balances and limits | |
| People | Customers (lookup, phone state, block), Admin and Area Manager accounts, payouts | |
| Area Manager view | The same screens, scoped to one Area and mostly read-only (`ADM-12`) | Show what is unavailable plainly |

Every Admin action that changes something asks for a reason.

## 7. Accessibility requirements

- **No WCAG conformance level is claimed** (`Q-5`).
- Readable text contrast in both themes. Use 4.5:1 for body text as the working floor and report any role that falls below it.
- Tap targets at least 48 dp.
- Status is never carried by colour alone. Pair it with a label or an icon.
- Layouts survive the system's larger text sizes without clipping money or actions.
- Shopkeeper and delivery screens stay readable in bright outdoor light.

## 8. Out of scope for this design iteration

- **The public website** (five pages) and the public deletion page.
- **Everything in PRD section 4.2.** In particular, do not design: price comparison across shops, live map tracking or route navigation, chat or masked calling, wishlist, trust badges, written reviews, sponsored listings, online payment, refunds, a separate delivery app, deliverer earnings, substitutions, tablet or landscape layouts, Hindi interface, an audit-log screen, reports beyond those in PRD 5.14.
- Roles other than Customer, Owner, Staff, Admin and Area Manager. There is no "Manager" or "Counter Staff" role.
- Marketing illustration, app-store screenshots, the app icon, a logo and a wordmark. Brand assets wait for issue #27.
- The owner's collected animation and effect references. They are held back until the tokens exist.

## 9. Open questions for Claude Design

1. What are the remaining steps of the type scale and the line heights for Inter, leaving room for Devanagari later?
2. What is the dark-theme value for indigo, since `#1E3A8A` on `#0D1A20` measures 1.71?
3. Where may saffron appear on a light surface, given it cannot carry text there?
4. How are seventeen order statuses grouped into visual treatments, and are the Customer and Shopkeeper groupings the same?
5. How does the app tell a shopkeeper, calmly and before an order is missed, that alerts are switched off or limited on this phone?
6. How is "waiting to sync" shown on a single bill, on a list, and for the app as a whole, without reading as an error?
7. Is one icon set enough for both mobile and web?

## Next step

Send this brief to Claude Design. When the design system and screens come back, document them as a separate UI specification page. This brief is the input and is not edited to hold the output.

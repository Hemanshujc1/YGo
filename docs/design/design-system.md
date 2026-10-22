# YGo design system, Phase 1

## Status

- [x] Draft
- [ ] Owner approved
- [ ] Reviewed on representative mobile, web and PDF output (Inter stays provisional until this is ticked; the checks run at build, in #30, #37 and #53)

Last updated: 14 Oct 2026 | Author: AI-assisted, for Hemanshu (owner) | Related: [Design Brief](../product/design-brief-phase1.md), [Specs UI](../product/specs-ui-phase1.md), [Phase 1 PRD](../product/prd-phase1.md), [ADR-0001](../adr/0001-mobile-app-framework.md), [ADR-0007](../adr/0007-monorepo-and-shared-packages.md)

## What this document is

These are the rules that every screen, developer and agent follows. They come from the nine design-system boards that Claude Design produced from the brief:

- colour roles
- type and formats
- space and motion
- order statuses
- buttons and inputs
- selection and quantity
- containers and feedback
- navigation and sync
- Admin web components

Section 5.1 and section 7 also record the patterns that the screens added. The screens themselves are documented in the [Specs UI](../product/specs-ui-phase1.md).

**The design exports are not in the repository.** The owner keeps them locally in this folder, and git ignores them because the repo is public and the files are large. They are:

- `YGo-design-system.html`
- `YGo-customer-app-design.html`
- `YGo-shopkeeper-app-design.html`
- `YGo-admin-web-design.html`
- a PDF of each

Open an HTML file in a browser to see the specimens. Every file shows each state in light and dark. Ask the owner for a copy.

If this document and the PRD disagree, the PRD wins. If a screen mockup and this document disagree, this document wins. Brand name, logo and app icon are not part of it until issue [#27](https://github.com/Hemanshujc1/YGo/issues/27) closes.

## 1. Rules that never bend

1. **Role names only.** No screen contains a literal colour, font size or spacing number. Everything comes from `@ygo/tokens` (ADR-0001, ADR-0007).
2. **Every colour role has a light and a dark value.** Bills, receipts, the bill PDF and the UPI QR stay light in both themes.
3. **Colour is never the only signal.** Every status pill, tag and sync state pairs colour with an icon or a word.
4. **Every control is at least 48 by 48.** A control that looks smaller (chip 40, checkbox 24, radio 24) needs a 48 hit area.
5. **Body text is at least 4.5:1.** Exceptions are listed in section 3 and are for disabled controls only.
6. **One primary action per screen.**
7. **Money is displayed, never computed on the phone.** Totals come from the server (`CRT-2`, `MNY-15`). While prices load, show a loading state, never a guessed figure.
8. **Offline is calm, not an error.** It uses the pending role and a cloud icon. Danger is for things that are wrong and need fixing.
9. **Owner-only areas are absent for Staff, not disabled.** The backend still enforces every permission. Hiding is presentation only.
10. **No claim that an order cannot be missed.** The new-order alert is best effort (`NOT-5`).
11. **All text lives outside the code** (`Q-2`). Every label may grow 40% and wraps to a second line rather than truncating. No layout depends on the length of the brand name.
12. **The brand name is one replaceable string** (`app.name`), set in Inter 600 in the brand role. No logo, wordmark or app icon until #27 closes.

## 2. Colour roles

Approved palette: teal `#0F766E` (dark theme `#2DD4BF`), saffron `#F59E0B`, indigo `#1E3A8A`, light background `#F6F9F9`, dark background `#0D1A20`. All six appear below unchanged.

| Role | Light | Dark | Use |
|---|---|---|---|
| `bg` | `#F6F9F9` | `#0D1A20` | Screen background |
| `surface` | `#FFFFFF` | `#14262D` | Cards, lists, inputs |
| `raised` | `#FFFFFF` | `#1B313A` | Sheets, dialogs. In dark, lighter means higher |
| `sunken` | `#EBF1F1` | `#0A1418` | Pressed rows, table headers, skeletons, thumbnails |
| `border` | `#D3DDDE` | `#29434C` | Decorative dividers |
| `border-strong` | `#7E9195` | `#6E8B93` | Input outlines, check and radio outlines, toggle track off |
| `text` | `#0D1A20` | `#E7EFF1` | Default text |
| `muted` | `#4B5D62` | `#9FB2B7` | Secondary text, placeholders |
| `primary` | `#0F766E` | `#2DD4BF` | Main actions, links, selected tab |
| `primary-pressed` | `#0B5D57` | `#22B3A1` | Pressed primary |
| `on-primary` | `#FFFFFF` | `#0D1A20` | Label on primary. In dark it is dark text, never white |
| `primary-subtle` | `#E1F2EF` | `#0E3633` | Selected chip, avatar, in-progress pill |
| `on-primary-subtle` | `#0B5D57` | `#7EEADB` | Text on `primary-subtle`. Do not use teal text there |
| `accent` | `#F59E0B` | `#F59E0B` | Fill only: "needs you" status, badges, rating star fill |
| `on-accent` | `#0D1A20` | `#0D1A20` | Text on accent |
| `accent-stroke` | `#B45309` | `#F59E0B` | Outline of a rating star |
| `accent-text` | `#8A4B05` | `#FBBF4D` | Small rating glyphs |
| `brand` | `#1E3A8A` | `#A9BBF5` | Brand name text only |
| `success` / `success-subtle` / `on-success-subtle` | `#166534` / `#E3F3E8` / `#166534` | `#5FD38D` / `#123224` / `#7FE0A6` | Done, discount lines |
| `warning` / `warning-subtle` / `on-warning-subtle` | `#9A4A06` / `#FDF0D5` / `#7A3A05` | `#FBBF4D` / `#3A2A0C` / `#FCD37A` | Needs attention, low countdown |
| `danger` / `on-danger` / `danger-subtle` / `on-danger-subtle` | `#B42318` / `#FFFFFF` / `#FDE9E7` / `#9F1D14` | `#FF8A80` / `#0D1A20` / `#3B1A1A` / `#FFA49C` | Wrong and needs fixing, destructive |
| `info` / `info-subtle` / `on-info-subtle` | `#1D4ED8` / `#E5ECFD` / `#1E40AF` | `#8DB0FF` / `#182B4D` / `#A9C2FF` | Waiting for someone else |
| `pending` / `pending-subtle` / `on-pending-subtle` | `#465A82` / `#E7ECF5` / `#3A4D73` | `#AEBCDB` / `#1E2A40` / `#C0CCE6` | Offline, waiting to sync |
| `neutral-subtle` / `on-neutral-subtle` | `#EBF1F1` / `#4B5D62` | `#1B2E35` / `#A9BBC0` | Quiet tags |
| `disabled-bg` / `disabled-text` | `#E4EAEB` / `#7D8B8E` | `#1B2B31` / `#6B7F84` | Controls that cannot be used |
| `inverse` / `on-inverse` / `inverse-action` | `#0D1A20` / `#E7EFF1` / `#5EEAD4` | `#E7EFF1` / `#0D1A20` / `#0F766E` | Toast |
| `scrim` | 48% `#0D1A20` | 60% black | Behind sheets and dialogs |

Colour rules:

- **Saffron is never text and never a thin icon on a light surface.** On white it is 2.15:1. It is a fill behind dark text only.
- **Indigo is brand text only.** On dark it would be 1.71:1, so the `brand` role switches to `#A9BBF5` (9.37:1).
- **White on dark teal fails** (1.86:1), so `on-primary` is dark in the dark theme.
- **Pending is not an error.** Warning means "needs attention". Danger means "wrong and needs fixing".
- **Elevation:** level 0 flat (surface and border), level 1 card (light: border and soft shadow; dark: border only), level 2 overlay (shadow, and `raised` is lighter in dark).

### Contrast, rechecked

I recomputed the key pairs from the hex values in the export. They match what the designer reported.

| Pair | Ratio |
|---|---|
| `text` on `bg`, light / dark | 16.73 / 15.19 |
| `muted` on `surface`, light / dark | 6.90 / 7.08 |
| `on-primary` on `primary`, light / dark | 5.47 / 9.51 |
| `on-accent` on `accent` | 8.25 |
| `brand` on `bg`, light / dark | 9.78 / 9.37 |
| `on-danger` on `danger`, light / dark | 6.57 / 7.76 |
| `on-primary-subtle` on `primary-subtle`, light | 6.68 |
| `border-strong` on `surface`, light / dark (3:1 target for non-text) | 3.30 / 4.30 |
| `disabled-text` on `disabled-bg`, light / dark | 2.90 / 3.48 (below 4.5 by design) |

No WCAG level is claimed (`Q-5`). The floor is 4.5:1 for body text.

## 3. Typography

**Inter, provisional** until the design system has been reviewed on representative mobile, web and PDF outputs. One family for both mobile apps and the Admin web. Weights 400, 500 and 600 only.

| Name | Size / line height | Weight | Use |
|---|---|---|---|
| Display | 28 / 40 | 600 | Rare: totals hero, handover code |
| Title large | 24 / 34 | 600 | Screen hero |
| Title | 20 / 28 | 600 | Section, totals |
| Headline | 18 / 26 | 600 | Top bar, card title |
| Body | 16 / 24 | 400 | Default text, rows |
| Label | 16 or 14 | 500 | Buttons, field labels |
| Secondary | 14 / 21 | 400 | Supporting text |
| Small label | 13 / 18 | 500 | Tab-bar labels, tags, badges |
| Caption | 12 / 18 | 400 | Captions only |

Admin web uses a desktop density: body 14 / 20, page title 24 / 32 (600), section title 16 / 24 (600), tile figure 28 / 36 (600).

Rules:

- Money, quantities, codes and timers use **tabular figures** (`tnum`), so columns and countdowns do not shift.
- Money totals are never below 16. 12 is for captions only, never for an action, a price, a tab label, a tag or a badge. Those use Small label (13 / 18, 500), even where the exports draw them at 12.
- Line heights are at least 1.4 times the size up to 20. This leaves room for Devanagari marks. Noto Sans Devanagari is the later Hindi companion.
- No second display family and no brand typeface until #27 closes.

### Formats (`Q-4`)

| Item | Format |
|---|---|
| Money | ₹1,25,000.00, Indian digit grouping, two decimals on every amount |
| Discount | −₹20.00 |
| Date | 13/10/2026 |
| Time | 2:05 PM (12-hour, India time) |
| Date and time | 13/10/2026, 2:05 PM |
| Quantity | 250 g · 1.5 kg · 2 × ₹6.00 |
| Phone | 98765 43210 |
| Bill reference | K7Q2-0F3A, or "Number pending" |

## 4. Space, shape, icons, motion

**Spacing (4-point):** 4, 8, 12, 16 (screen side margin and card padding), 20, 24, 32, 40 (web sections), 48 (minimum tap target).

**Radius:** 6 tag · 10 input · 12 button · 14 card and list · 16 dialog · 20 sheet (top corners) · full for pills and chips.

**Tap targets:** every control is at least 48 by 48. Primary buttons are 52 high. Counter and handover actions are 64. Small buttons are 48. Admin web controls are 40.

**Icons:** one set, Lucide, 2 px stroke, through `lucide-react-native` on mobile and `lucide-react` on web. Sizes 16 inline, 20 dense, 24 default, 32 empty states. An icon sits beside a label or carries an accessible name. Colour follows the text role. Google and Apple sign-in marks come from their own button kits.

**Motion:**

| Motion | Time | How |
|---|---|---|
| Press feedback | 150 ms | Scale 0.98 and pressed colour, ease-out |
| Sheet, screen | 250 ms in, 200 ms out | Slide from bottom or side with fade |
| List insert, remove | 200 ms | Height and opacity, neighbours slide |
| Skeleton | 1.2 s pulse | Opacity 1 to 0.55, stops when content arrives |
| Order placed | 400 ms | One check mark draws in a ring. The only celebratory moment |
| Toggle, chip | 150 ms | Thumb translate, fill change |

Mobile uses Reanimated and honours the system reduce-motion setting (every motion becomes an instant change). Web uses CSS transitions on opacity and transform only, off under `prefers-reduced-motion`. No looping decoration, parallax or particles. The countdown border thickens and turns warning under one minute, and never flashes.

## 5. Components, mobile

### Buttons

Variants: primary, secondary, destructive, destructive outline, text. States: default, pressed, disabled, loading, error. Sizes: 48 small, 52 default, 64 counter and handover.

- **Error state:** the button stays, its label becomes the retry, and one line below says what failed. Example: "Could not reach the server. Your order is not placed yet."
- Buttons size to their label and never truncate.
- Primary buttons that commit money show the amount: "Place order · ₹482.00".

### Inputs

- Text input: 52 high, radius 10, label above, help text below. States: default, focused (2 px primary), error (2 px danger), disabled, loading.
- Phone number: `+91` prefix, grouped 98765 43210. "Already used" points to the support email (`ACC-3`).
- Code input: 4 boxes for the handover code, 6 for the emailed code. States: first box focused, filled, error, disabled (until the proof photo is taken), checking.
- Search: rounded 26. A search term finds products through the shared search-term list (`DSC-3`).

### Selection and quantity

- **Quantity stepper:** counted goods in whole items. Measured goods from a minimum in fixed steps (`CAT-4`): 250 g, step 50 g, shown in kg from 1 kg. At 1, minus becomes remove. States: not in cart ("Add"), default, at maximum ("Only 3 left at this shop"), disabled (out of stock), loading.
- **Toggle:** 52 by 32. On error it returns to its last saved position, with a message.
- **Checkbox and radio:** 24 visual, 48 hit area. **Chips:** 40 visual, 48 hit area, with a count.
- **Star rating input:** 5 stars, 52 each. Display on cards is an amber glyph and a number, shown after 3 ratings.

### Status, tags, badges

- **Status pill:** 28 high, icon and label, five treatments (section 6).
- **Tag:** 24 high, radius 6, for "Out of stock", "Low stock · 3", "Number pending", "Owner only", "Bargain".
- **Badge:** 22, saffron fill with dark text, for counts.

### Containers and feedback

- **Card:** pressed, loading and error states. The error card says what failed and offers "Try again".
- **List row:** at least 56 high, title, secondary line, optional status, chevron. Out-of-stock items are shown and marked, never hidden (`DSC-4`).
- **Price rows and totals:** muted label, tabular value, total at 20 / 28 (600). A changed total shows the old figure struck, the new figure, and the reason beside it. Footer line: "Prices include tax. Pay the shop at the door."
- **Bottom sheet and dialog:** a reason is chosen before a destructive action ("Reject this order?", "Void bill"). A void bill keeps its reference and number and cannot be undone.
- **Toast:** inverse surface, one action, 48 high. A failure toast says "Nothing changed."
- **Persistent banner** (not a toast, stays until resolved): changed total with countdown (`ORD-4`), offline with count, balance at 82% of limit (`MNY-9`), bill needs attention, rate card change notice.

### Empty, loading, offline and sync

- **Empty state:** icon in a 72 disc, one line of reason, one line of what happens next. Skeletons pulse and stop on content.
- **Sync at three levels:** the app (top bar: "Offline · 3 waiting", "Syncing 2 of 3", "All synced", "1 needs attention"), a list (an icon on each row), and a single bill (its own line: "Saved on phone · number pending", "Synced · Bill 1042", "Needs attention").
- **Countdown:** 20 / 28, tabular, in a bordered pill. Under one minute: 2 px warning border. "Time is up" is a state. A ring is used on the full-screen order alert.

### Capture and special surfaces

- **Photo tile:** 4:3, dashed outline. States: empty, taken ("Taken 2:41 PM, tap to retake"), camera blocked (points to settings).
- **UPI QR:** always white so it scans, in both themes. Shown at full brightness, the shop's UPI id below, the amount above. The export's QR is a placeholder pattern, not a real code.
- **Bill paper:** always light (white, 12 / 18 text, tabular money), because it is shared as a PDF (`BIL-2`).
- **Full-screen alert:** `primary` background with `on-primary` text. Best effort, never described as guaranteed.

### Navigation

- **Top bar:** at least 56 high. Title 18 / 26, 48 icon buttons. Shows the sync state.
- **Tab bar:** Customer: Home, Search, Cart, Orders, Account. Shopkeeper: Orders, Bill, Stock, Deliveries, More. Deliveries shows for the Owner and for Staff who can deliver. Money and Settings sit under More for the Owner only. For Staff they are absent.

### 5.1 Patterns the screens added

These patterns are built from the components above. Each is used on more than one screen, so it is built once and reused.

- **Step tracker** (S18): a vertical list of the steps: Draft, Submitted, Under review, Approved, Live. Each step says who acts and what happens next. The current step uses `primary-subtle`. Done steps carry a check icon.
- **Readiness checklist with locked areas** (S14): what is done and what is outstanding, one line each. A locked area is shown with "Opens when you are Live" and "Waiting for: shop visit, rate card". It is never a bare disabled control.
- **Permission fix panel** (S03): one row per permission (notifications, ringing sound, show over lock screen). Each row says whether that permission is on, has one button to fix it, and the panel ends with "Test the alert". The panel uses calm copy, and an order that is still waiting stays pinned above it.
- **Notification row** (C22, S41): an icon, a one-line fact, the time, and the word "New" while unread. A tint alone is never enough. The list shows only what the server has already recorded.
- **Reason picker** (S05, S13, S22, S29, S30, S37): a bottom sheet with a fixed list of radio options. "Other" opens a required text field. The confirm button stays disabled until a reason is chosen. The reason lists are display text from outside the code. Their final wording is in the Specs UI, under "Reason lists".
- **Shop state banner** (S35): paused or suspended, with the reason, what still works (counter billing, stock, catalog), and the one action that lifts the pause when there is one (for example, entering a new FSSAI expiry). A pause uses warning. A suspension uses danger.
- **Sync queue view** (S08): three sections in this order: Needs attention, Waiting to sync, Synced today. An "Offline room used" meter reads "3 of 500 · 68 h left" (`BIL-3`). Only a held-back bill uses warning.
- **Scanner and camera viewfinder** (S28, S44): the viewfinder stays dark in both themes, and the controls around it follow the theme. A result shows as a row under the viewfinder ("On the bill · 2", "In stock 24"), so the person can keep scanning. If camera access is refused, a state points to the phone's settings.
- **Join code display** (S16, S20) and **join code entry** (S21): the code uses tabular figures in the Display style. The display says the code works once and only on the invited person's own phone. Entry has these states: wrong code, expired code, joined.
- **Owner-only field groups** (S12 and S13): for Staff, price fields, the Bargain floor and quantity-price options are left out of the layout. Prices that Staff need for billing appear as read-only price rows.
- **Discount and coupon editor** (S34, S45): the type comes first (percentage with an optional cap, or flat amount with a required minimum order). The maximum effective percentage is shown next to the value and checked when saving. A coupon or discount paused by a lowered maximum shows a "Paused" tag and the reason.
- **Design-only marker:** a dashed outline in the exports means "wording to confirm". It is not a component. Never build it. All six marked lists were settled on 14 Oct 2026, and the Specs UI holds their final wording.

## 6. Order status treatments (`ORD-1`)

Seventeen statuses, eight final. A treatment says **who has to act**, not what went wrong. The same five treatments serve both apps. The mapping differs because the person who must act differs.

| Treatment | Meaning | Look |
|---|---|---|
| Needs you | This person must act now | Saffron fill, dark text, bell icon |
| Waiting | Someone else must act | `info-subtle`, clock icon |
| In progress | Moving normally toward handover | `primary-subtle`, arrow-circle icon |
| Completed | Handed over and paid. Final | `success-subtle`, check-circle icon |
| Ended | Final without a sale. Outlined, never red: nobody is charged | Transparent, strong outline, x-circle icon |

| Status | Customer sees | Treatment | Shopkeeper sees | Treatment | Final |
|---|---|---|---|---|---|
| `PLACED` | Waiting for shop | Waiting | New order | Needs you | |
| `SCHEDULED_PENDING_REVIEW` | Booked for slot | In progress | Review by cutoff | Needs you | |
| `AWAITING_CUSTOMER_CONFIRM` | Confirm new total | Needs you | Waiting for customer | Waiting | |
| `ACCEPTED` | Accepted | In progress | Accepted | In progress | |
| `SCHEDULED_CONFIRMED` | Booked for slot | In progress | Scheduled | In progress | |
| `PREPARING` | Being packed | In progress | Packing | In progress | |
| `READY` | Ready | In progress | Ready | In progress | |
| `OUT_FOR_DELIVERY` | On the way | In progress | Out for delivery | In progress | |
| `ARRIVED` | At your door | Needs you | At customer | In progress | |
| `DELIVERED` | Delivered | Completed | Delivered | Completed | Yes |
| `PICKED_UP` | Collected | Completed | Picked up | Completed | Yes |
| `REJECTED_BY_SHOP` | Shop could not take it | Ended | Rejected | Ended | Yes |
| `EXPIRED` | Shop did not answer | Ended | Expired, no answer | Ended | Yes |
| `NOT_COLLECTED` | Not collected | Ended | Not collected | Ended | Yes |
| `CANCELLED_BY_CUSTOMER` | Cancelled | Ended | Cancelled by customer | Ended | Yes |
| `CANCELLED_BY_SHOP` | Cancelled by shop | Ended | Cancelled | Ended | Yes |
| `DELIVERY_FAILED` | Delivery failed | Ended | Delivery failed | Ended | Yes |

The customer-facing and shopkeeper-facing wording above is the designer's. It is display text and lives outside the code (`Q-2`).

## 7. Components, Admin web

Same tokens as mobile, separate components (ADR-0007, ADR-0009: no UI shared with mobile, no `react-native-web`). Desktop density: 40 high controls, 14 body.

- **Buttons:** 40 high, radius 8. Primary, secondary, destructive, text. States as on mobile.
- **Inputs:** 40 high, radius 8. Money fields show the ₹ prefix. A required value that is a typed 0 counts as set (`MNY-13`).
- **Reason field:** required and stored with the action. "Say why. The shop or customer may be shown this." Every Admin action that changes something asks for a reason.
- **Table:** header on `sunken`, 14 / 20, scrolls horizontally rather than wrapping below 720 wide. Queue rows show **age** ("2 d 4 h", "19 d · 4 left").
- **Tile:** large figure (28 / 36, tabular), label, a one-line detail. Dashboard is tiles only (`ADM-8`).
- **Source chip:** shows where a rate-card value came from: Global, Category, This shop (`MNY-3`).
- **Scope notice:** the Area Manager sees "Area Manager · Kothrud only" and a plain note of what is unavailable (`ADM-12`).
- **Navigation:** left side nav, Queues carries a count badge. **Modal:** 520 wide, on a scrim.

### 7.1 Patterns the Admin screens added

- **Waitlist** (A32, #218): title and a short expansion note above a read-only surface table. Columns: Callback phone, Pincode, Account, Last captured. Account shows name above email, or email alone when unnamed. Use the existing phone and Asia/Kolkata date/time formatters. Newest captures come first; equal times sort by pincode, then account id. Keep the Admin table's sunken header and horizontal scroll. Empty says "No waitlist captures yet."; loading says "Loading waitlist…"; failures use the shared alert and "Try again". No row actions or Area Manager entry.
- **Filter chips with counts** (A02): "All 13", "Complaints 2", "Flagged bills 2" and so on. The counts add up to the All count.
- **Queue item page** (A26 to A31): every queue item page has the same parts, in this order:
  1. a header with the item, its status pills and its age in the queue ("in the queue 3 d")
  2. Call shop and Call customer buttons where they apply
  3. the facts
  4. "What happened": a timeline of who did what and when, with each person's name and role
  5. a line saying nothing happens automatically
  6. a Decision section with the outcome options and the required reason field
  7. a confirm modal that says who will see the reason

  A recorded outcome replaces the Decision section with what was decided, by whom and when.
- **Area Manager shell** (A04, every "Area Manager" state): the nav says "YGo Area Manager", and read-only areas carry the label "view only". A scope banner says "You are working in Kothrud only" and lists what belongs to Admin. Wherever a decision is Admin's, the Decision section says "Admin decides this item. You can see it but not act on it." There are no disabled buttons.
- **Go-Live blocker notice** (A03): "Cannot go Live yet" names each empty rate-card value and links to Set. A typed 0 counts as set (`MNY-13`).
- **Draft-versus-now table** (A05, A16): two columns of figures, "Now" and "Draft", each with a source chip. A draft is tried out and never saved.
- **Three-step import** (A12): "1. Choose file › 2. Check › 3. Import". The check step shows a table of problem rows (row number and the problem in plain words) and a "Download rows with problems" button. A file with any problem row imports nothing.
- **Forced transition modal** (A15): shows the current status and lists only the moves that status allows, and the reason is required. A final order offers no move.
- **Linked action that does not act** (A27 "Open suspension form"): it opens the other screen with the fields filled in. Nothing changes until the person confirms on that screen.

## 8. How developers use this

1. Token names above become the keys in `@ygo/tokens`: one semantic name, a light value and a dark value. NativeWind (mobile) and Tailwind (Admin web) read the same file.
2. A screen uses `bg-surface`, `text-muted` and the like. It never uses a hex, a pixel size for text, or a raw spacing number.
3. Theme is a single switch that swaps the dark values in. The bill, QR and PDF opt out and stay light.
4. A new component is added here first, with all its states, then built.
5. The exported HTML (kept locally, not in git) is the visual reference only. Do not copy its markup into the apps.

## 9. Open items and things to check

Not decided, or the design disagrees with itself. None changes the PRD.

| # | Item | Why it matters | Who |
|---|---|---|---|
| 1 | ~~12 px is used for tab labels, tags and badges.~~ **Closed 14 Oct 2026.** The owner chose a new Small label style, 13 / 18 at weight 500, for tab labels, tags and badges. 12 stays for captions only | Readability on small screens, the owner's main concern | Done. Build from the type table, not from the exports |
| 2 | **48 hit area** is stated for chips (40 visual), checkbox and radio (24 visual), but the export only draws the visual size | Must be built as padding or hit-slop, and tested with a thumb | Developer, at build |
| 3 | **Rupee glyph in the bundled font.** The export loads Inter from Google Fonts, whose `latin` subset leaves out ₹ (U+20B9). The `latin-ext` subset includes it | A subset that drops it shows a fallback glyph on money. The app must bundle Inter with U+20B9, not use a CDN | Developer, then verify on a low-end Android |
| 4 | **Tabular figures** (`tnum`) must be switched on in the bundled font and in the PDF font | Money columns and countdowns | Developer, then verify |
| 5 | ~~Lucide is not in an ADR.~~ **Closed 14 Oct 2026.** Recorded in the ADR-0001 decision table, with `lucide-react-native` on mobile and `lucide-react` on the web | ADR-0001 now covers icons | Done |
| 6 | ~~Dark `brand` is `#A9BBF5`, not the approved indigo.~~ **Closed 14 Oct 2026.** The owner confirmed `#A9BBF5` for dark theme, since indigo is 1.71:1 on the dark background. Light theme keeps `#1E3A8A`. Revisit with the palette when #27 closes | A deliberate palette adjustment | Done |
| 7 | **Disabled text is 2.90:1 light and 3.48:1 dark.** Below 4.5 by design | Acceptable only on disabled controls, never for information | Rule 5 covers it |
| 8 | **QR is a placeholder**, and the Hindi line (प्याज़) is a space check only | Real QR comes from the shop's UPI id. Hindi is a later translation | None now |
| 9 | **Brand name** is plain text "YGo" until #27 closes | No logo, wordmark or app icon | Blocked on #27 |
| 10 | ~~Coverage is incomplete.~~ **Closed 14 Oct 2026.** Every journey in section 6 of the brief is drawn: Customer 24 screens, 84 states; Shopkeeper 45 screens, 174 states; Admin 31 screens, each in all its states | Listed in the [Specs UI](../product/specs-ui-phase1.md) | Done |
| 11 | **Inter review moved to build, 14 Oct 2026.** Build with Inter from the start. The section 10 checks are acceptance criteria on the tickets that first produce real output: phone in [#30](https://github.com/Hemanshujc1/YGo/issues/30), Admin web in [#37](https://github.com/Hemanshujc1/YGo/issues/37), PDF bill in [#53](https://github.com/Hemanshujc1/YGo/issues/53). If Inter fails a check, the fallback is Noto Sans, by changing one token | Owner's condition for approving Inter | Developer, at build |

## 10. Review checklist for Inter

Tick these on real output before marking Inter as final. They are acceptance criteria on #30 (phone), #37 (Admin web) and #53 (PDF bill). If Inter fails one, switch the font token to Noto Sans.

- [ ] ₹ renders in Inter on a low-end Android phone, an iPhone and the PDF bill
- [ ] Tabular figures line up in a price column and a countdown
- [ ] 14 px secondary text, 13 px Small labels and 12 px captions are readable on a small, low-density screen
- [ ] Five tab labels at 13 px fit a 360-wide screen without being cut off, including "Deliveries"
- [ ] Line heights hold Noto Sans Devanagari without clipping
- [ ] The three weights (400, 500, 600) are the only ones bundled, and the app size is acceptable on the 2 GB Android 10 floor

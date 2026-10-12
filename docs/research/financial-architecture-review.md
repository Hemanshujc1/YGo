# Review: `References/yugo_financial_architecture.pdf`

A 28-page "Financial & Business-Rule Architecture" document, written for the founder by an
acquaintance as a companion to an earlier **28-section master PRD under the retired brand** —
a larger document than `docs/product/prd-phase1-reference.md`, though it covers the same product
idea. Dated v1.0, tax position stated as verified 15 August 2026.

**Status: reference input only, ranking below `docs/product/prd-phase1-reference.md` for product
decisions and above it for statutory facts.** It is marked confidential by its author, it is
third-party work, and `References/` is gitignored and read-only, so **neither the file nor its text
is ever copied into this repository**. This note records only what was learned from it, and the
statutory citations below are public law, not its content.

## Why it is worth keeping

It is the only input so far that treats Indian tax law as a design constraint rather than a
later-phase worry, and it gets two things right that circulating template specs get wrong.

- **TCS under section 52 CGST Act is 0.5%**, not the 1% that older specs quote, cut by CBIC
  Notification 15/2024-Central Tax with effect from 10 July 2024.
- **TDS under section 194O Income Tax Act is 0.1%**, not 1%, reduced by the Finance (No. 2) Act
  2024 with effect from 1 October 2024.
- It notes that the **Income-tax Act 2025 came into force on 1 April 2026** and recodified the
  citations: 194O is now section 393(1), payment code 1035, and 194C is section 393(1) Table
  Sl. No. 6(i), with rates and thresholds unchanged. Practitioners still use the legacy numbers.
- The **GST 2.0 reform of 22 September 2025** collapsed the old five rates into mainly 5% and 18%
  plus a 40% slab, with an expanded nil list. For a kirana catalog the practical shape is: loose
  fresh produce and unbranded staples nil, packaged food and dairy 5%, hardware and electronics
  18%, and the platform's own services always 18% regardless of what is in the basket.
- On money arithmetic it says what this project already decided independently: integer paisa
  internally, `DECIMAL`, never `FLOAT` or `DOUBLE`, rounding only at display and final capture.
  This corroborates the FLOAT-money pitfall recorded against VaayuGO in `reference-projects.md`.

## The finding that changes a decision

**Section 194O has a deeming provision that covers customer-to-shop direct payment.** Where the
purchaser pays the participant directly for a sale the operator facilitated, the operator is deemed
to be the person responsible for paying, and the obligation to deduct 0.1% of the gross amount of
sales still attaches. The obligation is on facilitated sales value, not on commission.

This matters because YGo's settled model is that the shop collects every rupee and the platform
only invoices what it earned. That model does keep the platform out of section 52 TCS, which is
read as arising only where the operator collects the consideration. It does **not** keep the
platform out of 194O.

The relief is the threshold, not the payment route: **no deduction for an individual or HUF
participant whose gross sales through the platform stay under Rs 5 lakh in the financial year,
provided PAN or Aadhaar has been furnished.** Without PAN the rate is 5% instead of 0.1%. A firm,
LLP or company participant has no threshold at all.

Consequences for Phase 1: PAN capture at shop onboarding is a statutory gate, not a nice-to-have;
a proprietor shop in a short pilot is comfortably inside the exemption; a shop that is a registered
firm or company is not, and needs a flag.

## What does not transfer

The document assumes a platform shaped differently from the one being built here. Where it
conflicts with a closed decision, the closed decision wins.

- **The platform collects the money** through a nodal or escrow account, then settles to the shop
  on T+1 with riders paid weekly. YGo settled the opposite: the shop collects and the shop owes,
  and "payout" is notional.
- **A platform-managed rider network** with per-trip earnings, surge multipliers, wait-time pay,
  floating-cash caps and instant cashout. Out of scope in Phase 1; also the source of its
  section 194C analysis, which does not apply while the platform never pays a deliverer.
- **Restaurants and prepared food** under section 9(5) CGST Act, where the operator is the deemed
  supplier and pays 5% GST itself. This is the document's single biggest theme and it is entirely
  out of scope: `CONTEXT.md` excludes restaurants and pharmacy.
- **Customer wallets, coupons funded by the platform, loyalty, tipping, small-order fees,
  free-delivery thresholds and surge pricing.** Phase 1 has none of these, and its own pricing
  engine is authoritative in `docs/product/revenue-system-spec.md`.
- **A MySQL schema and DDL** of around 1,800 lines. The stack is unchosen, and PostgreSQL with
  PostGIS is the leading candidate, so this is a shape to read, never code to lift.
- Its commission rate card, parameter defaults and fee suggestions are its author's
  recommendations against the retired PRD, not decisions here, and the Phase 1 numbers are already
  settled elsewhere.

## Caution

Same rule as every other reference: treat it as inspiration, verify before reuse, never copy
blindly. Its own closing note is the right instruction — a tax position is a baseline as of its
date, not a permanent reference, and every statutory number here needs a chartered accountant's
sign-off before go-live and after each GST Council or Finance Act change.

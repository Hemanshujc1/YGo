# Hyperlocal Revenue System — Configurable Specification

## Purpose

Build a pricing and settlement engine for a marketplace where customers order from nearby shops and, in the initial operating model, shops fulfil deliveries with their own staff. The administrator controls all monetary amounts, percentages, thresholds, caps, eligibility rules, and splits. The examples below use symbols deliberately; they are **not preset prices or rates**.

The engine must produce, for each cart, a clear customer total, shop payout, platform contribution, and reason for any ineligible promotion or unavailable delivery option.

## Commercial principles

- The shop should see its expected payout and understand every deduction before accepting the arrangement.
- The shop receives the configured share of a delivery fee because it performs delivery. Its share need not equal its actual delivery cost; monitor both.
- The platform's minimum contribution is calculated **after** platform-funded promotions and estimated variable costs. It is an order eligibility rule, not a reason to add an unlimited surprise charge.
- Customer-facing fees must be disclosed before checkout and remain within configured caps.
- A promotion is funded by either the platform, the shop, or explicitly split between them. Funding and settlement must never be inferred from its display label.
- An order may fail the contribution floor. The engine should offer a configured alternative or explain why checkout is unavailable.
- Each fulfilment route earns differently and is governed by its own contribution rule. A delivered order earns product commission and configured fee shares. A self-pickup order earns no product commission; its only platform revenue is a configured booking fee. A walk-in counter bill earns no product commission either, and the platform must never create an incentive for a shop to omit counter sales, because those sales are what keep inventory accurate.

## Admin controls

Every control below can be enabled, disabled, scheduled, changed, and scoped. No rate or amount is hardcoded in the pricing engine.

| Control | Configurable choices |
| --- | --- |
| Product commission | Fixed amount, percentage, fixed plus percentage, higher of fixed and percentage, lower of fixed and percentage; optional minimum and maximum; category or product exclusions; commission base before or after eligible shop-funded discounts. Applies to delivered orders only |
| Pickup booking fee | Disclosed customer booking fee and an optional fixed shop booking fee, both charged only on a completed pickup; enabled or disabled, with amounts, caps and scope. Ships disabled |
| Counter-bill charge | Optional fixed per-bill charge to the shop on a walk-in counter bill. Ships disabled and stays disabled during the pilot. A flat subscription for the billing tool is the preferred later alternative |
| Platform contribution floor | Amount required after platform-funded discounts and variable costs; a separate floor per fulfilment route, since pickup earns no product commission |
| Delivery fee | Flat amount, distance bands, area bands, basket rules, waived-fee conditions, minimum and maximum; platform and shop shares as amounts or percentages |
| Small-cart fee | Qualifying basket threshold, fee formula, cap, eligible products, platform and shop shares |
| Other customer fees | Named fee, trigger, formula, cap, recipient split, tax handling, display text; avoid overlapping fees for the same purpose |
| Minimum cart | Minimum eligible product value for checkout or delivery, with exclusions and alternatives |
| Promotions | Issuer, funding source and split, eligibility, expiry, usage limit, stacking order, discount formula and cap, applicable lines and fees |
| Shop-wide discount | Owner-configured and shop-funded, in one of two forms only: a percentage with an optional maximum amount, or a flat amount with a required minimum order value. Bounded by the maximum effective shop-funded discount percentage below. See the dedicated section |
| Operating costs | Estimated payment, support, refund allowance, and other variable costs by applicable payment and fulfilment route |
| Shop terms | Commission overrides, delivery responsibility, payout schedule, campaign participation, negotiated caps |
| Guardrails | Maximum customer charges, minimum shop payout or merchant margin where agreed, exception handling, subsidy budget, and the **maximum effective shop-funded discount percentage** — global default 20 per cent, with per-shop overrides |

The administrator should be able to preview and publish a rule, see its effective scope, schedule its start and end, and inspect its change history. A published rule applies to new quotes; existing placed orders retain their pricing snapshot.

## Scope and precedence

Support global, area, category, area-and-category, and individual-shop settings. Shop settings may override any specific field while inheriting the remaining fields from broader settings. Display the effective value and source for every field.

Recommended precedence for each field: **shop override → area-and-category override → category override → area override → global default**. Make the precedence itself explicit in admin documentation and resolve conflicts deterministically.

For a mixed-category cart, calculate category commission per eligible line item. Define an explicit order-level floor policy in admin configuration, such as the highest applicable floor or a shop-specific floor. Never silently add all category floors together. Initially, treat each shop's basket as a separate order and quote; multi-shop checkout can combine their displayed totals while preserving separate settlements.

## Order ledger and formulas

Use named amounts rather than one undifferentiated “platform profit” number:

```text
Eligible product value = eligible product prices - applicable shop-funded product discounts

Product commission = configured commission formula applied to its configured base

Customer total = product subtotal
               - customer-visible promotions
               + customer-facing delivery, booking and other fees
               + applicable taxes

Platform contribution = product commission (delivered orders only)
                      + platform shares of delivery and other fees
                      + customer and shop booking fees (pickup orders only)
                      - platform-funded promotion amount
                      - platform-borne variable costs
                      - applicable platform subsidies or allowances

Shop payout = shop product proceeds after shop-funded discounts
            - product commission (delivered orders only)
            + shop shares of delivery and other fees
            - shop booking fee, where configured (pickup orders only)
            - any other explicitly contracted shop-borne amounts
            +/- separately itemized adjustments and taxes
```

"Shop payout" names the amount the shop **retains** from money it has already collected, not a transfer from the platform. The shop collects every rupee the customer pays, in cash or by UPI direct to its own account, and the periodic statement shows what it therefore owes the platform. An exceptional period in which the platform owes the shop is settled by an explicitly authorised manual adjustment and an offline transfer; the promotion budget rule below makes that rare but must not be assumed to make it impossible.

The platform's *gross receipts*, *contribution*, and *accounting profit* are different measures. The floor above governs contribution. Do not count taxes collected for remittance or the shop's share of a fee as platform earnings. Configure who bears refunds, cancellations, payment charges, and promotional costs; post later adjustments to the ledger rather than rewriting the original order snapshot.

## Shop-funded discount forms and the effective-discount cap

The shop-wide discount is an Owner-configured, shop-funded reduction on eligible product value. It takes **two forms**, and no other.

**Percentage with an optional maximum amount.** `d = min(round_half_up(pct × base), max_amount)`, where `max_amount` is optional. "10% off up to ₹20" is this form. The maximum amount only ever reduces the discount, never raises it.

**Flat amount with a required minimum order value.** `d = flat` when `base >= min_order_value`, and the rule is simply not applicable otherwise. "₹200 off on orders of ₹1,000 or more" is this form. The minimum order value is **required** on this form, not optional, because a flat amount without one has no bounded effective percentage.

In both, `base` is the **pre-discount eligible product value**: line totals for eligible lines, each already rounded half-up to two decimals, excluding negotiated lines and any excluded category or product. The base **never** includes delivery, booking, small-cart or other fees, and never includes taxes. A flat rule's minimum order value is tested against that same pre-discount base, so fees can never qualify a basket for a discount. The configured minimum cart is likewise tested pre-discount, so a discount can never push an order below the minimum that let it check out. The minimum cart is the one test that **counts negotiated lines**, at their accepted price: they are left out of every discount and coupon base, never out of the basket that has to reach the minimum.

**At most one shop-wide discount applies to an order.** Where several are eligible, the one producing the largest customer benefit wins, with a deterministic tie-break. Two percentage rules must never compound.

### The effective-discount cap

`effective discount percentage = d / base`. A configurable **maximum effective shop-funded discount percentage** bounds it, with a **20 per cent default**, a global scope and per-shop overrides, resolved by the ordinary precedence above.

This is the one number in this document stated as a default rather than a symbol, and it does not breach the rule above: a guardrail default bounds what an Owner may configure and earns nobody anything, where a rate would. The rupee figures in this section are illustrations of each form, not configured amounts.

The cap is enforced at **configuration time**, on each form's worst case, so an invalid rule cannot be published:

- Percentage form: the worst case is `pct` itself. Require `pct <= cap`.
- Flat form: the worst case is at exactly the minimum order value. Require `flat / min_order_value <= cap`, equivalently `min_order_value >= flat / cap`. At a 20 per cent cap, a ₹200 flat discount needs a minimum order value of at least ₹1,000 — which is why that example is well formed.

At **order time** the engine asserts `d <= cap × base`. Given the validation above this is unreachable, which is the point: it is a money invariant and a breach is a defect, so the quote fails loudly rather than silently clamping to the cap. Silent clamping would quote a customer a different number from the one the shop advertised.

**At most one promotion applies to an order: the shop-wide discount or one coupon, never both** (owner decision D-7, 13 Oct 2026, widened the same day from shop-funded coupons to coupons of every funding). Where a coupon and the shop-wide discount both qualify, the engine computes each alone and applies the one that takes the larger amount off that order, the shop-wide discount on a tie. The other contributes nothing, and a coupon that was not applied is not counted as used. The two never combine, so their percentages never compound. Platform-funded coupons are inside this rule: one never applies on top of a shop-wide discount. Its amount for the comparison is what it would actually give after the contribution-surplus bound below, and a coupon that is ineligible leaves the shop-wide discount to apply.

A split-funded coupon is compared with the shop-wide discount on its whole amount, both shares together, like any other coupon (owner decision D-13). **The cap binds every shop-funded offer** (owner decision D-12): a shop-funded coupon, and the shop-funded share of a split-funded one, are validated against it when saved, on the worst case of their form, and are paused with the Owner told when the cap is lowered. So `d` is the shop-funded amount of whichever single promotion applied, which is zero for a platform-funded coupon, and the assertion stays unreachable.

**Lowering the cap does not retro-clamp.** When an admin lowers it, existing rules are re-validated and those that now breach it are **paused and their Owner notified**, naming the rule. A paused rule stops being offered; it is never quietly reduced.

### Separation of funding sources

Shop-funded and platform-funded discounts are **separate amounts at every stage** — in the quote, in the ledger, and in the immutable placement snapshot — each carrying the rule id and rule version that produced it. There is no single `discount` field anywhere.

This is load-bearing rather than tidy. The commission base is eligible product value **after** shop-funded discounts and **before** platform-funded promotion value. Merging the two would shrink the base by the platform's own promotional spend, and the platform would under-bill itself on every promoted order.

Because commission is computed per line, an order-level shop-funded discount is **apportioned across eligible lines pro rata by line total**, in paise, with the rounding remainder assigned to the largest eligible line and a deterministic tie-break. The apportioned parts must sum exactly to the order-level amount; a discount that does not reconcile to its parts is the defect that makes a settlement unarguable only until someone checks it.

### What this protects, and what it does not

Stated plainly because the distinction is easy to lose: **this is platform-loss prevention, not shop-profit protection.**

What is protected: the platform's contribution, by the floor; the platform's promotional spend, bounded by the contribution surplus above that floor; and the commission base, by the separation above. The effective-discount cap protects against a **misconfiguration** — a 90 entered where 9 was meant — and against a discount quietly collapsing the commission base.

What is **not** protected, and must not be claimed anywhere in the product, the admin surface or the documentation: that a shop is selling profitably. The platform holds **no cost-of-goods data and no selling-price floor**. MRP is captured, but MRP is a ceiling set by a manufacturer, not a cost. Nothing in the engine can therefore distinguish a shop discounting its margin from a shop selling below what it paid, and the engine must not imply otherwise. A shop's own margin is the Owner's responsibility.

Real shop-profit protection would require a per-pack cost price, a selling-price floor derived from it, and shops willing to disclose purchase prices — commercially sensitive information a kirana shop has good reason to withhold. That is why it is out of Phase 1: not effort, but a data dependency that may never be obtainable. If it is ever added, the floor becomes a hard checkout gate and this section is superseded.

## Fulfilment-route revenue treatment

Three routes, three different revenue shapes. The engine must not apply one route's rule to another.

**Delivered order.** Product commission on its configured base, plus the platform's configured shares of the delivery fee, the small-cart fee and any other customer fee. Governed by the delivered-order contribution floor.

**Self-pickup order.** No product commission on product value. Platform revenue is a disclosed customer booking fee and, optionally, a fixed shop booking fee, both charged only once the pickup is completed; an order the customer never collects attracts neither. There is no delivery fee to charge or split. Pickup has its own contribution rule, which must be configured independently of the delivered-order floor, because pickup contribution consists only of booking fees and would otherwise fail a floor calibrated against commission plus delivery shares. Pickup must never be blocked for failing a floor that was built for delivery, since pickup is itself one of the configured remedies when a delivered order is not viable.

**Walk-in counter bill.** No product commission. A fixed per-bill charge to the shop is configurable but ships disabled and remains disabled throughout the pilot: a per-bill charge gives the shop a direct incentive to omit counter sales, and because counter bills originate in the shop's own app and sync from an offline queue, omission is both easy and invisible. The data is worth more than the fee. A flat subscription for the billing and inventory tool is the preferred way to charge for it later, since it does not scale with reported bills. Counter bills are always recorded for inventory and for the shop's own reports, whether or not any charge applies.

An accepted negotiated price is honoured. Where a negotiated order would breach the ordinary contribution floor, a configurable minimum commission governs it instead, so a customer whose offer was accepted is never refused at checkout. The minimum cart still applies to such an order, counting the negotiated line at its accepted price. **An order containing a negotiated line takes no coupon**, whether platform-funded, shop-funded or split (owner decision D-6, 13 Oct 2026). This tightens the earlier line-level rule, under which only the negotiated line was excluded from a coupon's base. The shop-wide discount is unchanged: its base still leaves out the negotiated line and it still applies to the order's other lines.

## Real-time quote and checkout flow

- On each change to cart contents, shop, address, fulfilment mode, payment method, or promotion, load the effective versioned rules and produce a fresh quote.
- Validate minimum cart and delivery availability. Calculate line-level shop discounts, eligible commission bases, commission, and disclosed fees and splits.
- Estimate platform-borne variable costs for the selected route. Compute contribution before any proposed platform-funded promotion.
- Calculate available platform promotion budget as `max(zero, contribution before promotion minus required floor)`. Also apply the promotion's own configured limits and remaining campaign budget.
- For a fixed-value promise that exceeds the available budget, mark that promotion ineligible. For a promotion explicitly advertised as “up to” an amount, the rules may reduce the discount to the available budget, with the actual amount shown before payment.
- Recompute the complete ledger after all shop-funded and platform-funded promotions, including any change to a percentage commission base. Validate the floor and shop guardrails.
- Return the total, fee breakdown, shop payout, platform contribution, and precise eligibility reasons. Requote authoritatively on the server at order placement. Save a snapshot of inputs, rule versions, allocation, and final amounts.

**After a partial acceptance** the order is requoted from the rule versions in its original snapshot. Fees stand as quoted and none is added or raised, and the order is not rejected for falling under the minimum cart; the customer sees the new total and decides. 

**A requote below the floor** (owner decision D-5, 13 Oct 2026). If the reduced order falls below its contribution floor, or below the minimum commission where it has a negotiated line, it proceeds as a recorded exception **provided contribution is not negative**. On a requote the platform promotion budget is `max(zero, contribution before promotion)` in place of the surplus above the floor, so **platform-funded promotion value never exceeds what the platform earns on the order**: a fixed-value promotion that no longer fits is removed, an "up to" promotion is reduced, and the customer sees either in the changed total with the reason. If contribution is negative even with no platform-funded promotion, the order does not proceed and is cancelled at no cost to the customer. The exception is written to the order with the shortfall and the reason and is listed for Admin. This is a standing authorisation and needs no approval per order; it is distinct from the deliberate, Admin-approved subsidy under "When the contribution floor fails", which is unchanged and which nothing in Phase 1 uses.

Quote previews are informative; the final server calculation is authoritative. In Phase 1 every preview is itself produced by that server calculation: no client computes a quote. The single exception to server-side money is a counter bill's total, which is worked out on the phone because the sale happens offline, and which the server checks on sync and flags rather than rewrites. If a rule changes between preview and checkout, show the new total and require the customer to accept it.

## Illustrative scenarios without preset amounts

**Commission formula choice.** Let `F` be a configured fixed commission, `R` a configured percentage, and `P` an eligible product value. Admin can choose `F`, `R × P`, `F + R × P`, `max(F, R × P)`, or `min(F, R × P)`, then apply any configured cap. A shop with thin margins may need a lower percentage or cap than another category. The formula and cap shown to that shop must match its settlement.

**Shop-delivered order.** A customer pays for products plus a disclosed delivery fee. The engine awards the shop its configured delivery share and the platform its share. Commission is deducted from the shop's eligible product proceeds. The quote displays the shop payout and the platform contribution after costs.

**Small cart.** A cart falls below the configured small-cart threshold. The disclosed small-cart fee applies and is allocated according to its rule. If the fee and allowed customer charges still cannot meet the contribution floor, the customer sees an actionable alternative, such as adding eligible products or selecting pickup where available.

**Platform-funded coupon.** Before the coupon, the order has a contribution surplus above the configured floor. The coupon can consume at most that surplus and any tighter campaign limit. A coupon promising more than the available amount is ineligible unless its advertised terms permit a variable “up to” discount.

**Shop-funded coupon.** A shop offers a discount on eligible products. The shop's product proceeds decrease. If commission is configured on the discounted value, percentage commission also changes. Requote the shop payout and contribution; a shop promotion is not automatically charged to the platform.

**Shared promotion.** A campaign specifies a platform funding share and a shop funding share. Record both separately and check the platform floor against only the platform-funded portion, while also enforcing any shop payout guardrail.

**Self-pickup order.** A customer collects from the shop. No product commission arises. The disclosed customer booking fee, where enabled, appears as a named line on the bill and is not a delivery charge; a shop booking fee, where enabled, reduces what the shop retains. Both apply only on completion. The quote is validated against the pickup contribution rule, never the delivered-order floor.

**Walk-in counter bill.** A shop bills a customer at the counter. Product value, discounts and stock movement are recorded; no commission and, during the pilot, no charge of any kind is computed. The bill never enters platform contribution while per-bill charges are disabled.

**Mixed-category order.** Each item uses its category's effective commission rule, including applicable shop overrides. The order-level floor follows the configured mixed-cart policy. A single delivery fee is allocated once for that shop order.

## When the contribution floor fails

Evaluate only explicitly configured actions, in a published priority order: apply an eligible disclosed fee within its cap; remove or reject an unaffordable platform promotion; offer a larger basket, pickup, or another fulfilment choice; or make that delivered order unavailable. Admin may fund a deliberate, budgeted exception for acquisition or retention. Record who approved the subsidy and how much it costs. Do not conceal a shortfall by assigning shop delivery revenue to the platform or by increasing a customer's fee without disclosure.

## Keeping shops engaged

The commission level alone cannot prevent direct orders. Give merchants a reason to continue using the platform: incremental nearby customers, reliable discovery, comparison visibility, repeat orders, straightforward payouts, and useful inventory, billing, staff, and order tools. Provide a dashboard showing product value, fee shares, discounts by funder, commission, delivery earnings, and final payout per order. Let shops opt into funded campaigns with a payout preview. Offer negotiated volume terms or loyalty benefits only when the resulting economics work for both parties. Track merchant retention, cancellations, contribution, delivery cost, and repeat purchases; adjust terms using observed data rather than forcing a single rate on every category.

## Admin simulator and acceptance criteria

Build a simulator where admin selects a shop, area, cart, delivery route, payment method, and promotion. It should show the effective rule sources, customer line items, shop payout, platform gross receipts, platform costs, final contribution, and failed guardrails. Admin can compare a draft rule with the active rule before publishing.

The implementation is complete when identical inputs and rule versions always yield the same quote; all fee and promotion allocations reconcile with customer payment and settlements; mixed carts and stacking rules are deterministic; ineligible offers have specific reasons; all displayed charges are capped and confirmed at checkout; and placed orders preserve an auditable calculation snapshot.

## Decisions to validate during a pilot

No rate, fee, floor, delivery share, credit limit or booking fee is hardcoded or assumed anywhere. An administrator must configure the required values before a shop can receive orders; a shop with incomplete pricing configuration is withheld from the customer feed and cannot accept orders, while its counter billing, inventory and catalog tools remain fully usable. Any credit-limit auto-pause stays off until its limit has been set. Any approved exception below a contribution floor must be explicitly authorised and recorded with a reason.

**The first rate card precedes the first live order.** "After testing representative baskets" means baskets run through the simulator, built from the pilot shops' own price lists; it cannot mean live baskets, because a shop with no configuration receives no orders. The values a shop cannot go Live without are the commission rule, the delivery fee and its shares, the delivered-order contribution floor, the minimum cart and the statement grace period, plus the pickup contribution rule and the negotiated-order minimum commission where the shop uses those features. An empty value is not configured; a deliberately entered zero is. The rate card is then revised from real orders. A revision to a Live shop's rate card takes effect from the start of the next statement week, after the shop has been told in the app and in person, and never applies to an order already placed (owner decision D-3, 13 Oct 2026).

Set actual rates, thresholds, caps, floor amounts, delivery shares, merchant margin guardrails, cost assumptions, promotion budgets, booking fees, and any later billing-tool subscription only after testing representative baskets with shops across categories and areas. Compare shop earnings *after its own delivery cost* with the platform's contribution *after its variable costs*. Tax and settlement treatment should be reviewed for the chosen legal and payment setup before launch.

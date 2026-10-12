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
| Operating costs | Estimated payment, support, refund allowance, and other variable costs by applicable payment and fulfilment route |
| Shop terms | Commission overrides, delivery responsibility, payout schedule, campaign participation, negotiated caps |
| Guardrails | Maximum customer charges, minimum shop payout or merchant margin where agreed, exception handling, subsidy budget |

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

## Fulfilment-route revenue treatment

Three routes, three different revenue shapes. The engine must not apply one route's rule to another.

**Delivered order.** Product commission on its configured base, plus the platform's configured shares of the delivery fee, the small-cart fee and any other customer fee. Governed by the delivered-order contribution floor.

**Self-pickup order.** No product commission on product value. Platform revenue is a disclosed customer booking fee and, optionally, a fixed shop booking fee, both charged only once the pickup is completed; an order the customer never collects attracts neither. There is no delivery fee to charge or split. Pickup has its own contribution rule, which must be configured independently of the delivered-order floor, because pickup contribution consists only of booking fees and would otherwise fail a floor calibrated against commission plus delivery shares. Pickup must never be blocked for failing a floor that was built for delivery, since pickup is itself one of the configured remedies when a delivered order is not viable.

**Walk-in counter bill.** No product commission. A fixed per-bill charge to the shop is configurable but ships disabled and remains disabled throughout the pilot: a per-bill charge gives the shop a direct incentive to omit counter sales, and because counter bills originate in the shop's own app and sync from an offline queue, omission is both easy and invisible. The data is worth more than the fee. A flat subscription for the billing and inventory tool is the preferred way to charge for it later, since it does not scale with reported bills. Counter bills are always recorded for inventory and for the shop's own reports, whether or not any charge applies.

An accepted negotiated price is honoured. Where a negotiated order would breach the ordinary contribution floor, a configurable minimum commission governs it instead, so a customer whose offer was accepted is never refused at checkout.

## Real-time quote and checkout flow

- On each change to cart contents, shop, address, fulfilment mode, payment method, or promotion, load the effective versioned rules and produce a fresh quote.
- Validate minimum cart and delivery availability. Calculate line-level shop discounts, eligible commission bases, commission, and disclosed fees and splits.
- Estimate platform-borne variable costs for the selected route. Compute contribution before any proposed platform-funded promotion.
- Calculate available platform promotion budget as `max(zero, contribution before promotion minus required floor)`. Also apply the promotion's own configured limits and remaining campaign budget.
- For a fixed-value promise that exceeds the available budget, mark that promotion ineligible. For a promotion explicitly advertised as “up to” an amount, the rules may reduce the discount to the available budget, with the actual amount shown before payment.
- Recompute the complete ledger after all shop-funded and platform-funded promotions, including any change to a percentage commission base. Validate the floor and shop guardrails.
- Return the total, fee breakdown, shop payout, platform contribution, and precise eligibility reasons. Requote authoritatively on the server at order placement. Save a snapshot of inputs, rule versions, allocation, and final amounts.

Quote previews are informative; the final server calculation is authoritative. If a rule changes between preview and checkout, show the new total and require the customer to accept it.

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

Set actual rates, thresholds, caps, floor amounts, delivery shares, merchant margin guardrails, cost assumptions, promotion budgets, booking fees, and any later billing-tool subscription only after testing representative baskets with shops across categories and areas. Compare shop earnings *after its own delivery cost* with the platform's contribution *after its variable costs*. Tax and settlement treatment should be reviewed for the chosen legal and payment setup before launch.

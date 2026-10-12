# YGo

Hyperlocal commerce platform connecting customers with local shops within roughly 2-3 km. In Phase 1 each shop delivers with its own staff.

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
**Shopkeeper app**: The mobile surface for Owner and Staff. "Shopkeeper" is only a surface name.

## Retired and banned terms

**Store**, **Zone**: retired. Use Shop and Area.
**Billing staff**, **Delivery staff**: retired as roles. There is one Staff role plus the `can deliver` flag.
**Partner**: banned outright, bare or qualified. The mockups used it for both the area manager and the delivery rider. Use **Area Manager**. A future platform-managed rider network will get its own name when it is in scope.

## Surfaces (Phase 1)

Customer Mobile, Shopkeeper Mobile and Admin Web. Shopkeeper Web and a separate Delivery Staff app are deferred; the delivery screens are a tab inside the Shopkeeper app.

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

## Service area

Two layers. An **Area** is administrative: shop approval, category availability, reporting and pausing. **Serviceability** is distance from the shop, which is what "within 2-3 km" means in the product.

Each shop belongs to exactly one Area, derived from its pincode and editable by Admin. The customer feed is driven by distance. A customer whose location falls in no active Area sees "not serviceable yet" and can leave a phone number; those captures guide expansion.

## Bargain

A per-product toggle the Owner turns on, with a hidden floor price per unit. The customer offers a price per unit for a chosen quantity. **The system decides instantly** against the floor: at or above it accepts, below it rejects, with no shopkeeper in the loop. An accepted price is pinned to that quantity in the cart and expires in 30 minutes if the order is not placed. Rejected offers are recorded for the Owner. A bargained line takes no coupon or other discount. Bargain is online only, never in counter billing. Commission is computed on the accepted price.

## Shop types

Grocery and kirana is the pilot focus. There is no second fixed shop type: every other type is an admin-defined category, so adding one needs no code change. Pharmacy and restaurants are out of scope.

## Search synonyms

An admin-managed global mapping of typed terms to catalog terms, applied to customer search only. Seeded with Hindi and transliterated terms for roughly the top 200 grocery items (kanda to onion, atta to flour). No automatic learning.

## Admin action record

An append-only record of **admin actions** is written from day one. There is no UI for it in Phase 1. Scope is admin actions only; whether shop-side actions by an Owner or Staff are recorded is not decided.

## Downstream obligations

These are unresolved and belong to named tickets. Do not invent rules for them here.

- **Stock reservation** for scheduled slots and for bargain-pinned cart lines: Order lifecycle (#9) and Inventory and counter billing (#11). A slot booked at night holds stock the shop may sell over the counter by morning.
- **Commission base on a bargained price**, and the **Area Manager payout formula**: Commission, fees and coupon funding (#15).
- **Area Manager payouts in the weekly settlement run**: Money direction and settlement (#14).
- **Per-product bargain toggle and floor price** in the data model: Catalog model (#10).
- **Delivery fee structure**: Commission, fees and coupon funding (#15).
- **Maximum permitted service radius** per shop: a config value, not yet set.
- **Re-inviting a deactivated staff phone number**: Login and handover OTP (#18).
- **Whether shop-side actions are recorded** (which staff member rejected an order or edited stock), and where. The admin action record covers admin actions only, so a shop currently has no internal accountability trail.
- **Whether Complaints needs its own decision ticket** beyond the triage that put the admin module in Phase 1.
- **Bargain offer rate limiting**, to stop a customer probing the floor price by repeated offers.
- **Owner of the synonym seeding work** before the pilot.

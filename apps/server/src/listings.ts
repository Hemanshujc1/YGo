import { STOCK_HOLDING_ORDER_STATUSES } from "@ygo/contracts";

/**
 * The listings a Customer can see, as FROM and WHERE text over `listing`, `pack`, `product`, `category` and `parent`:
 * switched on by the shop, with its pack, product and categories active and the product published.
 * A05 (#358) and C05 (#370) show the same set. The shop id is the query's `$1`.
 */
export const visibleListings = `shop_listings listing
    JOIN packs pack ON pack.id = listing.pack_id
    JOIN master_products product ON product.id = pack.product_id
    JOIN categories category ON category.id = product.category_id
    LEFT JOIN categories parent ON parent.id = category.parent_id
    WHERE listing.shop_id = $1 AND listing.available AND pack.active AND product.active AND product.published
      AND category.active AND COALESCE(parent.active, true)`;

/** The statuses whose lines hold stock, as SQL text. */
const holding = STOCK_HOLDING_ORDER_STATUSES.map((status) => `'${status}'`).join(", ");

/** A listing's stock on hand in base units: every stock movement added up, 0 with none. `listing` is the alias the query gives `shop_listings`. */
const onHandOf = (listing: string) =>
  `COALESCE((SELECT sum(movement.quantity) FROM stock_movements movement WHERE movement.listing_id = ${listing}.id), 0)`;

/**
 * What accepted orders hold of a listing, in base units (#425, #436): its lines on the shop's orders in the
 * STOCK_HOLDING_ORDER_STATUSES. Nothing writes a movement for a hold, so an order leaving those statuses
 * (rejected, cancelled, expired) gives its stock back by itself. An order in awaiting_customer_confirm holds
 * the proposed revision's reduced quantities (#64); confirmed revisions hold their confirmed lines.
 */
export const heldOf = (listing: string) =>
  `COALESCE((SELECT sum(held.stock_quantity) FROM orders holder
      CROSS JOIN LATERAL (
        SELECT (
          SELECT r.id FROM order_revisions r
          WHERE r.order_id = holder.id
            AND ((holder.status = 'awaiting_customer_confirm' AND r.status = 'proposed')
              OR (holder.status != 'awaiting_customer_confirm' AND r.status = 'confirmed'))
          ORDER BY r.revision DESC LIMIT 1
        ) AS active_revision_id,
        EXISTS (SELECT 1 FROM order_revisions r WHERE r.order_id = holder.id) AS has_revisions
      ) rev
      JOIN LATERAL (
        SELECT orl.stock_quantity FROM order_revision_lines orl
        WHERE rev.active_revision_id IS NOT NULL AND orl.revision_id = rev.active_revision_id AND orl.listing_id = ${listing}.id
        UNION ALL
        SELECT ol.stock_quantity FROM order_lines ol
        WHERE NOT rev.has_revisions AND ol.order_id = holder.id AND ol.listing_id = ${listing}.id
      ) held ON true
      WHERE holder.shop_id = ${listing}.shop_id AND holder.status IN (${holding})), 0)`;

/**
 * A listing's stock left to sell in base units (CAT-4): on hand less what accepted orders hold. The one rule
 * for both sides: Customers' availability (C05, search, cart, Accept) and the shop's listings and Stock (#436).
 */
export const stockOf = (listing: string) => `(${onHandOf(listing)} - ${heldOf(listing)})`;

/**
 * The part of a pack on sale when less than one pack is left (#377), as jsonb `{quantity, price}`, or NULL.
 * Only for measured goods, and only when the remainder is at least the shop's minimum order (owner's answers 2, 3 and 8);
 * the price is in proportion to the pack's online price, rounded half-up to the paisa (answer 4), and a part
 * that would cost nothing is not offered. Read from stock on every request: the phone never sends it.
 * The query names the pack `pack` and the product `product`.
 */
export const partOf = (listing: string) => `(SELECT CASE
    WHEN NOT ${listing}.out_of_stock AND product.classification = 'measured' AND remainder.stock > 0 AND remainder.stock < pack.quantity
      AND remainder.stock >= COALESCE(${listing}.minimum_order_quantity, 0) AND remainder.price > 0
    THEN jsonb_build_object('quantity', trim_scale(remainder.stock)::text, 'price', remainder.price::text) END
  FROM (SELECT stock, round(${listing}.online_price * stock / pack.quantity, 2) AS price
    FROM (SELECT ${stockOf(listing)} AS stock) stock) remainder)`;

/** A listing can be ordered now: it is not manually out of stock, and a whole pack or part is left (C05 and search, #377). */
export const inStock = (listing: string) => `(NOT ${listing}.out_of_stock AND (${stockOf(listing)} >= pack.quantity OR ${partOf(listing)} IS NOT NULL))`;

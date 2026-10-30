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

/**
 * A listing's stock in base units (CAT-4), 0 with no movements; `listing` is the alias the query gives `shop_listings`.
 */
export const stockOf = (listing: string) =>
  `COALESCE((SELECT sum(movement.quantity) FROM stock_movements movement WHERE movement.listing_id = ${listing}.id), 0)`;

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

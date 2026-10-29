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

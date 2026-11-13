-- MNY-15: the money of a partial acceptance is worked out here, not in TypeScript (#70). It takes the revised line totals and what the order was priced with
-- (its frozen shop-wide discount or coupon, its fees as quoted, the floor) and gives back each line's discount share and commission, the shop-wide discount,
-- the shop-funded and platform-funded coupon, the commission, the customer's total and the platform's contribution.
-- A line's commission rule is passed under "commission" and left out where none applies (a pickup earns no product commission, MNY-2).
CREATE OR REPLACE FUNCTION pricing_revision_quote(input jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  discount_rule jsonb := CASE WHEN jsonb_typeof(input->'shopDiscount') = 'object' THEN input->'shopDiscount' END;
  coupon jsonb := CASE WHEN discount_rule IS NULL AND jsonb_typeof(input->'coupon') = 'object' THEN input->'coupon' END;
  pickup boolean := (input->>'pickupFee') IS NOT NULL;
  totals numeric[];
  usable boolean[];
  every boolean[];
  zeros numeric[];
  coupon_shares numeric[];
  applied numeric[];
  outcome text;
  nominal numeric := 0;
  shop_wide numeric := 0;
  shop_coupon numeric := 0;
  platform_coupon numeric := 0;
  product numeric;
  commission numeric;
  contribution numeric;
  contribution_floor numeric := COALESCE((input->>'floor')::numeric, 0);
  priced jsonb;
BEGIN
  SELECT array_agg((line->>'lineTotal')::numeric ORDER BY position),
         array_agg(COALESCE((line->>'couponEligible')::boolean, true) ORDER BY position),
         array_agg(true ORDER BY position),
         array_agg(0.00::numeric ORDER BY position)
    INTO totals, usable, every, zeros
    FROM jsonb_array_elements(input->'lines') WITH ORDINALITY AS entries(line, position);
  SELECT COALESCE(sum(total), 0) INTO product FROM unnest(totals) AS total;

  IF discount_rule IS NOT NULL THEN
    applied := pricing_shop_discount_shares(discount_rule, totals, every);
    SELECT COALESCE(sum(share), 0) INTO shop_wide FROM unnest(applied) AS share;
  ELSIF coupon IS NOT NULL THEN
    SELECT s.outcome, s.shares INTO outcome, coupon_shares FROM pricing_coupon_shares(coupon, totals, usable) AS s;
    SELECT COALESCE(sum(share), 0) INTO nominal FROM unnest(coupon_shares) AS share;
    -- A shop-funded coupon takes its shares off the lines like a shop-wide discount; a platform-funded one takes nothing off any line (its amount comes off the total).
    IF coupon->>'funding' = 'shop' THEN applied := COALESCE(coupon_shares, zeros); shop_coupon := nominal;
    ELSE applied := zeros;
    END IF;
  ELSE applied := zeros;
  END IF;

  priced := pricing_quote_lines(input->'lines', totals, applied);
  commission := COALESCE((priced->>'commission')::numeric, 0);
  contribution := CASE WHEN pickup
    THEN (input->>'pickupFee')::numeric + COALESCE((input->>'pickupShopFee')::numeric, 0)
    ELSE commission + COALESCE((input->>'deliveryPlatformShare')::numeric, 0) + COALESCE((input->>'smallCartPlatformShare')::numeric, 0) END;
  -- A platform-funded coupon takes at most what the order earns above the floor, on the commission before any coupon.
  IF coupon->>'funding' = 'platform' AND NOT pickup THEN
    platform_coupon := pricing_platform_coupon(coupon->>'form', nominal, contribution, contribution_floor);
  END IF;

  RETURN jsonb_build_object(
    'lines', (SELECT COALESCE(jsonb_agg(jsonb_build_object('shopDiscount', COALESCE(line->>'shopDiscount', '0.00'), 'commission', COALESCE(line->>'commission', '0.00')) ORDER BY position), '[]')
              FROM jsonb_array_elements(priced->'lines') WITH ORDINALITY AS entries(line, position)),
    'productValue', round(product, 2)::text,
    'shopDiscount', round(shop_wide, 2)::text,
    'shopCoupon', round(shop_coupon, 2)::text,
    'platformCoupon', round(platform_coupon, 2)::text,
    'commission', round(commission, 2)::text,
    'customerTotal', round(product - shop_wide - shop_coupon - platform_coupon + COALESCE((input->>'deliveryFee')::numeric, 0)
      + COALESCE((input->>'smallCartFee')::numeric, 0) + COALESCE((input->>'pickupFee')::numeric, 0), 2)::text,
    'platformContribution', round(contribution - platform_coupon, 2)::text,
    'couponReason', CASE WHEN shop_coupon + platform_coupon > 0 THEN NULL
      WHEN outcome = 'below_minimum' THEN 'BELOW_MINIMUM' WHEN outcome = 'nothing_eligible' THEN 'NOTHING_ELIGIBLE' ELSE 'NO_ROOM' END
  );
END;
$$;

-- MNY-15: the coupon arithmetic is one piece of SQL, used by the quote and by the recalculation after a partial acceptance (#70).
-- What a coupon takes off each line, or why it takes nothing: nothing_eligible (no eligible value) or below_minimum (eligible value under its minimum order).
CREATE OR REPLACE FUNCTION pricing_coupon_shares(coupon jsonb, totals numeric[], usable boolean[]) RETURNS TABLE (outcome text, shares numeric[]) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  base numeric;
  minimum numeric := (coupon->>'minimumOrder')::numeric;
BEGIN
  SELECT COALESCE(sum(total) FILTER (WHERE can), 0) INTO base FROM unnest(totals, usable) AS lines(total, can);
  IF base = 0 THEN RETURN QUERY SELECT 'nothing_eligible'::text, NULL::numeric[];
  ELSIF minimum IS NOT NULL AND base < minimum THEN RETURN QUERY SELECT 'below_minimum'::text, NULL::numeric[];
  ELSE RETURN QUERY SELECT NULL::text, pricing_shop_discount_shares(coupon, totals, usable);
  END IF;
END;
$$;
--> statement-breakpoint
-- What a platform-funded coupon takes: at most the contribution surplus above the floor. A percentage coupon is trimmed to it; a flat one that cannot be paid in full takes nothing.
CREATE OR REPLACE FUNCTION pricing_platform_coupon(form text, nominal numeric, contribution numeric, contribution_floor numeric) RETURNS numeric LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN form = 'percentage' THEN LEAST(nominal, round(floor(GREATEST(contribution - contribution_floor, 0) * 100) / 100, 2))
    WHEN nominal > GREATEST(contribution - contribution_floor, 0) THEN 0.00
    ELSE nominal
  END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pricing_delivered_quote(input jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  coupon jsonb := CASE WHEN jsonb_typeof(input->'coupon') = 'object' THEN input->'coupon' END;
  totals numeric[];
  eligible boolean[];
  coupon_eligible boolean[];
  zeros numeric[];
  shop_shares numeric[];
  coupon_shares numeric[];
  applied_shares numeric[];
  shop_wide numeric;
  coupon_nominal numeric := 0;
  coupon_amount numeric := 0;
  surplus numeric;
  wins boolean := false;
  outcome text;
  shop_coupon numeric := 0;
  platform_coupon numeric := 0;
  priced jsonb;
  commission numeric;
  product numeric;
  delivery jsonb := pricing_fee_split((input->'deliveryFee'->>'amount')::numeric, input->'deliveryFee'->'split');
  small jsonb;
  contribution numeric;
  minimum_cart numeric := (input->>'minimumCart')::numeric;
  contribution_floor numeric := (input->>'deliveredContributionFloor')::numeric;
  reasons jsonb := '[]';
BEGIN
  SELECT array_agg(round((line->>'unitPrice')::numeric * (line->>'count')::integer, 2) ORDER BY position),
         array_agg(COALESCE((line->>'eligible')::boolean, true) ORDER BY position),
         array_agg(COALESCE((line->>'eligible')::boolean, true) AND COALESCE((line->>'couponEligible')::boolean, true) ORDER BY position),
         array_agg(0.00::numeric ORDER BY position)
    INTO totals, eligible, coupon_eligible, zeros
    FROM jsonb_array_elements(input->'lines') WITH ORDINALITY AS entries(line, position);
  shop_shares := pricing_shop_discount_shares(CASE WHEN jsonb_typeof(input->'shopDiscount') = 'object' THEN input->'shopDiscount' END, totals, eligible);
  SELECT COALESCE(sum(share), 0) INTO shop_wide FROM unnest(shop_shares) AS share;

  -- The small-cart threshold is tested on product value before discounts, like the minimum cart (CRT-6).
  SELECT COALESCE(sum(total), 0) INTO product FROM unnest(totals) AS total;
  IF jsonb_typeof(input->'smallCartFee') = 'object' AND (input->'smallCartFee'->>'enabled')::boolean
     AND product < (input->'smallCartFee'->>'threshold')::numeric THEN
    small := pricing_fee_split(
      LEAST((input->'smallCartFee'->>'amount')::numeric, COALESCE((input->'smallCartFee'->>'cap')::numeric, (input->'smallCartFee'->>'amount')::numeric)),
      input->'smallCartFee'->'split');
  END IF;

  IF coupon IS NOT NULL THEN
    SELECT s.outcome, s.shares INTO outcome, coupon_shares FROM pricing_coupon_shares(coupon, totals, coupon_eligible) AS s;
    IF outcome IS NULL THEN
      SELECT COALESCE(sum(share), 0) INTO coupon_nominal FROM unnest(coupon_shares) AS share;
      coupon_amount := coupon_nominal;
      IF coupon->>'funding' = 'platform' THEN
        -- The platform pays it from what the order earns above the floor, on the commission before any coupon (FR-PRC-04).
        priced := pricing_quote_lines(input->'lines', totals, zeros);
        contribution := (priced->>'commission')::numeric + (delivery->>'platformShare')::numeric + COALESCE((small->>'platformShare')::numeric, 0);
        surplus := GREATEST(contribution - contribution_floor, 0);
        coupon_amount := pricing_platform_coupon(coupon->>'form', coupon_nominal, contribution, contribution_floor);
        IF coupon_amount = 0 THEN outcome := CASE WHEN surplus = 0 THEN 'no_surplus' ELSE 'exceeds_surplus' END; END IF;
      END IF;
    END IF;
    wins := coupon_amount > 0 AND coupon_amount > shop_wide;
    IF coupon_amount > 0 AND NOT wins THEN outcome := 'beaten'; END IF;
  END IF;

  IF wins THEN
    shop_wide := 0;
    IF coupon->>'funding' = 'shop' THEN shop_coupon := coupon_amount; applied_shares := coupon_shares;
    ELSE platform_coupon := coupon_amount; applied_shares := zeros;
    END IF;
  ELSE applied_shares := shop_shares;
  END IF;

  priced := pricing_quote_lines(input->'lines', totals, applied_shares);
  commission := (priced->>'commission')::numeric;
  contribution := commission + (delivery->>'platformShare')::numeric + COALESCE((small->>'platformShare')::numeric, 0) - platform_coupon;
  IF product < minimum_cart THEN
    reasons := reasons || jsonb_build_object('code', 'BELOW_MINIMUM_CART', 'shortfall', round(minimum_cart - product, 2)::text);
  END IF;
  IF contribution < contribution_floor THEN
    reasons := reasons || jsonb_build_object('code', 'BELOW_CONTRIBUTION_FLOOR', 'shortfall', round(contribution_floor - contribution, 2)::text);
  END IF;

  RETURN jsonb_build_object(
    'lines', priced->'lines',
    'productValue', product::text,
    'shopDiscount', round(CASE WHEN wins THEN 0 ELSE shop_wide END, 2)::text,
    'coupon', CASE WHEN coupon IS NULL THEN NULL ELSE jsonb_build_object(
      'applied', wins, 'outcome', CASE WHEN wins THEN 'applied' ELSE outcome END,
      'shopFunded', round(shop_coupon, 2)::text, 'platformFunded', round(platform_coupon, 2)::text) END,
    'commission', commission::text,
    'deliveryFee', delivery,
    'smallCartFee', small,
    'customerTotal', round(product - shop_wide - shop_coupon - platform_coupon + (delivery->>'amount')::numeric + COALESCE((small->>'amount')::numeric, 0), 2)::text,
    'shopKeeps', round(product - shop_wide - shop_coupon - commission + (delivery->>'shopShare')::numeric + COALESCE((small->>'shopShare')::numeric, 0), 2)::text,
    'platformContribution', round(contribution, 2)::text,
    'placeable', jsonb_array_length(reasons) = 0,
    'reasons', reasons
  );
END;
$$;

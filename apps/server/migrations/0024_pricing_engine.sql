-- The one pricing engine (ADR-0004, ADR-0007, MNY-15): every money amount of a delivered quote is made here, on NUMERIC.
-- The caller resolves which rate-card rules apply and passes them in; this file does all the arithmetic.
-- Amounts leave as text with two decimals, so no JSON reader turns them into floating point.

-- One line's commission (MNY-2): the formula on its base, then the optional minimum and maximum, rounded half-up once.
-- With no shop discounts yet, the base is the line total whichever `base` the rule names; #63 applies `after_shop_discount`.
CREATE FUNCTION pricing_line_commission(base numeric, rule jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE STRICT AS $$
  -- GREATEST and LEAST skip nulls, so an absent minimum or maximum leaves the amount alone.
  SELECT round(LEAST(GREATEST(raw, (rule->>'minimum')::numeric), (rule->>'maximum')::numeric), 2)
  FROM (
    SELECT CASE rule->>'formula'
      WHEN 'fixed' THEN fixed
      WHEN 'percentage' THEN percent
      WHEN 'fixed_plus_percentage' THEN fixed + percent
      WHEN 'higher_of' THEN GREATEST(fixed, percent)
      WHEN 'lower_of' THEN LEAST(fixed, percent)
    END AS raw
    FROM (SELECT (rule->>'fixedAmount')::numeric AS fixed, base * (rule->>'percentage')::numeric / 100 AS percent) AS parts
  ) AS formula
$$;
--> statement-breakpoint
-- A fee and its split: the platform share is rounded half-up and the shop takes the rest, so the two always add up to the fee.
CREATE FUNCTION pricing_fee_split(amount numeric, split jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_build_object('amount', round(amount, 2)::text, 'platformShare', platform::text, 'shopShare', round(amount - platform, 2)::text)
  FROM (SELECT round(amount * (split->>'platformPercentage')::numeric / 100, 2) AS platform) AS shares
$$;
--> statement-breakpoint
-- input: { lines: [{ unitPrice, count, commission }], deliveryFee, smallCartFee (or null), minimumCart, deliveredContributionFloor }.
-- Platform variable costs count as zero until the rate card holds them (#357).
CREATE FUNCTION pricing_delivered_quote(input jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  lines jsonb;
  product numeric;
  commission numeric;
  delivery jsonb := pricing_fee_split((input->'deliveryFee'->>'amount')::numeric, input->'deliveryFee'->'split');
  small jsonb;
  contribution numeric;
  minimum_cart numeric := (input->>'minimumCart')::numeric;
  contribution_floor numeric := (input->>'deliveredContributionFloor')::numeric;
  reasons jsonb := '[]';
BEGIN
  SELECT jsonb_agg(jsonb_build_object('lineTotal', line_total::text, 'commission', line_commission::text) ORDER BY position),
         sum(line_total), sum(line_commission)
    INTO lines, product, commission
    FROM (
      SELECT position, line_total, pricing_line_commission(line_total, line->'commission') AS line_commission
      FROM (
        SELECT position, line, round((line->>'unitPrice')::numeric * (line->>'count')::integer, 2) AS line_total
        FROM jsonb_array_elements(input->'lines') WITH ORDINALITY AS entries(line, position)
      ) AS totals
    ) AS priced;

  -- The small-cart threshold is tested on product value before discounts, like the minimum cart (CRT-6).
  IF jsonb_typeof(input->'smallCartFee') = 'object' AND (input->'smallCartFee'->>'enabled')::boolean
     AND product < (input->'smallCartFee'->>'threshold')::numeric THEN
    small := pricing_fee_split(
      LEAST((input->'smallCartFee'->>'amount')::numeric, COALESCE((input->'smallCartFee'->>'cap')::numeric, (input->'smallCartFee'->>'amount')::numeric)),
      input->'smallCartFee'->'split');
  END IF;

  contribution := commission + (delivery->>'platformShare')::numeric + COALESCE((small->>'platformShare')::numeric, 0);
  IF product < minimum_cart THEN
    reasons := reasons || jsonb_build_object('code', 'BELOW_MINIMUM_CART', 'shortfall', round(minimum_cart - product, 2)::text);
  END IF;
  IF contribution < contribution_floor THEN
    reasons := reasons || jsonb_build_object('code', 'BELOW_CONTRIBUTION_FLOOR', 'shortfall', round(contribution_floor - contribution, 2)::text);
  END IF;

  RETURN jsonb_build_object(
    'lines', lines,
    'productValue', product::text,
    'commission', commission::text,
    'deliveryFee', delivery,
    'smallCartFee', small,
    'customerTotal', (product + (delivery->>'amount')::numeric + COALESCE((small->>'amount')::numeric, 0))::text,
    'shopKeeps', (product - commission + (delivery->>'shopShare')::numeric + COALESCE((small->>'shopShare')::numeric, 0))::text,
    'platformContribution', contribution::text,
    'placeable', jsonb_array_length(reasons) = 0,
    'reasons', reasons
  );
END;
$$;

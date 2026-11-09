CREATE TABLE "shop_discount_versions" (
	"rule_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"form" text NOT NULL,
	"percentage" numeric(7, 4),
	"cap" numeric(12, 2),
	"flat_amount" numeric(12, 2),
	"minimum_order" numeric(12, 2),
	"status" text NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shop_discount_versions_rule_id_version_pk" PRIMARY KEY("rule_id","version"),
	CONSTRAINT "shop_discount_versions_form_valid" CHECK (("shop_discount_versions"."form" = 'percentage' AND "shop_discount_versions"."percentage" > 0 AND "shop_discount_versions"."flat_amount" IS NULL AND "shop_discount_versions"."minimum_order" IS NULL AND ("shop_discount_versions"."cap" IS NULL OR "shop_discount_versions"."cap" > 0))
    OR ("shop_discount_versions"."form" = 'flat' AND "shop_discount_versions"."flat_amount" > 0 AND "shop_discount_versions"."minimum_order" > 0 AND "shop_discount_versions"."percentage" IS NULL AND "shop_discount_versions"."cap" IS NULL)),
	CONSTRAINT "shop_discount_versions_status_valid" CHECK ("shop_discount_versions"."status" IN ('active', 'off', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "shop_discounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"form" text NOT NULL,
	"percentage" numeric(7, 4),
	"cap" numeric(12, 2),
	"flat_amount" numeric(12, 2),
	"minimum_order" numeric(12, 2),
	"status" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shop_discounts_shop_id_unique" UNIQUE("shop_id"),
	CONSTRAINT "shop_discounts_form_valid" CHECK (("shop_discounts"."form" = 'percentage' AND "shop_discounts"."percentage" > 0 AND "shop_discounts"."flat_amount" IS NULL AND "shop_discounts"."minimum_order" IS NULL AND ("shop_discounts"."cap" IS NULL OR "shop_discounts"."cap" > 0))
    OR ("shop_discounts"."form" = 'flat' AND "shop_discounts"."flat_amount" > 0 AND "shop_discounts"."minimum_order" > 0 AND "shop_discounts"."percentage" IS NULL AND "shop_discounts"."cap" IS NULL)),
	CONSTRAINT "shop_discounts_status_valid" CHECK ("shop_discounts"."status" IN ('active', 'off', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "shop_discount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_discount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_discount_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_discount_rule_version" integer;--> statement-breakpoint
ALTER TABLE "shop_discount_versions" ADD CONSTRAINT "shop_discount_versions_rule_id_shop_discounts_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."shop_discounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_discount_versions" ADD CONSTRAINT "shop_discount_versions_actor_id_accounts_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_discounts" ADD CONSTRAINT "shop_discounts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_discount_rule_fk" FOREIGN KEY ("shop_discount_rule_id","shop_discount_rule_version") REFERENCES "public"."shop_discount_versions"("rule_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_idx" ON "notifications" USING btree ("account_id","dedupe_key") WHERE "notifications"."dedupe_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" IN ('order_placed', 'order_cancelled_by_customer', 'order_accepted', 'order_rejected', 'order_expired', 'order_partially_accepted', 'order_cancel_requested', 'order_cancel_agreed', 'order_cancel_kept', 'order_cancelled_by_shop', 'order_total_confirmed', 'product_request_approved', 'product_request_rejected', 'shop_discount_paused'));--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_shop_discount_valid" CHECK ("order_lines"."shop_discount" >= 0 AND "order_lines"."shop_discount" <= "order_lines"."line_total");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_discount_valid" CHECK ("orders"."shop_discount" >= 0 AND ("orders"."shop_discount_rule_id" IS NULL) = ("orders"."shop_discount_rule_version" IS NULL)
    AND ("orders"."shop_discount" = 0 OR "orders"."shop_discount_rule_id" IS NOT NULL));--> statement-breakpoint
-- The maximum effective percentage is held on each form's worst case (MNY-5): the percentage itself, or the flat amount over the minimum order.
-- Compared by cross-multiplying, so no division rounds a borderline rule under the maximum. A percentage's cap only lowers the amount, never the worst case.
CREATE FUNCTION shop_discount_exceeds(form text, percentage numeric, flat_amount numeric, minimum_order numeric, maximum numeric) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE form WHEN 'percentage' THEN percentage > maximum ELSE flat_amount * 100 > maximum * minimum_order END
$$;
--> statement-breakpoint
-- A rule's history can only grow: an order names the exact version it was priced on, so no version row is changed or removed.
CREATE TRIGGER shop_discount_versions_no_update_delete BEFORE UPDATE OR DELETE ON shop_discount_versions
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER shop_discount_versions_no_truncate BEFORE TRUNCATE ON shop_discount_versions
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
-- The shop-funded discount of one order, split across its lines in whole paise (MNY-6, CRT-3). `rule` is the shop's one active rule or null,
-- `totals` the line totals and `eligible` which lines may take a discount (a bargained line does not). The base is the eligible product value before
-- any discount, never fees or taxes. Each line takes its pro-rata part rounded down and the remainder goes to the largest eligible line (the first on a tie),
-- so the parts always add up to the discount. A remainder the largest line cannot hold without its part passing its total (only with many tiny lines)
-- spills to the next largest in the same order. The discount rounds half-up once, and never exceeds the base, so the spill always fits.
CREATE FUNCTION pricing_shop_discount_shares(rule jsonb, totals numeric[], eligible boolean[]) RETURNS numeric[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  count integer := COALESCE(array_length(totals, 1), 0);
  paise bigint[] := ARRAY[]::bigint[];
  shares bigint[] := ARRAY[]::bigint[];
  base bigint := 0;
  discount numeric := 0;
  remainder bigint;
  step bigint;
  index integer;
BEGIN
  FOR index IN 1..count LOOP
    paise := paise || (CASE WHEN eligible[index] THEN round(totals[index] * 100)::bigint ELSE 0 END);
    base := base + paise[index];
  END LOOP;
  IF rule IS NOT NULL AND base > 0 THEN
    discount := CASE rule->>'form'
      WHEN 'percentage' THEN LEAST(round(base * (rule->>'percentage')::numeric / 100), COALESCE((rule->>'cap')::numeric * 100, base))
      WHEN 'flat' THEN CASE WHEN base >= (rule->>'minimumOrder')::numeric * 100 THEN (rule->>'amount')::numeric * 100 ELSE 0 END
    END;
    discount := LEAST(discount, base);
  END IF;
  FOR index IN 1..count LOOP
    shares := shares || floor(discount * paise[index] / GREATEST(base, 1))::bigint;
  END LOOP;
  remainder := discount::bigint - (SELECT COALESCE(sum(part), 0) FROM unnest(shares) AS part);
  FOR index IN SELECT position FROM unnest(paise) WITH ORDINALITY AS lines(amount, position) WHERE amount > 0 ORDER BY amount DESC, position LOOP
    EXIT WHEN remainder = 0;
    step := LEAST(remainder, paise[index] - shares[index]);
    shares[index] := shares[index] + step;
    remainder := remainder - step;
  END LOOP;
  RETURN ARRAY(SELECT round(part / 100.0, 2) FROM unnest(shares) WITH ORDINALITY AS shares(part, position) ORDER BY position);
END;
$$;
--> statement-breakpoint
-- The delivered quote with the shop-funded discount (#63). New in the input: `shopDiscount` (the shop's active rule: form, percentage, cap, amount,
-- minimumOrder; or null) and, on a line, `eligible` (default true). The minimum cart and the small-cart threshold still test product value before discount.
-- A commission rule with base `after_shop_discount` takes each line's total less its share; `before_shop_discount` is unchanged.
CREATE OR REPLACE FUNCTION pricing_delivered_quote(input jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  lines jsonb;
  product numeric;
  commission numeric;
  discount numeric;
  totals numeric[];
  eligible boolean[];
  shares numeric[];
  delivery jsonb := pricing_fee_split((input->'deliveryFee'->>'amount')::numeric, input->'deliveryFee'->'split');
  small jsonb;
  contribution numeric;
  minimum_cart numeric := (input->>'minimumCart')::numeric;
  contribution_floor numeric := (input->>'deliveredContributionFloor')::numeric;
  reasons jsonb := '[]';
BEGIN
  SELECT array_agg(round((line->>'unitPrice')::numeric * (line->>'count')::integer, 2) ORDER BY position),
         array_agg(COALESCE((line->>'eligible')::boolean, true) ORDER BY position)
    INTO totals, eligible
    FROM jsonb_array_elements(input->'lines') WITH ORDINALITY AS entries(line, position);
  shares := pricing_shop_discount_shares(CASE WHEN jsonb_typeof(input->'shopDiscount') = 'object' THEN input->'shopDiscount' END, totals, eligible);
  SELECT COALESCE(sum(share), 0) INTO discount FROM unnest(shares) AS share;

  SELECT jsonb_agg(jsonb_build_object('lineTotal', line_total::text, 'shopDiscount', share::text, 'commission', line_commission::text) ORDER BY position),
         sum(line_total), sum(line_commission)
    INTO lines, product, commission
    FROM (
      SELECT position, line_total, share,
        pricing_line_commission(CASE WHEN rule->>'base' = 'after_shop_discount' THEN line_total - share ELSE line_total END, rule) AS line_commission
      FROM (
        SELECT position, totals[position] AS line_total, shares[position] AS share, line->'commission' AS rule
        FROM jsonb_array_elements(input->'lines') WITH ORDINALITY AS entries(line, position)
      ) AS totalled
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
    'shopDiscount', round(discount, 2)::text,
    'commission', commission::text,
    'deliveryFee', delivery,
    'smallCartFee', small,
    'customerTotal', (product - discount + (delivery->>'amount')::numeric + COALESCE((small->>'amount')::numeric, 0))::text,
    'shopKeeps', (product - discount - commission + (delivery->>'shopShare')::numeric + COALESCE((small->>'shopShare')::numeric, 0))::text,
    'platformContribution', contribution::text,
    'placeable', jsonb_array_length(reasons) = 0,
    'reasons', reasons
  );
END;
$$;

CREATE TABLE "coupon_uses" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"coupon_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupon_versions" (
	"coupon_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"code" text NOT NULL,
	"funding" text NOT NULL,
	"shop_id" uuid,
	"form" text NOT NULL,
	"percentage" numeric(7, 4),
	"cap" numeric(12, 2),
	"flat_amount" numeric(12, 2),
	"minimum_order" numeric(12, 2),
	"status" text NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"usage_limit" integer,
	"per_customer_limit" integer DEFAULT 1 NOT NULL,
	"first_order_only" boolean DEFAULT false NOT NULL,
	"area_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"actor_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "coupon_versions_coupon_id_version_pk" PRIMARY KEY("coupon_id","version"),
	CONSTRAINT "coupon_versions_form_valid" CHECK (("coupon_versions"."form" = 'percentage' AND "coupon_versions"."percentage" > 0 AND "coupon_versions"."percentage" <= 100 AND "coupon_versions"."flat_amount" IS NULL AND ("coupon_versions"."minimum_order" IS NULL OR "coupon_versions"."minimum_order" > 0) AND ("coupon_versions"."cap" IS NULL OR "coupon_versions"."cap" > 0))
    OR ("coupon_versions"."form" = 'flat' AND "coupon_versions"."flat_amount" > 0 AND "coupon_versions"."percentage" IS NULL AND "coupon_versions"."cap" IS NULL AND ("coupon_versions"."minimum_order" IS NULL OR "coupon_versions"."minimum_order" > 0))),
	CONSTRAINT "coupon_versions_status_valid" CHECK ("coupon_versions"."status" IN ('active', 'off', 'paused')),
	CONSTRAINT "coupon_versions_funding_valid" CHECK (("coupon_versions"."funding" = 'platform' AND "coupon_versions"."shop_id" IS NULL) OR ("coupon_versions"."funding" = 'shop' AND "coupon_versions"."shop_id" IS NOT NULL AND ("coupon_versions"."form" = 'percentage' OR "coupon_versions"."minimum_order" IS NOT NULL))),
	CONSTRAINT "coupon_versions_limits_valid" CHECK (("coupon_versions"."usage_limit" IS NULL OR "coupon_versions"."usage_limit" > 0) AND "coupon_versions"."per_customer_limit" > 0 AND ("coupon_versions"."starts_at" IS NULL OR "coupon_versions"."starts_at" < "coupon_versions"."expires_at")),
	CONSTRAINT "coupon_versions_code_valid" CHECK ("coupon_versions"."code" ~ '^[A-Za-z0-9]{3,20}$')
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"code" text NOT NULL,
	"funding" text NOT NULL,
	"shop_id" uuid,
	"form" text NOT NULL,
	"percentage" numeric(7, 4),
	"cap" numeric(12, 2),
	"flat_amount" numeric(12, 2),
	"minimum_order" numeric(12, 2),
	"status" text NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"usage_limit" integer,
	"per_customer_limit" integer DEFAULT 1 NOT NULL,
	"first_order_only" boolean DEFAULT false NOT NULL,
	"area_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"category_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "coupons_form_valid" CHECK (("coupons"."form" = 'percentage' AND "coupons"."percentage" > 0 AND "coupons"."percentage" <= 100 AND "coupons"."flat_amount" IS NULL AND ("coupons"."minimum_order" IS NULL OR "coupons"."minimum_order" > 0) AND ("coupons"."cap" IS NULL OR "coupons"."cap" > 0))
    OR ("coupons"."form" = 'flat' AND "coupons"."flat_amount" > 0 AND "coupons"."percentage" IS NULL AND "coupons"."cap" IS NULL AND ("coupons"."minimum_order" IS NULL OR "coupons"."minimum_order" > 0))),
	CONSTRAINT "coupons_status_valid" CHECK ("coupons"."status" IN ('active', 'off', 'paused')),
	CONSTRAINT "coupons_funding_valid" CHECK (("coupons"."funding" = 'platform' AND "coupons"."shop_id" IS NULL) OR ("coupons"."funding" = 'shop' AND "coupons"."shop_id" IS NOT NULL AND ("coupons"."form" = 'percentage' OR "coupons"."minimum_order" IS NOT NULL))),
	CONSTRAINT "coupons_limits_valid" CHECK (("coupons"."usage_limit" IS NULL OR "coupons"."usage_limit" > 0) AND "coupons"."per_customer_limit" > 0 AND ("coupons"."starts_at" IS NULL OR "coupons"."starts_at" < "coupons"."expires_at")),
	CONSTRAINT "coupons_code_valid" CHECK ("coupons"."code" ~ '^[A-Za-z0-9]{3,20}$')
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_valid";--> statement-breakpoint
ALTER TABLE "order_revisions" DROP CONSTRAINT "order_revisions_total_reconciles";--> statement-breakpoint
ALTER TABLE "carts" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD COLUMN "coupon_version" integer;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD COLUMN "shop_coupon" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD COLUMN "platform_coupon" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "coupon_version" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_coupon" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "platform_coupon" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_uses" ADD CONSTRAINT "coupon_uses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_versions" ADD CONSTRAINT "coupon_versions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_versions" ADD CONSTRAINT "coupon_versions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_versions" ADD CONSTRAINT "coupon_versions_actor_id_accounts_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupon_uses_coupon_id_idx" ON "coupon_uses" USING btree ("coupon_id");--> statement-breakpoint
CREATE INDEX "coupon_uses_account_id_idx" ON "coupon_uses" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupons_code_lower_idx" ON "coupons" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "coupons_shop_id_idx" ON "coupons" USING btree ("shop_id");--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_coupon_fk" FOREIGN KEY ("coupon_id","coupon_version") REFERENCES "public"."coupon_versions"("coupon_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_fk" FOREIGN KEY ("coupon_id","coupon_version") REFERENCES "public"."coupon_versions"("coupon_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" IN ('order_placed', 'order_cancelled_by_customer', 'order_accepted', 'order_rejected', 'order_expired', 'order_partially_accepted', 'order_cancel_requested', 'order_cancel_agreed', 'order_cancel_kept', 'order_cancelled_by_shop', 'order_total_confirmed', 'product_request_approved', 'product_request_rejected', 'shop_discount_paused', 'coupon_paused', 'pickup_ready', 'pickup_not_collected', 'order_delivery_failed'));--> statement-breakpoint
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_coupon_valid" CHECK ("order_revisions"."shop_coupon" >= 0 AND "order_revisions"."platform_coupon" >= 0 AND ("order_revisions"."coupon_id" IS NULL) = ("order_revisions"."coupon_version" IS NULL)
    AND ("order_revisions"."shop_coupon" + "order_revisions"."platform_coupon" = 0 OR "order_revisions"."coupon_id" IS NOT NULL) AND ("order_revisions"."shop_discount" = 0 OR "order_revisions"."shop_coupon" + "order_revisions"."platform_coupon" = 0)
    AND "order_revisions"."shop_coupon" + "order_revisions"."platform_coupon" <= "order_revisions"."product_value");--> statement-breakpoint
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_total_reconciles" CHECK ("order_revisions"."total" = "order_revisions"."product_value" - "order_revisions"."shop_discount" - "order_revisions"."shop_coupon" - "order_revisions"."platform_coupon" + "order_revisions"."delivery_fee" + COALESCE("order_revisions"."small_cart_fee", 0) + COALESCE("order_revisions"."pickup_fee", 0));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_valid" CHECK ("orders"."shop_coupon" >= 0 AND "orders"."platform_coupon" >= 0 AND ("orders"."coupon_id" IS NULL) = ("orders"."coupon_version" IS NULL)
    AND ("orders"."shop_coupon" + "orders"."platform_coupon" = 0 OR "orders"."coupon_id" IS NOT NULL) AND ("orders"."shop_discount" = 0 OR "orders"."shop_coupon" + "orders"."platform_coupon" = 0));--> statement-breakpoint
-- A coupon's history can only grow: an order names the exact version it was priced on, so no version row is changed or removed (MNY-6).
CREATE TRIGGER coupon_versions_no_update_delete BEFORE UPDATE OR DELETE ON coupon_versions
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER coupon_versions_no_truncate BEFORE TRUNCATE ON coupon_versions
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
-- A use is part of the order's record: it is never changed or removed, only counted or not by its order's status.
CREATE TRIGGER coupon_uses_no_update_delete BEFORE UPDATE OR DELETE ON coupon_uses
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER coupon_uses_no_truncate BEFORE TRUNCATE ON coupon_uses
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
-- A revision's shop-funded discount, whether a shop-wide discount or a shop-funded coupon (never both, D-7), is the sum of its lines' shares.
-- The platform-funded coupon takes nothing off any line, so it is not in this sum (MNY-6).
CREATE OR REPLACE FUNCTION check_order_revision_discount_sum() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM order_revisions r
    WHERE r.id = NEW.id
      AND (r.shop_discount + r.shop_coupon <> (SELECT COALESCE(sum(l.shop_discount), 0) FROM order_revision_lines l WHERE l.revision_id = r.id)
        OR r.product_value <> (SELECT COALESCE(sum(l.line_total), 0) FROM order_revision_lines l WHERE l.revision_id = r.id))
  ) THEN
    RAISE EXCEPTION 'Revision % does not add up: its product value and discount must equal the sums of its lines'' totals and discounts', NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- The lines of one quote: each line's total, its share of the shop-funded promotion and its commission, and their sums. The commission base is the line total
-- less its share when the rule says `after_shop_discount`, else the line total (revenue spec, "Separation of funding sources").
CREATE FUNCTION pricing_quote_lines(input_lines jsonb, totals numeric[], shares numeric[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'lines', jsonb_agg(jsonb_build_object('lineTotal', line_total::text, 'shopDiscount', share::text, 'commission', line_commission::text) ORDER BY position),
    'product', sum(line_total)::text, 'commission', sum(line_commission)::text)
  FROM (
    SELECT position, line_total, share,
      pricing_line_commission(CASE WHEN rule->>'base' = 'after_shop_discount' THEN line_total - share ELSE line_total END, rule) AS line_commission
    FROM (
      SELECT position, totals[position] AS line_total, shares[position] AS share, line->'commission' AS rule
      FROM jsonb_array_elements(input_lines) WITH ORDINALITY AS entries(line, position)
    ) AS totalled
  ) AS priced
$$;
--> statement-breakpoint
-- The delivered quote with one coupon (#70). New in the input: `coupon` (funding, form, percentage, cap, amount, minimumOrder; or null) and, on a line, `couponEligible`
-- (default true; a line outside the coupon's categories is false). At most one promotion applies (D-7): the shop-wide discount and the coupon are each worked out alone,
-- and the coupon applies only when it takes strictly more rupees off than the shop-wide discount, so the shop-wide discount wins a tie and a coupon that
-- was not applied takes nothing and is not counted as used. A platform-funded coupon takes nothing from the commission base and at most the contribution surplus
-- above the floor: a percentage coupon is trimmed to it, a flat one that cannot be paid in full is not applied. The result keeps the funding amounts apart (MNY-6):
-- `shopDiscount` (shop-wide, 0 when the coupon applied) and `coupon.shopFunded` / `coupon.platformFunded`. A line's `shopDiscount` is its share of the shop-funded
-- promotion that applied, whichever it was. `coupon.outcome` says why it did not apply: nothing_eligible, below_minimum, no_surplus, exceeds_surplus or beaten.
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
  coupon_base numeric;
  coupon_minimum numeric;
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
    SELECT COALESCE(sum(total) FILTER (WHERE usable), 0) INTO coupon_base FROM unnest(totals, coupon_eligible) AS lines(total, usable);
    coupon_minimum := (coupon->>'minimumOrder')::numeric;
    IF coupon_base = 0 THEN outcome := 'nothing_eligible';
    ELSIF coupon_minimum IS NOT NULL AND coupon_base < coupon_minimum THEN outcome := 'below_minimum';
    ELSE
      coupon_shares := pricing_shop_discount_shares(coupon, totals, coupon_eligible);
      SELECT COALESCE(sum(share), 0) INTO coupon_nominal FROM unnest(coupon_shares) AS share;
      coupon_amount := coupon_nominal;
      IF coupon->>'funding' = 'platform' THEN
        -- The platform pays it from what the order earns above the floor, on the commission before any coupon (FR-PRC-04).
        priced := pricing_quote_lines(input->'lines', totals, zeros);
        surplus := GREATEST((priced->>'commission')::numeric + (delivery->>'platformShare')::numeric + COALESCE((small->>'platformShare')::numeric, 0) - contribution_floor, 0);
        IF coupon->>'form' = 'percentage' THEN coupon_amount := LEAST(coupon_nominal, round(floor(surplus * 100) / 100, 2));
        ELSIF coupon_nominal > surplus THEN coupon_amount := 0;
        END IF;
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

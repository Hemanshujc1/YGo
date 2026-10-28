CREATE TABLE "shop_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"online_price" numeric(12, 2) NOT NULL,
	"counter_price" numeric(12, 2) NOT NULL,
	"mrp" numeric(12, 2) NOT NULL,
	"low_stock_level" numeric(12, 3) DEFAULT '0' NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"minimum_order_quantity" numeric(12, 3),
	"quantity_step" numeric(12, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_listings_prices_valid" CHECK ("shop_listings"."online_price" >= 0 AND "shop_listings"."online_price" <> 'NaN'::numeric AND "shop_listings"."counter_price" >= 0 AND "shop_listings"."counter_price" <> 'NaN'::numeric AND "shop_listings"."mrp" >= 0 AND "shop_listings"."mrp" <> 'NaN'::numeric AND "shop_listings"."low_stock_level" >= 0 AND "shop_listings"."low_stock_level" <> 'NaN'::numeric),
	CONSTRAINT "shop_listings_measured_rules_pair" CHECK ((("shop_listings"."minimum_order_quantity" IS NULL) AND ("shop_listings"."quantity_step" IS NULL)) OR ("shop_listings"."minimum_order_quantity" > 0 AND "shop_listings"."minimum_order_quantity" <> 'NaN'::numeric AND "shop_listings"."quantity_step" > 0 AND "shop_listings"."quantity_step" <> 'NaN'::numeric))
);
--> statement-breakpoint
CREATE TABLE "shop_quantity_price_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	CONSTRAINT "shop_quantity_price_options_valid" CHECK ("shop_quantity_price_options"."quantity" > 0 AND "shop_quantity_price_options"."quantity" <> 'NaN'::numeric AND "shop_quantity_price_options"."price" >= 0 AND "shop_quantity_price_options"."price" <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_kind_valid" CHECK ("stock_movements"."kind" IN ('opening')),
	CONSTRAINT "stock_movements_quantity_valid" CHECK ("stock_movements"."quantity" >= 0 AND "stock_movements"."quantity" <> 'NaN'::numeric)
);
--> statement-breakpoint
ALTER TABLE "shop_listings" ADD CONSTRAINT "shop_listings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_listings" ADD CONSTRAINT "shop_listings_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_quantity_price_options" ADD CONSTRAINT "shop_quantity_price_options_listing_id_shop_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."shop_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_listing_id_shop_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."shop_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shop_listings_shop_pack_idx" ON "shop_listings" USING btree ("shop_id","pack_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shop_quantity_price_options_quantity_idx" ON "shop_quantity_price_options" USING btree ("listing_id","quantity");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_client_id_idx" ON "stock_movements" USING btree ("listing_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_one_opening_idx" ON "stock_movements" USING btree ("listing_id") WHERE "stock_movements"."kind" = 'opening';
--> statement-breakpoint
CREATE FUNCTION reject_stock_movement_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stock_movements is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_update_delete BEFORE UPDATE OR DELETE ON stock_movements
FOR EACH ROW EXECUTE FUNCTION reject_stock_movement_change();
--> statement-breakpoint
CREATE TRIGGER stock_movements_no_truncate BEFORE TRUNCATE ON stock_movements
FOR EACH STATEMENT EXECUTE FUNCTION reject_stock_movement_change();

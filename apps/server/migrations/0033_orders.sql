CREATE TABLE "order_lines" (
	"order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"listing_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"base_unit" text NOT NULL,
	"pack_quantity" numeric(12, 3) NOT NULL,
	"count" integer NOT NULL,
	"part_quantity" numeric(12, 3),
	"unit_price" numeric(12, 2) NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"stock_quantity" numeric(12, 3) NOT NULL,
	CONSTRAINT "order_lines_order_id_position_pk" PRIMARY KEY("order_id","position"),
	CONSTRAINT "order_lines_count_valid" CHECK ("order_lines"."count" BETWEEN 1 AND 999),
	CONSTRAINT "order_lines_part_valid" CHECK ("order_lines"."part_quantity" IS NULL OR ("order_lines"."count" = 1 AND "order_lines"."part_quantity" > 0)),
	CONSTRAINT "order_lines_stock_valid" CHECK ("order_lines"."stock_quantity" = COALESCE("order_lines"."part_quantity", "order_lines"."count" * "order_lines"."pack_quantity"))
);
--> statement-breakpoint
CREATE TABLE "order_status_history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_status_history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_id" uuid,
	"actor_role" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"reason_code" text,
	"client_id" uuid,
	CONSTRAINT "order_status_history_role_valid" CHECK ("order_status_history"."actor_role" IN ('customer', 'owner', 'staff', 'system')),
	CONSTRAINT "order_status_history_actor_valid" CHECK (("order_status_history"."actor_role" = 'system') = ("order_status_history"."actor_id" IS NULL)),
	CONSTRAINT "order_status_history_statuses_valid" CHECK ("order_status_history"."to_status" IN ('placed', 'scheduled_pending_review', 'awaiting_customer_confirm', 'accepted', 'scheduled_confirmed',
  'preparing', 'ready', 'out_for_delivery', 'arrived', 'delivered', 'picked_up', 'rejected_by_shop', 'expired', 'not_collected',
  'cancelled_by_customer', 'cancelled_by_shop', 'delivery_failed') AND ("order_status_history"."from_status" IS NULL OR "order_status_history"."from_status" IN ('placed', 'scheduled_pending_review', 'awaiting_customer_confirm', 'accepted', 'scheduled_confirmed',
  'preparing', 'ready', 'out_for_delivery', 'arrived', 'delivered', 'picked_up', 'rejected_by_shop', 'expired', 'not_collected',
  'cancelled_by_customer', 'cancelled_by_shop', 'delivery_failed')))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "orders_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1001 CACHE 1),
	"account_id" uuid NOT NULL,
	"shop_id" uuid NOT NULL,
	"status" text NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"status_changed_at" timestamp with time zone NOT NULL,
	"address_label" text NOT NULL,
	"address_flat" text NOT NULL,
	"address_area_line" text,
	"address_pincode" text NOT NULL,
	"address_point" geography(Point,4326) NOT NULL,
	"product_value" numeric(12, 2) NOT NULL,
	"delivery_fee" numeric(12, 2) NOT NULL,
	"small_cart_fee" numeric(12, 2),
	"total" numeric(12, 2) NOT NULL,
	"rate_card_version" bigint NOT NULL,
	"quote" jsonb NOT NULL,
	CONSTRAINT "orders_status_valid" CHECK ("orders"."status" IN ('placed', 'scheduled_pending_review', 'awaiting_customer_confirm', 'accepted', 'scheduled_confirmed',
  'preparing', 'ready', 'out_for_delivery', 'arrived', 'delivered', 'picked_up', 'rejected_by_shop', 'expired', 'not_collected',
  'cancelled_by_customer', 'cancelled_by_shop', 'delivery_failed')),
	CONSTRAINT "orders_address_label_valid" CHECK ("orders"."address_label" IN ('home', 'work', 'other'))
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_listing_id_shop_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."shop_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_actor_id_accounts_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_rate_card_version_rate_card_versions_version_fk" FOREIGN KEY ("rate_card_version") REFERENCES "public"."rate_card_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_lines_listing_id_idx" ON "order_lines" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "order_status_history_order_id_idx" ON "order_status_history" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_number_idx" ON "orders" USING btree ("number");--> statement-breakpoint
CREATE INDEX "orders_account_id_placed_at_idx" ON "orders" USING btree ("account_id","placed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_shop_id_status_idx" ON "orders" USING btree ("shop_id","status");--> statement-breakpoint
-- Frozen at placement (MNY-7): only the status and when it changed may change, and nothing is deleted.
CREATE FUNCTION reject_frozen_order_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) - 'status' - 'status_changed_at' = to_jsonb(OLD) - 'status' - 'status_changed_at' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is frozen at placement: % refused', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_frozen BEFORE UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION reject_frozen_order_change();
--> statement-breakpoint
CREATE TRIGGER orders_no_truncate BEFORE TRUNCATE ON orders
FOR EACH STATEMENT EXECUTE FUNCTION reject_frozen_order_change();
--> statement-breakpoint
-- Lines and history have no changeable column at all.
CREATE FUNCTION reject_order_record_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_lines_no_update_delete BEFORE UPDATE OR DELETE ON order_lines
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER order_lines_no_truncate BEFORE TRUNCATE ON order_lines
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER order_status_history_no_update_delete BEFORE UPDATE OR DELETE ON order_status_history
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER order_status_history_no_truncate BEFORE TRUNCATE ON order_status_history
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_record_change();

CREATE TABLE "order_revision_lines" (
	"revision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"listing_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"base_unit" text NOT NULL,
	"pack_quantity" numeric(12, 3) NOT NULL,
	"original_count" integer NOT NULL,
	"count" integer NOT NULL,
	"original_part_quantity" numeric(12, 3),
	"part_quantity" numeric(12, 3),
	"unit_price" numeric(12, 2) NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"commission" numeric(12, 2) NOT NULL,
	"stock_quantity" numeric(12, 3) NOT NULL,
	"change_reason" text,
	CONSTRAINT "order_revision_lines_revision_id_position_pk" PRIMARY KEY("revision_id","position"),
	CONSTRAINT "order_revision_lines_count_valid" CHECK ("order_revision_lines"."count" BETWEEN 0 AND "order_revision_lines"."original_count"),
	CONSTRAINT "order_revision_lines_stock_valid" CHECK ("order_revision_lines"."stock_quantity" = CASE WHEN "order_revision_lines"."count" = 0 THEN 0 ELSE COALESCE("order_revision_lines"."part_quantity", "order_revision_lines"."count" * "order_revision_lines"."pack_quantity") END),
	CONSTRAINT "order_revision_lines_reason_valid" CHECK ("order_revision_lines"."change_reason" IS NULL OR "order_revision_lines"."change_reason" IN ('out_of_stock', 'damaged', 'near_expiry', 'other')),
	CONSTRAINT "order_revision_lines_reduction_reason" CHECK (("order_revision_lines"."count" = "order_revision_lines"."original_count" AND ("order_revision_lines"."part_quantity" IS NULL OR "order_revision_lines"."part_quantity" = "order_revision_lines"."original_part_quantity")) OR "order_revision_lines"."change_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "order_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" text NOT NULL,
	"source_status" text NOT NULL,
	"actor_id" uuid,
	"actor_role" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirm_by_at" timestamp with time zone NOT NULL,
	"product_value" numeric(12, 2) NOT NULL,
	"delivery_fee" numeric(12, 2) NOT NULL,
	"small_cart_fee" numeric(12, 2),
	"total" numeric(12, 2) NOT NULL,
	"commission" numeric(12, 2) NOT NULL,
	"platform_contribution" numeric(12, 2) NOT NULL,
	"quote" jsonb NOT NULL,
	"below_floor_exception" boolean DEFAULT false NOT NULL,
	"below_floor_shortfall" numeric(12, 2),
	"below_floor_reason" text,
	CONSTRAINT "order_revisions_status_valid" CHECK ("order_revisions"."status" IN ('proposed', 'confirmed', 'declined', 'expired', 'cancelled_negative_contribution')),
	CONSTRAINT "order_revisions_source_status_valid" CHECK ("order_revisions"."source_status" IN ('placed', 'accepted', 'preparing')),
	CONSTRAINT "order_revisions_actor_role_valid" CHECK ("order_revisions"."actor_role" IN ('owner', 'staff', 'system')),
	CONSTRAINT "order_revisions_revision_positive" CHECK ("order_revisions"."revision" >= 1),
	CONSTRAINT "order_revisions_confirmed_at_valid" CHECK (("order_revisions"."status" = 'confirmed' AND "order_revisions"."confirmed_at" IS NOT NULL AND "order_revisions"."confirmed_at" >= "order_revisions"."created_at") OR ("order_revisions"."status" <> 'confirmed' AND "order_revisions"."confirmed_at" IS NULL)),
	CONSTRAINT "order_revisions_confirm_by_at_valid" CHECK ("order_revisions"."confirm_by_at" >= "order_revisions"."created_at"),
	CONSTRAINT "order_revisions_below_floor_valid" CHECK (("order_revisions"."below_floor_exception" = true AND "order_revisions"."below_floor_shortfall" IS NOT NULL AND "order_revisions"."below_floor_shortfall" > 0) OR ("order_revisions"."below_floor_exception" = false AND "order_revisions"."below_floor_shortfall" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_valid";--> statement-breakpoint
ALTER TABLE "order_revision_lines" ADD CONSTRAINT "order_revision_lines_revision_id_order_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."order_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_revision_lines" ADD CONSTRAINT "order_revision_lines_listing_id_shop_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."shop_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_actor_id_accounts_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_revision_lines_listing_id_idx" ON "order_revision_lines" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_revisions_order_id_revision_idx" ON "order_revisions" USING btree ("order_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "order_revisions_one_open_proposal_idx" ON "order_revisions" USING btree ("order_id") WHERE "order_revisions"."status" = 'proposed';--> statement-breakpoint
CREATE INDEX "order_revisions_order_id_status_idx" ON "order_revisions" USING btree ("order_id","status");--> statement-breakpoint
CREATE INDEX "order_revisions_confirm_by_at_idx" ON "order_revisions" USING btree ("confirm_by_at");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" IN ('order_placed', 'order_cancelled_by_customer', 'order_accepted', 'order_rejected', 'order_expired', 'order_partially_accepted'));--> statement-breakpoint
CREATE FUNCTION reject_order_revision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'proposed' AND NEW.status IN ('confirmed', 'declined', 'expired') THEN
      IF (NEW.status = 'confirmed' AND NEW.confirmed_at IS NOT NULL AND OLD.confirmed_at IS NULL)
         OR (NEW.status IN ('declined', 'expired') AND NEW.confirmed_at IS NULL AND OLD.confirmed_at IS NULL) THEN
        IF NEW.status = 'confirmed' THEN
          IF NOT EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND status = 'awaiting_customer_confirm') THEN
            RAISE EXCEPTION 'Cannot confirm revision % for order %: order is not awaiting_customer_confirm', NEW.id, NEW.order_id;
          END IF;
        END IF;
        IF to_jsonb(NEW) - 'status' - 'confirmed_at' = to_jsonb(OLD) - 'status' - 'confirmed_at' THEN
          RETURN NEW;
        END IF;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER order_revisions_frozen BEFORE UPDATE OR DELETE ON order_revisions
FOR EACH ROW EXECUTE FUNCTION reject_order_revision_change();
--> statement-breakpoint
CREATE TRIGGER order_revision_lines_no_update_delete BEFORE UPDATE OR DELETE ON order_revision_lines
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE FUNCTION check_order_awaiting_proposal_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'awaiting_customer_confirm' AND NEW.status <> 'awaiting_customer_confirm' THEN
    IF EXISTS (SELECT 1 FROM order_revisions WHERE order_id = NEW.id AND status = 'proposed') THEN
      RAISE EXCEPTION 'Order % cannot leave awaiting_customer_confirm with an open proposal', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER orders_awaiting_confirm_proposal_check
AFTER UPDATE OF status ON orders
FOR EACH ROW EXECUTE FUNCTION check_order_awaiting_proposal_lifecycle();

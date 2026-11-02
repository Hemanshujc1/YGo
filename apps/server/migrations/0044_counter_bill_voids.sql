CREATE TABLE "counter_bill_voids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"stock_moved" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "counter_bill_voids_reason_valid" CHECK ("counter_bill_voids"."reason" IN ('wrong_item', 'wrong_price', 'billed_twice', 'not_taken', 'other')),
	CONSTRAINT "counter_bill_voids_note_valid" CHECK (("counter_bill_voids"."reason" = 'other') = ("counter_bill_voids"."note" IS NOT NULL) AND btrim("counter_bill_voids"."note") <> '' AND char_length("counter_bill_voids"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_quantity_valid";--> statement-breakpoint
ALTER TABLE "counter_bill_voids" ADD CONSTRAINT "counter_bill_voids_bill_id_counter_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."counter_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "counter_bill_voids_bill_id_idx" ON "counter_bill_voids" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "counter_bills_received_idx" ON "counter_bills" USING btree ("shop_id","received_at");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_valid" CHECK ("stock_movements"."kind" IN ('opening', 'opening_correction', 'sale', 'void'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_valid" CHECK (("stock_movements"."quantity" >= 0 OR "stock_movements"."kind" IN ('opening_correction', 'sale')) AND ("stock_movements"."kind" <> 'sale' OR "stock_movements"."quantity" < 0)
    AND ("stock_movements"."kind" <> 'void' OR "stock_movements"."quantity" > 0) AND "stock_movements"."quantity" <> 'NaN'::numeric);
--> statement-breakpoint
-- A void stays as written (BIL-6), like the bill it is about.
CREATE TRIGGER counter_bill_voids_no_update_delete BEFORE UPDATE OR DELETE ON counter_bill_voids
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER counter_bill_voids_no_truncate BEFORE TRUNCATE ON counter_bill_voids
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_record_change();

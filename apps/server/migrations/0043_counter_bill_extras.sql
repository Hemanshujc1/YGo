CREATE TABLE "counter_bill_manual_lines" (
	"bill_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"count" integer NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	CONSTRAINT "counter_bill_manual_lines_bill_id_position_pk" PRIMARY KEY("bill_id","position"),
	CONSTRAINT "counter_bill_manual_lines_valid" CHECK ("counter_bill_manual_lines"."position" > 0 AND "counter_bill_manual_lines"."count" > 0 AND "counter_bill_manual_lines"."unit_price" >= 0 AND "counter_bill_manual_lines"."unit_price" <> 'NaN'::numeric
    AND btrim("counter_bill_manual_lines"."name") <> '' AND char_length("counter_bill_manual_lines"."name") <= 80)
);
--> statement-breakpoint
ALTER TABLE "counter_bills" ADD COLUMN "discount" numeric(20, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "counter_bills" ADD COLUMN "customer_name" text;--> statement-breakpoint
ALTER TABLE "counter_bills" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "counter_bills" ADD COLUMN "customer_offers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "counter_bill_manual_lines" ADD CONSTRAINT "counter_bill_manual_lines_bill_id_counter_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."counter_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_bills" ADD CONSTRAINT "counter_bills_discount_valid" CHECK ("counter_bills"."discount" >= 0 AND "counter_bills"."discount" <> 'NaN'::numeric);--> statement-breakpoint
ALTER TABLE "counter_bills" ADD CONSTRAINT "counter_bills_customer_valid" CHECK (("counter_bills"."customer_name" IS NOT NULL OR "counter_bills"."customer_phone" IS NOT NULL OR NOT "counter_bills"."customer_offers")
    AND ("counter_bills"."customer_phone" IS NOT NULL OR NOT "counter_bills"."customer_offers"));
--> statement-breakpoint
-- A typed line stays as recorded (BIL-6), like the catalog lines beside it.
CREATE TRIGGER counter_bill_manual_lines_no_update_delete BEFORE UPDATE OR DELETE ON counter_bill_manual_lines
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER counter_bill_manual_lines_no_truncate BEFORE TRUNCATE ON counter_bill_manual_lines
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_record_change();

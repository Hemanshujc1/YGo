CREATE TABLE "counter_bill_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"note" text NOT NULL,
	"stock_moved" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counter_bill_resolutions_action_valid" CHECK ("counter_bill_resolutions"."action" IN ('numbered', 'duplicate', 'reviewed', 'noted')),
	CONSTRAINT "counter_bill_resolutions_note_valid" CHECK (btrim("counter_bill_resolutions"."note") <> '' AND char_length("counter_bill_resolutions"."note") <= 500),
	CONSTRAINT "counter_bill_resolutions_stock_valid" CHECK (NOT "counter_bill_resolutions"."stock_moved" OR "counter_bill_resolutions"."action" = 'numbered')
);
--> statement-breakpoint
ALTER TABLE "counter_bill_resolutions" ADD CONSTRAINT "counter_bill_resolutions_bill_id_counter_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."counter_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "counter_bill_resolutions_closing_idx" ON "counter_bill_resolutions" USING btree ("bill_id") WHERE "counter_bill_resolutions"."action" <> 'noted';--> statement-breakpoint
CREATE INDEX "counter_bill_resolutions_bill_id_idx" ON "counter_bill_resolutions" USING btree ("bill_id");--> statement-breakpoint
-- What Admin decided stays as written (#470), like the bill it is about.
CREATE TRIGGER counter_bill_resolutions_no_update_delete BEFORE UPDATE OR DELETE ON counter_bill_resolutions
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER counter_bill_resolutions_no_truncate BEFORE TRUNCATE ON counter_bill_resolutions
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_record_change();

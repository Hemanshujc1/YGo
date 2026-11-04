CREATE TABLE "push_receipts" (
	"ticket_id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"app" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"check_after" timestamp with time zone NOT NULL,
	"claim_id" uuid,
	"claimed_until" timestamp with time zone,
	CONSTRAINT "push_receipts_app_valid" CHECK ("push_receipts"."app" IN ('customer', 'shopkeeper'))
);
--> statement-breakpoint
CREATE INDEX "push_receipts_check_after_idx" ON "push_receipts" USING btree ("check_after");
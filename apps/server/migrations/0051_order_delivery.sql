CREATE TABLE "delivery_photo_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"byte_length" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "delivery_photo_uploads_byte_length_valid" CHECK ("delivery_photo_uploads"."byte_length" BETWEEN 1 AND 5000000)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "deliverer_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "handover_code_hash" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "handover_code_salt" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "handover_code_ciphertext" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "handover_code_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "handover_code_blocked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "items_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_photo_key" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_payment" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "proof_exception" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "proof_exception_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "failed_delivery_reason" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_call_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shop_members" ADD COLUMN "can_deliver" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_photo_uploads" ADD CONSTRAINT "delivery_photo_uploads_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_photo_uploads" ADD CONSTRAINT "delivery_photo_uploads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_photo_uploads_order_id_idx" ON "delivery_photo_uploads" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_deliverer_id_accounts_id_fk" FOREIGN KEY ("deliverer_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_handover_code_pair" CHECK (("orders"."handover_code_hash" IS NULL) = ("orders"."handover_code_salt" IS NULL) AND ("orders"."handover_code_hash" IS NULL) = ("orders"."handover_code_ciphertext" IS NULL));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_payment_valid" CHECK ("orders"."delivery_payment" IS NULL OR "orders"."delivery_payment" IN ('cash', 'upi'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_frozen_order_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) - 'status' - 'status_changed_at' - 'deliverer_id' - 'handover_code_hash' - 'handover_code_salt' - 'handover_code_ciphertext' - 'handover_code_attempts' - 'handover_code_blocked_until' - 'items_checked_at' - 'delivery_photo_key' - 'delivery_payment' - 'proof_exception' - 'proof_exception_reason' - 'failed_delivery_reason' - 'delivery_call_attempt_at'
    = to_jsonb(OLD) - 'status' - 'status_changed_at' - 'deliverer_id' - 'handover_code_hash' - 'handover_code_salt' - 'handover_code_ciphertext' - 'handover_code_attempts' - 'handover_code_blocked_until' - 'items_checked_at' - 'delivery_photo_key' - 'delivery_payment' - 'proof_exception' - 'proof_exception_reason' - 'failed_delivery_reason' - 'delivery_call_attempt_at' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is frozen at placement: % refused', TG_TABLE_NAME, TG_OP;
END;
$$;

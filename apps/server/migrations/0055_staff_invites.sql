CREATE TABLE "staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"account_id" uuid,
	"can_deliver" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"code_digest" text,
	"code_expires_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "staff_invites_status_valid" CHECK ("staff_invites"."status" IN ('invited', 'active', 'deactivated')),
	CONSTRAINT "staff_invites_code_valid" CHECK (("staff_invites"."status" = 'invited') = ("staff_invites"."code_digest" IS NOT NULL AND "staff_invites"."code_expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invites_shop_phone_idx" ON "staff_invites" USING btree ("shop_id","phone");--> statement-breakpoint
CREATE INDEX "staff_invites_phone_idx" ON "staff_invites" USING btree ("phone");
CREATE TABLE "customer_blocks" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"phone_digest" text NOT NULL,
	"email_digest" text NOT NULL,
	"reason" text NOT NULL,
	"blocked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_blocks_reason_valid" CHECK (btrim("customer_blocks"."reason") <> '' AND char_length("customer_blocks"."reason") <= 500)
);
--> statement-breakpoint
CREATE INDEX "customer_blocks_phone_digest_idx" ON "customer_blocks" USING btree ("phone_digest");
--> statement-breakpoint
CREATE INDEX "customer_blocks_email_digest_idx" ON "customer_blocks" USING btree ("email_digest");
--> statement-breakpoint
CREATE TABLE "customer_signup_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_signup_settings_singleton" CHECK ("customer_signup_settings"."id" = 1)
);
--> statement-breakpoint
INSERT INTO "customer_signup_settings" ("id", "enabled") VALUES (1, true);
--> statement-breakpoint

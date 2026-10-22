CREATE TABLE "saved_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"label" text NOT NULL,
	"flat" text NOT NULL,
	"area_line" text,
	"pincode" text NOT NULL,
	"point" geography(Point,4326),
	"saved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "saved_addresses_label_valid" CHECK ("saved_addresses"."label" IN ('home', 'work', 'other'))
);
--> statement-breakpoint
ALTER TABLE "saved_addresses" ADD CONSTRAINT "saved_addresses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "saved_addresses_account_id_idx" ON "saved_addresses" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_addresses_home_work_idx" ON "saved_addresses" USING btree ("account_id","label") WHERE "saved_addresses"."label" <> 'other';
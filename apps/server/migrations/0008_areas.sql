CREATE TABLE "area_pincodes" (
	"pincode" text PRIMARY KEY NOT NULL,
	"area_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	CONSTRAINT "areas_name_valid" CHECK (btrim("areas"."name") <> '' AND char_length("areas"."name") <= 100)
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"account_id" uuid NOT NULL,
	"pincode" text NOT NULL,
	"phone" text NOT NULL,
	"saved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "waitlist_entries_account_id_pincode_pk" PRIMARY KEY("account_id","pincode")
);
--> statement-breakpoint
ALTER TABLE "area_pincodes" ADD CONSTRAINT "area_pincodes_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "area_pincodes_area_id_idx" ON "area_pincodes" USING btree ("area_id");--> statement-breakpoint
CREATE UNIQUE INDEX "areas_name_idx" ON "areas" USING btree (lower("name"));
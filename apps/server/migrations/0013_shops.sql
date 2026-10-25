CREATE TABLE "shop_members" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "shop_members_role_valid" CHECK ("shop_members"."role" IN ('owner', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"shop_name" text,
	"address" text,
	"pincode" text,
	"location" geography(Point,4326),
	"owner_name" text,
	"entity_type" text,
	"pan" text,
	"fssai_number" text,
	"fssai_expiry" date,
	"service_radius_metres" integer DEFAULT 2000 NOT NULL,
	"upi_id" text,
	"area_id" uuid,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shops_state_valid" CHECK ("shops"."state" IN ('draft', 'submitted', 'under_review', 'approved')),
	CONSTRAINT "shops_entity_type_valid" CHECK ("shops"."entity_type" IN ('proprietorship', 'partnership_firm', 'llp', 'company')),
	CONSTRAINT "shops_service_radius_valid" CHECK ("shops"."service_radius_metres" BETWEEN 500 AND 5000 AND "shops"."service_radius_metres" % 500 = 0),
	CONSTRAINT "shops_sent_complete" CHECK ("shops"."state" = 'draft' OR ("shops"."shop_name" IS NOT NULL AND "shops"."address" IS NOT NULL
    AND "shops"."pincode" IS NOT NULL AND "shops"."location" IS NOT NULL AND "shops"."owner_name" IS NOT NULL
    AND "shops"."entity_type" IS NOT NULL AND "shops"."pan" IS NOT NULL AND "shops"."fssai_number" IS NOT NULL
    AND "shops"."fssai_expiry" IS NOT NULL AND "shops"."upi_id" IS NOT NULL AND "shops"."area_id" IS NOT NULL
    AND "shops"."submitted_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "shop_members" ADD CONSTRAINT "shop_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_members" ADD CONSTRAINT "shop_members_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_members_shop_id_idx" ON "shop_members" USING btree ("shop_id");
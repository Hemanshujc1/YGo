CREATE TABLE "shop_holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"starts" date NOT NULL,
	"ends" date NOT NULL,
	CONSTRAINT "shop_holidays_dates_valid" CHECK ("shop_holidays"."ends" >= "shop_holidays"."starts")
);
--> statement-breakpoint
ALTER TABLE "shop_holidays" ADD CONSTRAINT "shop_holidays_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_holidays_shop_id_ends_idx" ON "shop_holidays" USING btree ("shop_id","ends");
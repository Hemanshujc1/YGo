CREATE TABLE "shop_hours" (
	"shop_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"opens" smallint NOT NULL,
	"closes" smallint NOT NULL,
	CONSTRAINT "shop_hours_shop_id_weekday_opens_pk" PRIMARY KEY("shop_id","weekday","opens"),
	CONSTRAINT "shop_hours_weekday_valid" CHECK ("shop_hours"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "shop_hours_times_valid" CHECK ("shop_hours"."opens" BETWEEN 0 AND 1410 AND "shop_hours"."opens" % 30 = 0 AND "shop_hours"."closes" BETWEEN 0 AND 1410 AND "shop_hours"."closes" % 30 = 0)
);
--> statement-breakpoint
ALTER TABLE "shop_hours" ADD CONSTRAINT "shop_hours_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
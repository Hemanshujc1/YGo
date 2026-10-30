CREATE TABLE "stock_sync_items" (
	"shop_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"payload" jsonb,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stock_sync_items_shop_id_pack_id_pk" PRIMARY KEY("shop_id","pack_id")
);
--> statement-breakpoint
CREATE TABLE "stock_sync_shops" (
	"shop_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_sync_items" ADD CONSTRAINT "stock_sync_items_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_sync_shops" ADD CONSTRAINT "stock_sync_shops_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;
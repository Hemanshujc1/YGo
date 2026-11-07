CREATE TABLE "denylist_words" (
	"word" text PRIMARY KEY NOT NULL,
	CONSTRAINT "denylist_words_normalized" CHECK ("denylist_words"."word" ~ '^[a-z0-9]+( [a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "product_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"pack_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"reason" text,
	"excluded_good" boolean DEFAULT false NOT NULL,
	"mapped_pack_id" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_requests_status_valid" CHECK ("product_requests"."status" IN ('pending', 'approved', 'mapped', 'rejected')),
	CONSTRAINT "product_requests_resolution_valid" CHECK (("product_requests"."status" = 'pending') = ("product_requests"."resolved_at" IS NULL)
    AND ("product_requests"."status" = 'rejected') = ("product_requests"."reason" IS NOT NULL) AND ("product_requests"."status" = 'mapped') = ("product_requests"."mapped_pack_id" IS NOT NULL)
    AND ("product_requests"."excluded_good" = false OR "product_requests"."status" = 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_quantity_valid";--> statement-breakpoint
ALTER TABLE "master_products" ADD COLUMN "requested_by_shop_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "shop_id" uuid;--> statement-breakpoint
ALTER TABLE "shop_listings" ADD COLUMN "removed_from_counter" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_requested_by_accounts_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_product_id_master_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."master_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_pack_id_packs_id_fk" FOREIGN KEY ("pack_id") REFERENCES "public"."packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_listing_id_shop_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."shop_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_mapped_pack_id_packs_id_fk" FOREIGN KEY ("mapped_pack_id") REFERENCES "public"."packs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_resolved_by_accounts_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_requests_client_id_idx" ON "product_requests" USING btree ("shop_id","client_id");--> statement-breakpoint
CREATE INDEX "product_requests_status_created_at_idx" ON "product_requests" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "master_products" ADD CONSTRAINT "master_products_requested_by_shop_id_shops_id_fk" FOREIGN KEY ("requested_by_shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" IN ('order_placed', 'order_cancelled_by_customer', 'order_accepted', 'order_rejected', 'order_expired', 'order_partially_accepted', 'order_cancel_requested', 'order_cancel_agreed', 'order_cancel_kept', 'order_cancelled_by_shop', 'product_request_approved', 'product_request_rejected'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_valid" CHECK ("stock_movements"."kind" IN ('opening', 'opening_correction', 'sale', 'void', 'transfer_out', 'transfer_in'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_valid" CHECK (("stock_movements"."quantity" >= 0 OR "stock_movements"."kind" IN ('opening_correction', 'sale', 'transfer_out', 'transfer_in')) AND ("stock_movements"."kind" <> 'sale' OR "stock_movements"."quantity" < 0)
    AND ("stock_movements"."kind" <> 'void' OR "stock_movements"."quantity" > 0) AND "stock_movements"."quantity" <> 'NaN'::numeric);--> statement-breakpoint
INSERT INTO "denylist_words" ("word") VALUES ('tobacco'), ('cigarette'), ('cigar'), ('bidi'), ('gutka'), ('gutkha'), ('pan masala'), ('hookah'), ('vape'), ('alcohol'), ('liquor'), ('whisky'), ('vodka'), ('rum'), ('beer'), ('wine');

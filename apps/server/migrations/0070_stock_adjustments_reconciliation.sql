CREATE TABLE "stock_reconciliation_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"listing_id" uuid NOT NULL,
	"on_hand" numeric(14, 3) NOT NULL,
	"expected" numeric(14, 3) NOT NULL,
	"difference" numeric(14, 3) NOT NULL,
	"first_found_at" timestamp with time zone NOT NULL,
	"last_found_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "stock_reconciliation_issues_difference_valid" CHECK ("stock_reconciliation_issues"."difference" <> 0 AND "stock_reconciliation_issues"."difference" = "stock_reconciliation_issues"."on_hand" - "stock_reconciliation_issues"."expected")
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_target_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_quantity_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "stock_reconciliation_issues" ADD CONSTRAINT "stock_reconciliation_issues_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reconciliation_issues" ADD CONSTRAINT "stock_reconciliation_issues_listing_id_shop_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."shop_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_reconciliation_issues_open_idx" ON "stock_reconciliation_issues" USING btree ("listing_id") WHERE "stock_reconciliation_issues"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX "stock_reconciliation_issues_shop_idx" ON "stock_reconciliation_issues" USING btree ("shop_id","resolved_at");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_valid" CHECK (("stock_movements"."kind" = 'adjustment') = ("stock_movements"."reason" IS NOT NULL) AND ("stock_movements"."reason" IS NULL OR "stock_movements"."reason" IN ('received', 'counted', 'damaged', 'expired', 'returned', 'correction'))
    AND ("stock_movements"."reason" IS NULL OR "stock_movements"."reason" NOT IN ('damaged', 'expired') OR "stock_movements"."quantity" < 0) AND ("stock_movements"."reason" IS NULL OR "stock_movements"."reason" IN ('counted') OR "stock_movements"."quantity" <> 0));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_target_valid" CHECK (("stock_movements"."kind" = 'opening_correction' OR ("stock_movements"."kind" = 'adjustment' AND "stock_movements"."reason" = 'counted')) = ("stock_movements"."target_quantity" IS NOT NULL) AND "stock_movements"."target_quantity" >= 0);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_valid" CHECK ("stock_movements"."kind" IN ('opening', 'opening_correction', 'adjustment', 'sale', 'void', 'transfer_out', 'transfer_in'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_valid" CHECK (("stock_movements"."quantity" >= 0 OR "stock_movements"."kind" IN ('opening_correction', 'adjustment', 'sale', 'transfer_out', 'transfer_in')) AND ("stock_movements"."kind" <> 'sale' OR "stock_movements"."quantity" < 0)
    AND ("stock_movements"."kind" <> 'void' OR "stock_movements"."quantity" > 0) AND "stock_movements"."quantity" <> 'NaN'::numeric);
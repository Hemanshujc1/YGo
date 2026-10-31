ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_quantity_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_valid" CHECK ("stock_movements"."kind" IN ('opening', 'opening_correction'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_valid" CHECK (("stock_movements"."quantity" >= 0 OR "stock_movements"."kind" = 'opening_correction') AND "stock_movements"."quantity" <> 'NaN'::numeric);
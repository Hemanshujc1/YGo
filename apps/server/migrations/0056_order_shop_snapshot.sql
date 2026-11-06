ALTER TABLE "orders" ADD COLUMN "shop_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_address" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_pincode" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shop_gstin" text;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "gstin" text;--> statement-breakpoint
-- Orders placed before this had no snapshot: the shop's current name, address and pincode are the best we hold (#537).
-- The freeze trigger refuses any change, so it is off for this one backfill and on again straight after.
ALTER TABLE "orders" DISABLE TRIGGER orders_frozen;--> statement-breakpoint
UPDATE "orders" o SET shop_name = s.shop_name, shop_address = s.address, shop_pincode = s.pincode FROM "shops" s WHERE s.id = o.shop_id;--> statement-breakpoint
ALTER TABLE "orders" ENABLE TRIGGER orders_frozen;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shop_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shop_address" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "shop_pincode" SET NOT NULL;

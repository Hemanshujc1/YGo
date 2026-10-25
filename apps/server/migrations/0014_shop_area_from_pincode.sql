ALTER TABLE "shops" DROP CONSTRAINT "shops_sent_complete";--> statement-breakpoint
ALTER TABLE "shops" DROP CONSTRAINT "shops_area_id_areas_id_fk";
--> statement-breakpoint
DROP INDEX "shops_area_id_idx";--> statement-breakpoint
ALTER TABLE "shops" DROP COLUMN "area_id";--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_sent_complete" CHECK ("shops"."state" = 'draft' OR ("shops"."shop_name" IS NOT NULL AND "shops"."address" IS NOT NULL
    AND "shops"."pincode" IS NOT NULL AND "shops"."location" IS NOT NULL AND "shops"."owner_name" IS NOT NULL
    AND "shops"."entity_type" IS NOT NULL AND "shops"."pan" IS NOT NULL AND "shops"."fssai_number" IS NOT NULL
    AND "shops"."fssai_expiry" IS NOT NULL AND "shops"."upi_id" IS NOT NULL
    AND "shops"."submitted_at" IS NOT NULL));
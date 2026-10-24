CREATE TABLE "packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"barcode" text,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "packs_quantity_positive" CHECK ("packs"."quantity" > 0 AND "packs"."quantity" <> 'NaN'::numeric),
	CONSTRAINT "packs_barcode_valid" CHECK ("packs"."barcode" IS NULL OR "packs"."barcode" ~ '^(?:[0-9]{8}|[0-9]{12}|[0-9]{13})$')
);
--> statement-breakpoint
ALTER TABLE "packs" ADD CONSTRAINT "packs_product_id_master_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."master_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "packs_product_quantity_idx" ON "packs" USING btree ("product_id","quantity");--> statement-breakpoint
CREATE UNIQUE INDEX "packs_barcode_idx" ON "packs" USING btree ("barcode");
CREATE TABLE "master_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"category_id" uuid NOT NULL,
	"base_unit" text NOT NULL,
	"classification" text NOT NULL,
	"image_256_key" text,
	"image_512_key" text,
	"image_1024_key" text,
	"active" boolean DEFAULT true NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	CONSTRAINT "master_products_name_valid" CHECK (btrim("master_products"."name") <> '' AND char_length("master_products"."name") <= 200),
	CONSTRAINT "master_products_brand_valid" CHECK ("master_products"."brand" IS NULL OR (btrim("master_products"."brand") <> '' AND char_length("master_products"."brand") <= 100)),
	CONSTRAINT "master_products_unit_valid" CHECK ("master_products"."base_unit" IN ('each', 'kg', 'l')),
	CONSTRAINT "master_products_classification_valid" CHECK ("master_products"."classification" IN ('counted', 'measured')),
	CONSTRAINT "master_products_unit_classification_valid" CHECK (("master_products"."classification" = 'counted' AND "master_products"."base_unit" = 'each') OR ("master_products"."classification" = 'measured' AND "master_products"."base_unit" IN ('kg', 'l'))),
	CONSTRAINT "master_products_published_image_valid" CHECK (NOT "master_products"."published" OR ("master_products"."image_256_key" IS NOT NULL AND "master_products"."image_512_key" IS NOT NULL AND "master_products"."image_1024_key" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "master_products" ADD CONSTRAINT "master_products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "master_products_name_brand_idx" ON "master_products" USING btree (lower("name"),coalesce(lower("brand"), ''));--> statement-breakpoint
CREATE INDEX "master_products_category_id_idx" ON "master_products" USING btree ("category_id");
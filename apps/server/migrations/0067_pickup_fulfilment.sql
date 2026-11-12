CREATE TABLE "shop_fulfilment_modes" (
	"shop_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"shop_on" boolean DEFAULT true NOT NULL,
	"admin_forced_off" boolean DEFAULT false NOT NULL,
	CONSTRAINT "shop_fulfilment_modes_shop_id_mode_pk" PRIMARY KEY("shop_id","mode"),
	CONSTRAINT "shop_fulfilment_modes_mode_valid" CHECK ("shop_fulfilment_modes"."mode" IN ('instant', 'scheduled', 'pickup'))
);
--> statement-breakpoint
ALTER TABLE "order_revisions" DROP CONSTRAINT "order_revisions_total_reconciles";--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "address_label" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "address_flat" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "address_pincode" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "address_point" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD COLUMN "pickup_fee" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfilment" text DEFAULT 'delivery' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "pickup_fee" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "shop_fulfilment_modes" ADD CONSTRAINT "shop_fulfilment_modes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_total_reconciles" CHECK ("order_revisions"."total" = "order_revisions"."product_value" - "order_revisions"."shop_discount" + "order_revisions"."delivery_fee" + COALESCE("order_revisions"."small_cart_fee", 0) + COALESCE("order_revisions"."pickup_fee", 0));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fulfilment_valid" CHECK ("orders"."fulfilment" IN ('delivery', 'pickup'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fulfilment_address" CHECK (("orders"."fulfilment" = 'delivery' AND "orders"."address_label" IS NOT NULL AND "orders"."address_flat" IS NOT NULL
    AND "orders"."address_pincode" IS NOT NULL AND "orders"."address_point" IS NOT NULL AND "orders"."pickup_fee" IS NULL)
    OR ("orders"."fulfilment" = 'pickup' AND "orders"."address_label" IS NULL AND "orders"."address_flat" IS NULL AND "orders"."address_area_line" IS NULL
    AND "orders"."address_pincode" IS NULL AND "orders"."address_point" IS NULL AND "orders"."pickup_fee" IS NOT NULL AND "orders"."delivery_fee" = 0 AND "orders"."small_cart_fee" IS NULL));
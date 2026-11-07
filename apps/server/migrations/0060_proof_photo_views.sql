CREATE TABLE "proof_photo_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"viewed_by" uuid NOT NULL,
	"viewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proof_photo_views" ADD CONSTRAINT "proof_photo_views_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_photo_views" ADD CONSTRAINT "proof_photo_views_viewed_by_accounts_id_fk" FOREIGN KEY ("viewed_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proof_photo_views_order_id_idx" ON "proof_photo_views" USING btree ("order_id");
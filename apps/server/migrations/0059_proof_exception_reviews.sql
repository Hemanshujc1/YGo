CREATE TABLE "proof_exception_reviews" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "proof_exception_reviews" ADD CONSTRAINT "proof_exception_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_exception_reviews" ADD CONSTRAINT "proof_exception_reviews_reviewed_by_accounts_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
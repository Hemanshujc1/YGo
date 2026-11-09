CREATE TABLE "below_floor_exception_reviews" (
	"revision_id" uuid PRIMARY KEY NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "below_floor_exception_reviews" ADD CONSTRAINT "below_floor_exception_reviews_revision_id_order_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."order_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "below_floor_exception_reviews" ADD CONSTRAINT "below_floor_exception_reviews_reviewed_by_accounts_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;
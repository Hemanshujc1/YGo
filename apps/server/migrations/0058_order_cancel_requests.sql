CREATE TABLE "order_cancel_requests" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"settled_by" uuid,
	CONSTRAINT "order_cancel_requests_status_valid" CHECK ("order_cancel_requests"."status" IN ('asked', 'agreed', 'kept', 'closed_unanswered')),
	CONSTRAINT "order_cancel_requests_settled_valid" CHECK (("order_cancel_requests"."status" = 'asked') = ("order_cancel_requests"."settled_at" IS NULL)),
	CONSTRAINT "order_cancel_requests_settled_by_valid" CHECK ("order_cancel_requests"."settled_by" IS NULL OR "order_cancel_requests"."status" IN ('agreed', 'kept'))
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_valid";--> statement-breakpoint
ALTER TABLE "order_cancel_requests" ADD CONSTRAINT "order_cancel_requests_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cancel_requests" ADD CONSTRAINT "order_cancel_requests_settled_by_accounts_id_fk" FOREIGN KEY ("settled_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" IN ('order_placed', 'order_cancelled_by_customer', 'order_accepted', 'order_rejected', 'order_expired', 'order_partially_accepted', 'order_cancel_requested', 'order_cancel_agreed', 'order_cancel_kept', 'order_cancelled_by_shop'));
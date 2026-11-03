CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"app" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"order_id" uuid,
	"loud" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_app_valid" CHECK ("notifications"."app" IN ('customer', 'shopkeeper')),
	CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" IN ('order_placed', 'order_cancelled_by_customer', 'order_accepted', 'order_rejected'))
);
--> statement-breakpoint
CREATE TABLE "push_queue" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "push_queue_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"notification_id" uuid NOT NULL,
	"token" text,
	"send_after" timestamp with time zone NOT NULL,
	"tries" integer DEFAULT 0 NOT NULL,
	"claimed_until" timestamp with time zone,
	CONSTRAINT "push_queue_tries_valid" CHECK ("push_queue"."tries" BETWEEN 0 AND 2)
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"app" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "push_tokens_app_valid" CHECK ("push_tokens"."app" IN ('customer', 'shopkeeper'))
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_token_push_tokens_token_fk" FOREIGN KEY ("token") REFERENCES "public"."push_tokens"("token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_account_id_app_created_at_idx" ON "notifications" USING btree ("account_id","app","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "push_queue_send_after_idx" ON "push_queue" USING btree ("send_after");--> statement-breakpoint
CREATE INDEX "push_queue_token_idx" ON "push_queue" USING btree ("token");--> statement-breakpoint
CREATE INDEX "push_tokens_session_id_idx" ON "push_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_account_id_idx" ON "sessions" USING btree ("account_id");
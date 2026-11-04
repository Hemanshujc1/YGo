ALTER TABLE "push_tokens" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_platform_valid" CHECK ("push_tokens"."platform" IS NULL OR "push_tokens"."platform" IN ('android', 'ios'));--> statement-breakpoint
CREATE TABLE "ring_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"token" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "ring_attempts" ADD CONSTRAINT "ring_attempts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ring_attempts" ADD CONSTRAINT "ring_attempts_token_push_tokens_token_fk" FOREIGN KEY ("token") REFERENCES "public"."push_tokens"("token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ring_attempts_order_id_idx" ON "ring_attempts" USING btree ("order_id");--> statement-breakpoint
ALTER TABLE "push_queue" ADD COLUMN "ring_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "push_queue" ADD COLUMN "floor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "push_queue" ADD CONSTRAINT "push_queue_ring_attempt_id_ring_attempts_id_fk" FOREIGN KEY ("ring_attempt_id") REFERENCES "public"."ring_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_queue_ring_attempt_id_idx" ON "push_queue" USING btree ("ring_attempt_id");


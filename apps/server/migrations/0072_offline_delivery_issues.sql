CREATE TABLE "offline_delivery_issues" (
	"action_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"action" text NOT NULL,
	"code" text NOT NULL,
	"clock_suspect" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "offline_delivery_issues_account_id_action_id_pk" PRIMARY KEY("account_id","action_id")
);
--> statement-breakpoint
CREATE INDEX "offline_delivery_issues_order_idx" ON "offline_delivery_issues" USING btree ("order_id","created_at");
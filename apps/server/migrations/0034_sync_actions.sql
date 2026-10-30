CREATE TABLE "sync_actions" (
	"account_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"clock_suspect" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_devices" (
	"account_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sync_actions_identity_idx" ON "sync_actions" USING btree ("account_id","action_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_actions_sequence_idx" ON "sync_actions" USING btree ("account_id","device_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_devices_identity_idx" ON "sync_devices" USING btree ("account_id","device_id");
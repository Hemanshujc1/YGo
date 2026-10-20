CREATE TABLE "refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"replaced_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_session_generation_idx" ON "refresh_tokens" USING btree ("session_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_one_current_idx" ON "refresh_tokens" USING btree ("session_id") WHERE "refresh_tokens"."replaced_at" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "refresh_token_hash";
CREATE TABLE "identity_challenges" (
	"nonce" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"address" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "identity_challenges_expiry_idx" ON "identity_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "identity_challenges_address_idx" ON "identity_challenges" USING btree ("address");
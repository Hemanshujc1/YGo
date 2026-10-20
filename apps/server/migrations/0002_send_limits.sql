CREATE TABLE "email_code_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"address" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_code_sends_email_sent_at_idx" ON "email_code_sends" USING btree ("email","sent_at");--> statement-breakpoint
CREATE INDEX "email_code_sends_address_sent_at_idx" ON "email_code_sends" USING btree ("address","sent_at");
CREATE TABLE "rate_card_versions" (
	"version" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rate_card_versions_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid,
	"values" jsonb NOT NULL,
	"reason" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_card_versions_scope_valid" CHECK (("rate_card_versions"."scope_type" = 'global' AND "rate_card_versions"."scope_id" IS NULL) OR ("rate_card_versions"."scope_type" IN ('area', 'category', 'shop') AND "rate_card_versions"."scope_id" IS NOT NULL)),
	CONSTRAINT "rate_card_versions_reason_valid" CHECK (btrim("rate_card_versions"."reason") <> '' AND char_length("rate_card_versions"."reason") <= 500)
);
--> statement-breakpoint
ALTER TABLE "rate_card_versions" ADD CONSTRAINT "rate_card_versions_actor_id_accounts_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_card_versions_scope_idx" ON "rate_card_versions" USING btree ("scope_type","scope_id","version" DESC NULLS LAST);
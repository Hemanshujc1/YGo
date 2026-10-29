CREATE TABLE "shop_agreement_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"agreement_version" integer NOT NULL,
	"rate_card_version" bigint NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "shop_agreement_acceptances_version_valid" CHECK ("shop_agreement_acceptances"."agreement_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "shop_agreement_acceptances" ADD CONSTRAINT "shop_agreement_acceptances_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_agreement_acceptances" ADD CONSTRAINT "shop_agreement_acceptances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_agreement_acceptances" ADD CONSTRAINT "shop_agreement_acceptances_rate_card_version_rate_card_versions_version_fk" FOREIGN KEY ("rate_card_version") REFERENCES "public"."rate_card_versions"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shop_agreement_acceptances_shop_idx" ON "shop_agreement_acceptances" USING btree ("shop_id","accepted_at" DESC NULLS LAST);--> statement-breakpoint
-- An acceptance is the record of what the Owner agreed to, so it is never changed or removed (ONB-5).
CREATE TRIGGER shop_agreement_acceptances_no_update_delete BEFORE UPDATE OR DELETE ON shop_agreement_acceptances
FOR EACH ROW EXECUTE FUNCTION reject_rate_card_change();

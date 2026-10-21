CREATE TABLE "admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_account_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_actions_action_nonempty" CHECK (btrim("admin_actions"."action") <> ''),
	CONSTRAINT "admin_actions_reason_valid" CHECK (btrim("admin_actions"."reason") <> '' AND char_length("admin_actions"."reason") <= 500),
	CONSTRAINT "admin_actions_actor_valid" CHECK (("admin_actions"."action" = 'admin.bootstrap' AND "admin_actions"."actor_id" IS NULL AND "admin_actions"."reason" = 'Initial Admin bootstrap') OR ("admin_actions"."action" <> 'admin.bootstrap' AND "admin_actions"."actor_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "admin_memberships" (
	"account_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_memberships" ADD CONSTRAINT "admin_memberships_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_actions_one_bootstrap_idx" ON "admin_actions" USING btree ("action") WHERE "admin_actions"."action" = 'admin.bootstrap';
--> statement-breakpoint
CREATE FUNCTION reject_admin_action_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_actions is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER admin_actions_no_update_delete BEFORE UPDATE OR DELETE ON admin_actions
FOR EACH ROW EXECUTE FUNCTION reject_admin_action_change();
--> statement-breakpoint
CREATE TRIGGER admin_actions_no_truncate BEFORE TRUNCATE ON admin_actions
FOR EACH STATEMENT EXECUTE FUNCTION reject_admin_action_change();

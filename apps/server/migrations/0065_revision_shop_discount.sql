ALTER TABLE "order_revisions" ADD COLUMN "shop_discount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD COLUMN "shop_discount_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD COLUMN "shop_discount_rule_version" integer;--> statement-breakpoint
ALTER TABLE "order_revision_lines" ADD COLUMN "shop_discount" numeric(12, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_shop_discount_rule_fk" FOREIGN KEY ("shop_discount_rule_id","shop_discount_rule_version") REFERENCES "public"."shop_discount_versions"("rule_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- A revision carries its own discount (#572): never negative, never above its product value, a rule named whenever the order had one (an amount of 0 keeps it),
-- and a total that reconciles to the paisa. Lines and the revision's sum are checked below.
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_shop_discount_valid" CHECK ("order_revisions"."shop_discount" >= 0 AND "order_revisions"."shop_discount" <= "order_revisions"."product_value"
    AND ("order_revisions"."shop_discount_rule_id" IS NULL) = ("order_revisions"."shop_discount_rule_version" IS NULL)
    AND ("order_revisions"."shop_discount" = 0 OR "order_revisions"."shop_discount_rule_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "order_revisions" ADD CONSTRAINT "order_revisions_total_reconciles" CHECK ("order_revisions"."total" = "order_revisions"."product_value" - "order_revisions"."shop_discount" + "order_revisions"."delivery_fee" + COALESCE("order_revisions"."small_cart_fee", 0));--> statement-breakpoint
ALTER TABLE "order_revision_lines" ADD CONSTRAINT "order_revision_lines_shop_discount_valid" CHECK ("order_revision_lines"."shop_discount" >= 0 AND "order_revision_lines"."shop_discount" <= "order_revision_lines"."line_total");--> statement-breakpoint
-- The revision's discount is the sum of its lines' shares. Lines are inserted after the revision, so the check runs when the transaction commits.
-- Once inserted, a revision's figures can never change (reject_order_revision_change allows only its status and confirmed_at to move), so one that passes here cannot drift.
CREATE FUNCTION check_order_revision_discount_sum() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM order_revisions r
    WHERE r.id = NEW.id
      AND (r.shop_discount <> (SELECT COALESCE(sum(l.shop_discount), 0) FROM order_revision_lines l WHERE l.revision_id = r.id)
        OR r.product_value <> (SELECT COALESCE(sum(l.line_total), 0) FROM order_revision_lines l WHERE l.revision_id = r.id))
  ) THEN
    RAISE EXCEPTION 'Revision % does not add up: its product value and discount must equal the sums of its lines'' totals and discounts', NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER order_revisions_discount_sum AFTER INSERT ON order_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_order_revision_discount_sum();

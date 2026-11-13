CREATE TABLE "statement_lines" (
	"order_id" uuid PRIMARY KEY NOT NULL,
	"statement_id" uuid NOT NULL,
	"order_number" integer NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"late" boolean NOT NULL,
	"fulfilment" text NOT NULL,
	"order_total" numeric(12, 2) NOT NULL,
	"commission" numeric(12, 2) NOT NULL,
	"fee_share" numeric(12, 2) NOT NULL,
	"booking_fees" numeric(12, 2) NOT NULL,
	"platform_coupon" numeric(12, 2) NOT NULL,
	"owed" numeric(12, 2) NOT NULL,
	CONSTRAINT "statement_lines_fulfilment_valid" CHECK ("statement_lines"."fulfilment" IN ('delivery', 'pickup')),
	CONSTRAINT "statement_lines_owed_reconciles" CHECK ("statement_lines"."owed" = "statement_lines"."commission" + "statement_lines"."fee_share" + "statement_lines"."booking_fees" - "statement_lines"."platform_coupon"
    AND "statement_lines"."platform_coupon" >= 0 AND "statement_lines"."booking_fees" >= 0)
);
--> statement-breakpoint
CREATE TABLE "statement_weeks" (
	"period_start" date PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone NOT NULL,
	"statement_count" integer NOT NULL,
	CONSTRAINT "statement_weeks_monday" CHECK (extract(isodow FROM "statement_weeks"."period_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "statements_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1001 CACHE 1),
	"shop_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"grace_days" integer NOT NULL,
	"due_on" date NOT NULL,
	"shop_name" text NOT NULL,
	"shop_address" text,
	"shop_pincode" text,
	"order_count" integer NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	CONSTRAINT "statements_period_valid" CHECK (extract(isodow FROM "statements"."period_start") = 1 AND "statements"."period_end" = "statements"."period_start" + 6
    AND "statements"."issued_at" >= ("statements"."period_end" + 1)::timestamp AT TIME ZONE 'Asia/Kolkata'),
	CONSTRAINT "statements_due_valid" CHECK ("statements"."grace_days" >= 0 AND "statements"."due_on" = ("statements"."issued_at" AT TIME ZONE 'Asia/Kolkata')::date + "statements"."grace_days"),
	CONSTRAINT "statements_total_valid" CHECK ("statements"."order_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_kind_valid";--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "statement_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statements" ADD CONSTRAINT "statements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statement_lines_statement_idx" ON "statement_lines" USING btree ("statement_id","completed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "statements_number_idx" ON "statements" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "statements_shop_week_idx" ON "statements" USING btree ("shop_id","period_start");--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_statement_id_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_kind_valid" CHECK ("notifications"."kind" IN ('order_placed', 'order_cancelled_by_customer', 'order_accepted', 'order_rejected', 'order_expired', 'order_partially_accepted', 'order_cancel_requested', 'order_cancel_agreed', 'order_cancel_kept', 'order_cancelled_by_shop', 'order_total_confirmed', 'product_request_approved', 'product_request_rejected', 'shop_discount_paused', 'coupon_paused', 'pickup_ready', 'pickup_not_collected', 'order_delivery_failed', 'statement_issued'));--> statement-breakpoint
-- A statement, its lines and the record of a finished week never change once made (#629, MNY-12): what the shop was told it owes stays what it was told.
CREATE FUNCTION reject_statement_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER statements_no_update_delete BEFORE UPDATE OR DELETE ON statements FOR EACH ROW EXECUTE FUNCTION reject_statement_change();
--> statement-breakpoint
CREATE TRIGGER statements_no_truncate BEFORE TRUNCATE ON statements FOR EACH STATEMENT EXECUTE FUNCTION reject_statement_change();
--> statement-breakpoint
CREATE TRIGGER statement_lines_no_update_delete BEFORE UPDATE OR DELETE ON statement_lines FOR EACH ROW EXECUTE FUNCTION reject_statement_change();
--> statement-breakpoint
CREATE TRIGGER statement_lines_no_truncate BEFORE TRUNCATE ON statement_lines FOR EACH STATEMENT EXECUTE FUNCTION reject_statement_change();
--> statement-breakpoint
CREATE TRIGGER statement_weeks_no_update_delete BEFORE UPDATE OR DELETE ON statement_weeks FOR EACH ROW EXECUTE FUNCTION reject_statement_change();
--> statement-breakpoint
CREATE TRIGGER statement_weeks_no_truncate BEFORE TRUNCATE ON statement_weeks FOR EACH STATEMENT EXECUTE FUNCTION reject_statement_change();
--> statement-breakpoint
-- Q-6: at commit, a statement's total and order count are exactly those of its lines, to the paisa.
CREATE FUNCTION check_statement_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM statements s
    CROSS JOIN LATERAL (SELECT COALESCE(sum(l.owed), 0) AS owed, count(*)::integer AS orders FROM statement_lines l WHERE l.statement_id = s.id) lines
    WHERE s.id = NEW.id AND (s.total <> lines.owed OR s.order_count <> lines.orders)
  ) THEN
    RAISE EXCEPTION 'Statement % does not add up: its total and order count must equal its lines', NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER statements_total_reconciles AFTER INSERT ON statements
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_statement_total();

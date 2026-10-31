CREATE TABLE "counter_bill_lines" (
	"bill_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"pack_id" uuid NOT NULL,
	"count" integer NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	CONSTRAINT "counter_bill_lines_bill_id_position_pk" PRIMARY KEY("bill_id","position"),
	CONSTRAINT "counter_bill_lines_valid" CHECK ("counter_bill_lines"."position" > 0 AND "counter_bill_lines"."count" > 0 AND "counter_bill_lines"."unit_price" >= 0 AND "counter_bill_lines"."unit_price" <> 'NaN'::numeric)
);
--> statement-breakpoint
CREATE TABLE "counter_bill_numbers" (
	"shop_id" uuid PRIMARY KEY NOT NULL,
	"last_number" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counter_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"reference_clash" boolean DEFAULT false NOT NULL,
	"number" integer,
	"held_reason" text,
	"invalid_payload" jsonb,
	"payment" text,
	"total" numeric(20, 2),
	"checked_total" numeric(20, 2),
	"total_mismatch" boolean GENERATED ALWAYS AS (COALESCE(total <> checked_total, false)) STORED NOT NULL,
	"clock_suspect" boolean NOT NULL,
	"made_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "counter_bills_held_valid" CHECK (("counter_bills"."number" IS NULL) = ("counter_bills"."held_reason" IS NOT NULL) AND "counter_bills"."number" > 0
    AND "counter_bills"."held_reason" IN ('reference_taken', 'not_listed', 'too_old', 'invalid')),
	CONSTRAINT "counter_bills_recorded_valid" CHECK (("counter_bills"."held_reason" IS NOT DISTINCT FROM 'invalid') = ("counter_bills"."invalid_payload" IS NOT NULL)
    AND ("counter_bills"."invalid_payload" IS NULL) = ("counter_bills"."payment" IS NOT NULL AND "counter_bills"."total" IS NOT NULL AND "counter_bills"."checked_total" IS NOT NULL)),
	CONSTRAINT "counter_bills_payment_valid" CHECK ("counter_bills"."payment" IN ('cash', 'upi')),
	CONSTRAINT "counter_bills_reference_valid" CHECK ("counter_bills"."reference" ~ '^[0-9A-F]{4}-[0-9A-F]{4}$'),
	CONSTRAINT "counter_bills_total_valid" CHECK ("counter_bills"."total" >= 0 AND "counter_bills"."checked_total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_kind_valid";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_quantity_valid";--> statement-breakpoint
ALTER TABLE "counter_bill_lines" ADD CONSTRAINT "counter_bill_lines_bill_id_counter_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."counter_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_bill_numbers" ADD CONSTRAINT "counter_bill_numbers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counter_bills" ADD CONSTRAINT "counter_bills_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "counter_bills_client_id_idx" ON "counter_bills" USING btree ("shop_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "counter_bills_number_idx" ON "counter_bills" USING btree ("shop_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "counter_bills_reference_idx" ON "counter_bills" USING btree ("shop_id","reference") WHERE NOT "counter_bills"."reference_clash";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_kind_valid" CHECK ("stock_movements"."kind" IN ('opening', 'opening_correction', 'sale'));--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_valid" CHECK (("stock_movements"."quantity" >= 0 OR "stock_movements"."kind" IN ('opening_correction', 'sale')) AND ("stock_movements"."kind" <> 'sale' OR "stock_movements"."quantity" < 0) AND "stock_movements"."quantity" <> 'NaN'::numeric);--> statement-breakpoint
-- A bill stays as the phone recorded it (BIL-6). Only a held bill may change, by taking the shop's next number:
-- whoever resolves it raises counter_bill_numbers first, so the sequence keeps no gap and no repeat (BIL-5).
CREATE FUNCTION reject_counter_bill_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.number IS NULL AND NEW.held_reason IS NULL
    AND NEW.number = (SELECT last_number FROM counter_bill_numbers WHERE shop_id = NEW.shop_id)
    AND to_jsonb(NEW) - 'number' - 'held_reason' - 'total_mismatch' = to_jsonb(OLD) - 'number' - 'held_reason' - 'total_mismatch' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is kept as recorded: % refused', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER counter_bills_recorded BEFORE UPDATE OR DELETE ON counter_bills
FOR EACH ROW EXECUTE FUNCTION reject_counter_bill_change();
--> statement-breakpoint
CREATE TRIGGER counter_bills_no_truncate BEFORE TRUNCATE ON counter_bills
FOR EACH STATEMENT EXECUTE FUNCTION reject_counter_bill_change();
--> statement-breakpoint
CREATE TRIGGER counter_bill_lines_no_update_delete BEFORE UPDATE OR DELETE ON counter_bill_lines
FOR EACH ROW EXECUTE FUNCTION reject_order_record_change();
--> statement-breakpoint
CREATE TRIGGER counter_bill_lines_no_truncate BEFORE TRUNCATE ON counter_bill_lines
FOR EACH STATEMENT EXECUTE FUNCTION reject_order_record_change();

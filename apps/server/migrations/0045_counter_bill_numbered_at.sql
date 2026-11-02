DROP INDEX "counter_bills_received_idx";--> statement-breakpoint
ALTER TABLE "counter_bills" ADD COLUMN "numbered_at" timestamp with time zone;--> statement-breakpoint
-- Bills numbered so far: when Admin numbered a held one, else on arrival (#497). Only the backfill may pass the trigger.
ALTER TABLE "counter_bills" DISABLE TRIGGER "counter_bills_recorded";--> statement-breakpoint
UPDATE "counter_bills" b SET "numbered_at" = COALESCE(
  (SELECT r."created_at" FROM "counter_bill_resolutions" r WHERE r."bill_id" = b."id" AND r."action" = 'numbered'), b."received_at")
WHERE b."number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "counter_bills" ENABLE TRIGGER "counter_bills_recorded";--> statement-breakpoint
CREATE INDEX "counter_bills_listed_idx" ON "counter_bills" USING btree ("shop_id",COALESCE("numbered_at", "received_at"));--> statement-breakpoint
ALTER TABLE "counter_bills" ADD CONSTRAINT "counter_bills_numbered_valid" CHECK (("counter_bills"."number" IS NULL) = ("counter_bills"."numbered_at" IS NULL));--> statement-breakpoint
-- Numbering a held bill now also stamps when (#497), never before the bill arrived; the check above makes the
-- stamp part of numbering.
CREATE OR REPLACE FUNCTION reject_counter_bill_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.number IS NULL AND NEW.held_reason IS NULL
    AND NEW.number = (SELECT last_number FROM counter_bill_numbers WHERE shop_id = NEW.shop_id)
    AND NEW.numbered_at >= OLD.received_at
    AND to_jsonb(NEW) - 'number' - 'held_reason' - 'total_mismatch' - 'numbered_at' = to_jsonb(OLD) - 'number' - 'held_reason' - 'total_mismatch' - 'numbered_at' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is kept as recorded: % refused', TG_TABLE_NAME, TG_OP;
END;
$$;

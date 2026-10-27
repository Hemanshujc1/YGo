CREATE TABLE "onboarding_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"amount" numeric(12, 2),
	"payment_date" date,
	"reference" text,
	"reason" text,
	CONSTRAINT "onboarding_fees_status_valid" CHECK (("onboarding_fees"."status" = 'waived' AND "onboarding_fees"."reason" IS NOT NULL AND "onboarding_fees"."amount" IS NULL AND "onboarding_fees"."payment_date" IS NULL AND "onboarding_fees"."reference" IS NULL) OR ("onboarding_fees"."status" = 'paid' AND "onboarding_fees"."amount" IS NOT NULL AND "onboarding_fees"."payment_date" IS NOT NULL AND "onboarding_fees"."reference" IS NOT NULL)),
	CONSTRAINT "onboarding_fees_amount_valid" CHECK ("onboarding_fees"."amount" IS NULL OR ("onboarding_fees"."amount" > 0 AND "onboarding_fees"."amount" <> 'NaN'::numeric)),
	CONSTRAINT "onboarding_fees_date_valid" CHECK ("onboarding_fees"."payment_date" IS NULL OR (isfinite("onboarding_fees"."payment_date") AND "onboarding_fees"."payment_date" <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)),
	CONSTRAINT "onboarding_fees_reference_valid" CHECK ("onboarding_fees"."reference" IS NULL OR (btrim("onboarding_fees"."reference") <> '' AND char_length("onboarding_fees"."reference") <= 500)),
	CONSTRAINT "onboarding_fees_reason_valid" CHECK ("onboarding_fees"."reason" IS NULL OR (btrim("onboarding_fees"."reason") <> '' AND char_length("onboarding_fees"."reason") <= 500))
);
--> statement-breakpoint
CREATE TABLE "shop_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"visit_date" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pan" boolean NOT NULL,
	"fssai" boolean NOT NULL,
	"owner_phone" boolean NOT NULL,
	"owner_email" boolean NOT NULL,
	"alarm_permission" boolean NOT NULL,
	"tester_opt_in" boolean NOT NULL,
	"notes" text,
	CONSTRAINT "shop_visits_date_valid" CHECK (isfinite("shop_visits"."visit_date") AND "shop_visits"."visit_date" <= (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),
	CONSTRAINT "shop_visits_checks_complete" CHECK ("shop_visits"."pan" AND "shop_visits"."fssai" AND "shop_visits"."owner_phone" AND "shop_visits"."owner_email" AND "shop_visits"."alarm_permission" AND "shop_visits"."tester_opt_in"),
	CONSTRAINT "shop_visits_notes_valid" CHECK ("shop_visits"."notes" IS NULL OR char_length("shop_visits"."notes") <= 500)
);
--> statement-breakpoint
CREATE TABLE "visit_photo_uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"byte_length" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "visit_photo_uploads_size_valid" CHECK ("visit_photo_uploads"."byte_length" BETWEEN 1 AND 10000000)
);
--> statement-breakpoint
CREATE TABLE "visit_photos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"visit_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"captured_at" text,
	CONSTRAINT "visit_photos_visit_id_unique" UNIQUE("visit_id"),
	CONSTRAINT "visit_photos_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "visit_photos_key_valid" CHECK (btrim("visit_photos"."object_key") <> ''),
	CONSTRAINT "visit_photos_latitude_valid" CHECK ("visit_photos"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "visit_photos_longitude_valid" CHECK ("visit_photos"."longitude" BETWEEN -180 AND 180)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "phone_visit_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "email_visit_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "onboarding_fees" ADD CONSTRAINT "onboarding_fees_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_visits" ADD CONSTRAINT "shop_visits_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_photo_uploads" ADD CONSTRAINT "visit_photo_uploads_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_photos" ADD CONSTRAINT "visit_photos_visit_id_shop_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."shop_visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "onboarding_fees_shop_recorded_idx" ON "onboarding_fees" USING btree ("shop_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "shop_visits_shop_recorded_idx" ON "shop_visits" USING btree ("shop_id","recorded_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "visit_photo_uploads_expiry_idx" ON "visit_photo_uploads" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_phone_confirmation_valid" CHECK ("accounts"."phone_visit_confirmed_at" IS NULL OR "accounts"."phone" IS NOT NULL);
--> statement-breakpoint
-- A replacement contact cannot inherit an in-person confirmation (#321 owner decision).
CREATE FUNCTION clear_changed_contact_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    NEW.phone_visit_confirmed_at := NULL;
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    NEW.email_visit_confirmed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER accounts_clear_contact_confirmation BEFORE UPDATE ON accounts
FOR EACH ROW EXECUTE FUNCTION clear_changed_contact_confirmation();
--> statement-breakpoint
CREATE FUNCTION check_visit_shop_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Lock the shop so a concurrent state change cannot race the visit.
  PERFORM 1 FROM shops WHERE id = NEW.shop_id
    AND state IN ('submitted', 'under_review', 'approved') FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Visits require a Submitted, Under Review or Approved shop' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_visits_check_state BEFORE INSERT ON shop_visits
FOR EACH ROW EXECUTE FUNCTION check_visit_shop_state();
--> statement-breakpoint
CREATE FUNCTION check_fee_change_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialize fee appends for this shop before looking for earlier records.
  PERFORM 1 FROM shops WHERE id = NEW.shop_id FOR UPDATE;
  IF NEW.reason IS NULL AND EXISTS (SELECT 1 FROM onboarding_fees WHERE shop_id = NEW.shop_id) THEN
    RAISE EXCEPTION 'Changing an onboarding fee requires a reason' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER onboarding_fees_check_change BEFORE INSERT ON onboarding_fees
FOR EACH ROW EXECUTE FUNCTION check_fee_change_reason();
--> statement-breakpoint
CREATE FUNCTION reject_visit_fee_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shop_visits_no_update_delete BEFORE UPDATE OR DELETE ON shop_visits
FOR EACH ROW EXECUTE FUNCTION reject_visit_fee_change();
--> statement-breakpoint
CREATE TRIGGER shop_visits_no_truncate BEFORE TRUNCATE ON shop_visits
FOR EACH STATEMENT EXECUTE FUNCTION reject_visit_fee_change();
--> statement-breakpoint
CREATE TRIGGER onboarding_fees_no_update_delete BEFORE UPDATE OR DELETE ON onboarding_fees
FOR EACH ROW EXECUTE FUNCTION reject_visit_fee_change();
--> statement-breakpoint
CREATE TRIGGER onboarding_fees_no_truncate BEFORE TRUNCATE ON onboarding_fees
FOR EACH STATEMENT EXECUTE FUNCTION reject_visit_fee_change();

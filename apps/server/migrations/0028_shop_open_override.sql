ALTER TABLE "shops" ADD COLUMN "open_override" boolean;--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN "open_override_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shops" ADD CONSTRAINT "shops_open_override_pair" CHECK (("shops"."open_override" IS NULL) = ("shops"."open_override_until" IS NULL));
ALTER TABLE "counter_bills" ADD COLUMN "flagged_denylist" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "denylist_words" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "shop_quantity_price_options" ADD COLUMN "flagged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
INSERT INTO "denylist_words" ("word") VALUES
  ('daru'), ('sharab'), ('tambaku'),
  ('cough syrup'), ('paracetamol'), ('dolo'), ('crocin'), ('dawai'),
  ('chicken'), ('mutton'), ('fish'), ('machhi'), ('prawns'),
  ('crackers'), ('fatake'), ('patakhe'),
  ('lpg'), ('gas cylinder'), ('petrol'), ('kerosene'), ('rockel'),
  ('pesticide'), ('keetnashak'),
  ('lottery'),
  ('infant formula'), ('lactogen')
ON CONFLICT DO NOTHING;
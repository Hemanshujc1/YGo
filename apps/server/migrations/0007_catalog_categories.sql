CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "categories_name_valid" CHECK (btrim("categories"."name") <> '' AND char_length("categories"."name") <= 100)
);
--> statement-breakpoint
ALTER TABLE "admin_actions" RENAME COLUMN "target_account_id" TO "target_id";--> statement-breakpoint
ALTER TABLE "admin_actions" ADD COLUMN "target_type" text DEFAULT 'account' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_root_name_idx" ON "categories" USING btree (lower("name")) WHERE "categories"."parent_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "categories_child_name_idx" ON "categories" USING btree ("parent_id",lower("name")) WHERE "categories"."parent_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id");
--> statement-breakpoint
CREATE FUNCTION categories_two_levels() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id OR NOT EXISTS (
      SELECT 1 FROM categories WHERE id = NEW.parent_id AND parent_id IS NULL FOR UPDATE
    ) THEN RAISE EXCEPTION 'Category parent must be top-level'; END IF;
    IF EXISTS (SELECT 1 FROM categories WHERE parent_id = NEW.id) THEN
      RAISE EXCEPTION 'Category with children cannot become a child';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER categories_two_levels_trigger BEFORE INSERT OR UPDATE OF parent_id ON categories
FOR EACH ROW EXECUTE FUNCTION categories_two_levels();
--> statement-breakpoint
INSERT INTO categories (name) VALUES ('Groceries'), ('Fruits and Vegetables'), ('Stationery');

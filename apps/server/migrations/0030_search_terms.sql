CREATE TABLE "search_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"typed_word" text NOT NULL,
	"catalog_word" text NOT NULL,
	CONSTRAINT "search_terms_words_valid" CHECK ("search_terms"."typed_word" ~ '^[a-z ]{2,40}$' AND "search_terms"."catalog_word" ~ '^[a-z ]{2,40}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "search_terms_pair_idx" ON "search_terms" USING btree ("typed_word","catalog_word");
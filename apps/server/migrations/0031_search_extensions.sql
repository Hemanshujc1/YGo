-- Customer search (#398): trigram matching catches small typos, unaccent ignores accents (ADR-0002).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
-- Text as search compares it: no accents, lower case, and every run of other characters one space.
CREATE FUNCTION search_text(value text) RETURNS text AS $$
  SELECT trim(regexp_replace(lower(unaccent(value)), '[^a-z0-9]+', ' ', 'g'))
$$ LANGUAGE sql STABLE;

SET search_path = automations, pg_catalog;

-- The ADD COLUMN default IS the backfill: every existing movement predates
-- language versioning, so it is pinned to version 1 (the language as of v0.6.0).
ALTER TABLE movement
	ADD COLUMN validity_checked_against integer,
	ADD COLUMN language_version integer DEFAULT 1 NOT NULL;

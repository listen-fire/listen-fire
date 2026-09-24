
SET search_path = public, pg_catalog;

ALTER TABLE llm_usage
	DROP COLUMN IF EXISTS byot,
	ADD COLUMN preferred_model text;

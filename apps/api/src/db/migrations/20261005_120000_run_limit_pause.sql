SET search_path = automations, pg_catalog;

ALTER TABLE trigger_run
	ADD COLUMN limit_pause jsonb,
	ADD COLUMN cost_cap_baseline_microdollars bigint DEFAULT 0 NOT NULL;

ALTER TABLE parked_run
	DROP CONSTRAINT parked_run_park_reason_check;

ALTER TABLE parked_run
	ADD CONSTRAINT parked_run_park_reason_check CHECK ((park_reason = ANY (ARRAY['ask'::text, 'timer'::text, 'await'::text, 'limit'::text])));

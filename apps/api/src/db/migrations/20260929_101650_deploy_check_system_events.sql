
SET search_path = automations, pg_catalog;

CREATE TABLE deploy_check (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	release_tag text NOT NULL,
	language_release text NOT NULL,
	summary jsonb NOT NULL,
	ran_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


CREATE TABLE system_event (
	id uuid DEFAULT gen_random_uuid() NOT NULL,
	team_id uuid NOT NULL,
	kind text NOT NULL,
	payload jsonb NOT NULL,
	occurred_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE movement
	ADD COLUMN upgrade_diagnostics jsonb,
	ADD COLUMN upgrade_checked_against integer;

-- Backfill: no pin has moved yet (the deploy check that moves them lands with
-- this migration), so every snapshot was minted under its movement's pin today.
ALTER TABLE movement_version
	ADD COLUMN language_version integer;

UPDATE movement_version v
	SET language_version = m.language_version
	FROM movement m
	WHERE m.id = v.movement_id;

ALTER TABLE movement_version
	ALTER COLUMN language_version SET NOT NULL;

ALTER TABLE deploy_check
	ADD CONSTRAINT deploy_check_pkey PRIMARY KEY (id);

ALTER TABLE system_event
	ADD CONSTRAINT system_event_pkey PRIMARY KEY (id);

ALTER TABLE deploy_check
	ADD CONSTRAINT deploy_check_release_unique UNIQUE (release_tag, language_release);

CREATE INDEX system_event_team_occurred_idx ON system_event USING btree (team_id, occurred_at, id);

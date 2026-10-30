-- @lf/postgres-store, migration 9: a run's waits on listenable edges
-- (crates/lf/src/waits.rs). Every arrival a module reports is logged under a
-- store-wide increasing seq; a wait reads those logged on its record's edge
-- after its mark. A wait notes each arrival it judged, by identity and
-- version, and whether its record matched then. No foreign key from an
-- arrival: the log outlives the waits that read it, and is swept by age.
-- `json`, not `jsonb`: a landing reads back in the key order it was written in.
CREATE TABLE lf.arrival (
  seq bigserial PRIMARY KEY,
  team_id uuid NOT NULL,
  adapter_type text NOT NULL,
  edge text NOT NULL,
  key text NOT NULL,
  identity text,
  version text,
  landing json,
  gone boolean NOT NULL,
  logged_at timestamptz NOT NULL
);
CREATE INDEX arrival_key_idx ON lf.arrival (team_id, adapter_type, edge, key, seq);
CREATE INDEX arrival_logged_idx ON lf.arrival (logged_at);
CREATE TABLE lf.wait_row (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES lf.trigger_run(id) ON UPDATE CASCADE ON DELETE CASCADE,
  team_id uuid NOT NULL,
  adapter_type text NOT NULL,
  edge text NOT NULL,
  key text NOT NULL,
  since bigint NOT NULL,
  address text,
  created_at timestamptz DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT wait_row_edge_unique UNIQUE (run_id, team_id, adapter_type, edge, key)
);
CREATE INDEX wait_row_key_idx ON lf.wait_row (team_id, adapter_type, edge, key);
CREATE TABLE lf.wait_seen (
  id bigserial PRIMARY KEY,
  wait_id uuid NOT NULL REFERENCES lf.wait_row(id) ON DELETE CASCADE,
  identity text NOT NULL,
  version text,
  matched boolean NOT NULL,
  -- The leaf whose resuming segment noted it, until that segment's progress
  -- is kept (its leaf finished, or parked again): null once kept.
  leaf text
);
CREATE INDEX wait_seen_identity_idx ON lf.wait_seen (wait_id, identity);
-- One transaction-scoped lock per record's edge: logging an arrival there and
-- parking a wait there take turns, so either the log sees the park (and
-- wakes it) or the park's transaction commits after the log's (and the
-- run's re-read after parking sees the arrival).
CREATE FUNCTION lf.lock_wait_key(team uuid, adapter_type text, edge text, key text) RETURNS void
  LANGUAGE sql AS $$ SELECT pg_advisory_xact_lock(hashtextextended(concat_ws(chr(31), team::text, adapter_type, edge, key), 0)) $$;

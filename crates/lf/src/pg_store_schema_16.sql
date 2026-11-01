-- @lf/postgres-store, migration 16: each listen that could not judge an
-- arrival (`unjudged.note`), once per listen and arrival, read oldest first
-- by the records door (`Arrival Not Judged`).
CREATE TABLE lf.arrival_unjudged (
  team_id uuid NOT NULL,
  pipeline text NOT NULL,
  arrival text NOT NULL,
  file text NOT NULL,
  movement text NOT NULL,
  delivery_id text,
  edge text NOT NULL,
  record_id text,
  reason text NOT NULL,
  cause text,
  noted_at timestamptz NOT NULL,
  PRIMARY KEY (team_id, pipeline, arrival)
);
CREATE INDEX arrival_unjudged_at_idx ON lf.arrival_unjudged (team_id, noted_at, pipeline, arrival);

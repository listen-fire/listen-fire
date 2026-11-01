-- @lf/postgres-store, migration 16: each listen that could not judge an
-- arrival (`unjudged.note`), once per listen, arrival and attempt (0 as
-- delivered, one more per replay), read oldest first by the records door
-- (`Arrival Not Judged`); and the request a kept delivery was received as
-- (its body and the headers its module declares it reads; sensitive, kept
-- while the delivery is), so a listen can be put through it again
-- (`listen-fire listens replay`).
CREATE TABLE lf.arrival_unjudged (
  team_id uuid NOT NULL,
  pipeline text NOT NULL,
  arrival text NOT NULL,
  attempt int NOT NULL,
  file text NOT NULL,
  movement text NOT NULL,
  delivery_id text,
  edge text NOT NULL,
  record_id text,
  reason text NOT NULL,
  cause text,
  noted_at timestamptz NOT NULL,
  PRIMARY KEY (team_id, pipeline, arrival, attempt)
);
CREATE INDEX arrival_unjudged_at_idx ON lf.arrival_unjudged (team_id, noted_at, pipeline, arrival, attempt);
ALTER TABLE lf.delivery ADD COLUMN request jsonb;

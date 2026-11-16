-- @lf/postgres-store, migration 18: a listen waits on an arrival whose
-- filter the host could not answer (a host function out of reach), or that
-- came after one, and judges its waiting arrivals again in the order they
-- came (`unjudged.note`'s `waiting`, cleared by `unjudged.judged`). False on
-- a fact kept before.
ALTER TABLE lf.arrival_unjudged ADD COLUMN waiting boolean NOT NULL DEFAULT false;
CREATE INDEX arrival_unjudged_waiting_idx ON lf.arrival_unjudged (team_id, pipeline, noted_at) WHERE waiting;

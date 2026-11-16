-- @lf/postgres-store, migration 18: a listen waits on an arrival whose
-- filter the host could not answer (a host function out of reach), or that
-- came after one, and judges its waiting arrivals again in the order they
-- came (`unjudged.note`'s `waiting`, cleared by `unjudged.judged`). False on
-- a fact kept before. Facts found in one instant (the arrivals waiting
-- behind another ask nothing, so are found together) are read in the order
-- they were kept, never by their receipt keys as text.
ALTER TABLE lf.arrival_unjudged ADD COLUMN waiting boolean NOT NULL DEFAULT false;
ALTER TABLE lf.arrival_unjudged ADD COLUMN kept_order bigint GENERATED ALWAYS AS IDENTITY;
DROP INDEX lf.arrival_unjudged_at_idx;
CREATE INDEX arrival_unjudged_order_idx ON lf.arrival_unjudged (team_id, noted_at, kept_order);
CREATE INDEX arrival_unjudged_waiting_idx ON lf.arrival_unjudged (team_id, pipeline, noted_at, kept_order) WHERE waiting;

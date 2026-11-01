-- @lf/postgres-store, migration 17: a kept delivery keeps the request it was
-- received as (its body and the headers its module reads; sensitive, kept
-- while the delivery is), so a listen can be put through it again
-- (`listen-fire listens replay`); and each replay of an arrival a listen
-- still cannot judge is an attempt of its own (`unjudged.note`).
ALTER TABLE lf.delivery ADD COLUMN request jsonb;
ALTER TABLE lf.arrival_unjudged ADD COLUMN attempt int NOT NULL DEFAULT 0;
ALTER TABLE lf.arrival_unjudged DROP CONSTRAINT arrival_unjudged_pkey;
ALTER TABLE lf.arrival_unjudged ADD PRIMARY KEY (team_id, pipeline, arrival, attempt);
DROP INDEX lf.arrival_unjudged_at_idx;
CREATE INDEX arrival_unjudged_at_idx ON lf.arrival_unjudged (team_id, noted_at, pipeline, arrival, attempt);

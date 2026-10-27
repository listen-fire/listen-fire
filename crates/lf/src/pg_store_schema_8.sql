-- @lf/postgres-store, migration 8: a failed run run again (`lf runs rerun`)
-- is the same run's next attempt. `attempt` is the latest's number;
-- `attempts` the earlier ones as each settled (`{ attempt, status,
-- startedAt, finishedAt, outcome }`, oldest first). A run keeps the writes
-- it lists (`writeRecords`), a failed one too, so a rerun can say what the
-- failed attempt already committed. `json`, not `jsonb`: they read back in
-- the key order they were written in.
ALTER TABLE lf.trigger_run ADD COLUMN attempt integer NOT NULL DEFAULT 1;
ALTER TABLE lf.trigger_run ADD COLUMN attempts json NOT NULL DEFAULT '[]';
ALTER TABLE lf.trigger_run ADD COLUMN write_records json;

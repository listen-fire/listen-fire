-- @lf/postgres-store, migration 15: what the records door reads
-- (docs/contracts/store-slot.md, `runs.failed`, `releases.*`, `waits.open`'s
-- `recordId`). A wait keeps the record it waits on, so a stranded wait can
-- say which record it lost; each release the store is opened under is kept
-- once; failed runs are read oldest first.
ALTER TABLE lf.wait_row ADD COLUMN record_id text;
CREATE TABLE lf.release_seen (
  team_id uuid NOT NULL,
  version text NOT NULL,
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (team_id, version)
);
CREATE INDEX release_seen_at_idx ON lf.release_seen (team_id, seen_at, version);
CREATE INDEX trigger_run_failed_idx ON lf.trigger_run (team_id, failed_at, id) WHERE status = 'failed';

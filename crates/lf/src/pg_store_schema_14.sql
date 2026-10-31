-- @lf/postgres-store, migration 14: the write ledger
-- (docs/contracts/store-slot.md, `writes.record`, `writes.depth`). Each
-- record write a run made, with the run's place in its chain of writes and
-- arrivals, kept for the loop breaker's window: an arrival on a record a run
-- wrote soon before was caused by that run.
CREATE TABLE lf.write_ledger (
  team_id uuid NOT NULL,
  adapter text NOT NULL,
  record_type text NOT NULL,
  external_id text NOT NULL,
  run_id text NOT NULL,
  depth integer NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX write_ledger_record_idx ON lf.write_ledger (team_id, adapter, record_type, external_id, at);
CREATE INDEX write_ledger_at_idx ON lf.write_ledger (team_id, at);

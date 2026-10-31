-- @lf/postgres-store, migration 13: the arrival log's sweep per record
-- (docs/contracts/store-slot.md, `waits.sweep`). A run's lease keeps the
-- arrival mark its step took when it claimed it: the lowest among unexpired
-- leases is the sweep's floor. An arrival's identity outlives its entry for
-- its module's re-send window, so a re-send after the sweep is a repeat. A
-- wait a delivery opened for a run it queued names that run's `fire_event`
-- row, and is live while the row is queued or the run exists.
ALTER TABLE lf.trigger_run ADD COLUMN lease_mark bigint;
CREATE INDEX trigger_run_lease_mark_idx ON lf.trigger_run (lease_until) WHERE lease_mark IS NOT NULL;

CREATE TABLE lf.arrival_identity (
  team_id uuid NOT NULL,
  adapter_type text NOT NULL,
  edge text NOT NULL,
  key text NOT NULL,
  identity text NOT NULL,
  version text,
  kept_until timestamptz NOT NULL
);
CREATE INDEX arrival_identity_of_idx ON lf.arrival_identity (team_id, adapter_type, edge, key, identity);
CREATE INDEX arrival_identity_until_idx ON lf.arrival_identity (kept_until);

ALTER TABLE lf.wait_row ADD COLUMN fire_key text;
CREATE INDEX wait_row_fire_key_idx ON lf.wait_row (fire_key) WHERE fire_key IS NOT NULL;
-- The run of a wait a delivery opened does not exist until the drain starts
-- it; the wait goes with its run's state (`leases.dropRunState`), or with its
-- `fire_event` row's burial when the run never started.
ALTER TABLE lf.wait_row DROP CONSTRAINT wait_row_run_id_fkey;

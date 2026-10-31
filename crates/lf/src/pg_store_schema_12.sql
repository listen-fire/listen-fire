-- @lf/postgres-store, migration 12: listens' resolved heads
-- (docs/contracts/store-slot.md, `listens.states`). A listen whose traversal
-- has an earlier hop the host resolves keeps the records it was last
-- resolved to, when, why its last resolve failed and why it is paused;
-- and the hold of the one resolve listing it now.
CREATE TABLE lf.listen_state (
  team_id uuid NOT NULL,
  pipeline text NOT NULL,
  state jsonb NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, pipeline)
);

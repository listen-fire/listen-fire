-- @lf/postgres-store, migration 7: a delivery's receipt, kept at the door in
-- its one write: the events it produced (never its raw body, headers or
-- signature). A provider's own delivery id, when the door has one, keeps a
-- redelivery out at its subscription. A run names the delivery whose event
-- started it. No foreign key: retention forgets deliveries that settled runs
-- still name.
CREATE TABLE lf.delivery (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL,
  subscription_id text NOT NULL,
  external_id text,
  received_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('webhook', 'hook', 'emit', 'cli')),
  inline boolean NOT NULL,
  replay_of uuid,
  events jsonb NOT NULL,
  event_count int NOT NULL
);
CREATE UNIQUE INDEX delivery_external_idx ON lf.delivery (team_id, subscription_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX delivery_received_idx ON lf.delivery (team_id, received_at);
ALTER TABLE lf.trigger_run ADD COLUMN delivery_id uuid;
CREATE INDEX trigger_run_delivery_id_idx ON lf.trigger_run (delivery_id);

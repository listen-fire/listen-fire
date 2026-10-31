-- @lf/postgres-store, migration 11: stranded waits
-- (docs/contracts/stranded-waits.md). A wait parked on a record the module
-- reports deleted is stranded: it stays parked, and `stranded_at` says when
-- the store found it so. A wait opened on a record already gone has no key.
ALTER TABLE lf.wait_row ALTER COLUMN key DROP NOT NULL;
ALTER TABLE lf.wait_row ADD COLUMN stranded_at timestamptz;
CREATE INDEX wait_row_stranded_idx ON lf.wait_row (stranded_at, id) WHERE stranded_at IS NOT NULL;

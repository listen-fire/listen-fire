-- @lf/postgres-store, migration 10: callbacks and the waits keyed by a
-- correlation retired at 0.13 (a run waits on a listenable edge, migration
-- 9). A run parked on one cannot resume on 0.13, so their rows go.
DROP TABLE IF EXISTS lf.callback;
DROP TABLE IF EXISTS lf.adapter_await;
-- Their work rows go too: a callback's firing and a wake by key (rather than
-- by wait) have no kind left to run as, and would retry until buried.
DELETE FROM lf.work WHERE kind = 'fire_callback' OR (kind = 'wake_await' AND NOT (payload ? 'waitId'));

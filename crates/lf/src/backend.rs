//! The run host's backend as one trait (movement-engine
//! `services/run_host/store.ts` `RunHostStore`, with listen-fire's run records
//! beside it), so every command runs over whichever store it
//! was given: a SQLite state file (crate::store), the hosted product's
//! Postgres tables (crate::pg_store), or a store module's process.
//!
//! Which one is the store slot's (crate::core): `--store <spec>` names one
//! outright (a spec that starts `postgres://` or `postgresql://` is a
//! Postgres connection; anything else is a SQLite file); else the module
//! lf.yaml's `core: { store: … }` names, by its settings — @lf/sqlite-store
//! (the default; `.lf/state.db`), @lf/postgres-store (its `url`), or a
//! store module run as a process (crate::store_module).
//!
//! Every method blocks until its backend answers, as rusqlite does. The
//! Postgres store serves the same blocking calls from its own connection
//! thread, so the rules over the store (crate::run_host) read alike over
//! both.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::json::Js;
use crate::loop_breaker::{Deepest, LedgerRecord, LedgerWrite};
use crate::records_door::{FailedPage, ReleaseAfter, SeenRelease};
#[cfg(feature = "postgres")]
use crate::pg_store::PgStore;
use crate::core;
use crate::project::Project;
use crate::resolve::{ListenState, Resolution};
use crate::store::{
    BranchExport, ClaimDue, ClaimedWork, DeliveryQuery, DeliveryRow, LeafRow, NewDelivery, NewWork, OwedRace, Park, Release, Rerun, Result, RunRow, RunStart, SegmentCommit,
    Store,
};
use crate::waits::{DeliveryArrivals, DeliveryWait, KeptDelivery, Logged, Noted, OpenWait, Stranded, StrandedOf, WaitArrivals, WaitWake};

/// The tenant a SQLite state file's rows belong to (`LOCAL_TENANT`).
pub const SQLITE_TENANT: &str = "local";

/// The tenant listen-fire's rows belong to in a Postgres store, unless `--team`
/// names another: the database's team ids are uuids, so the local tenant
/// is one too. Fixed, so every listen-fire process pointed at one database (a
/// `run`, its door, the `drain` workers) shares one queue.
pub const POSTGRES_TENANT: &str = "6c66206c-6f63-4061-8c00-000000000001";

/// Where a command's run state is kept.
#[derive(Debug, Clone, PartialEq)]
pub enum StoreSpec {
    Sqlite(PathBuf),
    Postgres { url: String, tenant: String },
    /// A third-party store module, started and driven over the store wire
    /// (crate::store_module) with its settings.
    Module { name: String, process: core::ProcessModule, settings: std::collections::BTreeMap<String, String> },
}

impl StoreSpec {
    /// `spec` read as a store; `team` the Postgres tenant (refused for SQLite,
    /// whose tenant is always the local one).
    pub fn parse(spec: &str, relative_to: &Path, team: Option<&str>) -> std::result::Result<StoreSpec, String> {
        if spec.starts_with("postgres://") || spec.starts_with("postgresql://") {
            let tenant = team.unwrap_or(POSTGRES_TENANT);
            if uuid::Uuid::parse_str(tenant).is_err() {
                return Err(format!("--team {tenant}: a Postgres store's team is a uuid"));
            }
            return Ok(StoreSpec::Postgres { url: spec.to_string(), tenant: tenant.to_string() });
        }
        if team.is_some() {
            return Err("--team names a Postgres store's tenant; a SQLite state file has one tenant".into());
        }
        Ok(StoreSpec::Sqlite(relative_to.join(spec)))
    }

    /// The store a command opens: `--store`, else the store slot's module by
    /// its settings.
    pub fn of_command(flag: Option<&str>, project: &Project, team: Option<&str>, env: &[(String, String)]) -> std::result::Result<StoreSpec, String> {
        if let Some(spec) = flag {
            return StoreSpec::parse(spec, &project.root, team);
        }
        let module = &project.core.store;
        let settings = core::settings_of(crate::secrets::Secrets::open(project, env)?.credentials(), module);
        if let Some(process) = &module.process {
            if team.is_some() {
                return Err(format!("--team names a Postgres store's tenant; {} names its own", module.name));
            }
            return Ok(StoreSpec::Module { name: module.name.to_string(), process: process.clone(), settings });
        }
        match module.name.as_ref() {
            core::POSTGRES_STORE => StoreSpec::parse(core::required(&settings, module, "url")?, &project.root, team),
            _ if team.is_some() => Err("--team names a Postgres store's tenant; a SQLite state file has one tenant".into()),
            _ => Ok(StoreSpec::Sqlite(core::sqlite_path(project, &settings)?)),
        }
    }

    /// How the store is named in a message: a Postgres URL without its password.
    pub fn display(&self) -> String {
        match self {
            StoreSpec::Sqlite(path) => path.display().to_string(),
            StoreSpec::Postgres { url, .. } => redact_password(url),
            StoreSpec::Module { name, .. } => format!("the store module {name}"),
        }
    }
}

fn redact_password(url: &str) -> String {
    let Some(scheme_end) = url.find("://").map(|i| i + 3) else { return url.to_string() };
    let rest = &url[scheme_end..];
    let Some(at) = rest.find('@') else { return url.to_string() };
    match rest[..at].find(':') {
        Some(colon) => format!("{}{}:***{}", &url[..scheme_end], &rest[..colon], &rest[at..]),
        None => url.to_string(),
    }
}

pub fn open_store(spec: &StoreSpec) -> std::result::Result<Box<dyn RunHostStore>, String> {
    let opened: Result<Box<dyn RunHostStore>> = match spec {
        StoreSpec::Sqlite(path) => Store::open(path).map(|s| Box::new(s) as Box<dyn RunHostStore>),
        #[cfg(feature = "postgres")]
        StoreSpec::Postgres { url, tenant } => PgStore::connect(url, tenant).map(|s| Box::new(s) as Box<dyn RunHostStore>),
        #[cfg(not(feature = "postgres"))]
        StoreSpec::Postgres { .. } => return Err(format!("{}: {}", spec.display(), crate::core::NO_POSTGRES)),
        StoreSpec::Module { name, process, settings } => {
            crate::store_module::ProcessStore::start(name, process, settings).map(|s| Box::new(s) as Box<dyn RunHostStore>)
        }
    };
    opened.map_err(|e| format!("{}: {e}", spec.display()))
}

/// Every family a run host's backend serves, and listen-fire's run records.
pub trait RunHostStore {
    /// The tenant this store's rows of listen-fire's own runs belong to.
    fn tenant(&self) -> &str;

    // ── Run records ─────────────────────────────────────────────────────────
    fn start_run(&self, run: &RunStart<'_>) -> Result<()>;
    /// Note the event's receipt on the listen (as `claim_event`) and start
    /// its run, as one write: false, and no run, for a redelivery. A crash
    /// never leaves a receipt whose run was never started.
    fn start_event_run(&self, listen: &str, key: &str, run: &RunStart<'_>) -> Result<bool>;
    /// Runs still `running` whose lease lapsed, or which hold none, started
    /// more than `stale_ms` ago: their worker is gone (a live first firing
    /// holds its lease and renews it). Oldest first.
    fn lapsed_runs(&self, stale_ms: i64, limit: i64) -> Result<Vec<String>>;
    /// `completed`, `parked`, `running` or `failed`.
    fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()>;
    fn mark_parked(&self, id: &str) -> Result<()>;
    /// The run is over without completing; the writes it settled with stay in its outcome.
    fn mark_failed(&self, id: &str, message: &str) -> Result<()>;
    /// A failed run's next attempt, as one write under `rerun.fence`: the
    /// latest attempt kept beside the run (`RunRow::attempts`), and the run
    /// `running` again on `rerun.input`, its cancel request and its spend
    /// against the cost cap cleared. The new attempt's number; None, and
    /// nothing written, when the run is not failed. A lost fence is
    /// `LeaseLost`.
    fn rerun_run(&self, run_id: &str, rerun: &Rerun<'_>) -> Result<Option<i64>>;
    /// The operator's cancel request on the run (its reason), or None.
    fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>>;
    /// An operator asks to cancel the run.
    fn request_cancel(&self, id: &str, reason: Option<&str>) -> Result<()>;
    fn run(&self, id: &str) -> Result<Option<RunRow>>;
    /// The most recent runs first.
    fn runs(&self, limit: i64) -> Result<Vec<RunRow>>;
    /// The entries a segment appended to its run's trace (`segment_id`: the
    /// segment's, so a store that keeps one record per segment finds its own).
    fn append_trace(&self, run_id: &str, segment_id: &str, entries: &[Js]) -> Result<()>;
    /// What the run has spent so far, in microdollars: the cost cap reads it.
    fn run_spent(&self, run_id: &str) -> Result<f64>;
    /// Add what one segment spent to the run's account.
    fn add_run_spend(&self, run_id: &str, microdollars: f64) -> Result<()>;
    /// The cap counts spend from here on: a run paused at its cap, resumed.
    fn reset_spend_baseline(&self, run_id: &str) -> Result<()>;
    fn trace_len(&self, run_id: &str) -> Result<i64>;
    /// The run's trace entries in order, or None when this store does not
    /// hand them back (a store module's wire has no read for them).
    fn trace_entries(&self, _run_id: &str) -> Result<Option<Vec<Js>>> {
        Ok(None)
    }

    // ── Parks ───────────────────────────────────────────────────────────────
    fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()>;
    fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>>;
    fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()>;
    fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>>;
    fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()>;
    /// A park and what wakes it, as one fenced write: the leaf, its kind's
    /// row (a timer's `resume_timer` row, a wait's address), and the run
    /// marked parked.
    /// A wait parked at the address before is parked there no more.
    fn commit_park(&self, park: &Park<'_>) -> Result<()>;
    /// What a segment held back, as one fenced write at its end: its join
    /// counts recorded, its parks committed as `commit_park` commits each,
    /// the leaf it resumed finished (unless it parks there again) and the
    /// run marked parked when it parked, the run settled, the race it
    /// settled no longer owed and each race it owes queued as a
    /// `settle_race` row. In the same write, each wait it parks whose
    /// arrivals are unread gets a `wake_await` row; those wakes are the
    /// answer. A deleted record wakes nothing: its waits keep waiting.
    fn commit_segment(&self, commit: &SegmentCommit<'_>) -> Result<Vec<WaitWake>>;
    /// The races the run owes (`settle_race` rows), in the order first owed.
    fn owed_races(&self, run_id: &str) -> Result<Vec<OwedRace>>;

    // ── Joins ───────────────────────────────────────────────────────────────
    fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()>;
    fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool>;
    fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()>;
    fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>>;
    fn has_pending_joins(&self, run_id: &str) -> Result<bool>;
    fn frames(&self, run_id: &str) -> Result<Vec<String>>;
    /// The frames, their exports, and the races owed at them.
    fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()>;

    // ── Waits on listenable edges (crate::waits) ────────────────────────────
    /// The latest seq logged: a wait opened since it reads every arrival
    /// logged after this call.
    fn arrival_mark(&self) -> Result<i64>;
    /// Log the arrivals, in order, and queue a `wake_await` row for each
    /// wait parked on their records, as one write: the waits it woke (one
    /// each). A gone arrival wakes none: it strands each wait parked on its
    /// record not stranded already. Any other arrival clears the stranding
    /// of its record's waits (the newest report wins). The answer's
    /// `stranded` is the waits the log left stranded.
    /// It never interleaves with a wait's park on the same record's edge, so
    /// a run that reads its wait's arrivals after parking misses none.
    /// An arrival whose identity and version its record's edge logged
    /// within the module's re-send window (`resend_window_ms` after that
    /// log) is a repeat: not logged again, even after the sweep forgot it.
    fn log_arrivals(&self, log: &DeliveryArrivals<'_>) -> Result<Logged>;
    /// `log_arrivals` now, under the default re-send window.
    #[cfg(test)]
    fn log_now(&self, team_id: &str, adapter_type: &str, arrivals: &[crate::waits::NewArrival]) -> Result<Logged> {
        let at = crate::store::iso(0);
        self.log_arrivals(&DeliveryArrivals { team_id, adapter_type, arrivals, at: &at, resend_window_ms: crate::externals::DEFAULT_RESEND_WINDOW_MS })
    }
    /// The wait's id; a run that already waits on this edge of this record
    /// keeps that wait and its mark. Without a key (the record already
    /// gone), stranded when it parks; a run that already waits on this edge
    /// of a record already gone keeps that wait.
    fn open_wait(&self, wait: &OpenWait<'_>) -> Result<String>;
    /// The arrivals logged after the wait's mark on its record's edge that it
    /// has not noted, the first of each identity and version only, in log
    /// order.
    fn wait_arrivals(&self, wait_id: &str) -> Result<WaitArrivals>;
    /// The stranded waits `of` names (docs/contracts/stranded-waits.md),
    /// oldest stranded first.
    fn stranded_waits(&self, of: &StrandedOf<'_>) -> Result<Vec<Stranded>>;
    /// Note the arrival judged, and whether its record matched: whether it
    /// counts (it matched, and did not at the identity's last noted arrival).
    /// A note naming a leaf is kept with that leaf's end (`Noted::leaf`).
    fn note_arrival(&self, noted: &Noted<'_>) -> Result<bool>;
    /// Forget at most `limit` arrivals that no live wait on their record's
    /// edge reads with a mark below them and that are at or below the floor
    /// (the lowest mark an unexpired run lease took, else the latest seq),
    /// and the identities past their re-send window: how many arrivals went.
    /// A wait is live while its run exists, or one a delivery opened while
    /// its run's `fire_event` row is queued. `floor`: a mark the caller's
    /// own running steps hold, held in its process rather than by a lease;
    /// nothing above it goes either.
    fn sweep_arrivals(&self, limit: i64, floor: Option<i64>) -> Result<i64>;

    // ── The run lease ───────────────────────────────────────────────────────
    /// The lease's token, or None while another holds it. It keeps the
    /// arrival mark now (`arrival_mark`): the sweep's floor while it holds.
    fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>>;
    fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool>;
    fn release_lease(&self, run_id: &str, token: &str) -> Result<()>;
    /// The run's leaves, joins, waits and the races it owes.
    fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool>;

    // ── The work queue ──────────────────────────────────────────────────────
    /// `team_id` absent: the store's own tenant's row.
    fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: Option<&str>) -> Result<()>;
    /// Insert when no row has the key, in one write; a row there in any
    /// state (due, leased, dead) is left as it is. Whether it was queued.
    fn enqueue_if_absent(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: Option<&str>) -> Result<bool>;
    fn claim_due(&self, claim: &ClaimDue<'_>) -> Result<Vec<ClaimedWork>>;
    fn complete(&self, id: &str, claim: &str) -> Result<()>;
    /// A row its own caller queued a run lease out (so a drain takes it
    /// only if the caller died) and ran itself, done: deleted, unless a live
    /// claim holds it (the caller was slow and a drain took it, which
    /// completes it). Completing a `fire_event` row drops the waits opened
    /// under its key for runs that never started, as burying it does.
    /// Whether it was deleted.
    fn complete_key(&self, key: &str) -> Result<bool>;
    fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>, why: Release) -> Result<()>;
    /// The row gave up: never claimed again, kept with `reason` (unless it
    /// was re-armed since the claim, which then stands).
    fn bury_work(&self, id: &str, claim: &str, reason: &str) -> Result<()>;

    // ── Library sources ─────────────────────────────────────────────────────
    fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()>;
    fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>>;

    // ── Inbound pull cursors ────────────────────────────────────────────────
    /// An install's saved pull cursor (a notify-then-pull source's), or None.
    fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>>;
    fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<()>;

    // ── Listens' resolved heads ─────────────────────────────────────────────
    /// What each listen named was last resolved to (crate::resolve), and
    /// why it is paused, by its pipeline: one with nothing kept is absent.
    fn listen_states(&self, pipelines: &[String]) -> Result<BTreeMap<String, ListenState>>;
    /// `listen_states` of one listen.
    fn listen_state(&self, pipeline: &str) -> Result<Option<ListenState>> {
        Ok(self.listen_states(&[pipeline.to_string()])?.remove(pipeline))
    }
    /// Hold the listen's resolve for `ttl_ms`, so one process lists it at a
    /// time: the hold's token, or None while another's has not lapsed.
    fn claim_listen_resolve(&self, pipeline: &str, ttl_ms: i64) -> Result<Option<String>>;
    /// Keep what the resolve held by `token` came to, the listen's `paused`
    /// as it is, and let the hold go, as one write. False, and nothing
    /// kept, when the hold lapsed and another took it since.
    fn save_listen_resolution(&self, pipeline: &str, token: &str, resolution: &Resolution) -> Result<bool>;
    /// Why the listen is paused (None: it is not), its resolution as it is.
    /// Pausing keeps the count of arrivals it held; resuming (None) clears it.
    fn set_listen_paused(&self, pipeline: &str, paused: Option<&str>) -> Result<()>;
    /// Count one arrival a paused listen held and did not run, as one write
    /// that adds to the count whatever other processes add (`listens.hold`).
    /// A listen that is not paused counts none: it was resumed meanwhile.
    fn hold_listen_arrival(&self, pipeline: &str) -> Result<()>;

    // ── The write ledger (crate::loop_breaker) ──────────────────────────────
    /// Keep a run's record write (`writes.record`), and forget every write
    /// made before `forget_before`.
    fn ledger_write(&self, write: &LedgerWrite, forget_before: &str) -> Result<()>;
    /// The deepest write of `record` made at or after `since`, the latest of
    /// those as deep (`writes.depth`).
    fn deepest_write(&self, record: &LedgerRecord<'_>, since: &str) -> Result<Option<Deepest>>;

    // ── What the records door reads (crate::records_door) ───────────────────
    /// The failed runs `page` names, oldest failure first, ties by id (`runs.failed`).
    fn failed_runs(&self, page: &FailedPage<'_>) -> Result<Vec<RunRow>>;
    /// Keep `version` as a release the store was opened under, at `at`,
    /// unless it was before: whether it is new (`releases.note`).
    fn note_release(&self, version: &str, at: &str) -> Result<bool>;
    /// The releases kept after `after`, oldest first, ties by version (`releases.list`).
    fn releases(&self, after: Option<&ReleaseAfter<'_>>, limit: i64) -> Result<Vec<SeenRelease>>;
    /// What one inbound delivery leaves, as one write: its receipt, its pull
    /// cursor (when it moved), its arrivals and its work rows (its events,
    /// its wakes). A crash never leaves a cursor past events its receipt does
    /// not hold.
    ///
    /// With `arrivals`, `waits` open first, for the runs the delivery's
    /// `fire_event` rows queue, reading from the mark before the arrivals
    /// (crate::waits::DeliveryWait); the arrivals are logged after the
    /// receipt; each `fire_event` row's payload carries `arrivalMark`, that
    /// mark; and a `wake_await { waitId, runId, address }` row is queued per
    /// wait they answer, once (crate::waits::delivery_rows). The answer holds
    /// those wake rows and the mark.
    ///
    /// None, and nothing written, for a duplicate: a delivery whose external
    /// id was kept at its subscription before (a redelivery, even one whose
    /// first's work is still queued).
    fn keep_delivery(
        &self,
        subscription_id: &str,
        checkpoint: Option<&Js>,
        delivery: &NewDelivery,
        work: &[NewWork],
        arrivals: Option<&DeliveryArrivals<'_>>,
        waits: &[DeliveryWait],
    ) -> Result<Option<KeptDelivery>>;
    /// Why a delivery's arrivals cannot be kept with it in this store (its
    /// module serves no `waits.log`); None when they can. Asked before a
    /// delivery that reports arrivals writes anything, so a store that would
    /// drop them refuses it whole and its sender sends it again.
    fn arrivals_unkept(&self) -> Result<Option<String>> {
        Ok(None)
    }
    /// Clear a kept delivery's external id, its receipt kept: its events
    /// failed inside the request and its sender was answered 500, so the
    /// sender's retry under that id is kept as a delivery of its own.
    fn forget_delivery_id(&self, id: &str) -> Result<()>;
    /// The kept deliveries the query names, most recent first, each with its
    /// runs and without its events.
    fn deliveries(&self, query: &DeliveryQuery<'_>) -> Result<Vec<DeliveryRow>>;
    /// One kept delivery with its events and its runs, or None.
    fn delivery(&self, id: &str) -> Result<Option<DeliveryRow>>;
    /// Forget at most `limit` deliveries received before `before` whose runs
    /// are settled and whose `fire_event` rows are gone: how many went.
    fn sweep_deliveries(&self, before: &str, limit: i64) -> Result<i64>;

    // ── The module processes listen-fire started ─────────────────────────────────────
    /// The list of module processes the lfs on this store started (so the
    /// next one stops what a killed one left behind), at its version: 0 for a
    /// list never written.
    fn module_processes(&self) -> Result<ModuleProcesses>;
    /// Write `processes` only if the list is still at `version` (it then
    /// moves to `version + 1`): true when it wrote. Two lfs on one store
    /// never overwrite each other's entries.
    fn swap_module_processes(&self, version: i64, processes: &Js) -> Result<bool>;

    // ── Event receipts ──────────────────────────────────────────────────────
    /// Note one delivery of an event to a listen by the event's
    /// `idempotencyKey` (the provider's own id for the occurrence): true the
    /// first time, false for a redelivery, which runs nothing (the
    /// platform's `trigger_event` unique on trigger and external event id).
    fn claim_event(&self, listen: &str, key: &str) -> Result<bool>;
}

impl RunHostStore for Store {
    fn tenant(&self) -> &str {
        SQLITE_TENANT
    }

    fn start_run(&self, run: &RunStart<'_>) -> Result<()> {
        Store::start_run(self, run)
    }
    fn start_event_run(&self, listen: &str, key: &str, run: &RunStart<'_>) -> Result<bool> {
        Store::start_event_run(self, listen, key, run)
    }
    fn lapsed_runs(&self, stale_ms: i64, limit: i64) -> Result<Vec<String>> {
        Store::lapsed_runs(self, stale_ms, limit)
    }
    fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()> {
        Store::settle_run(self, id, status, outcome, at)
    }
    fn mark_parked(&self, id: &str) -> Result<()> {
        Store::mark_parked(self, id)
    }
    fn mark_failed(&self, id: &str, message: &str) -> Result<()> {
        Store::mark_failed(self, id, message)
    }
    fn rerun_run(&self, run_id: &str, rerun: &Rerun<'_>) -> Result<Option<i64>> {
        Store::rerun_run(self, run_id, rerun)
    }
    fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>> {
        Store::cancel_request(self, id)
    }
    fn request_cancel(&self, id: &str, reason: Option<&str>) -> Result<()> {
        Store::request_cancel(self, id, reason)
    }
    fn run(&self, id: &str) -> Result<Option<RunRow>> {
        Store::run(self, id)
    }
    fn runs(&self, limit: i64) -> Result<Vec<RunRow>> {
        Store::runs(self, limit)
    }
    fn append_trace(&self, run_id: &str, _segment_id: &str, entries: &[Js]) -> Result<()> {
        Store::append_trace(self, run_id, entries)
    }
    fn trace_len(&self, run_id: &str) -> Result<i64> {
        Store::trace_len(self, run_id)
    }
    fn trace_entries(&self, run_id: &str) -> Result<Option<Vec<Js>>> {
        Store::trace_entries(self, run_id).map(Some)
    }
    fn run_spent(&self, run_id: &str) -> Result<f64> {
        Store::run_spent(self, run_id)
    }
    fn add_run_spend(&self, run_id: &str, microdollars: f64) -> Result<()> {
        Store::add_run_spend(self, run_id, microdollars)
    }
    fn reset_spend_baseline(&self, run_id: &str) -> Result<()> {
        Store::reset_spend_baseline(self, run_id)
    }

    fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()> {
        Store::put_leaf(self, run_id, address, reason, wake_at, state, fence)
    }
    fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>> {
        Store::claim_leaf(self, run_id, address, reason)
    }
    fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()> {
        Store::finish_leaf(self, run_id, address, fence)
    }
    fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>> {
        Store::leaves(self, run_id, parked_only, reason, due_by)
    }
    fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()> {
        Store::delete_leaves(self, run_id, addresses)
    }
    fn commit_park(&self, park: &Park<'_>) -> Result<()> {
        Store::commit_park(self, park)
    }
    fn commit_segment(&self, commit: &SegmentCommit<'_>) -> Result<Vec<WaitWake>> {
        Store::commit_segment(self, commit)
    }
    fn owed_races(&self, run_id: &str) -> Result<Vec<OwedRace>> {
        Store::owed_races(self, run_id)
    }

    fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()> {
        Store::record_join(self, run_id, frame_address, pending, fence)
    }
    fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool> {
        Store::decrement_join(self, run_id, frame_address, branch_address, leaf_address)
    }
    fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()> {
        Store::persist_branch_export(self, run_id, frame_address, branch_address, branch_index, exports)
    }
    fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>> {
        Store::collect_branch_exports(self, run_id, frame_address)
    }
    fn has_pending_joins(&self, run_id: &str) -> Result<bool> {
        Store::has_pending_joins(self, run_id)
    }
    fn frames(&self, run_id: &str) -> Result<Vec<String>> {
        Store::frames(self, run_id)
    }
    fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()> {
        Store::delete_frames(self, run_id, frame_addresses)
    }

    fn arrival_mark(&self) -> Result<i64> {
        Store::arrival_mark(self)
    }
    fn log_arrivals(&self, log: &DeliveryArrivals<'_>) -> Result<Logged> {
        Store::log_arrivals(self, log)
    }
    fn open_wait(&self, wait: &OpenWait<'_>) -> Result<String> {
        Store::open_wait(self, wait)
    }
    fn wait_arrivals(&self, wait_id: &str) -> Result<WaitArrivals> {
        Store::wait_arrivals(self, wait_id)
    }
    fn stranded_waits(&self, of: &StrandedOf<'_>) -> Result<Vec<Stranded>> {
        Store::stranded_waits(self, of)
    }
    fn note_arrival(&self, noted: &Noted<'_>) -> Result<bool> {
        Store::note_arrival(self, noted)
    }
    fn sweep_arrivals(&self, limit: i64, floor: Option<i64>) -> Result<i64> {
        Store::sweep_arrivals(self, limit, floor)
    }

    fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>> {
        Store::claim_lease(self, run_id, ttl_ms)
    }
    fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool> {
        Store::renew_lease(self, run_id, token, ttl_ms)
    }
    fn release_lease(&self, run_id: &str, token: &str) -> Result<()> {
        Store::release_lease(self, run_id, token)
    }
    fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool> {
        Store::drop_run_state(self, run_id, fence)
    }

    // The state file has one tenant, so a row's team is not kept.
    fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, _team_id: Option<&str>) -> Result<()> {
        Store::enqueue(self, kind, key, payload, due_at)
    }
    fn enqueue_if_absent(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, _team_id: Option<&str>) -> Result<bool> {
        Store::enqueue_if_absent(self, kind, key, payload, due_at)
    }
    fn claim_due(&self, claim: &ClaimDue<'_>) -> Result<Vec<ClaimedWork>> {
        Store::claim_due(self, claim)
    }
    fn complete(&self, id: &str, claim: &str) -> Result<()> {
        Store::complete(self, id, claim)
    }
    fn complete_key(&self, key: &str) -> Result<bool> {
        Store::complete_key(self, key)
    }
    fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>, why: Release) -> Result<()> {
        Store::release_work(self, id, claim, due_at, why)
    }
    fn bury_work(&self, id: &str, claim: &str, reason: &str) -> Result<()> {
        Store::bury_work(self, id, claim, reason)
    }

    fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()> {
        Store::put_source(self, team_id, hash, source)
    }
    fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>> {
        Store::get_source(self, team_id, hash)
    }

    fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>> {
        Store::inbound_checkpoint(self, subscription_id)
    }
    fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<()> {
        Store::save_inbound_checkpoint(self, subscription_id, checkpoint)
    }
    fn listen_states(&self, pipelines: &[String]) -> Result<BTreeMap<String, ListenState>> {
        Store::listen_states(self, pipelines)
    }
    fn claim_listen_resolve(&self, pipeline: &str, ttl_ms: i64) -> Result<Option<String>> {
        Store::claim_listen_resolve(self, pipeline, ttl_ms)
    }
    fn save_listen_resolution(&self, pipeline: &str, token: &str, resolution: &Resolution) -> Result<bool> {
        Store::save_listen_resolution(self, pipeline, token, resolution)
    }
    fn set_listen_paused(&self, pipeline: &str, paused: Option<&str>) -> Result<()> {
        Store::set_listen_paused(self, pipeline, paused)
    }
    fn hold_listen_arrival(&self, pipeline: &str) -> Result<()> {
        Store::hold_listen_arrival(self, pipeline)
    }
    fn ledger_write(&self, write: &LedgerWrite, forget_before: &str) -> Result<()> {
        Store::ledger_write(self, write, forget_before)
    }
    fn deepest_write(&self, record: &LedgerRecord<'_>, since: &str) -> Result<Option<Deepest>> {
        Store::deepest_write(self, record, since)
    }
    fn failed_runs(&self, page: &FailedPage<'_>) -> Result<Vec<RunRow>> {
        Store::failed_runs(self, page)
    }
    fn note_release(&self, version: &str, at: &str) -> Result<bool> {
        Store::note_release(self, version, at)
    }
    fn releases(&self, after: Option<&ReleaseAfter<'_>>, limit: i64) -> Result<Vec<SeenRelease>> {
        Store::releases(self, after, limit)
    }
    fn keep_delivery(
        &self,
        subscription_id: &str,
        checkpoint: Option<&Js>,
        delivery: &NewDelivery,
        work: &[NewWork],
        arrivals: Option<&DeliveryArrivals<'_>>,
        waits: &[DeliveryWait],
    ) -> Result<Option<KeptDelivery>> {
        Store::keep_delivery(self, subscription_id, checkpoint, delivery, work, arrivals, waits)
    }
    fn forget_delivery_id(&self, id: &str) -> Result<()> {
        Store::forget_delivery_id(self, id)
    }
    fn deliveries(&self, query: &DeliveryQuery<'_>) -> Result<Vec<DeliveryRow>> {
        Store::deliveries(self, query)
    }
    fn delivery(&self, id: &str) -> Result<Option<DeliveryRow>> {
        Store::delivery(self, id)
    }
    fn sweep_deliveries(&self, before: &str, limit: i64) -> Result<i64> {
        Store::sweep_deliveries(self, before, limit)
    }

    fn module_processes(&self) -> Result<ModuleProcesses> {
        Store::module_processes(self)
    }
    fn swap_module_processes(&self, version: i64, processes: &Js) -> Result<bool> {
        Store::swap_module_processes(self, version, processes)
    }

    fn claim_event(&self, listen: &str, key: &str) -> Result<bool> {
        Store::claim_event(self, listen, key)
    }
}

/// The store's list of started module processes (crate::module_hosts), at the
/// version a compare-and-set writes over.
#[derive(Debug, Clone, PartialEq)]
pub struct ModuleProcesses {
    /// An array; empty for a list never written.
    pub processes: Js,
    pub version: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A checkpoint saved as null is a forgotten one on every store: a poll
    /// that finds none arms again, and a row that arms by it is not skipped.
    fn a_null_checkpoint_reads_as_none(store: &dyn RunHostStore) {
        let subscription = format!("sub-{}", uuid::Uuid::new_v4());
        assert_eq!(store.inbound_checkpoint(&subscription).unwrap(), None);
        let kept = Js::parse(br#"{"armed":true,"cursor":"c-2"}"#).unwrap();
        store.save_inbound_checkpoint(&subscription, &kept).unwrap();
        assert_eq!(store.inbound_checkpoint(&subscription).unwrap(), Some(kept));
        store.save_inbound_checkpoint(&subscription, &Js::Null).unwrap();
        assert_eq!(store.inbound_checkpoint(&subscription).unwrap(), None);
    }

    /// A listen's resolution is kept by the one resolve that holds it, and
    /// its pause by a pause alone, on every store: neither undoes the
    /// other.
    fn a_listens_state_is_kept_as_it_was_saved(store: &dyn RunHostStore) {
        let pipeline = format!("listen:notes:a:{}", uuid::Uuid::new_v4());
        assert_eq!(store.listen_state(&pipeline).unwrap(), None);
        let token = store.claim_listen_resolve(&pipeline, 60_000).unwrap().expect("no one holds it");
        assert_eq!(store.claim_listen_resolve(&pipeline, 60_000).unwrap(), None, "held: a second resolve waits");
        assert_eq!(store.listen_state(&pipeline).unwrap().map(|s| s.resolution.resolved_at), Some(None), "held, never resolved");
        let resolved = Resolution { heads: vec!["b1".into(), "b2".into()], resolved_at: Some("2026-10-31T09:00:00.000Z".into()), failure: None };
        // A pause lands while the resolve reads: the resolve keeps it.
        store.set_listen_paused(&pipeline, Some("LISTEN_LOOP: …")).unwrap();
        assert!(store.save_listen_resolution(&pipeline, &token, &resolved).unwrap());
        // Two arrivals held meanwhile are counted, and a resolve keeps the count.
        store.hold_listen_arrival(&pipeline).unwrap();
        store.hold_listen_arrival(&pipeline).unwrap();
        let paused = ListenState { resolution: resolved.clone(), paused: Some("LISTEN_LOOP: …".into()), held: 2 };
        assert_eq!(store.listen_state(&pipeline).unwrap(), Some(paused));
        assert!(!store.save_listen_resolution(&pipeline, &token, &resolved).unwrap(), "a hold is let go as its resolution is kept");
        let token = store.claim_listen_resolve(&pipeline, 60_000).unwrap().expect("let go: held again");
        // A pause that is set again keeps the count; a resume clears it.
        store.set_listen_paused(&pipeline, Some("LISTEN_LOOP: again")).unwrap();
        assert_eq!(store.listen_state(&pipeline).unwrap().map(|s| s.held), Some(2));
        store.set_listen_paused(&pipeline, None).unwrap();
        store.hold_listen_arrival(&pipeline).unwrap();
        let suspended = Resolution { heads: Vec::new(), failure: Some("LISTEN_SCOPE_LIMIT: …".into()), ..resolved };
        assert!(store.save_listen_resolution(&pipeline, &token, &suspended).unwrap());
        assert_eq!(store.listen_state(&pipeline).unwrap(), Some(ListenState { resolution: suspended.clone(), paused: None, held: 0 }), "a listen resumed counts no arrival");
        // A lapsed hold is taken over, and the first holder keeps nothing.
        let lapsed = store.claim_listen_resolve(&pipeline, -1).unwrap().expect("let go: held again");
        let taken = store.claim_listen_resolve(&pipeline, 60_000).unwrap().expect("lapsed: taken over");
        assert!(!store.save_listen_resolution(&pipeline, &lapsed, &Resolution::default()).unwrap());
        assert!(store.save_listen_resolution(&pipeline, &taken, &suspended).unwrap());
        let never = format!("listen:notes:b:{}", uuid::Uuid::new_v4());
        store.set_listen_paused(&never, Some("LISTEN_LOOP: …")).unwrap();
        assert_eq!(store.listen_state(&never).unwrap(), Some(ListenState { resolution: Resolution::default(), paused: Some("LISTEN_LOOP: …".into()), held: 0 }), "paused before it was ever resolved");
        store.hold_listen_arrival(&never).unwrap();
        assert_eq!(store.listen_state(&never).unwrap().map(|s| s.held), Some(1));
        store.hold_listen_arrival("listen:notes:unknown").unwrap();
        assert_eq!(store.listen_state("listen:notes:unknown").unwrap(), None, "a listen with no state counts none, and gains none");
        let both = store.listen_states(&[pipeline.clone(), never.clone(), "listen:notes:other".into()]).unwrap();
        assert_eq!(both.keys().collect::<Vec<_>>(), {
            let mut keys = vec![&pipeline, &never];
            keys.sort();
            keys
        }, "one read for many; one with nothing kept is absent");
    }

    /// The write ledger answers the deepest write of a record since an
    /// instant (the latest of those as deep), per record, on every store;
    /// a write is forgotten once a later one is kept past it.
    fn the_write_ledger_answers_the_deepest_write_since(store: &dyn RunHostStore) {
        let company = format!("company-{}", uuid::Uuid::new_v4());
        let record = LedgerRecord { adapter: "acme_crm", record_type: "Company", external_id: &company };
        let keep = |run: &str, depth: u32, at: &str, forget_before: &str| {
            let write = LedgerWrite { adapter: "acme_crm".into(), record_type: "Company".into(), external_id: company.clone(), run_id: run.into(), depth, at: at.into() };
            store.ledger_write(&write, forget_before).unwrap();
        };
        let long_ago = "2026-10-31T09:00:00.000Z";
        assert_eq!(store.deepest_write(&record, long_ago).unwrap(), None);
        keep("a1", 0, "2026-10-31T10:00:00.000Z", long_ago);
        keep("b1", 1, "2026-10-31T10:00:01.000Z", long_ago);
        keep("b0", 1, "2026-10-31T10:00:00.500Z", long_ago);
        keep("c0", 0, "2026-10-31T10:00:02.000Z", long_ago);
        assert_eq!(store.deepest_write(&record, long_ago).unwrap(), Some(Deepest { run_id: "b1".into(), depth: 1 }), "the deepest, the latest of those");
        assert_eq!(store.deepest_write(&record, "2026-10-31T10:00:01.500Z").unwrap(), Some(Deepest { run_id: "c0".into(), depth: 0 }), "only since");
        assert_eq!(store.deepest_write(&record, "2026-10-31T11:00:00+01:00").unwrap(), Some(Deepest { run_id: "b1".into(), depth: 1 }), "an instant in another form");
        let other = LedgerRecord { external_id: "another", ..record };
        assert_eq!(store.deepest_write(&other, long_ago).unwrap(), None, "per record");
        keep("d0", 0, "2026-10-31T10:05:00.000Z", "2026-10-31T10:00:01.500Z");
        assert_eq!(store.deepest_write(&record, long_ago).unwrap(), Some(Deepest { run_id: "d0".into(), depth: 0 }), "the earlier writes forgotten but the last kept before");
    }

    #[test]
    fn the_write_ledger_is_kept_in_the_state_file() {
        let dir = std::env::temp_dir().join(format!("lf-backend-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        the_write_ledger_answers_the_deepest_write_since(&Store::open(&dir.join("state.db")).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Over Postgres when LF_TEST_PG names a database to set up and write into.
    #[cfg(feature = "postgres")]
    #[test]
    fn the_write_ledger_is_kept_over_postgres() {
        let Some(url) = std::env::var("LF_TEST_PG").ok().filter(|u| !u.is_empty()) else { return };
        PgStore::migrate(&url).unwrap();
        the_write_ledger_answers_the_deepest_write_since(&PgStore::connect(&url, POSTGRES_TENANT).unwrap());
    }

    #[test]
    fn a_listens_state_is_kept_in_the_state_file() {
        let dir = std::env::temp_dir().join(format!("lf-backend-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        a_listens_state_is_kept_as_it_was_saved(&Store::open(&dir.join("state.db")).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Over Postgres when LF_TEST_PG names a database to set up and write into.
    #[cfg(feature = "postgres")]
    #[test]
    fn a_listens_state_is_kept_over_postgres() {
        let Some(url) = std::env::var("LF_TEST_PG").ok().filter(|u| !u.is_empty()) else { return };
        PgStore::migrate(&url).unwrap();
        a_listens_state_is_kept_as_it_was_saved(&PgStore::connect(&url, POSTGRES_TENANT).unwrap());
    }

    #[test]
    fn a_null_checkpoint_reads_as_none_in_the_state_file() {
        let dir = std::env::temp_dir().join(format!("lf-backend-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        a_null_checkpoint_reads_as_none(&Store::open(&dir.join("state.db")).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Over Postgres when LF_TEST_PG names a database to set up and write into.
    #[cfg(feature = "postgres")]
    #[test]
    fn a_null_checkpoint_reads_as_none_over_postgres() {
        let Some(url) = std::env::var("LF_TEST_PG").ok().filter(|u| !u.is_empty()) else { return };
        PgStore::migrate(&url).unwrap();
        a_null_checkpoint_reads_as_none(&PgStore::connect(&url, POSTGRES_TENANT).unwrap());
    }

    #[test]
    fn a_postgres_url_is_a_postgres_store_and_anything_else_a_state_file() {
        let root = Path::new("/p");
        assert_eq!(
            StoreSpec::parse("postgres://u:pw@h:5432/db", root, None).unwrap(),
            StoreSpec::Postgres { url: "postgres://u:pw@h:5432/db".into(), tenant: POSTGRES_TENANT.into() }
        );
        assert_eq!(StoreSpec::parse("state/other.db", root, None).unwrap(), StoreSpec::Sqlite(PathBuf::from("/p/state/other.db")));
        assert!(StoreSpec::parse("postgresql://h/db", root, Some("not-a-uuid")).unwrap_err().contains("uuid"));
        assert!(StoreSpec::parse("x.db", root, Some(POSTGRES_TENANT)).is_err());
    }

    #[test]
    fn the_local_tenant_is_a_uuid() {
        assert!(uuid::Uuid::parse_str(POSTGRES_TENANT).is_ok());
    }

    #[test]
    fn a_url_is_shown_without_its_password() {
        assert_eq!(redact_password("postgres://u:secret@h:1/db"), "postgres://u:***@h:1/db");
        assert_eq!(redact_password("postgres://h/db"), "postgres://h/db");
    }
}

//! Core slots: the host's own services, filled by a module
//! (docs/contracts/store-slot.md, limiter-slot.md, loop-guard-slot.md,
//! wake-slot.md). Each
//! slot's methods are those documents' tables, method for method, carried in
//! the adapter protocol's envelope like every other module's (`store.open`,
//! `runs.start`, …), with a slot's results as its table gives them.
//!
//! A fenced store write that finds the run's lease gone fails with
//! [`ModuleError::run_lease_lost`].

use std::collections::BTreeMap;
use std::future::Future;

use module_wire::json::Js;
use serde::ser::SerializeMap;
use serde::{Deserialize, Serialize, Serializer};

use crate::context::{Answer, Ctx, ModuleError, from_js, to_js};
use crate::module::{LocalFuture, Module, manifest_frame};

/// The error code of a fenced write that found the run's lease gone: the
/// host treats it as losing the run.
pub const RUN_LEASE_LOST_CODE: &str = "run_lease_lost";

impl ModuleError {
    pub fn run_lease_lost(run_id: &str) -> ModuleError {
        ModuleError::new(RUN_LEASE_LOST_CODE, format!("run {run_id}'s lease is gone"))
            .with_data(Js::Obj(module_wire::obj! { "name" => Js::str("RunLeaseLost"), "runId" => Js::str(run_id) }))
    }
}

/// One slot: its params, its trait, and the module the host serves for it.
macro_rules! slot {
    (
        $(#[$doc:meta])*
        pub trait $Trait:ident served as $Served:ident in slot $slot:literal {
            $(
                $(#[$mdoc:meta])*
                $wire:literal => fn $method:ident($Params:ident { $( $(#[$fmeta:meta])* $field:ident : $fty:ty ),* $(,)? }) -> $Ret:ty;
            )*
        }
    ) => {
        $(
            #[derive(Debug, Clone, Deserialize)]
            #[serde(rename_all = "camelCase")]
            pub struct $Params { $( $(#[$fmeta])* pub $field: $fty, )* }
        )*

        $(#[$doc])*
        pub trait $Trait {
            $( $(#[$mdoc])* fn $method(&self, ctx: &Ctx, params: $Params) -> impl Future<Output = Answer<$Ret>>; )*
        }

        #[doc = concat!("A module filling the `", $slot, "` slot, as the host serves it.")]
        pub struct $Served<T> {
            name: String,
            module: T,
        }

        impl<T: $Trait> $Served<T> {
            pub fn new(name: impl Into<String>, module: T) -> $Served<T> {
                $Served { name: name.into(), module }
            }

            async fn answer(&self, ctx: &Ctx, method: &str, params: Js) -> Answer<Js> {
                match method {
                    $( $wire => to_js(&self.module.$method(ctx, from_js(method, &params)?).await?), )*
                    unknown => Err(ModuleError::not_implemented(unknown)),
                }
            }
        }

        impl<T: $Trait> Module for $Served<T> {
            fn manifest(&self) -> Js {
                let methods = [$( $wire.to_string() ),*];
                manifest_frame("core", &self.name, &[], &methods, &module_wire::obj! { "slot" => Js::str($slot) })
            }

            fn call<'a>(&'a self, ctx: &'a Ctx, method: &'a str, params: Js) -> LocalFuture<'a, Answer<Js>> {
                Box::pin(self.answer(ctx, method, params))
            }
        }
    };
}

// ── store ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Opened {
    /// The team id the host's own runs are kept under.
    pub tenant: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub file: String,
    pub movement: String,
    pub status: String,
    pub started_at: String,
    pub input: String,
    pub outcome: Option<String>,
    /// The delivery whose event started it (`runs.start`'s `deliveryId`).
    #[serde(default)]
    pub delivery_id: Option<String>,
    /// The latest attempt's number, from 1; left out by a store that keeps no
    /// attempts (one attempt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<i64>,
    /// The earlier attempts (`runs.rerun` keeps them), oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attempts: Vec<RunAttempt>,
}

/// One earlier attempt of a run, as `runs.rerun` kept it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAttempt {
    pub attempt: i64,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    /// The JSON object the attempt settled with.
    pub outcome: Js,
}

/// `runs.rerun`'s answer: the attempt the run now runs as.
#[derive(Debug, Clone, Serialize)]
pub struct Rerun {
    pub attempt: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CancelRequest {
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaimedLeaf {
    pub reason: String,
    pub state: Js,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeafRow {
    pub address: String,
    pub reason: String,
    pub status: String,
    pub wake_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JoinClosed {
    pub closed: bool,
}

/// A race the run owes (`parks.owedRaces`'s answer, and
/// `parks.commitSegment`'s `owedRaces`): its frame, and the state of an arm
/// that won it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwedRace {
    pub frame_address: String,
    pub state: Js,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchExport {
    pub branch_address: String,
    pub branch_index: i64,
    pub exports: Js,
}

#[derive(Debug, Clone, Serialize)]
pub struct Lease {
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClaimedWork {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub payload: Js,
    pub claim: String,
    /// The row's claims since it last succeeded, this one included, less
    /// those released as `busy`.
    pub attempts: i64,
}

/// One park's kind and what wakes it (`parks.commit`'s `park`).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ParkKind {
    /// Arms the run's `resume_timer` row at `wake_at` (an earlier due time kept).
    #[serde(rename_all = "camelCase")]
    Timer { wake_at: String },
    /// Parks the wait at the address (its leaf's reason is `await`); a run
    /// with no such wait writes nothing. Any park at an address unparks the
    /// run's wait parked there before.
    #[serde(rename_all = "camelCase")]
    Wait { wait_id: String },
    /// A run paused at a limit.
    Limit,
}

/// A join frame's pending count a segment recorded (`parks.commitSegment`'s `joins`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldJoin {
    pub frame_address: String,
    pub pending: i64,
}

/// A park a segment made (`parks.commitSegment`'s `parks`): `parks.commit`'s
/// park without its run and fence.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldPark {
    pub address: String,
    pub state: Js,
    pub park: ParkKind,
}

/// Where a segment leaves its run (`parks.commitSegment`'s `settle`):
/// `runs.settle`'s settle, kept in the segment's one write.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentSettle {
    pub status: String,
    pub outcome: Js,
    pub at: String,
}

/// One arrival a module reported (`waits.log`'s `arrivals`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewArrival {
    pub edge: String,
    /// The record whose edge it arrived on.
    pub key: String,
    /// `None`: this report is an arrival of its own (`#` and its seq is its identity).
    #[serde(default)]
    pub identity: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub landing: Option<Js>,
    /// The record is gone: nothing more arrives on its edges.
    #[serde(default)]
    pub gone: bool,
}

/// A wait parked at `address` that a logged arrival answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitWake {
    pub run_id: String,
    pub wait_id: String,
    pub address: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedWait {
    pub wait_id: String,
}

/// An arrival a wait has yet to judge (`identity`: the reported one, else `#` and its seq).
#[derive(Debug, Clone, Serialize)]
pub struct LoggedArrival {
    pub seq: i64,
    pub identity: String,
    pub version: Option<String>,
    pub landing: Js,
}

#[derive(Debug, Clone, Serialize)]
pub struct WaitArrivals {
    pub arrivals: Vec<LoggedArrival>,
}

/// A wait parked on a record whose newest report is that it went
/// (`waits.stranded`, docs/contracts/stranded-waits.md).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stranded {
    pub wait_id: String,
    pub run_id: String,
    pub adapter_type: String,
    pub edge: String,
    /// `None` for a wait opened on a record already gone.
    pub key: Option<String>,
    /// When the store found the wait parked on a deleted record.
    pub at: String,
    /// Whether the wait's leaf is still parked.
    pub parked: bool,
}

/// `waits.log`'s answer: the waits it answered and the waits it stranded.
#[derive(Debug, Clone, Serialize)]
pub struct Logged {
    pub wakes: Vec<WaitWake>,
    pub stranded: Vec<Stranded>,
}

/// Where a page of `waits.stranded` left off: its last wait.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrandedAfter {
    pub at: String,
    pub wait_id: String,
}

/// What a `work.release` says of the claim.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReleaseWhy {
    /// The work failed: the claim was an attempt.
    #[default]
    Failed,
    /// The row's run was held elsewhere: the attempt is given back.
    Busy,
    /// The work was done and is due again: the attempts start over.
    Rescheduled,
}

/// A work row to queue, as `work.enqueue` takes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewWork {
    pub kind: String,
    pub key: String,
    pub payload: Js,
    pub due_at: Option<String>,
    pub team_id: Option<String>,
}

/// Where a delivery came in.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliverySource {
    Webhook,
    Hook,
    Emit,
    Cli,
    /// A poll of a listenable edge that fired a listen.
    Poll,
}

/// A delivery's receipt (`inbound.keepDelivery`'s `delivery`): the events it
/// produced. A second one with the same `external_id` at the same
/// subscription is a duplicate.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDelivery {
    pub id: String,
    #[serde(default)]
    pub external_id: Option<String>,
    pub received_at: String,
    pub source: DeliverySource,
    pub inline: bool,
    #[serde(default)]
    pub replay_of: Option<String>,
    pub events: Vec<Js>,
}

/// A delivery's arrivals (`inbound.keepDelivery`'s `arrivals`), logged in
/// the write that keeps it, after the receipt: a duplicate logs none.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryArrivals {
    pub team_id: String,
    pub adapter_type: String,
    pub arrivals: Vec<NewArrival>,
    pub at: String,
    /// The module's re-send window, as `waits.log` takes it.
    pub resend_window_ms: i64,
}

/// A wait a kept delivery opens for a run it queued, before the run exists
/// (`inbound.keepDelivery`'s `waits`): reading from the mark before the
/// delivery's arrivals, live while the `fire_event` row `fire_key` is queued
/// or the run exists. `pre_noted` is the run's trigger, noted on it as
/// judged and not matching.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryWait {
    pub run_id: String,
    pub edge: String,
    #[serde(default)]
    pub key: Option<String>,
    pub fire_key: String,
    #[serde(default)]
    pub pre_noted: Option<PreNoted>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreNoted {
    pub identity: String,
    #[serde(default)]
    pub version: Option<String>,
}

/// `inbound.keepDelivery`'s answer: `false` for a duplicate, which wrote
/// nothing. When kept, `arrival_mark` is the mark before its arrivals (the
/// `arrivalMark` its `fire_event` rows carry). When the call carried
/// `arrivals`, `wakes` is the `wake_await` rows it queued, one per wait they
/// answer (an empty list for none): the rows its `waits.log` queued, never a
/// second set.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub kept: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wakes: Option<Vec<NewWork>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arrival_mark: Option<i64>,
}

/// `waits.sweep`'s answer: how many arrivals went.
#[derive(Debug, Clone, Serialize)]
pub struct Swept {
    pub swept: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeliveryRun {
    pub id: String,
    pub status: String,
}

/// A kept delivery: `events` only from `inbound.delivery`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryRow {
    pub id: String,
    pub subscription_id: String,
    pub external_id: Option<String>,
    pub received_at: String,
    pub source: DeliverySource,
    pub inline: bool,
    pub replay_of: Option<String>,
    pub event_count: i64,
    pub runs: Vec<DeliveryRun>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<Js>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Checkpoint {
    pub checkpoint: Js,
}

/// What a listen's heads were last resolved to: the heads, when, and why
/// the resolve failed (`None`: it did not).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenResolution {
    pub heads: Vec<String>,
    pub resolved_at: Option<String>,
    pub failure: Option<String>,
}

/// A listen's kept state (`listens.states`): its resolution, and why it is
/// paused (`None`: it is not).
#[derive(Debug, Clone, Serialize)]
pub struct ListenState {
    #[serde(flatten)]
    pub resolution: ListenResolution,
    pub paused: Option<String>,
}

/// The module processes the hosts on this store started, at the version a
/// `processes.swap` writes over (0: never written).
#[derive(Debug, Clone, Serialize)]
pub struct ModuleProcesses {
    pub processes: Js,
    pub version: i64,
}

slot! {
    /// The store slot: a host's run state (runs, parks, joins, waits and
    /// the arrivals they read, leases, the work queue, library sources, pull
    /// cursors and event receipts). The meaning of each method is the
    /// run host's contract suite's.
    pub trait Store served as StoreModule in slot "store" {
        /// Always the first request.
        "store.open" => fn open(StoreOpen { #[serde(default)] settings: BTreeMap<String, String> }) -> Opened;
        "runs.start" => fn start_run(RunsStart { id: String, file: String, movement: String, started_at: String, input: String, #[serde(default)] delivery_id: Option<String> }) -> ();
        /// `runs.start` and `events.claim` as one write: `false`, and no run,
        /// for an event the listen has run before.
        "events.startRun" => fn start_event_run(EventsStartRun {
            listen: String,
            key: String,
            id: String,
            file: String,
            movement: String,
            started_at: String,
            input: String,
            #[serde(default)]
            delivery_id: Option<String>,
        }) -> bool;
        /// Runs still `running` whose lease lapsed or was never taken,
        /// started more than `stale_ms` ago; oldest first.
        "runs.lapsed" => fn lapsed_runs(RunsLapsed { stale_ms: i64, limit: i64 }) -> Vec<String>;
        /// `status`: `completed`, `parked`, `running` or `failed`.
        "runs.settle" => fn settle_run(RunsSettle { run_id: String, status: String, outcome: Js, at: String }) -> ();
        /// A failed run's next attempt, as one write fenced like `parks.commit`:
        /// `None`, and nothing written, when the run's status is not `failed`.
        "runs.rerun" => fn rerun_run(RunsRerun { run_id: String, input: String, at: String, fence: String }) -> Option<Rerun>;
        "runs.markParked" => fn mark_parked(RunsMarkParked { run_id: String }) -> ();
        "runs.get" => fn run(RunsGet { run_id: String }) -> Option<RunRow>;
        /// Most recent first.
        "runs.list" => fn runs(RunsList { limit: i64 }) -> Vec<RunRow>;
        "runs.appendTrace" => fn append_trace(RunsAppendTrace { run_id: String, segment_id: String, entries: Vec<Js> }) -> ();
        "runs.traceLength" => fn trace_length(RunsTraceLength { run_id: String }) -> i64;
        /// Microdollars spent since the spend baseline.
        "runs.spent" => fn spent(RunsSpent { run_id: String }) -> f64;
        "runs.addSpend" => fn add_spend(RunsAddSpend { run_id: String, microdollars: f64 }) -> ();
        "runs.resetSpendBaseline" => fn reset_spend_baseline(RunsResetSpendBaseline { run_id: String }) -> ();
        "runs.requestCancel" => fn request_cancel(RunsRequestCancel { run_id: String, reason: Option<String> }) -> ();
        /// `None` when no cancel was asked.
        "records.cancelRequest" => fn cancel_request(RecordsCancelRequest { run_id: String }) -> Option<CancelRequest>;
        "records.markFailed" => fn mark_failed(RecordsMarkFailed { run_id: String, message: String }) -> ();
        "parks.putLeaf" => fn put_leaf(ParksPutLeaf { run_id: String, address: String, reason: String, wake_at: Option<String>, state: Js, fence: Option<String> }) -> ();
        "parks.claimLeaf" => fn claim_leaf(ParksClaimLeaf { run_id: String, address: String, reason: Option<String> }) -> Option<ClaimedLeaf>;
        "parks.finishLeaf" => fn finish_leaf(ParksFinishLeaf { run_id: String, address: String, fence: Option<String> }) -> ();
        "parks.leaves" => fn leaves(ParksLeaves { run_id: String, parked_only: bool, reason: Option<String>, due_by: Option<String> }) -> Vec<LeafRow>;
        "parks.deleteLeaves" => fn delete_leaves(ParksDeleteLeaves { run_id: String, addresses: Vec<String> }) -> ();
        /// One fenced write: the leaf, its kind's row, the run marked parked.
        /// A `Wait` park on a record already gone (the newest arrival logged
        /// on it after the wait's `since` is gone, or no key) strands the
        /// wait, now.
        "parks.commit" => fn commit_park(ParksCommit { run_id: String, address: String, state: Js, fence: Option<String>, park: ParkKind }) -> ();
        /// A segment's held writes as one fenced write: `joins` recorded as
        /// `joins.recordJoin` records them, `parks` committed in order as
        /// `parks.commit` commits each, `resumed` finished as
        /// `parks.finishLeaf` finishes it unless one of `parks` is at its
        /// address, the run marked parked when `parks` is not empty, and
        /// then `settle`, when given, settled as `runs.settle` settles it.
        /// Then `settled_race`'s `settle_race` row is deleted, and each of
        /// `owed_races` is queued as one (`work.enqueue` of key
        /// `settle_race:<runId>:<frameAddress>`, payload `{ runId,
        /// frameAddress, state }`, under `team_id`, due now).
        /// In the same write, each wait parked whose arrivals are unread
        /// (`waits.arrivals` lists some) gets a `wake_await { waitId,
        /// runId, address }` row under `team_id` (a deleted record wakes
        /// nothing: its waits keep waiting, stranded as `parks.commit`
        /// strands them);
        /// those wakes are the answer.
        "parks.commitSegment" => fn commit_segment(ParksCommitSegment {
            run_id: String,
            team_id: String,
            fence: Option<String>,
            resumed: Option<String>,
            joins: Vec<HeldJoin>,
            parks: Vec<HeldPark>,
            #[serde(default)]
            settle: Option<SegmentSettle>,
            #[serde(default)]
            owed_races: Vec<OwedRace>,
            #[serde(default)]
            settled_race: Option<String>,
        }) -> Vec<WaitWake>;
        /// The races the run owes: its `settle_race` rows' payloads, oldest first.
        "parks.owedRaces" => fn owed_races(ParksOwedRaces { run_id: String }) -> Vec<OwedRace>;
        "joins.recordJoin" => fn record_join(JoinsRecordJoin { run_id: String, frame_address: String, pending: i64, fence: Option<String> }) -> ();
        "joins.decrementJoin" => fn decrement_join(JoinsDecrementJoin { run_id: String, frame_address: String, branch_address: String, leaf_address: String }) -> JoinClosed;
        "joins.persistBranchExport" => fn persist_branch_export(JoinsPersistBranchExport { run_id: String, frame_address: String, branch_address: String, branch_index: i64, exports: Js }) -> ();
        "joins.collectBranchExports" => fn collect_branch_exports(JoinsCollectBranchExports { run_id: String, frame_address: String }) -> Vec<BranchExport>;
        "joins.hasPendingJoins" => fn has_pending_joins(JoinsHasPendingJoins { run_id: String }) -> bool;
        "joins.frames" => fn frames(JoinsFrames { run_id: String }) -> Vec<String>;
        /// The frames, their exports, and the `settle_race` rows owed at them.
        "joins.deleteFrames" => fn delete_frames(JoinsDeleteFrames { run_id: String, frame_addresses: Vec<String> }) -> ();
        /// The latest seq logged (store-wide; 0 for none): every `waits.log`
        /// call made after it logs under a greater seq.
        "waits.mark" => fn arrival_mark(WaitsMark {}) -> i64;
        /// Log the arrivals in order and queue a `wake_await` row per parked
        /// wait on their records, as one write: a crash leaves both or
        /// neither. Each row is `{ kind: "wake_await", key:
        /// "wake_await:<unique>", payload: { waitId, runId, address }, teamId }`,
        /// due now, one per wait however many of the arrivals answer it; the
        /// answer is those waits (a wait is parked while its leaf is kept).
        /// Never interleaved with a `Wait` park on the same record's edge. A
        /// repeat (an identity and version its record's edge logged within
        /// the retention) is skipped and wakes nothing; an arrival without an
        /// identity is never one. The answer is `{ wakes, stranded }`. A gone
        /// arrival (its record deleted) is logged but wakes nothing: it
        /// strands each wait parked on its record not stranded already
        /// (`stranded_at` = `at`, written as an ISO 8601 instant with
        /// milliseconds in UTC). Any other arrival clears the stranding of
        /// every wait on its record (the newest report wins) and wakes the
        /// parked ones. `stranded` is the waits the log left stranded. A
        /// wait whose record is deleted keeps waiting.
        /// An arrival whose identity and version its record's edge logged
        /// within the module's re-send window (`resend_window_ms` after
        /// that log) is a repeat and is not logged again, even after the
        /// sweep forgot its entry: keep identities apart from entries.
        "waits.log" => fn log_arrivals(WaitsLog { team_id: String, adapter_type: String, arrivals: Vec<NewArrival>, at: String, resend_window_ms: i64 }) -> Logged;
        /// A run that already waits on this edge of this record keeps that
        /// wait, and its `since`. No `key`: the record was already gone, so
        /// nothing arrives on it and a park on it strands it; a run that
        /// already waits on this edge of a record already gone keeps that
        /// wait.
        "waits.open" => fn open_wait(WaitsOpen { run_id: String, team_id: String, adapter_type: String, edge: String, #[serde(default)] key: Option<String>, since: i64 }) -> OpenedWait;
        /// The arrivals logged after the wait's `since` on its record's edge
        /// that it has not noted, the first of each identity and version
        /// only, in log order.
        "waits.arrivals" => fn wait_arrivals(WaitsArrivals { wait_id: String }) -> WaitArrivals;
        /// Whether the arrival counts: it matched, and its identity did not
        /// at its last noted arrival. A noted arrival counts no more.
        "waits.note" => fn note_arrival(WaitsNote { wait_id: String, identity: String, version: Option<String>, matched: bool, leaf: Option<String>, fence: Option<String> }) -> bool;
        /// Forget at most `limit` arrivals that no live wait on their
        /// record's edge reads with a `since` below them and that are at or
        /// below the floor: the lowest mark an unexpired run lease took when
        /// it was claimed (`leases.claim` keeps `waits.mark` then), else the
        /// latest seq. A wait is live while its run exists, or one
        /// `inbound.keepDelivery` opened while its `fire_event` row is
        /// queued (not buried). `floor`: a mark the caller's own running
        /// steps hold in its process; nothing above it goes either. Forget
        /// too the identities past their re-send window. How many arrivals
        /// went.
        "waits.sweep" => fn sweep_arrivals(WaitsSweep { limit: i64, #[serde(default)] floor: Option<i64> }) -> Swept;
        /// The stranded waits, oldest stranded first (ties by wait id): the
        /// run's, given `run_id`; else every run's, at most `limit`, after
        /// the wait `after` names. A wait is stranded when it is parked on a
        /// record already gone: by a gone arrival `waits.log` logs while it
        /// is parked, or as `parks.commit` (or `parks.commitSegment`) parks
        /// it on a record whose newest arrival after its `since` is gone, or
        /// with no key. It stays stranded until `waits.log` logs another
        /// arrival on its record, or its run's rows go.
        "waits.stranded" => fn stranded_waits(WaitsStranded {
            #[serde(default)]
            run_id: Option<String>,
            #[serde(default)]
            after: Option<StrandedAfter>,
            #[serde(default)]
            limit: Option<i64>,
        }) -> Vec<Stranded>;
        /// `None` while another holds it.
        /// Keeps `waits.mark` now as the lease's mark: the sweep's floor
        /// while the lease holds.
        "leases.claim" => fn claim_lease(LeasesClaim { run_id: String, ttl_ms: i64 }) -> Option<Lease>;
        "leases.renew" => fn renew_lease(LeasesRenew { run_id: String, token: String, ttl_ms: i64 }) -> bool;
        "leases.release" => fn release_lease(LeasesRelease { run_id: String, token: String }) -> ();
        /// Drops the run's leaves, joins, waits and `settle_race` rows.
        "leases.dropRunState" => fn drop_run_state(LeasesDropRunState { run_id: String, fence: Option<String> }) -> bool;
        "work.enqueue" => fn enqueue(WorkEnqueue { kind: String, key: String, payload: Js, due_at: Option<String>, team_id: Option<String> }) -> ();
        /// Insert when no row has the key, in one write; a row there in any
        /// state (due, leased, dead) is left as it is. Whether it was queued.
        "work.enqueueIfAbsent" => fn enqueue_if_absent(WorkEnqueueIfAbsent { kind: String, key: String, payload: Js, due_at: Option<String>, team_id: Option<String> }) -> bool;
        /// `kinds` (a drain pool's) leases only rows of those kinds; absent, every kind.
        "work.claimDue" => fn claim_due(WorkClaimDue { limit: i64, lease_ms: i64, due_by: Option<String>, kinds: Option<Vec<String>> }) -> Vec<ClaimedWork>;
        "work.complete" => fn complete_work(WorkComplete { id: String, claim: String }) -> ();
        /// `why` absent is `failed`.
        "work.release" => fn release_work(WorkRelease { id: String, claim: String, due_at: Option<String>, #[serde(default)] why: ReleaseWhy }) -> ();
        /// Never claimed again, kept with `reason`, unless re-armed since the claim.
        "work.bury" => fn bury_work(WorkBury { id: String, claim: String, reason: String }) -> ();
        "sources.put" => fn put_source(SourcesPut { team_id: String, hash: String, source: String }) -> ();
        "sources.get" => fn source(SourcesGet { team_id: String, hash: String }) -> Option<String>;
        "inbound.checkpoint" => fn inbound_checkpoint(InboundCheckpoint { subscription_id: String }) -> Option<Checkpoint>;
        "inbound.saveCheckpoint" => fn save_inbound_checkpoint(InboundSaveCheckpoint { subscription_id: String, checkpoint: Js }) -> ();
        /// Each named listen's state, by its pipeline; one with nothing kept
        /// is absent.
        "listens.states" => fn listen_states(ListensStates { pipelines: Vec<String> }) -> BTreeMap<String, ListenState>;
        /// Hold the listen's resolve for `ttl_ms`, so one process lists it
        /// at a time; `None` while another's hold has not lapsed.
        "listens.claimResolve" => fn claim_listen_resolve(ListensClaimResolve { pipeline: String, ttl_ms: i64 }) -> Option<Lease>;
        /// Keep what the resolve held by `token` came to, the listen's
        /// `paused` as it is, and let the hold go, as one write. `false`, and
        /// nothing kept, when the hold lapsed and another took it since.
        "listens.saveResolution" => fn save_listen_resolution(ListensSaveResolution { pipeline: String, token: String, resolution: ListenResolution }) -> bool;
        /// Why the listen is paused (`None`: it is not), its resolution as it is.
        "listens.setPaused" => fn set_listen_paused(ListensSetPaused { pipeline: String, #[serde(default)] paused: Option<String> }) -> ();
        /// One write: the receipt first, then the cursor (absent: left as it
        /// is), the arrivals and the work rows. A duplicate
        /// (`delivery.external_id` kept at this subscription before) writes
        /// nothing and answers `kept: false`. With `arrivals`: they are
        /// logged as `waits.log` logs them, with the `wake_await` row it
        /// queues per wait they answer, after `waits` open, each from
        /// `waits.mark` before the arrivals (its `pre_noted` trigger noted on
        /// it); each `fire_event` row's payload gains `arrivalMark`, that
        /// mark; and those wake rows are answered as `wakes`. The mark is
        /// answered as `arrival_mark`. A `fire_event` row this write queued
        /// that is buried (`work.bury`) takes with it the waits it opened
        /// for runs that never started. A `keep_delivery` that logs through the
        /// store's own `log_arrivals` has queued them already: it must not
        /// queue them a second time, or each wait wakes twice.
        "inbound.keepDelivery" => fn keep_delivery(InboundKeepDelivery {
            subscription_id: String,
            #[serde(default, deserialize_with = "present")]
            checkpoint: Option<Js>,
            delivery: NewDelivery,
            work: Vec<NewWork>,
            #[serde(default)]
            arrivals: Option<DeliveryArrivals>,
            #[serde(default)]
            waits: Vec<DeliveryWait>,
        }) -> Kept;
        /// Clear a kept delivery's `external_id`, its receipt kept: its
        /// events failed inside the request, so the sender's retry under
        /// that id is a delivery of its own.
        "inbound.forgetDeliveryId" => fn forget_delivery_id(InboundForgetDeliveryId { id: String }) -> ();
        /// Most recent first, each with its runs and without its events;
        /// `since`: received at or after it.
        "inbound.deliveries" => fn deliveries(InboundDeliveries { subscription_id: Option<String>, since: Option<String>, limit: i64 }) -> Vec<DeliveryRow>;
        /// With its events and its runs; `None` when none is kept.
        "inbound.delivery" => fn delivery(InboundDelivery { id: String }) -> Option<DeliveryRow>;
        /// Forget at most `limit` deliveries received before `before` whose
        /// runs are settled (none `running` or `parked`) and that no
        /// `fire_event` row names (`payload.deliveryId`); how many went.
        "inbound.sweepDeliveries" => fn sweep_deliveries(InboundSweepDeliveries { before: String, limit: i64 }) -> i64;
        /// The module processes the hosts on this store started (so the next
        /// stops what a killed one left), with the list's version.
        "processes.list" => fn module_processes(ProcessesList {}) -> ModuleProcesses;
        /// Write `processes` only if the list is still at `version` (it moves
        /// to `version + 1`); `true` when it wrote.
        "processes.swap" => fn swap_module_processes(ProcessesSwap { version: i64, processes: Js }) -> bool;
        /// `true` the first time this event key reaches this listen; `false`
        /// for a redelivery, which runs nothing.
        "events.claim" => fn claim_event(EventsClaim { listen: String, key: String }) -> bool;
    }
}

/// A field that is present, even as `null`, is Some: `inbound.keepDelivery`'s
/// cursor is absent when it did not move, and may move to `null`.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Js>, D::Error> {
    Js::deserialize(deserializer).map(Some)
}

// ── limiter ──────────────────────────────────────────────────────────────────

/// One limit a call counts in: at most `calls` per `per_ms`, and at most
/// `concurrent` permits held at once, in the bucket `key` names (opaque).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub key: String,
    pub calls: Option<f64>,
    pub per_ms: Option<f64>,
    pub concurrent: Option<f64>,
}

/// An `acquire`'s answer. A refused call counts in no limit.
#[derive(Debug, Clone)]
pub enum Grant {
    Granted { permit: String },
    /// Ask again at this instant.
    Refused { retry_at: String },
}

impl Serialize for Grant {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        match self {
            Grant::Granted { permit } => {
                map.serialize_entry("granted", &true)?;
                map.serialize_entry("permit", permit)?;
            }
            Grant::Refused { retry_at } => {
                map.serialize_entry("granted", &false)?;
                map.serialize_entry("retryAt", retry_at)?;
            }
        }
        map.end()
    }
}

slot! {
    /// The limiter slot: keeps the host's calls to modules and models inside
    /// the providers' limits. No method waits; the host does the waiting.
    /// Every request carries its limits, so a limiter keeps no configuration.
    pub trait Limiter served as LimiterModule in slot "limiter" {
        "limiter.open" => fn open(LimiterOpen { #[serde(default)] settings: BTreeMap<String, String> }) -> ();
        /// Granted only when every limit has room and `key` is not throttled;
        /// then the call counts in all of them at once. A permit never
        /// released lapses after `hold_ms`.
        "limiter.acquire" => fn acquire(LimiterAcquire { key: String, cost: f64, limits: Vec<Limit>, hold_ms: i64 }) -> Grant;
        /// A permit released twice, or never given, changes nothing.
        "limiter.release" => fn release(LimiterRelease { permit: String }) -> ();
        /// No call on `key` before `until`.
        "limiter.throttle" => fn throttle(LimiterThrottle { key: String, until: String }) -> ();
    }
}

// ── wake ─────────────────────────────────────────────────────────────────────

slot! {
    /// The wake slot: the host saying work is due, so whatever starts its
    /// workers (a cloud queue, a scheduled task service) starts one then.
    /// Each method answers once the wake is arranged, not once the work ran.
    /// `kind` is the work row's kind (`fire_event`, `resume_timer`, …); a
    /// module may start a worker for that kind's pool, or ignore it.
    pub trait Wake served as WakeModule in slot "wake" {
        /// Start a worker soon. Many in a row may start one.
        "wake.now" => fn now(WakeNow { kind: String }) -> ();
        /// Start a worker at `at` (an instant, as `Date.toISOString` writes
        /// it), never before; one in the past is `now`. Refuse an `at` that
        /// is not an instant with `ModuleError::bad_request`.
        "wake.at" => fn at(WakeAt { kind: String, at: String }) -> ();
    }
}

// ── ocr ──────────────────────────────────────────────────────────────────────

/// One cost line of a read: what it spent, as the run's spend counts it.
#[derive(Debug, Clone, Serialize)]
pub struct OcrCost {
    pub label: String,
    pub microdollars: u64,
}

/// An `ocr.read`'s answer.
#[derive(Debug, Clone, Serialize)]
pub struct OcrRead {
    /// Every page's text, in page order; empty when the pages hold none.
    pub text: String,
    /// The pages read (an image is one).
    pub pages: u64,
    /// Required, and not zero for pages read unless the module is free:
    /// the host refuses a read its run's cost cap cannot count.
    pub cost: Vec<OcrCost>,
}

slot! {
    /// The ocr slot: a scanned PDF's or an image's bytes in, their text out.
    /// The host asks it of a file with no text layer of its own; a module
    /// asks it through the host (`Ctx::ocr`). Refuse bytes of a type the
    /// module does not read with the code `unsupported_type`. The optional
    /// `ocr.prices` (a price per page) is not part of this trait: a module
    /// publishing one serves it beside it.
    pub trait Ocr served as OcrModule in slot "ocr" {
        "ocr.read" => fn read(OcrReadRequest {
            #[serde(deserialize_with = "crate::host_ocr::base64_bytes")]
            bytes: Vec<u8>,
            content_type: String,
            #[serde(default)]
            name: Option<String>,
            label: String,
        }) -> OcrRead;
    }
}

// ── loop guard ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentRecord {
    pub record_type: String,
    pub record: Js,
}

/// An `isEcho`'s answer.
#[derive(Debug, Clone)]
pub enum Echo {
    Decided(bool),
    /// The guard needs the record as it stands: the host reads it and asks
    /// again with `current`.
    Read { record_type: String },
}

impl Serialize for Echo {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(1))?;
        match self {
            Echo::Decided(echo) => map.serialize_entry("echo", echo)?,
            Echo::Read { record_type } => {
                let read: BTreeMap<&str, &str> = BTreeMap::from([("recordType", record_type.as_str())]);
                map.serialize_entry("read", &read)?;
            }
        }
        map.end()
    }
}

slot! {
    /// The loop guard slot: tells a movement's own write coming back (an
    /// echo) from a real change. Any doubt means the event fires.
    pub trait LoopGuard served as LoopGuardModule in slot "loopGuard" {
        "guard.open" => fn open(GuardOpen { #[serde(default)] settings: BTreeMap<String, String> }) -> ();
        /// `writer` (`listen:<file>:<movement>`) wrote `external_id`; `record`
        /// is the source's answer read back right after (`null`: gone).
        "guard.recordWrite" => fn record_write(GuardRecordWrite { adapter: String, record_type: String, external_id: String, writer: String, record: Js }) -> ();
        "guard.isEcho" => fn is_echo(GuardIsEcho { adapter: String, external_id: String, writer: String, current: Option<CurrentRecord> }) -> Echo;
    }
}

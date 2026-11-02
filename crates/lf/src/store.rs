//! The run host's backend families (movement-engine
//! `services/run_host/store.ts`) over SQLite, in the state file
//! `.lf/state.db` (@lf/sqlite-store, the store slot's default). Held to the hosted
//! Postgres backend's meaning by the run host's contract suite, which drives
//! this store through `--contract-store` (crate::contract_store).
//!
//! Instants are text in `Date.toISOString`'s form, compared as text: that
//! form sorts as the instants do.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params, params_from_iter};

use crate::backend::SQLITE_TENANT;
use crate::json::Js;
use crate::waits::WaitWake;

/// The state file's tables, created when missing on every open.
pub const SCHEMA: &str = "
create table if not exists run (
  id text primary key,
  file text not null,
  movement text not null,
  status text not null,
  started_at text not null,
  finished_at text,
  input text not null,
  outcome text,
  lease_token text,
  lease_until text,
  attempt integer not null default 1,
  attempts text not null default '[]'
);
create table if not exists trace (
  run_id text not null,
  seq integer not null,
  entry text not null,
  primary key (run_id, seq)
);
create table if not exists leaf (
  run_id text not null,
  address text not null,
  reason text not null,
  status text not null default 'parked',
  wake_at text,
  state text not null,
  primary key (run_id, address)
);
create table if not exists join_frame (
  run_id text not null,
  frame_address text not null,
  pending integer not null,
  closed_by_address text,
  primary key (run_id, frame_address)
);
create table if not exists join_branch_export (
  run_id text not null,
  frame_address text not null,
  branch_address text not null,
  branch_index integer not null,
  exports text not null,
  decremented integer not null default 0,
  primary key (run_id, frame_address, branch_address)
);
create table if not exists record_binding (
  a_adapter_type text not null,
  a_instance_key text not null,
  a_type_id text not null,
  a_record_id text not null,
  b_adapter_type text not null,
  b_instance_key text not null,
  b_type_id text not null,
  b_record_id text not null,
  bound_seq integer not null,
  primary key (a_adapter_type, a_instance_key, a_type_id, a_record_id, b_adapter_type, b_instance_key, b_type_id, b_record_id)
);
create table if not exists park_library_source (
  team_id text not null,
  hash text not null,
  source text not null,
  primary key (team_id, hash)
);
create table if not exists inbound_checkpoint (
  subscription_id text primary key,
  checkpoint text not null
);
create table if not exists listen_state (
  pipeline text primary key,
  state text not null,
  lease_token text,
  lease_until text
);
create table if not exists write_ledger (
  adapter text not null,
  record_type text not null,
  external_id text not null,
  run_id text not null,
  depth integer not null,
  at text not null
);
create index if not exists write_ledger_record on write_ledger (adapter, record_type, external_id, at);
create index if not exists write_ledger_at on write_ledger (at);
create table if not exists release_seen (
  version text primary key,
  seen_at text not null
);
create index if not exists release_seen_at on release_seen (seen_at, version);
create index if not exists run_failed on run (finished_at, id) where status = 'failed';
create table if not exists arrival_unjudged (
  pipeline text not null,
  arrival text not null,
  file text not null,
  movement text not null,
  delivery_id text,
  edge text not null,
  adapter text,
  record_id text,
  landing text,
  reason text not null,
  cause text,
  noted_at text not null,
  attempt integer not null,
  primary key (pipeline, arrival, attempt)
);
create index if not exists arrival_unjudged_at on arrival_unjudged (noted_at, pipeline, arrival, attempt);
create table if not exists module_processes (
  id integer primary key check (id = 1),
  processes text not null,
  version integer not null
);
create table if not exists event_receipt (
  team_id text not null default 'local',
  listen text not null,
  key text not null,
  received_at text not null,
  primary key (team_id, listen, key)
);
create table if not exists delivery (
  id text primary key,
  subscription_id text not null,
  external_id text,
  received_at text not null,
  source text not null,
  inline integer not null,
  replay_of text,
  events text not null,
  event_count integer not null,
  request text
);
create unique index if not exists delivery_external on delivery (subscription_id, external_id) where external_id is not null;
create index if not exists delivery_received on delivery (received_at);
create table if not exists arrival (
  seq integer primary key autoincrement,
  team_id text not null,
  adapter_type text not null,
  edge text not null,
  key text not null,
  identity text,
  version text,
  landing text,
  gone integer not null,
  logged_at text not null
);
create index if not exists arrival_key on arrival (team_id, adapter_type, edge, key, seq);
create index if not exists arrival_logged on arrival (logged_at);
create table if not exists arrival_identity (
  team_id text not null,
  adapter_type text not null,
  edge text not null,
  key text not null,
  identity text not null,
  version text,
  kept_until text not null
);
create index if not exists arrival_identity_of on arrival_identity (team_id, adapter_type, edge, key, identity);
create index if not exists arrival_identity_until on arrival_identity (kept_until);
create table if not exists wait_seen (
  id integer primary key autoincrement,
  wait_id text not null,
  identity text not null,
  version text,
  matched integer not null,
  leaf text
);
create index if not exists wait_seen_identity on wait_seen (wait_id, identity);
create table if not exists work (
  id integer primary key autoincrement,
  kind text not null,
  key text not null unique,
  payload text not null,
  due_at text not null,
  lease_token text,
  lease_until text,
  version integer not null default 0,
  attempts integer not null default 0,
  dead_at text,
  dead_reason text
);
";

/// The core's park reasons (`CORE_PARK_REASONS`).
pub const CORE_PARK_REASONS: &[&str] = &["timer", "await", "limit"];
/// The work kinds listen-fire queues.
pub const WORK_KINDS: &[&str] = &["resume_timer", "wake_await", "fire_event", crate::edge_polls::EDGE_POLL_WORK_KIND, crate::resolve::RESOLVE_WORK_KIND, "refresh_subscription", SETTLE_RACE_WORK_KIND];
/// A race a resumed arm won and left to its run to settle (crate::run_host):
/// the row is what the run owes until the commit of the step that settles
/// the race deletes it.
pub const SETTLE_RACE_WORK_KIND: &str = "settle_race";

/// A run's waits (crate::waits). `key` is null for a wait opened on a record
/// already gone, one per run and edge as a keyed wait is one per record;
/// `stranded_at` is when the wait was found parked on a deleted record;
/// `record_id` the record it waits on, as the engine named it.
const WAIT_ROW: &str = "
create table if not exists wait_row (
  id text primary key,
  run_id text not null,
  team_id text not null,
  adapter_type text not null,
  edge text not null,
  key text,
  since integer not null,
  address text,
  stranded_at text,
  fire_key text,
  record_id text
);
create unique index if not exists wait_row_edge on wait_row (run_id, team_id, adapter_type, edge, key);
create unique index if not exists wait_row_keyless on wait_row (run_id, team_id, adapter_type, edge) where key is null;
create index if not exists wait_row_key on wait_row (team_id, adapter_type, edge, key);
create index if not exists wait_row_stranded on wait_row (stranded_at, id) where stranded_at is not null;
create index if not exists wait_row_fire_key on wait_row (fire_key) where fire_key is not null;
";

/// Columns a state file written by an earlier listen-fire lacks, added on open.
const ADDED_RUN_COLUMNS: &[&str] = &["cancel_requested_at", "cancel_reason", "delivery_id", "team_id"];
/// Added to a state file written before a failed run could be run again.
const ATTEMPT_COLUMNS: &[(&str, &str)] = &[("attempt", "integer not null default 1"), ("attempts", "text not null default '[]'")];
/// Added to a state file written before a run's lease kept the arrival
/// mark its step took (the sweep's floor).
const LEASE_COLUMNS: &[(&str, &str)] = &[("lease_mark", "integer")];
const ADDED_WORK_COLUMNS: &[(&str, &str)] = &[("attempts", "integer not null default 0"), ("dead_at", "text"), ("dead_reason", "text")];

#[derive(Debug)]
pub enum StoreError {
    /// `RunLeaseLost`: a fenced write under a token that no longer holds the run.
    LeaseLost { run_id: String },
    /// A value outside what the families take.
    Invalid(String),
    Db(rusqlite::Error),
    /// Another backend's failure (crate::pg_store), in its own words.
    Backend(String),
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        StoreError::Db(error)
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            // `RunLeaseLost`'s words.
            StoreError::LeaseLost { .. } => f.write_str("run lease lost; another instance may hold the run"),
            StoreError::Invalid(message) => f.write_str(message),
            StoreError::Db(error) => write!(f, "{error}"),
            StoreError::Backend(message) => f.write_str(message),
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// A run's row, as far as the host reads it.
pub struct RunRow {
    pub id: String,
    pub file: String,
    pub movement: String,
    pub status: String,
    pub started_at: String,
    /// When it last settled completed or failed; none while it runs or is parked.
    pub finished_at: Option<String>,
    /// The run's facts a resume needs, as JSON.
    pub input: String,
    pub outcome: Option<String>,
    /// The delivery whose event started it, when one did.
    pub delivery_id: Option<String>,
    /// The latest attempt's number, from 1: a rerun (`listen-fire runs rerun`) is
    /// the run's next attempt. `status`, `started_at`, `finished_at`,
    /// `input` and `outcome` are that attempt's.
    pub attempt: i64,
    /// The earlier attempts, oldest first, each as the rerun kept it:
    /// `{ attempt, status, startedAt, finishedAt, outcome }`.
    pub attempts: Vec<Js>,
}

pub(crate) const RUN_COLUMNS: &str = "id, file, movement, status, started_at, input, outcome, delivery_id, finished_at, attempt, attempts";

pub(crate) fn run_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    Ok(RunRow {
        id: r.get(0)?,
        file: r.get(1)?,
        movement: r.get(2)?,
        status: r.get(3)?,
        started_at: r.get(4)?,
        input: r.get(5)?,
        outcome: r.get(6)?,
        delivery_id: r.get(7)?,
        finished_at: r.get(8)?,
        attempt: r.get(9)?,
        attempts: attempts_of(&r.get::<_, String>(10)?),
    })
}

/// A run's earlier attempts as kept: a list that does not read is none.
fn attempts_of(text: &str) -> Vec<Js> {
    Js::parse(text.as_bytes()).ok().and_then(|list| list.as_array().map(<[Js]>::to_vec)).unwrap_or_default()
}

/// The attempt a rerun keeps beside the run: the run's latest, as it settled.
pub fn kept_attempt(run: &RunRow) -> Js {
    let outcome = run.outcome.as_deref().and_then(|text| Js::parse(text.as_bytes()).ok()).unwrap_or(Js::Null);
    Js::Obj(crate::obj! {
        "attempt" => Js::Num(run.attempt.into()),
        "status" => Js::str(&run.status),
        "startedAt" => Js::str(&run.started_at),
        "finishedAt" => run.finished_at.as_deref().map_or(Js::Null, Js::str),
        "outcome" => outcome,
    })
}

pub struct LeafRow {
    pub address: String,
    pub reason: String,
    pub status: String,
    pub wake_at: Option<String>,
}

/// One claim of due work rows (`work.claimDue`).
pub struct ClaimDue<'a> {
    pub limit: i64,
    pub lease_ms: i64,
    /// None: now.
    pub due_by: Option<&'a str>,
    /// Only rows of these kinds (a drain pool's, `listen-fire drain --kinds`); None:
    /// every kind listen-fire drains.
    pub kinds: Option<&'a [String]>,
}

impl ClaimDue<'_> {
    /// The kinds the claim takes, each one listen-fire drains.
    pub fn kinds(&self) -> Result<Vec<String>> {
        let Some(kinds) = self.kinds else { return Ok(WORK_KINDS.iter().map(|k| k.to_string()).collect()) };
        match kinds.iter().find(|k| !WORK_KINDS.contains(&k.as_str())) {
            Some(other) => Err(StoreError::Invalid(format!("not a work kind: {other} (the kinds: {})", WORK_KINDS.join(", ")))),
            None => Ok(kinds.to_vec()),
        }
    }
}

pub struct ClaimedWork {
    pub id: String,
    pub kind: String,
    pub key: String,
    pub payload: Js,
    pub claim: String,
    /// The row's claims since it last succeeded, this one included, less
    /// those given back ([`Release::Busy`]): a claim whose worker died counts.
    pub attempts: i64,
}

/// What a claimed row's release says of the claim (`work.release`'s `why`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Release {
    /// The work failed: the claim was an attempt.
    Failed,
    /// The row's run was held elsewhere: the claim was no attempt.
    Busy,
    /// The work was done and is due again (a polled listen's next poll):
    /// its attempts start over.
    Rescheduled,
}

impl Release {
    pub fn wire(self) -> &'static str {
        match self {
            Release::Failed => "failed",
            Release::Busy => "busy",
            Release::Rescheduled => "rescheduled",
        }
    }

    /// Absent is `failed`: a release before `why` existed was a retry.
    pub fn of_wire(why: Option<&str>) -> Result<Release> {
        match why {
            None | Some("failed") => Ok(Release::Failed),
            Some("busy") => Ok(Release::Busy),
            Some("rescheduled") => Ok(Release::Rescheduled),
            Some(other) => Err(StoreError::Invalid(format!("not a release: {other} (failed, busy or rescheduled)"))),
        }
    }
}

/// A work row to queue, as `work.enqueue` takes it.
#[derive(Debug, Clone)]
pub struct NewWork {
    pub kind: String,
    pub key: String,
    pub payload: Js,
    /// None: now.
    pub due_at: Option<String>,
    /// None: the store's own tenant's row.
    pub team_id: Option<String>,
}

/// A run's `resume_timer` row: one per run, due at its earliest timer.
pub fn timer_work_key(run_id: &str) -> String {
    format!("resume_timer:{run_id}")
}

pub fn timer_work_payload(run_id: &str) -> Js {
    Js::Obj(crate::obj! { "runId" => Js::str(run_id) })
}

/// The `settle_race` row of the race at `frame_address`: one per race, so
/// every arm that owes it writes the same row.
pub fn settle_race_work_key(run_id: &str, frame_address: &str) -> String {
    format!("{SETTLE_RACE_WORK_KIND}:{run_id}:{frame_address}")
}

pub fn settle_race_work_payload(run_id: &str, race: &HeldRace<'_>) -> Js {
    Js::Obj(crate::obj! { "runId" => Js::str(run_id), "frameAddress" => Js::str(race.frame_address), "state" => race.state.clone() })
}

/// A race the run owes (`parks.owedRaces`): its frame, and the state of an
/// arm that won it, which the step that settles it resumes from.
#[derive(Debug, Clone, PartialEq)]
pub struct OwedRace {
    pub frame_address: String,
    pub state: Js,
}

impl OwedRace {
    /// A `settle_race` row's payload, or `parks.owedRaces`'s answer, read
    /// back; None when it is not one.
    pub fn of_payload(payload: &Js) -> Option<OwedRace> {
        Some(OwedRace { frame_address: payload.get("frameAddress")?.as_str()?.to_string(), state: payload.get("state")?.clone() })
    }
}

/// One park, kept as one with what wakes it (`parks.commit`): the leaf, the
/// kind's own row, and the run marked parked.
pub struct Park<'a> {
    pub run_id: &'a str,
    pub address: &'a str,
    pub state: &'a Js,
    /// The lease the write is fenced on; a lost one writes nothing.
    pub fence: Option<&'a str>,
    pub kind: ParkKind<'a>,
}

/// What a segment held back to keep in one write at its end
/// (`parks.commitSegment`, crate::segment): the joins it recorded, the
/// parks it made, the end of the leaf it resumed, and the races it owes or
/// settled. A segment that dies before it leaves none of them, so the leaf
/// it resumed is resumed again, and the race it settled is still owed.
pub struct SegmentCommit<'a> {
    pub run_id: &'a str,
    /// The tenant the wakes it queues are queued under.
    pub team_id: &'a str,
    /// The lease the write is fenced on; a lost one writes nothing.
    pub fence: Option<&'a str>,
    /// The leaf the segment resumed, finished in this write (deleted if
    /// resuming, its notes kept) unless one of `parks` is at its address.
    pub resumed: Option<&'a str>,
    pub joins: Vec<HeldJoin<'a>>,
    pub parks: Vec<HeldPark<'a>>,
    /// Where the run stands after the segment, kept in this write as
    /// `runs.settle` keeps it, so a run never stays parked with nothing
    /// left to wake it; None leaves the run's row as it is.
    pub settle: Option<RunSettle<'a>>,
    /// The races the resumed arm won and left to the run to settle: each a
    /// `settle_race` row, queued in this write, so the obligation outlives
    /// a crash before the step that settles it.
    pub owed_races: Vec<HeldRace<'a>>,
    /// The race this segment settled: its `settle_race` row is deleted in
    /// this write.
    pub settled_race: Option<&'a str>,
}

/// A race a segment owes (`parks.commitSegment`'s `owedRaces`).
pub struct HeldRace<'a> {
    pub frame_address: &'a str,
    pub state: &'a Js,
}

/// A run's settle (`runs.settle`'s): its status, its outcome and when.
pub struct RunSettle<'a> {
    pub status: &'a str,
    pub outcome: &'a Js,
    pub at: &'a str,
}

/// A join frame's pending count (`joins.recordJoin`), held by a segment.
pub struct HeldJoin<'a> {
    pub frame_address: &'a str,
    pub pending: i64,
}

/// A park (`parks.commit` without its run and fence), held by a segment.
pub struct HeldPark<'a> {
    pub address: &'a str,
    pub state: &'a Js,
    pub kind: ParkKind<'a>,
}

#[derive(Clone, Copy)]
pub enum ParkKind<'a> {
    /// Woken by the run's `resume_timer` row, armed at `wake_at` (an earlier
    /// due time it already has is kept).
    Timer { wake_at: &'a str },
    /// Woken when an arrival is logged on its wait's record (crate::waits),
    /// which it parks at its address.
    Wait { wait_id: &'a str },
    /// Paused at a run limit.
    Limit,
}

impl ParkKind<'_> {
    pub fn reason(&self) -> &'static str {
        match self {
            ParkKind::Timer { .. } => "timer",
            ParkKind::Wait { .. } => "await",
            ParkKind::Limit => "limit",
        }
    }
}

/// A failed run's next attempt (`runs.rerun`), written under its lease.
pub struct Rerun<'a> {
    /// The attempt's facts, as `RunStart::input`.
    pub input: &'a str,
    /// When the attempt starts: the run's `started_at` from now on.
    pub at: &'a str,
    pub fence: &'a str,
}

/// A new run's row (`runs.start`).
pub struct RunStart<'a> {
    pub id: &'a str,
    pub file: &'a str,
    pub movement: &'a str,
    pub started_at: &'a str,
    /// The run's facts a resume needs, as JSON.
    pub input: &'a str,
    /// The delivery whose event started it (`delivery.id`), when one did.
    pub delivery_id: Option<&'a str>,
    /// The team it is kept under; None: the store's own tenant.
    pub team_id: Option<&'a str>,
}

/// A listen's receipt of an event or arrival (`events.claim`): its key
/// (the event's `idempotencyKey`, or the arrival's receipt key) on the
/// listen's pipeline, under a team. None: the store's own tenant.
#[derive(Clone, Copy)]
pub struct EventReceipt<'a> {
    pub team_id: Option<&'a str>,
    pub listen: &'a str,
    pub key: &'a str,
}

impl<'a> EventReceipt<'a> {
    /// A receipt under the store's own tenant, as listen-fire's runs take one.
    pub fn own(listen: &'a str, key: &'a str) -> EventReceipt<'a> {
        EventReceipt { team_id: None, listen, key }
    }
}

/// Where a delivery came in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DeliverySource {
    /// A provider's webhook at its door.
    Webhook,
    /// listen-fire's older `/hooks/<external>` door.
    Hook,
    /// An external's own push (`emit`).
    Emit,
    /// `listen-fire run --webhook`, or a replay by `listen-fire listens replay`.
    Cli,
    /// A poll of a listenable edge that fired a listen sharing it: its
    /// arrivals, and the waits of the runs it started, kept in one write.
    Poll,
}

impl DeliverySource {
    pub fn wire(self) -> &'static str {
        match self {
            DeliverySource::Webhook => "webhook",
            DeliverySource::Hook => "hook",
            DeliverySource::Emit => "emit",
            DeliverySource::Cli => "cli",
            DeliverySource::Poll => "poll",
        }
    }

    pub fn of_wire(source: &str) -> Result<DeliverySource> {
        match source {
            "webhook" => Ok(DeliverySource::Webhook),
            "hook" => Ok(DeliverySource::Hook),
            "emit" => Ok(DeliverySource::Emit),
            "cli" => Ok(DeliverySource::Cli),
            "poll" => Ok(DeliverySource::Poll),
            other => Err(StoreError::Invalid(format!("not a delivery source: {other} (webhook, hook, emit, cli or poll)"))),
        }
    }
}

/// A delivery's receipt, kept in the door's one write (`inbound.keepDelivery`):
/// the events it produced, and the request as it was received, for a replay
/// (crate::listen_replay).
#[derive(Debug, Clone)]
pub struct NewDelivery {
    /// listen-fire's own id for it.
    pub id: String,
    /// The provider's id for it, when the door has one: a second delivery
    /// under it, at the same subscription, is kept out.
    pub external_id: Option<String>,
    pub received_at: String,
    pub source: DeliverySource,
    /// Its events ran inside the request rather than from the queue.
    pub inline: bool,
    /// The delivery it replays.
    pub replay_of: Option<String>,
    pub events: Vec<Js>,
    /// The request as the door received it (crate::inbound::Captured): its
    /// body, the headers its module declares it reads (never a credential)
    /// and the arrivals it brought. Sensitive:
    /// kept while the delivery is (`deliveries.retainDays`), shown only when
    /// asked for. A poll's page keeps the arrivals it read instead
    /// (crate::inbound::Page). None for a delivery no request made (a replay).
    pub request: Option<Js>,
}

/// A kept delivery, as `inbound.deliveries` and `inbound.delivery` read it.
#[derive(Debug, Clone)]
pub struct DeliveryRow {
    pub id: String,
    pub subscription_id: String,
    pub external_id: Option<String>,
    pub received_at: String,
    pub source: DeliverySource,
    pub inline: bool,
    pub replay_of: Option<String>,
    pub event_count: i64,
    /// The runs its events started.
    pub runs: Vec<DeliveryRun>,
    /// Read by `inbound.delivery` only.
    pub events: Option<Vec<Js>>,
    /// Read by `inbound.delivery` only: the request it was received as,
    /// while it is kept (NewDelivery::request).
    pub request: Option<Js>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeliveryRun {
    pub id: String,
    pub status: String,
}

/// Which deliveries `inbound.deliveries` lists, most recent first.
pub struct DeliveryQuery<'a> {
    pub subscription_id: Option<&'a str>,
    /// Received at or after this instant.
    pub since: Option<&'a str>,
    pub limit: i64,
}

pub struct BranchExport {
    pub branch_address: String,
    pub branch_index: i64,
    pub exports: Js,
}

/// `Date.prototype.toISOString` of now plus `offset_ms`.
pub fn iso(offset_ms: i64) -> String {
    iso_at(jiff::Timestamp::now().as_millisecond() + offset_ms)
}

/// The instant `at` (epoch milliseconds), as `iso` writes it.
pub fn iso_at(at: i64) -> String {
    let ts = jiff::Timestamp::from_millisecond(at).expect("an instant within range");
    format!("{}.{:03}Z", ts.strftime("%Y-%m-%dT%H:%M:%S"), at.rem_euclid(1000))
}

/// An instant a caller gave, as `iso` writes it: the state file orders and
/// compares instants as text, so one written in another form (an offset,
/// no milliseconds) would sort apart from the instant it names.
pub(crate) fn canonical_iso(text: &str) -> Result<String> {
    text.parse::<jiff::Timestamp>().map(|at| iso_at(at.as_millisecond())).map_err(|_| StoreError::Invalid(format!("{text}: not an ISO 8601 instant")))
}

pub(crate) fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn text_of(value: &Js) -> String {
    value.to_json()
}

fn parse_text(text: &str) -> Result<Js> {
    Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored value is not JSON: {e}")))
}

fn reason_of(reason: String) -> Result<String> {
    if CORE_PARK_REASONS.contains(&reason.as_str()) { Ok(reason) } else { Err(StoreError::Invalid(format!("not a park reason: {reason}"))) }
}

/// A work claim's handle (`<lease token>/<version>`).
fn work_claim(claim: &str) -> Result<(String, i64)> {
    let not = || StoreError::Invalid(format!("not a work claim: {claim}"));
    let at = claim.rfind('/').filter(|at| *at > 0).ok_or_else(not)?;
    let version = claim[at + 1..].parse::<i64>().map_err(|_| not())?;
    Ok((claim[..at].to_string(), version))
}

pub struct Store {
    pub(crate) db: Connection,
}

/// What a run has spent, and what it had spent when last resumed from its
/// cost cap, in microdollars (the cost cap reads the difference).
const SPEND_COLUMNS: &[&str] = &["spent_microdollars", "cost_cap_baseline_microdollars"];

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        let db = Connection::open(path)?;
        // Two processes may share the file: readers never block the writer,
        // and a writer waits for another's transaction.
        db.execute_batch("pragma journal_mode = wal; pragma busy_timeout = 5000;")?;
        db.execute_batch(SCHEMA)?;
        let columns = db
            .prepare("select name from pragma_table_info('run')")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for column in ADDED_RUN_COLUMNS {
            if !columns.iter().any(|c| c == column) {
                db.execute_batch(&format!("alter table run add column {column} text"))?;
            }
        }
        for (column, declared) in ATTEMPT_COLUMNS.iter().chain(LEASE_COLUMNS) {
            if !columns.iter().any(|c| c == column) {
                db.execute_batch(&format!("alter table run add column {column} {declared}"))?;
            }
        }
        // As @lf/postgres-store's migration 13: the leases a sweep's floor reads.
        db.execute_batch(
            "create index if not exists run_delivery on run (delivery_id);
             create index if not exists run_lease_mark on run (lease_until) where lease_mark is not null;",
        )?;
        Self::open_wait_rows(&db)?;
        Self::open_event_receipts(&db)?;
        // Added to a state file written before a delivery kept its request.
        let delivery_columns = db
            .prepare("select name from pragma_table_info('delivery')")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !delivery_columns.iter().any(|c| c == "request") {
            db.execute_batch("alter table delivery add column request text")?;
        }
        // Added to a state file written before a fact kept what landed and
        // the module it came from (0.13.0).
        let unjudged_columns = db
            .prepare("select name from pragma_table_info('arrival_unjudged')")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for column in ["adapter", "landing"] {
            if !unjudged_columns.iter().any(|c| c == column) {
                db.execute_batch(&format!("alter table arrival_unjudged add column {column} text"))?;
            }
        }
        // Callbacks and the waits keyed by a correlation retired at 0.13: a
        // run parked on one cannot resume on this release, and the work rows
        // that would have woken it (a callback's firing, a wake by key
        // rather than by wait) have no kind left to run as. Nor has a
        // settings listen's poll: a listen is polled on its edge from 0.13.
        db.execute_batch(
            "drop table if exists callback; drop table if exists await_correlation;
             delete from work where kind in ('fire_callback', 'poll_listen') or (kind = 'wake_await' and json_extract(payload, '$.waitId') is null);",
        )?;
        // Added to a state file written before the cost cap kept run spend.
        for column in SPEND_COLUMNS {
            if !columns.iter().any(|c| c == column) {
                db.execute_batch(&format!("alter table run add column {column} real not null default 0"))?;
            }
        }
        // Added to a state file written before a failing row's retries were capped.
        let work_columns = db
            .prepare("select name from pragma_table_info('work')")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (column, declared) in ADDED_WORK_COLUMNS {
            if !work_columns.iter().any(|c| c == column) {
                db.execute_batch(&format!("alter table work add column {column} {declared}"))?;
            }
        }
        Ok(Store { db })
    }

    /// The wait rows, rebuilt from a state file written before a wait could
    /// be stranded or keyless (SQLite cannot drop a column's `not null`).
    fn open_wait_rows(db: &Connection) -> Result<()> {
        fn open(db: &Connection) -> Result<()> {
            let columns = db
                .prepare("select name from pragma_table_info('wait_row')")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if columns.is_empty() || columns.iter().any(|c| c == "stranded_at") {
                // Columns added since a wait could be stranded.
                for column in ["fire_key", "record_id"] {
                    if !columns.is_empty() && !columns.iter().any(|c| c == column) {
                        db.execute_batch(&format!("alter table wait_row add column {column} text"))?;
                    }
                }
                return Ok(db.execute_batch(WAIT_ROW)?);
            }
            Ok(db.execute_batch(&format!(
                "drop index if exists wait_row_edge; drop index if exists wait_row_key;
                 alter table wait_row rename to wait_row_before;
                 {WAIT_ROW}
                 insert into wait_row (id, run_id, team_id, adapter_type, edge, key, since, address)
                   select id, run_id, team_id, adapter_type, edge, key, since, address from wait_row_before;
                 drop table wait_row_before;"
            ))?)
        }
        // Read under the write lock: another process opening the same state
        // file may be rebuilding the table, and a second rebuild would
        // rename the rebuilt table (its indexes with it) before dropping it.
        db.execute_batch("begin immediate")?;
        match open(db) {
            Ok(()) => Ok(db.execute_batch("commit")?),
            Err(error) => {
                db.execute_batch("rollback")?;
                Err(error)
            }
        }
    }

    /// The receipts, rebuilt from a state file written before a receipt was
    /// a team's (SQLite cannot change a primary key): each kept is the
    /// store's own tenant's.
    fn open_event_receipts(db: &Connection) -> Result<()> {
        db.execute_batch("begin immediate")?;
        let rebuilt = (|| -> Result<()> {
            let columns = db
                .prepare("select name from pragma_table_info('event_receipt')")?
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if columns.iter().any(|c| c == "team_id") {
                return Ok(());
            }
            Ok(db.execute_batch(&format!(
                "alter table event_receipt rename to event_receipt_before;
                 create table event_receipt (
                   team_id text not null default '{SQLITE_TENANT}',
                   listen text not null,
                   key text not null,
                   received_at text not null,
                   primary key (team_id, listen, key)
                 );
                 insert into event_receipt (listen, key, received_at) select listen, key, received_at from event_receipt_before;
                 drop table event_receipt_before;"
            ))?)
        })();
        match rebuilt {
            Ok(()) => Ok(db.execute_batch("commit")?),
            Err(error) => {
                db.execute_batch("rollback")?;
                Err(error)
            }
        }
    }

    /// One write transaction, taken before its first read.
    pub(crate) fn transaction<T>(&self, body: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.db.execute_batch("begin immediate")?;
        match body(&self.db) {
            Ok(value) => {
                self.db.execute_batch("commit")?;
                Ok(value)
            }
            Err(error) => {
                self.db.execute_batch("rollback")?;
                Err(error)
            }
        }
    }

    /// Whether the run is leased under `fence`, and the lease has not lapsed.
    pub(crate) fn holds(db: &Connection, run_id: &str, fence: &str) -> Result<bool> {
        Ok(db
            .query_row("select 1 from run where id = ? and lease_token = ? and lease_until > ?", params![run_id, fence, iso(0)], |_| Ok(()))
            .optional()?
            .is_some())
    }

    fn fenced<T>(&self, run_id: &str, fence: Option<&str>, body: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.transaction(|db| {
            if let Some(fence) = fence
                && !Self::holds(db, run_id, fence)?
            {
                return Err(StoreError::LeaseLost { run_id: run_id.to_string() });
            }
            body(db)
        })
    }

    // ── Runs ────────────────────────────────────────────────────────────────

    pub fn start_run(&self, run: &RunStart<'_>) -> Result<()> {
        Self::start_run_in(&self.db, run)
    }

    fn start_run_in(db: &Connection, run: &RunStart<'_>) -> Result<()> {
        db.execute(
            "insert into run (id, file, movement, status, started_at, input, delivery_id, team_id) values (?, ?, ?, ?, ?, ?, ?, ?)",
            params![run.id, run.file, run.movement, "running", run.started_at, run.input, run.delivery_id, run.team_id.unwrap_or(SQLITE_TENANT)],
        )?;
        Ok(())
    }

    /// crate::backend::RunHostStore::start_event_run: the receipt and the
    /// run, or neither.
    pub fn start_event_run(&self, receipt: &EventReceipt<'_>, run: &RunStart<'_>) -> Result<bool> {
        self.transaction(|db| {
            if !Self::claim_event_in(db, receipt)? {
                return Ok(false);
            }
            Self::start_run_in(db, run)?;
            Ok(true)
        })
    }

    /// crate::backend::RunHostStore::lapsed_runs.
    pub fn lapsed_runs(&self, stale_ms: i64, limit: i64) -> Result<Vec<String>> {
        let now = iso(0);
        let mut statement = self.db.prepare(
            "select id from run
             where status = 'running' and (lease_until is null or lease_until < ?) and started_at < ?
             order by started_at limit ?",
        )?;
        Ok(statement.query_map(params![now, iso(-stale_ms), limit], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Record where the run stands.
    pub fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()> {
        self.transaction(|db| Self::settle_run_in(db, id, &RunSettle { status, outcome, at }))
    }

    fn settle_run_in(db: &Connection, id: &str, settle: &RunSettle<'_>) -> Result<()> {
        let RunSettle { status, outcome, at } = *settle;
        let ended = status == "completed" || status == "failed";
        db.execute(
            "update run set status = ?, outcome = ?, finished_at = ? where id = ?",
            params![status, text_of(outcome), ended.then_some(at), id],
        )?;
        Ok(())
    }

    /// The run is observably parked (a park landed). A settled run stays.
    pub fn mark_parked(&self, id: &str) -> Result<()> {
        Self::mark_parked_in(&self.db, id)
    }

    fn mark_parked_in(db: &Connection, id: &str) -> Result<()> {
        db.execute("update run set status = 'parked' where id = ? and status in ('running', 'parked')", params![id])?;
        Ok(())
    }

    /// The run is over without completing. A run already settled stays. The
    /// writes it settled with stay in its outcome: they were made.
    pub fn mark_failed(&self, id: &str, message: &str) -> Result<()> {
        self.transaction(|db| {
            db.execute(
                "update run set status = 'failed', outcome = json_set(coalesce(outcome, '{}'), '$.error', ?), finished_at = ?
                 where id = ? and status in ('running', 'parked')",
                params![message, iso(0), id],
            )?;
            Ok(())
        })
    }

    /// crate::backend::RunHostStore::rerun_run.
    pub fn rerun_run(&self, run_id: &str, rerun: &Rerun<'_>) -> Result<Option<i64>> {
        self.fenced(run_id, Some(rerun.fence), |db| {
            let Some(run) = db.query_row(&format!("select {RUN_COLUMNS} from run where id = ?"), params![run_id], run_row).optional()? else { return Ok(None) };
            if run.status != "failed" {
                return Ok(None);
            }
            let mut attempts = run.attempts.clone();
            attempts.push(kept_attempt(&run));
            let next = run.attempt + 1;
            db.execute(
                "update run set status = 'running', attempt = ?, attempts = ?, input = ?, started_at = ?, finished_at = null, outcome = null,
                   cancel_requested_at = null, cancel_reason = null, cost_cap_baseline_microdollars = spent_microdollars
                 where id = ?",
                params![next, Js::Arr(attempts).to_json(), rerun.input, rerun.at, run_id],
            )?;
            Ok(Some(next))
        })
    }

    /// An operator asks to cancel the run (`requestCancel`): the first
    /// request's reason stands, and a run already over takes none.
    pub fn request_cancel(&self, run_id: &str, reason: Option<&str>) -> Result<()> {
        self.db.execute(
            "update run set cancel_requested_at = ?, cancel_reason = ? where id = ? and cancel_requested_at is null and status in ('running', 'parked')",
            params![iso(0), reason, run_id],
        )?;
        Ok(())
    }

    /// The operator's cancel request on the run (its reason), or None.
    pub fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>> {
        Ok(self
            .db
            .query_row("select cancel_requested_at, cancel_reason from run where id = ?", params![id], |r| {
                Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .optional()?
            .and_then(|(at, reason)| at.map(|_| reason)))
    }

    pub fn run(&self, id: &str) -> Result<Option<RunRow>> {
        Ok(self.db.query_row(&format!("select {RUN_COLUMNS} from run where id = ?"), params![id], run_row).optional()?)
    }

    /// The most recent runs first.
    pub fn runs(&self, limit: i64) -> Result<Vec<RunRow>> {
        let mut statement = self.db.prepare(&format!("select {RUN_COLUMNS} from run order by started_at desc limit ?"))?;
        Ok(statement.query_map(params![limit], run_row)?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ── Trace ───────────────────────────────────────────────────────────────

    pub fn append_trace(&self, run_id: &str, entries: &[Js]) -> Result<()> {
        self.transaction(|db| {
            let next: i64 = db.query_row("select coalesce(max(seq), -1) + 1 from trace where run_id = ?", params![run_id], |r| r.get(0))?;
            let mut insert = db.prepare("insert into trace (run_id, seq, entry) values (?, ?, ?)")?;
            for (i, entry) in entries.iter().enumerate() {
                insert.execute(params![run_id, next + i as i64, text_of(entry)])?;
            }
            Ok(())
        })
    }

    pub fn trace_entries(&self, run_id: &str) -> Result<Vec<Js>> {
        let mut statement = self.db.prepare("select entry from trace where run_id = ? order by seq")?;
        let texts = statement.query_map(params![run_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        texts.iter().map(|text| Js::parse(text.as_bytes()).map_err(StoreError::Backend)).collect()
    }

    pub fn run_spent(&self, run_id: &str) -> Result<f64> {
        Ok(self.db.query_row("select spent_microdollars - cost_cap_baseline_microdollars from run where id = ?", params![run_id], |r| r.get(0)).optional()?.unwrap_or(0.0))
    }

    pub fn add_run_spend(&self, run_id: &str, microdollars: f64) -> Result<()> {
        self.db.execute("update run set spent_microdollars = spent_microdollars + ? where id = ?", params![microdollars, run_id])?;
        Ok(())
    }

    pub fn reset_spend_baseline(&self, run_id: &str) -> Result<()> {
        self.db.execute("update run set cost_cap_baseline_microdollars = spent_microdollars where id = ?", params![run_id])?;
        Ok(())
    }

    pub fn trace_len(&self, run_id: &str) -> Result<i64> {
        Ok(self.db.query_row("select count(*) from trace where run_id = ?", params![run_id], |r| r.get(0))?)
    }

    // ── Parks ───────────────────────────────────────────────────────────────

    pub fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()> {
        // `rewritten` is not kept: listen-fire has no limit resume to read it.
        reason_of(reason.to_string())?;
        self.fenced(run_id, fence, |db| Self::put_leaf_in(db, run_id, address, reason, wake_at, state))
    }

    fn put_leaf_in(db: &Connection, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js) -> Result<()> {
        db.execute(
            "insert into leaf (run_id, address, reason, status, wake_at, state) values (?, ?, ?, 'parked', ?, ?)
             on conflict (run_id, address) do update set
               reason = excluded.reason, status = 'parked', wake_at = excluded.wake_at, state = excluded.state",
            params![run_id, address, reason, wake_at, text_of(state)],
        )?;
        Ok(())
    }

    /// crate::backend::RunHostStore::commit_park: one transaction, fenced.
    pub fn commit_park(&self, park: &Park<'_>) -> Result<()> {
        let Park { run_id, address, state, fence, kind } = *park;
        let held = HeldPark { address, state, kind };
        self.fenced(run_id, fence, |db| {
            Self::park_in(db, run_id, &held)?;
            Self::mark_parked_in(db, run_id)
        })
    }

    /// crate::backend::RunHostStore::commit_segment: one transaction, fenced.
    pub fn commit_segment(&self, commit: &SegmentCommit<'_>) -> Result<Vec<WaitWake>> {
        let SegmentCommit { run_id, team_id, fence, resumed, ref joins, ref parks, ref settle, ref owed_races, settled_race } = *commit;
        self.fenced(run_id, fence, |db| {
            for join in joins {
                Self::record_join_in(db, run_id, join.frame_address, join.pending)?;
            }
            for park in parks {
                Self::park_in(db, run_id, park)?;
            }
            if let Some(resumed) = resumed.filter(|resumed| !parks.iter().any(|park| park.address == *resumed)) {
                Self::finish_leaf_in(db, run_id, resumed)?;
            }
            if !parks.is_empty() {
                Self::mark_parked_in(db, run_id)?;
            }
            if let Some(settle) = settle {
                Self::settle_run_in(db, run_id, settle)?;
            }
            if let Some(frame) = settled_race {
                db.execute("delete from work where key = ?", params![settle_race_work_key(run_id, frame)])?;
            }
            for race in owed_races {
                Self::enqueue_in(db, SETTLE_RACE_WORK_KIND, &settle_race_work_key(run_id, race.frame_address), &settle_race_work_payload(run_id, race), None)?;
            }
            // Read in the write, so an arrival logged before it is read here
            // and one logged after it finds the wait parked.
            let mut wakes = Vec::new();
            for park in parks {
                let ParkKind::Wait { wait_id } = park.kind else { continue };
                let unread = Self::wait_arrivals_in(db, wait_id)?;
                if !unread.arrivals.is_empty() {
                    let wake = WaitWake { run_id: run_id.to_string(), wait_id: wait_id.to_string(), address: park.address.to_string() };
                    let row = crate::waits::wake_row(team_id, &wake);
                    Self::enqueue_in(db, &row.kind, &row.key, &row.payload, row.due_at.as_deref())?;
                    wakes.push(wake);
                }
            }
            Ok(wakes)
        })
    }

    /// One park's leaf and what wakes it, in the caller's transaction.
    fn park_in(db: &Connection, run_id: &str, park: &HeldPark<'_>) -> Result<()> {
        let HeldPark { address, state, ref kind } = *park;
        let wake_at = match kind {
            ParkKind::Timer { wake_at } => Some(*wake_at),
            ParkKind::Wait { .. } | ParkKind::Limit => None,
        };
        Self::put_leaf_in(db, run_id, address, kind.reason(), wake_at, state)?;
        Self::unpark_waits_in(db, run_id, address)?;
        Self::keep_leaf_notes_in(db, run_id, address)?;
        match kind {
            // The leaf is the truth; the work row only says when to look.
            ParkKind::Timer { wake_at } => Self::enqueue_in(db, "resume_timer", &timer_work_key(run_id), &timer_work_payload(run_id), Some(wake_at)),
            ParkKind::Wait { wait_id } => Self::park_wait_in(db, run_id, address, wait_id),
            ParkKind::Limit => Ok(()),
        }
    }

    /// The leaf, now resuming. What a segment that resumed it before noted
    /// and never kept (it died) is dropped, so its arrivals are read again.
    pub fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>> {
        let sql = format!(
            "update leaf set status = 'resuming' where run_id = ? and address = ? and status = 'parked' {} returning reason, state",
            if reason.is_some() { "and reason = ?" } else { "" }
        );
        let mut args: Vec<&str> = vec![run_id, address];
        args.extend(reason);
        let row = self.transaction(|db| {
            let row = db.query_row(&sql, params_from_iter(args), |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()?;
            if row.is_some() {
                Self::drop_leaf_notes_in(db, run_id, address)?;
            }
            Ok(row)
        })?;
        row.map(|(reason, state)| Ok((reason_of(reason)?, parse_text(&state)?))).transpose()
    }

    pub fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()> {
        self.transaction(|db| {
            if let Some(fence) = fence
                && !Self::holds(db, run_id, fence)?
            {
                return Ok(());
            }
            Self::finish_leaf_in(db, run_id, address)
        })
    }

    /// The leaf's resume is over: the notes its segment made are kept.
    fn finish_leaf_in(db: &Connection, run_id: &str, address: &str) -> Result<()> {
        db.execute("delete from leaf where run_id = ? and address = ? and status = 'resuming'", params![run_id, address])?;
        Self::keep_leaf_notes_in(db, run_id, address)
    }

    pub fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>> {
        let mut clauses = vec!["run_id = ?"];
        let mut args: Vec<&str> = vec![run_id];
        if parked_only {
            clauses.push("status = 'parked'");
        }
        if let Some(reason) = reason {
            clauses.push("reason = ?");
            args.push(reason);
        }
        if let Some(due_by) = due_by {
            clauses.push("reason = 'timer' and wake_at <= ?");
            args.push(due_by);
        }
        let sql = format!("select address, reason, status, wake_at from leaf where {} order by address", clauses.join(" and "));
        let mut statement = self.db.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(args), |r| Ok(LeafRow { address: r.get(0)?, reason: r.get(1)?, status: r.get(2)?, wake_at: r.get(3)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for row in &rows {
            reason_of(row.reason.clone())?;
        }
        Ok(rows)
    }

    pub fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()> {
        self.transaction(|db| {
            let mut drop = db.prepare("delete from leaf where run_id = ? and address = ?")?;
            for address in addresses {
                drop.execute(params![run_id, address])?;
            }
            Ok(())
        })
    }

    // ── Joins ───────────────────────────────────────────────────────────────

    pub fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()> {
        self.fenced(run_id, fence, |db| Self::record_join_in(db, run_id, frame_address, pending))
    }

    fn record_join_in(db: &Connection, run_id: &str, frame_address: &str, pending: i64) -> Result<()> {
        db.execute(
            "insert into join_frame (run_id, frame_address, pending) values (?, ?, ?)
             on conflict (run_id, frame_address) do update set pending = excluded.pending",
            params![run_id, frame_address, pending],
        )?;
        Ok(())
    }

    /// True for the one branch that closes the frame, also on a retry of it.
    pub fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool> {
        self.transaction(|db| {
            let claimed = db.execute(
                "update join_branch_export set decremented = 1 where run_id = ? and frame_address = ? and branch_address = ? and decremented = 0",
                params![run_id, frame_address, branch_address],
            )?;
            if claimed > 0 {
                let updated: Option<i64> = db
                    .query_row(
                        "update join_frame set pending = pending - 1 where run_id = ? and frame_address = ? and pending > 0 returning pending",
                        params![run_id, frame_address],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(pending) = updated {
                    if pending > 0 {
                        return Ok(false);
                    }
                    db.execute(
                        "update join_frame set closed_by_address = ? where run_id = ? and frame_address = ?",
                        params![leaf_address, run_id, frame_address],
                    )?;
                    return Ok(true);
                }
            }
            let closed_by: Option<Option<String>> = db
                .query_row("select closed_by_address from join_frame where run_id = ? and frame_address = ?", params![run_id, frame_address], |r| r.get(0))
                .optional()?;
            Ok(closed_by.flatten().as_deref() == Some(leaf_address))
        })
    }

    pub fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()> {
        // A rewrite never touches `decremented`, the branch's decrement claim.
        self.db.execute(
            "insert into join_branch_export (run_id, frame_address, branch_address, branch_index, exports) values (?, ?, ?, ?, ?)
             on conflict (run_id, frame_address, branch_address) do update set exports = excluded.exports, branch_index = excluded.branch_index",
            params![run_id, frame_address, branch_address, branch_index, text_of(exports)],
        )?;
        Ok(())
    }

    pub fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>> {
        let mut statement =
            self.db.prepare("select branch_address, branch_index, exports from join_branch_export where run_id = ? and frame_address = ? order by branch_index")?;
        let rows = statement
            .query_map(params![run_id, frame_address], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(branch_address, branch_index, exports)| Ok(BranchExport { branch_address, branch_index, exports: parse_text(&exports)? }))
            .collect()
    }

    pub fn has_pending_joins(&self, run_id: &str) -> Result<bool> {
        Ok(self.db.query_row("select 1 from join_frame where run_id = ? and pending > 0 limit 1", params![run_id], |_| Ok(())).optional()?.is_some())
    }

    pub fn frames(&self, run_id: &str) -> Result<Vec<String>> {
        let mut statement = self.db.prepare("select frame_address from join_frame where run_id = ? order by frame_address")?;
        Ok(statement.query_map(params![run_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The frames, their exports, and the races owed at them: a withdrawn
    /// race is settled by nobody.
    pub fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()> {
        self.transaction(|db| {
            let mut drop_frame = db.prepare("delete from join_frame where run_id = ? and frame_address = ?")?;
            let mut drop_exports = db.prepare("delete from join_branch_export where run_id = ? and frame_address = ?")?;
            let mut drop_owed = db.prepare("delete from work where key = ?")?;
            for frame in frame_addresses {
                drop_frame.execute(params![run_id, frame])?;
                drop_exports.execute(params![run_id, frame])?;
                drop_owed.execute(params![settle_race_work_key(run_id, frame)])?;
            }
            Ok(())
        })
    }

    /// The races the run owes, in the order they were first owed.
    pub fn owed_races(&self, run_id: &str) -> Result<Vec<OwedRace>> {
        let mut statement = self.db.prepare("select payload from work where kind = ? and json_extract(payload, '$.runId') = ? order by id")?;
        let payloads = statement.query_map(params![SETTLE_RACE_WORK_KIND, run_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        payloads
            .iter()
            .map(|payload| OwedRace::of_payload(&parse_text(payload)?).ok_or_else(|| StoreError::Invalid(format!("a {SETTLE_RACE_WORK_KIND} row of run {run_id} that is not one: {payload}"))))
            .collect()
    }

    // ── The run lease ───────────────────────────────────────────────────────

    pub fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>> {
        let token = uuid();
        self.transaction(|db| {
            // The step's mark: the sweep keeps what arrives above it while
            // the lease holds.
            let claimed = db.execute(
                "update run set lease_token = ?, lease_until = ?, lease_mark = (select coalesce(max(seq), 0) from arrival) where id = ? and (lease_until is null or lease_until < ?)",
                params![token, iso(ttl_ms), run_id, iso(0)],
            )?;
            if claimed == 0 {
                return Ok(None);
            }
            db.execute("update leaf set status = 'parked' where run_id = ? and status = 'resuming'", params![run_id])?;
            Ok(Some(token))
        })
    }

    pub fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool> {
        let renewed = self.db.execute(
            "update run set lease_until = ? where id = ? and lease_token = ? and lease_until > ?",
            params![iso(ttl_ms), run_id, token, iso(0)],
        )?;
        Ok(renewed > 0)
    }

    pub fn release_lease(&self, run_id: &str, token: &str) -> Result<()> {
        self.db.execute("update run set lease_token = null, lease_until = null where id = ? and lease_token = ?", params![run_id, token])?;
        Ok(())
    }

    pub fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool> {
        self.transaction(|db| {
            if let Some(fence) = fence
                && !Self::holds(db, run_id, fence)?
            {
                return Ok(false);
            }
            db.execute("delete from leaf where run_id = ?", params![run_id])?;
            db.execute("delete from join_frame where run_id = ?", params![run_id])?;
            db.execute("delete from join_branch_export where run_id = ?", params![run_id])?;
            db.execute("delete from work where kind = ? and json_extract(payload, '$.runId') = ?", params![SETTLE_RACE_WORK_KIND, run_id])?;
            Self::drop_run_waits_in(db, run_id)?;
            Ok(true)
        })
    }

    // ── The work queue ──────────────────────────────────────────────────────

    pub fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>) -> Result<()> {
        Self::enqueue_in(&self.db, kind, key, payload, due_at)
    }

    pub(crate) fn enqueue_in(db: &Connection, kind: &str, key: &str, payload: &Js, due_at: Option<&str>) -> Result<()> {
        if !WORK_KINDS.contains(&kind) {
            return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
        }
        // Against a held row the new due time wins: its holder's completion
        // leaves the row for the re-arm. A dead row queued again is new
        // work: it lives again, its attempts from nought.
        let now = iso(0);
        db.execute(
            "insert into work (kind, key, payload, due_at) values (?, ?, ?, ?)
             on conflict (key) do update set
               due_at = case when work.dead_at is not null then excluded.due_at
                             when work.lease_until > ? then excluded.due_at else min(work.due_at, excluded.due_at) end,
               payload = excluded.payload,
               attempts = case when work.dead_at is null then work.attempts else 0 end,
               dead_at = null,
               dead_reason = null,
               version = work.version + 1",
            params![kind, key, text_of(payload), due_at.unwrap_or(&now), now],
        )?;
        Ok(())
    }

    pub fn enqueue_if_absent(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>) -> Result<bool> {
        if !WORK_KINDS.contains(&kind) {
            return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
        }
        let now = iso(0);
        let inserted = self.db.execute(
            "insert into work (kind, key, payload, due_at) values (?, ?, ?, ?) on conflict (key) do nothing",
            params![kind, key, text_of(payload), due_at.unwrap_or(&now)],
        )?;
        Ok(inserted == 1)
    }

    pub fn claim_due(&self, claim: &ClaimDue<'_>) -> Result<Vec<ClaimedWork>> {
        let now = iso(0);
        let due_by = claim.due_by.map(str::to_string).unwrap_or_else(|| now.clone());
        let kinds = Js::strings(claim.kinds()?).to_json();
        let lease_ms = claim.lease_ms;
        self.transaction(|db| {
            let mut select = db.prepare(
                "select id, kind, key, payload, version, attempts from work
                 where due_at <= ? and (lease_until is null or lease_until < ?) and dead_at is null and kind in (select value from json_each(?))
                 order by due_at, id limit ?",
            )?;
            let due = select
                .query_map(params![due_by, now, kinds, claim.limit], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut lease = db.prepare("update work set lease_token = ?, lease_until = ?, version = version + 1, attempts = attempts + 1 where id = ?")?;
            due.into_iter()
                .map(|(id, kind, key, payload, version, attempts)| {
                    if !WORK_KINDS.contains(&kind.as_str()) {
                        return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
                    }
                    let lease_token = uuid();
                    lease.execute(params![lease_token, iso(lease_ms), id])?;
                    let claim = format!("{lease_token}/{}", version + 1);
                    Ok(ClaimedWork { id: id.to_string(), kind, key, payload: parse_text(&payload)?, claim, attempts: attempts + 1 })
                })
                .collect()
        })
    }

    pub fn complete(&self, id: &str, claim: &str) -> Result<()> {
        // Deleted only when nothing re-armed it since the claim; else the
        // re-armed row stays, unleased, for its new due time.
        let (lease_token, version) = work_claim(claim)?;
        let id = work_id(id)?;
        self.transaction(|db| {
            db.execute("delete from work where id = ? and lease_token = ? and version = ?", params![id, lease_token, version])?;
            db.execute("update work set lease_token = null, lease_until = null where id = ? and lease_token = ?", params![id, lease_token])?;
            Ok(())
        })
    }

    /// crate::backend::RunHostStore::complete_key: deleted unless a live
    /// claim holds it, with the waits it opened for runs never started.
    pub fn complete_key(&self, key: &str) -> Result<bool> {
        self.transaction(|db| {
            let done = db.execute("delete from work where key = ? and dead_at is null and (lease_until is null or lease_until < ?)", params![key, iso(0)])?;
            if done > 0 {
                Self::drop_unstarted_waits_in(db, key)?;
            }
            Ok(done > 0)
        })
    }

    pub fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>, why: Release) -> Result<()> {
        let (lease_token, version) = work_claim(claim)?;
        let attempts = match why {
            Release::Failed => "attempts",
            Release::Busy => "max(attempts - 1, 0)",
            Release::Rescheduled => "0",
        };
        self.db.execute(
            &format!(
                "update work set lease_token = null, lease_until = null, attempts = {attempts},
                   due_at = case when version = ? then coalesce(?, due_at) else due_at end
                 where id = ? and lease_token = ?"
            ),
            params![version, due_at, work_id(id)?, lease_token],
        )?;
        Ok(())
    }

    /// crate::backend::RunHostStore::bury_work: dead, unless re-armed since
    /// the claim (as `complete`): then only unleased, for its new due time.
    pub fn bury_work(&self, id: &str, claim: &str, reason: &str) -> Result<()> {
        let (lease_token, version) = work_claim(claim)?;
        let id = work_id(id)?;
        self.transaction(|db| {
            let buried = db.execute(
                "update work set dead_at = ?, dead_reason = ? where id = ? and lease_token = ? and version = ?",
                params![iso(0), reason, id, lease_token, version],
            )?;
            db.execute("update work set lease_token = null, lease_until = null where id = ? and lease_token = ?", params![id, lease_token])?;
            if buried > 0 {
                let key: String = db.query_row("select key from work where id = ?", params![id], |r| r.get(0))?;
                Self::drop_unstarted_waits_in(db, &key)?;
            }
            Ok(())
        })
    }

    // ── Library sources ─────────────────────────────────────────────────────

    pub fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()> {
        self.db.execute("insert into park_library_source (team_id, hash, source) values (?, ?, ?) on conflict do nothing", params![team_id, hash, source])?;
        Ok(())
    }

    pub fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>> {
        Ok(self.db.query_row("select source from park_library_source where team_id = ? and hash = ?", params![team_id, hash], |r| r.get(0)).optional()?)
    }

    // ── Deliveries ──────────────────────────────────────────────────────────

    /// The delivery's receipt, inside the door's one write: false, and
    /// nothing written, when its id, or its external id at its
    /// subscription, was kept before.
    pub(crate) fn insert_delivery_in(db: &Connection, subscription_id: &str, delivery: &NewDelivery) -> Result<bool> {
        let inserted = db.execute(
            "insert into delivery (id, subscription_id, external_id, received_at, source, inline, replay_of, events, event_count, request)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing",
            params![
                delivery.id,
                subscription_id,
                delivery.external_id,
                delivery.received_at,
                delivery.source.wire(),
                delivery.inline,
                delivery.replay_of,
                Js::Arr(delivery.events.clone()).to_json(),
                delivery.events.len(),
                delivery.request.as_ref().map(Js::to_json),
            ],
        )?;
        Ok(inserted == 1)
    }

    /// crate::backend::RunHostStore::deliveries.
    pub fn deliveries(&self, query: &DeliveryQuery<'_>) -> Result<Vec<DeliveryRow>> {
        let mut statement = self.db.prepare(&format!(
            "select {DELIVERY_COLUMNS} from delivery
             where (?1 is null or subscription_id = ?1) and (?2 is null or received_at >= ?2)
             order by received_at desc, id desc limit ?3"
        ))?;
        let rows = statement.query_map(params![query.subscription_id, query.since, query.limit], delivery_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|row| self.delivery_of(row, None)).collect()
    }

    /// crate::backend::RunHostStore::delivery: with its events and its request.
    pub fn delivery(&self, id: &str) -> Result<Option<DeliveryRow>> {
        let row = self
            .db
            .query_row(&format!("select {DELIVERY_COLUMNS}, events, request from delivery where id = ?"), params![id], |r| {
                Ok((delivery_row(r)?, r.get::<_, String>(8)?, r.get::<_, Option<String>>(9)?))
            })
            .optional()?;
        row.map(|(row, events, request)| {
            let events = match parse_text(&events)? {
                Js::Arr(events) => events,
                _ => return Err(StoreError::Invalid(format!("delivery {id}'s events are not a list"))),
            };
            let request = request.as_deref().map(parse_text).transpose()?;
            Ok(DeliveryRow { request, ..self.delivery_of(row, Some(events))? })
        })
        .transpose()
    }

    fn delivery_of(&self, row: StoredDelivery, events: Option<Vec<Js>>) -> Result<DeliveryRow> {
        let mut statement = self.db.prepare("select id, status from run where delivery_id = ? order by started_at, id")?;
        let runs = statement.query_map(params![row.id], |r| Ok(DeliveryRun { id: r.get(0)?, status: r.get(1)? }))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(DeliveryRow {
            source: DeliverySource::of_wire(&row.source)?,
            id: row.id,
            subscription_id: row.subscription_id,
            external_id: row.external_id,
            received_at: row.received_at,
            inline: row.inline,
            replay_of: row.replay_of,
            event_count: row.event_count,
            runs,
            events,
            request: None,
        })
    }

    /// crate::backend::RunHostStore::sweep_deliveries: a delivery whose runs
    /// still hold it is kept past `before`, its request forgotten.
    pub fn sweep_deliveries(&self, before: &str, limit: i64) -> Result<i64> {
        self.db.execute("update delivery set request = null where received_at < ?1 and request is not null", params![before])?;
        let swept = self.db.execute(
            "delete from delivery where id in (
               select d.id from delivery d
               where d.received_at < ?1
                 and not exists (select 1 from run r where r.delivery_id = d.id and r.status in ('running', 'parked'))
                 and not exists (select 1 from work w where w.kind = 'fire_event' and json_extract(w.payload, '$.deliveryId') = d.id)
               order by d.received_at limit ?2)",
            params![before, limit],
        )?;
        Ok(i64::try_from(swept).unwrap_or(i64::MAX))
    }

    /// crate::backend::RunHostStore::forget_delivery_id.
    pub fn forget_delivery_id(&self, id: &str) -> Result<()> {
        self.db.execute("update delivery set external_id = null where id = ?", params![id])?;
        Ok(())
    }

    /// crate::backend::RunHostStore::claim_event.
    pub fn claim_event(&self, receipt: &EventReceipt<'_>) -> Result<bool> {
        Self::claim_event_in(&self.db, receipt)
    }

    fn claim_event_in(db: &Connection, receipt: &EventReceipt<'_>) -> Result<bool> {
        let inserted = db.execute(
            "insert into event_receipt (team_id, listen, key, received_at) values (?, ?, ?, ?) on conflict do nothing",
            params![receipt.team_id.unwrap_or(SQLITE_TENANT), receipt.listen, receipt.key, iso(0)],
        )?;
        Ok(inserted == 1)
    }
}

const DELIVERY_COLUMNS: &str = "id, subscription_id, external_id, received_at, source, inline, replay_of, event_count";

/// A delivery's row as the state file holds it, its runs not yet read.
struct StoredDelivery {
    id: String,
    subscription_id: String,
    external_id: Option<String>,
    received_at: String,
    source: String,
    inline: bool,
    replay_of: Option<String>,
    event_count: i64,
}

fn delivery_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredDelivery> {
    Ok(StoredDelivery {
        id: r.get(0)?,
        subscription_id: r.get(1)?,
        external_id: r.get(2)?,
        received_at: r.get(3)?,
        source: r.get(4)?,
        inline: r.get(5)?,
        replay_of: r.get(6)?,
        event_count: r.get(7)?,
    })
}

/// `Number(work.id)`: the row id a claim names.
fn work_id(id: &str) -> Result<i64> {
    id.parse().map_err(|_| StoreError::Invalid(format!("not a work id: {id}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instants_are_written_as_to_iso_string_writes_them() {
        let now = iso(0);
        assert_eq!(now.len(), "2026-10-17T12:00:00.000Z".len(), "{now}");
        assert!(now.ends_with('Z') && now.as_bytes()[19] == b'.', "{now}");
        assert!(iso(60_000) > now);
    }

    #[test]
    fn a_work_claim_is_a_token_and_a_version() {
        assert_eq!(work_claim("abc/3").unwrap(), ("abc".to_string(), 3));
        assert!(work_claim("/3").is_err());
        assert!(work_claim("abc").is_err());
    }

    /// A fresh state file, and its path for a second handle.
    fn state_file() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("lf-state-{}", uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        (Store::open(&path).unwrap(), path)
    }

    #[test]
    fn an_event_key_is_received_once_per_listen() {
        let (store, path) = state_file();
        assert!(store.claim_event(&EventReceipt::own("listen:a:welcome", "delivery-1")).unwrap());
        assert!(!store.claim_event(&EventReceipt::own("listen:a:welcome", "delivery-1")).unwrap());
        assert!(store.claim_event(&EventReceipt::own("listen:a:other", "delivery-1")).unwrap());
        // Kept in the state file: another handle sees the receipt.
        assert!(!Store::open(&path).unwrap().claim_event(&EventReceipt::own("listen:a:welcome", "delivery-1")).unwrap());
    }

    /// A receipt is its team's: the same listen and key under another team
    /// is another receipt, and its run is kept under that team.
    #[test]
    fn a_receipt_and_its_run_are_their_teams() {
        let (store, _) = state_file();
        let other = EventReceipt { team_id: Some("globex"), ..EventReceipt::own("listen:a:welcome", "delivery-1") };
        assert!(store.claim_event(&EventReceipt::own("listen:a:welcome", "delivery-1")).unwrap());
        assert!(store.claim_event(&other).unwrap());
        assert!(!store.claim_event(&other).unwrap());
        let run = RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: Some("globex") };
        assert!(store.start_event_run(&EventReceipt { key: "delivery-2", ..other }, &run).unwrap());
        let team: String = store.db.query_row("select team_id from run where id = 'run-1'", [], |r| r.get(0)).unwrap();
        assert_eq!(team, "globex");
    }

    /// A state file written before a receipt was a team's keeps each of its
    /// receipts as the store's own tenant's.
    #[test]
    fn a_receipt_kept_before_teams_is_the_stores_own() {
        let (store, path) = state_file();
        store
            .db
            .execute_batch(
                "drop table event_receipt;
                 create table event_receipt (listen text not null, key text not null, received_at text not null, primary key (listen, key));
                 insert into event_receipt values ('listen:a:welcome', 'delivery-1', '2026-10-30T00:00:00.000Z');",
            )
            .unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert!(!store.claim_event(&EventReceipt::own("listen:a:welcome", "delivery-1")).unwrap());
        assert!(store.claim_event(&EventReceipt { team_id: Some("globex"), ..EventReceipt::own("listen:a:welcome", "delivery-1") }).unwrap());
    }

    fn work_row(store: &Store, key: &str) -> (String, Option<String>) {
        store.db.query_row("select due_at, lease_token from work where key = ?", params![key], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
    }

    fn claim(limit: i64, lease_ms: i64) -> ClaimDue<'static> {
        ClaimDue { limit, lease_ms, due_by: None, kinds: None }
    }

    fn no_payload() -> Js {
        Js::Obj(crate::json::Obj::new())
    }

    #[test]
    fn work_rows_of_the_retired_callbacks_and_settings_polls_go_on_open() {
        let (store, path) = state_file();
        let due = iso(-1_000);
        for (kind, key, payload) in [
            ("fire_callback", "legacy-fire", r#"{"callbackId":"c1"}"#),
            ("poll_listen", "listen:notes:watch", r#"{"subscription":"listen:notes:watch"}"#),
            ("wake_await", "legacy-key-wake", r#"{"adapterType":"slack","correlationKey":"k"}"#),
            ("wake_await", "wait-wake", r#"{"waitId":"w1","runId":"r1","address":"s1"}"#),
            ("resume_timer", "timer", r#"{"runId":"r1"}"#),
        ] {
            store.db.execute("insert into work (kind, key, payload, due_at) values (?, ?, ?, ?)", params![kind, key, payload, due]).unwrap();
        }
        drop(store);
        let reopened = Store::open(&path).unwrap();
        let left: Vec<String> = reopened.claim_due(&claim(10, 60_000)).unwrap().into_iter().map(|w| w.key).collect();
        assert_eq!(left.len(), 2, "a firing, a settings listen's poll and a wake by key are dropped: {left:?}");
        assert!(left.contains(&"wait-wake".to_string()) && left.contains(&"timer".to_string()), "{left:?}");
    }

    #[test]
    fn an_arm_if_absent_leaves_a_held_row_due_when_its_holder_says() {
        let (store, _) = state_file();
        assert!(store.enqueue_if_absent("poll_edge", "p", &no_payload(), None).unwrap(), "queued");
        let held = store.claim_due(&claim(10, 60_000)).unwrap();
        assert_eq!(held.len(), 1);
        assert!(!store.enqueue_if_absent("poll_edge", "p", &no_payload(), None).unwrap(), "a second worker's arm queues nothing");
        let next = iso(3_600_000);
        store.release_work(&held[0].id, &held[0].claim, Some(&next), Release::Rescheduled).unwrap();
        assert_eq!(work_row(&store, "p").0, next, "due when the holder said, not at once");
        assert!(store.claim_due(&claim(10, 60_000)).unwrap().is_empty());
    }

    #[test]
        fn enqueue_against_a_row_whose_lease_lapsed_keeps_the_earlier_due_time() {
        let (store, _) = state_file();
        let due = iso(-60_000);
        store.enqueue("resume_timer", "k", &no_payload(), Some(&due)).unwrap();
        // Claimed under a lease that has already lapsed.
        assert_eq!(store.claim_due(&claim(10, -1)).unwrap().len(), 1);
        store.enqueue("resume_timer", "k", &no_payload(), Some(&iso(3_600_000))).unwrap();
        assert_eq!(work_row(&store, "k").0, due);
    }

    #[test]
    fn a_release_without_a_retry_time_keeps_the_due_time_and_clears_the_lease() {
        let (store, _) = state_file();
        let due = iso(-60_000);
        store.enqueue("wake_await", "k", &no_payload(), Some(&due)).unwrap();
        let claimed = store.claim_due(&claim(10, 60_000)).unwrap().pop().unwrap();
        assert!(work_row(&store, "k").1.is_some());
        store.release_work(&claimed.id, &claimed.claim, None, Release::Failed).unwrap();
        assert_eq!(work_row(&store, "k"), (due, None));
    }

    #[test]
    fn two_handles_on_one_file_claim_disjoint_rows() {
        let (store, path) = state_file();
        let other = Store::open(&path).unwrap();
        for i in 0..6 {
            store.enqueue("wake_await", &format!("k{i}"), &no_payload(), Some(&iso(-1_000))).unwrap();
        }
        let mut keys: Vec<String> = store.claim_due(&claim(3, 60_000)).unwrap().into_iter().map(|w| w.key).collect();
        keys.extend(other.claim_due(&claim(3, 60_000)).unwrap().into_iter().map(|w| w.key));
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), 6);
    }

    #[test]
    fn a_claim_naming_kinds_leases_only_rows_of_those_kinds() {
        let (store, _) = state_file();
        for (kind, key) in [("poll_edge", "p1"), ("resume_timer", "t1"), ("poll_edge", "p2"), ("fire_event", "e1")] {
            store.enqueue(kind, key, &no_payload(), Some(&iso(-1_000))).unwrap();
        }
        let polls = [String::from("poll_edge")];
        let mut keys: Vec<String> = store.claim_due(&ClaimDue { kinds: Some(&polls), ..claim(10, 60_000) }).unwrap().into_iter().map(|w| w.key).collect();
        keys.sort();
        assert_eq!(keys, ["p1", "p2"]);
        let rest: Vec<String> = store.claim_due(&claim(10, 60_000)).unwrap().into_iter().map(|w| w.key).collect();
        assert_eq!(rest, ["t1", "e1"]);
        let unknown = [String::from("fire_callback")];
        assert!(matches!(store.claim_due(&ClaimDue { kinds: Some(&unknown), ..claim(10, 60_000) }), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn a_kind_lf_does_not_drain_is_refused_at_the_queue() {
        let (store, _) = state_file();
        // A callback's body is no work since callbacks retired at 0.13, nor a settings listen's poll.
        assert!(matches!(store.enqueue("fire_callback", "k", &no_payload(), None), Err(StoreError::Invalid(_))));
        assert!(matches!(store.enqueue("poll_listen", "k", &no_payload(), None), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn a_lapsed_run_lease_is_taken_by_another_process_with_the_abandoned_claim_parked_again() {
        let (store, path) = state_file();
        store.start_run(&RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
        store.put_leaf("run-1", "s1", "timer", Some(&iso(-1_000)), &no_payload(), None).unwrap();
        let first = store.claim_lease("run-1", 60_000).unwrap().expect("the run was free");
        assert!(store.claim_leaf("run-1", "s1", None).unwrap().is_some());
        let other = Store::open(&path).unwrap();
        assert_eq!(other.claim_lease("run-1", 60_000).unwrap(), None, "one holder at a time");
        // The first holder's lease lapses (its process stalled past it).
        store.db.execute("update run set lease_until = ? where id = 'run-1'", params![iso(-1)]).unwrap();
        assert!(!store.renew_lease("run-1", &first, 60_000).unwrap());
        assert!(other.claim_lease("run-1", 60_000).unwrap().is_some());
        let parked: Vec<String> = other.leaves("run-1", true, None, None).unwrap().into_iter().map(|l| l.address).collect();
        assert_eq!(parked, ["s1"]);
    }

    /// A write that fails partway: the statement `on` names aborts, as a
    /// crash between the old separate writes would have stopped them.
    fn failing(store: &Store, name: &str, on: &str) {
        store.db.execute_batch(&format!("create trigger {name} {on} begin select raise(abort, 'injected'); end;")).unwrap();
    }

    fn unfail(store: &Store, name: &str) {
        store.db.execute_batch(&format!("drop trigger {name}")).unwrap();
    }

    fn status(store: &Store, run_id: &str) -> String {
        store.run(run_id).unwrap().unwrap().status
    }

    fn work_keys(store: &Store) -> Vec<String> {
        let mut statement = store.db.prepare("select key from work order by key").unwrap();
        statement.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()
    }

    fn running(store: &Store, run_id: &str) -> String {
        store.start_run(&RunStart { id: run_id, file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
        store.claim_lease(run_id, 60_000).unwrap().unwrap()
    }

    #[test]
    fn a_timer_park_is_its_leaf_its_wake_and_the_run_parked_or_none_of_them() {
        let (store, _) = state_file();
        let fence = running(&store, "run-1");
        let wake_at = iso(60_000);
        let park = Park { run_id: "run-1", address: "s1", state: &no_payload(), fence: Some(&fence), kind: ParkKind::Timer { wake_at: &wake_at } };
        // Before: the leaf was written, then the crash, and nothing ever woke it.
        failing(&store, "no_work", "before insert on work");
        assert!(store.commit_park(&park).is_err());
        assert!(store.leaves("run-1", false, None, None).unwrap().is_empty());
        assert_eq!(status(&store, "run-1"), "running");
        unfail(&store, "no_work");
        store.commit_park(&park).unwrap();
        assert_eq!(store.leaves("run-1", true, Some("timer"), None).unwrap()[0].wake_at.as_deref(), Some(wake_at.as_str()));
        assert_eq!(work_row(&store, "resume_timer:run-1").0, wake_at);
        assert_eq!(status(&store, "run-1"), "parked");
    }

    #[test]
    fn a_limit_park_is_undone_whole_when_its_last_write_fails() {
        let (store, _) = state_file();
        let fence = running(&store, "run-1");
        let limit = Park { run_id: "run-1", address: "s1", state: &no_payload(), fence: Some(&fence), kind: ParkKind::Limit };
        // The run's status is the last write: failing it undoes the leaf.
        failing(&store, "no_status", "before update of status on run");
        assert!(store.commit_park(&limit).is_err());
        assert!(store.leaves("run-1", false, None, None).unwrap().is_empty());
        unfail(&store, "no_status");
        store.commit_park(&limit).unwrap();
        assert_eq!(store.leaves("run-1", false, None, None).unwrap()[0].reason, "limit");
    }

    #[test]
    fn a_park_under_a_lost_lease_writes_nothing() {
        let (store, _) = state_file();
        running(&store, "run-1");
        let wake_at = iso(1_000);
        let park = Park { run_id: "run-1", address: "s1", state: &no_payload(), fence: Some("not-the-lease"), kind: ParkKind::Timer { wake_at: &wake_at } };
        assert!(matches!(store.commit_park(&park), Err(StoreError::LeaseLost { .. })));
        assert!(store.leaves("run-1", false, None, None).unwrap().is_empty());
        assert!(work_keys(&store).is_empty());
        assert_eq!(status(&store, "run-1"), "running");
    }

    #[test]
    fn an_event_receipt_and_its_run_are_one_write() {
        let (store, _) = state_file();
        let start = |id: &'static str| RunStart { id, file: "f", movement: "m", started_at: "2026-10-20T00:00:00.000Z", input: "{}", delivery_id: None, team_id: None };
        // Before: the receipt was noted, then the crash, and the event never ran.
        failing(&store, "no_run", "before insert on run");
        assert!(store.start_event_run(&EventReceipt::own("listen:f:m", "delivery-1"), &start("run-1")).is_err());
        unfail(&store, "no_run");
        assert!(store.start_event_run(&EventReceipt::own("listen:f:m", "delivery-1"), &start("run-1")).unwrap(), "its receipt went with the failed run");
        assert!(!store.start_event_run(&EventReceipt::own("listen:f:m", "delivery-1"), &start("run-2")).unwrap());
        assert!(store.run("run-1").unwrap().is_some());
        assert!(store.run("run-2").unwrap().is_none(), "a redelivery starts no run");
    }

    fn delivery(external_id: Option<&str>) -> NewDelivery {
        NewDelivery {
            id: uuid(),
            external_id: external_id.map(str::to_string),
            received_at: iso(0),
            source: DeliverySource::Webhook,
            inline: false,
            replay_of: None,
            events: vec![Js::str("e-1")],
            request: None,
        }
    }

    fn fire_row(key: &str) -> NewWork {
        NewWork { kind: "fire_event".into(), key: key.into(), payload: no_payload(), due_at: None, team_id: None }
    }

    #[test]
    fn a_delivery_keeps_its_cursor_only_with_its_work() {
        let (store, _) = state_file();
        let cursor = Js::str("c-2");
        let work = [fire_row("fire_event:1"), fire_row("fire_event:2")];
        let first = delivery(None);
        // Before: the cursor moved past events that were then never queued.
        failing(&store, "no_work", "before insert on work");
        assert!(store.keep_delivery("sub", Some(&cursor), &first, &work, None, &[], &[]).is_err());
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), None);
        assert!(store.delivery(&first.id).unwrap().is_none(), "its receipt went with the failed write");
        unfail(&store, "no_work");
        assert!(store.keep_delivery("sub", Some(&cursor), &first, &work, None, &[], &[]).unwrap().is_some());
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), Some(cursor));
        assert_eq!(work_keys(&store), ["fire_event:1", "fire_event:2"]);
        // No cursor: the saved one stays.
        assert!(store.keep_delivery("sub", None, &delivery(None), &[fire_row("fire_event:3")], None, &[], &[]).unwrap().is_some());
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), Some(Js::str("c-2")));
    }

    #[test]
    fn a_duplicate_on_a_second_connection_is_kept_out() {
        let (store, path) = state_file();
        let other = Store::open(&path).unwrap();
        assert!(store.keep_delivery("sub", Some(&Js::str("c-1")), &delivery(Some("d-1")), &[fire_row("fire_event:1")], None, &[], &[]).unwrap().is_some());
        // The first's work is still queued: the redelivery is kept out by the write, not the drain.
        assert!(!other.keep_delivery("sub", Some(&Js::str("c-2")), &delivery(Some("d-1")), &[fire_row("fire_event:2")], None, &[], &[]).unwrap().is_some());
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), Some(Js::str("c-1")));
        assert_eq!(work_keys(&store), ["fire_event:1"]);
        let all = DeliveryQuery { subscription_id: None, since: None, limit: 10 };
        assert_eq!(store.deliveries(&all).unwrap().len(), 1);
        // Another subscription's, or none, is its own.
        assert!(other.keep_delivery("other", None, &delivery(Some("d-1")), &[], None, &[], &[]).unwrap().is_some());
        assert!(other.keep_delivery("sub", None, &delivery(None), &[], None, &[], &[]).unwrap().is_some());
        assert!(other.keep_delivery("sub", None, &delivery(None), &[], None, &[], &[]).unwrap().is_some());
        assert_eq!(store.deliveries(&all).unwrap().len(), 4);
    }

    #[test]
    fn a_forgotten_delivery_id_lets_the_retry_in() {
        let (store, _) = state_file();
        let first = delivery(Some("d-1"));
        assert!(store.keep_delivery("sub", None, &first, &[], None, &[], &[]).unwrap().is_some());
        store.forget_delivery_id(&first.id).unwrap();
        let kept = store.delivery(&first.id).unwrap().unwrap();
        assert_eq!((kept.external_id, kept.event_count), (None, 1), "the receipt stays, without its id");
        assert!(store.keep_delivery("sub", None, &delivery(Some("d-1")), &[], None, &[], &[]).unwrap().is_some(), "the retry is its own");
        assert!(!store.keep_delivery("sub", None, &delivery(Some("d-1")), &[], None, &[], &[]).unwrap().is_some(), "and its id is kept");
    }

    #[test]
    fn the_sweep_forgets_settled_old_deliveries_only() {
        let (store, _) = state_file();
        let old = |store: &Store| {
            let kept = NewDelivery { received_at: iso(-30 * 86_400_000), ..delivery(None) };
            store.keep_delivery("sub", None, &kept, &[], None, &[], &[]).unwrap();
            kept.id
        };
        let start = |id: &str, delivery_id: &str| {
            store.start_run(&RunStart { id, file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: Some(delivery_id), team_id: None }).unwrap()
        };
        let (settled, running, queued) = (old(&store), old(&store), old(&store));
        start("done", &settled);
        store.settle_run("done", "completed", &Js::Null, &iso(0)).unwrap();
        start("live", &running);
        let payload = Js::Obj(crate::obj! { "deliveryId" => Js::str(&queued) });
        store.enqueue("fire_event", "fire_event:q", &payload, None).unwrap();
        let fresh = delivery(None);
        store.keep_delivery("sub", None, &fresh, &[], None, &[], &[]).unwrap();
        assert_eq!(store.sweep_deliveries(&iso(-14 * 86_400_000), 100).unwrap(), 1);
        assert!(store.delivery(&settled).unwrap().is_none());
        for kept in [&running, &queued, &fresh.id] {
            assert!(store.delivery(kept).unwrap().is_some(), "{kept}");
        }
    }

    #[test]
    fn a_state_file_without_delivery_id_gains_it_on_open() {
        let dir = std::env::temp_dir().join(format!("lf-state-{}", uuid()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        // A run table as a listen-fire before delivery receipts wrote it.
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "create table run (id text primary key, file text not null, movement text not null, status text not null, started_at text not null,
                   finished_at text, input text not null, outcome text, lease_token text, lease_until text);
                 insert into run (id, file, movement, status, started_at, input) values ('old', 'f', 'm', 'completed', '2026-10-01T00:00:00.000Z', '{}');",
            )
            .unwrap();
        let store = Store::open(&path).unwrap();
        assert_eq!(store.run("old").unwrap().unwrap().delivery_id, None);
        let first = delivery(None);
        store.keep_delivery("sub", None, &first, &[], None, &[], &[]).unwrap();
        store.start_run(&RunStart { id: "new", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: Some(&first.id), team_id: None }).unwrap();
        assert_eq!(store.run("new").unwrap().unwrap().delivery_id.as_deref(), Some(first.id.as_str()));
        let runs: Vec<String> = store.delivery(&first.id).unwrap().unwrap().runs.into_iter().map(|r| r.id).collect();
        assert_eq!(runs, ["new"]);
        let indexed: i64 = store.db.query_row("select count(*) from pragma_index_list('run') where name = 'run_delivery'", [], |r| r.get(0)).unwrap();
        assert_eq!(indexed, 1);
    }

    #[test]
    fn a_run_is_lapsed_when_it_is_running_without_a_live_lease_a_lease_length_after_it_started() {
        let (store, _) = state_file();
        let long_ago = iso(-120_000);
        let start = |id: &str, at: &str| store.start_run(&RunStart { id, file: "f", movement: "m", started_at: at, input: "{}", delivery_id: None, team_id: None }).unwrap();
        let lease_until = |id: &str, until: Option<String>| {
            store.db.execute("update run set lease_token = 't', lease_until = ? where id = ?", params![until, id]).unwrap();
        };
        start("lapsed", &long_ago);
        lease_until("lapsed", Some(iso(-1_000)));
        start("live", &long_ago);
        lease_until("live", Some(iso(40_000)));
        start("never-leased", &long_ago);
        start("just-started", &iso(0));
        start("parked", &long_ago);
        store.mark_parked("parked").unwrap();
        assert_eq!(store.lapsed_runs(60_000, 10).unwrap(), ["lapsed", "never-leased"]);
    }

    #[test]
    fn a_rows_attempts_count_its_claims_less_those_busy_and_start_over_when_it_succeeds() {
        let (store, _) = state_file();
        let due_soon = || claim(10, 60_000);
        store.enqueue("resume_timer", "k", &no_payload(), Some(&iso(-1_000))).unwrap();
        let first = store.claim_due(&due_soon()).unwrap().pop().unwrap();
        assert_eq!(first.attempts, 1);
        store.release_work(&first.id, &first.claim, Some(&iso(-1_000)), Release::Failed).unwrap();
        let second = store.claim_due(&due_soon()).unwrap().pop().unwrap();
        assert_eq!(second.attempts, 2);
        store.release_work(&second.id, &second.claim, Some(&iso(-1_000)), Release::Busy).unwrap();
        let third = store.claim_due(&due_soon()).unwrap().pop().unwrap();
        assert_eq!(third.attempts, 2, "a busy release gives its attempt back");
        store.release_work(&third.id, &third.claim, Some(&iso(-1_000)), Release::Rescheduled).unwrap();
        assert_eq!(store.claim_due(&due_soon()).unwrap().pop().unwrap().attempts, 1);
    }

    #[test]
    fn a_buried_row_is_never_claimed_until_it_is_queued_again() {
        let (store, _) = state_file();
        store.enqueue("wake_await", "k", &no_payload(), Some(&iso(-1_000))).unwrap();
        let claimed = store.claim_due(&claim(10, 60_000)).unwrap().pop().unwrap();
        store.bury_work(&claimed.id, &claimed.claim, "gave up").unwrap();
        let dead: (Option<String>, Option<String>) = store.db.query_row("select dead_reason, lease_token from work where key = 'k'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(dead, (Some("gave up".into()), None));
        assert!(store.claim_due(&claim(10, 60_000)).unwrap().is_empty());
        store.enqueue("wake_await", "k", &no_payload(), Some(&iso(-1_000))).unwrap();
        assert_eq!(store.claim_due(&claim(10, 60_000)).unwrap().pop().unwrap().attempts, 1);
        // Re-armed during its claim, a row is not buried: the new work stands.
        store.enqueue("resume_timer", "t", &no_payload(), Some(&iso(-1_000))).unwrap();
        let held = store.claim_due(&claim(10, 60_000)).unwrap().pop().unwrap();
        store.enqueue("resume_timer", "t", &no_payload(), Some(&iso(-500))).unwrap();
        store.bury_work(&held.id, &held.claim, "gave up").unwrap();
        assert_eq!(store.claim_due(&claim(10, 60_000)).unwrap().len(), 1);
    }
}

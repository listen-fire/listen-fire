//! A session — one project opened for running: its secrets, externals,
//! catalog, files and listens — and the entry points the run commands share:
//! an event routed to the listens it matches and run, a parked run resumed,
//! the work queue drained, a callback called and a run cancelled, and the
//! line each run is reported by (`report`).

use std::cell::{Cell, OnceCell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Write;
use std::rc::Rc;
use std::time::{Duration, Instant};

use indexmap::IndexMap;

use crate::callbacks::{CALLBACK_AWAIT_TYPE, CallFor, CallOutcome, queue_body, record_callback_call, refusal, resolvable_awaits};
use crate::catalog::{ConnectionSchemas, catalog_of};
use crate::check::{LOCAL_TENANT, check_parsed, describe_external, missing_line};
use crate::documents::Documents;
use crate::loop_guard::{Answer, Asked, Current, LoopGuard, Wrote};
use crate::externals::{External, Reach, RunningExternal, needed_externals, rpc, rpc_in, scan_externals, start_externals};
use crate::module_hosts::{Hold, Keep, ModuleProcess};
use movement_engine::executor::join_all;
use crate::json::{Js, Obj};
use crate::obj;
use crate::project::Project;
use movement_parser::version::{LANGUAGE_VERSION, Standing, standing};
use crate::remote::{Externals, SegmentAdapters};
use crate::routing::{Arrival, Listen, address_matches_key, event_matches_trigger_scope, routes_by_key, trigger_event_of, unrouted_line};
use crate::run_host::{
    BUSY_RETRY_MS, CANCELLED_BY_OPERATOR, FailedWork, Lease, Settled, StepOutcome, StepRequest, Stepper, WORKER_LOST, after_step, arm_timer_wake,
    clear_if_quiescent, drain_due_timers, drain_run, fail_lost_runs, fail_run, give_up_work, next_timer_wake, past_cap, run_complete_without, run_quiescent,
    settle_if_cancel_requested, with_run_lease, work_failed,
};
use crate::secrets::{Secrets, credential_for, imported_credentials, missing_credentials};
use crate::segment::{Ended, Entry, Ran, SegmentHost, SegmentHostParts, SegmentInput, run_segment};
use crate::movements_slot::{Change, ChangeKind, Listed, MovementsStore, Watched, movement_file, ordered};
use crate::sources::{MOVEMENT_EXTENSION, MovementFile, Parsed, scan_movements};
use crate::backend::{RunHostStore, StoreSpec, open_store};
use crate::store::{ClaimDue, POLL_WORK_KIND, Release, RunStart, iso};
use module_wire::results as wire_results;

/// How many files' parses a session's runs keep (movement_engine::program::keep_parses):
/// a run's segment starts from a copy of its file's, a fifth of parsing it.
const KEPT_PARSES: usize = 128;

/// How many due work rows one drain of `lf resume` or `lf serve` claims.
pub const WORK_ROWS_PER_DRAIN: i64 = 100;

/// How long a work row's claim lasts (`LEASE_TTL_MS`).
const WORK_LEASE_MS: i64 = 60_000;
/// How often a drain looks for runs whose worker was lost (the platform's
/// `run_orphan_sweep` interval).
const LOST_RUN_SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
/// Where `lf serve` listens unless told otherwise (`DEFAULT_PORT`).
pub const DEFAULT_PORT: u16 = 4400;

/// The files a session runs and what is built from them: the catalog they
/// link against, their listens and the externals they import. An entry point
/// takes the set once and works within it, so work begun before the set is
/// replaced finishes on the files it began with.
pub struct FileSet {
    pub files: Vec<MovementFile>,
    /// Each file read (its program, its listens), in the files' order: a
    /// refresh keeps the reading of each file whose text did not change.
    parsed: Vec<Rc<Parsed>>,
    pub catalog: Js,
    pub listens: Vec<Listen>,
    pub running: Vec<Rc<RunningExternal>>,
    schemas: IndexMap<String, ConnectionSchemas>,
    /// Each file's count of check errors against this set's catalog, by name.
    errors: OnceCell<BTreeMap<String, usize>>,
    /// The set's claims on its externals' processes: a worker's keep them
    /// up for as long as the set is held, and a process no set holds stops.
    _holds: Vec<Hold>,
}

/// Every process started, together.
async fn start_and_check(slots: &[crate::slot_client::SlotProcess]) -> Result<(), String> {
    let started = join_all(slots.iter().map(|slot| async move {
        slot.process.start().await?;
        slot.reached.checked().await
    }).collect()).await;
    started.into_iter().collect()
}

/// The set's claim on each external's process lf started.
fn hold_all(running: &[Rc<RunningExternal>], keep: Keep) -> Vec<Hold> {
    running
        .iter()
        .filter_map(|r| match &r.reach {
            Reach::Process(process) => Some(process.hold(keep)),
            Reach::Url(_) => None,
        })
        .collect()
}

impl FileSet {
    /// The file a listen is in. Its listens are read from its own files, so
    /// every listen's file is there.
    pub fn file(&self, name: &str) -> &MovementFile {
        self.files.iter().find(|f| f.name == name).unwrap_or_else(|| panic!("no file {name} in the set its listen was read from"))
    }

    /// The listens on a polled source (its manifest declares `poll`), each
    /// with its source and the subscription its checkpoint is kept under.
    fn polled_listens(&self) -> impl Iterator<Item = (&Listen, &RunningExternal, String)> {
        self.listens.iter().filter_map(|listen| {
            let running = self.running.iter().find(|r| !r.is_plugin() && r.external.manifest.name == listen.adapter && r.poll_interval_seconds.is_some())?;
            let file = self.file(&listen.file);
            let config = Js::Obj(listen.config.clone()).to_json();
            let subscription = format!("poll:{}:{}:{}:{config}", listen.adapter, file.name, listen.movement_name);
            // A positioned connection's listen is polled under a key of its
            // own; one in no position keeps the key it always had, and with
            // it the checkpoint an earlier lf kept.
            let subscription = match running.position_settings(&listen.args) {
                Some(position) => format!("{subscription}:{position}"),
                None => subscription,
            };
            Some((listen, &**running, subscription))
        })
    }
}

/// What a session is opened for, which its module processes follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// One command (`lf run`, `lf resume`, `lf call`, …): a module stops when idle.
    Command,
    /// `lf drain`: every module the files use is started as the session
    /// opens and kept up for the worker's life, so no run pays a start.
    Drain,
    /// `lf serve`: a module stops when idle, and starts again for the
    /// delivery or the run that needs it; a refresh registers the webhooks
    /// the new listens need (crate::subscriptions).
    Serve,
    /// `lf serve --doors-only`: as `Serve`, and the slots' modules a door
    /// calls (`DOOR_SLOTS`) are started as it opens, never the others.
    Doors,
}

/// The slots whose modules a door calls: the run state, the secrets and
/// the movements it reads, the limiter its module calls go through, and the
/// wake it tells of the work it queues. Never models, OCR, files, the loop
/// guard, the judge or the browser: those serve runs.
const DOOR_SLOTS: &[&str] = &["store", "secrets", "movements", "limiter", "wake"];

impl Role {
    fn keep(self) -> Keep {
        match self {
            Role::Drain => Keep::Up,
            Role::Command | Role::Serve | Role::Doors => Keep::Idle,
        }
    }

    /// Whether the slot `kind`'s module is started as the session opens.
    fn starts_slot(self, kind: &str) -> bool {
        match self {
            Role::Drain => true,
            Role::Doors => DOOR_SLOTS.contains(&kind),
            Role::Command | Role::Serve => false,
        }
    }

    /// Whether a refresh registers the webhooks its listens need.
    fn registers_webhooks(self) -> bool {
        match self {
            Role::Serve | Role::Doors => true,
            Role::Command | Role::Drain => false,
        }
    }
}

/// How a session is opened: where its run state is kept (an ephemeral
/// session keeps its own in a temporary state file instead), and its role.
pub struct Opening<'s> {
    pub ephemeral: bool,
    pub store: &'s StoreSpec,
    pub role: Role,
}

pub struct Session {
    pub project: Project,
    pub role: Role,
    pub store: std::rc::Rc<dyn RunHostStore>,
    /// Never borrowed across an await: a webhook registration replaces it
    /// with what it wrote (crate::subscriptions).
    secrets: RefCell<Rc<Secrets>>,
    /// What `lf serve` has said of its webhooks' registration, so a failure
    /// a refresh meets again is not said again.
    pub registrations: crate::subscriptions::Registrations,
    pub documents: Documents,
    /// Never borrowed across an await: a refresh may replace it meanwhile.
    file_set: RefCell<Rc<FileSet>>,
    /// `LF_CLOCK_AHEAD_MS`: what is due is judged this far ahead.
    due_offset_ms: i64,
    /// The principal every event acts as (`localIdentity`).
    user: Js,
    /// Where lf is reached from outside: a callback's url is under it.
    public_url: String,
    /// The temporary folder an ephemeral session's state lives in.
    ephemeral_dir: Option<std::path::PathBuf>,
    /// The work this session's drains take (`lf drain --kinds`): all of it,
    /// unless a pool is named.
    pub pool: crate::drain::Pool,
    /// The loopGuard slot's module; None unless lf.yaml names one.
    loop_guard: Option<std::sync::Arc<dyn LoopGuard>>,
    /// The session's claims on the slots' module processes it started.
    _slot_holds: Vec<Hold>,
    /// When this session's drain last looked for lost runs.
    swept_at: Cell<Option<Instant>>,
    /// `LF_MOVEMENTS_REFRESH_MS`: how long the watch loop waits before it
    /// asks again a movements module that answered at once with nothing, or
    /// did not answer.
    watch_pause: Duration,
    /// The files (path, version) of the last set a refresh did not take:
    /// listed again, they are not checked or warned about again.
    refused: RefCell<Option<Vec<(String, String)>>>,
    /// Why the movements module last did not answer the watch loop (its
    /// watch, or its list): said once until it answers again.
    watch_failed: RefCell<Option<String>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(dir) = &self.ephemeral_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// `localIdentity`: LF_USER / LF_USER_EMAIL, else lf.yaml's `user` (its
/// name and email), else the OS user.
fn local_identity(configured: &(Option<String>, Option<String>), env: impl Fn(&str) -> Option<String>) -> Js {
    let name = env("LF_USER").or_else(|| configured.0.clone()).or_else(|| env("USER")).or_else(|| env("USERNAME")).unwrap_or_else(|| "lf".into());
    let email = env("LF_USER_EMAIL").or_else(|| configured.1.clone()).unwrap_or_else(|| format!("{name}@localhost"));
    Js::Obj(obj! {
        "principal" => Js::Obj(obj! { "id" => Js::Str(format!("local:{name}")), "display" => Js::str(&name) }),
        "email" => Js::Str(email),
    })
}

fn due_clock_offset() -> Result<i64, String> {
    match std::env::var("LF_CLOCK_AHEAD_MS") {
        Err(_) => Ok(0),
        Ok(raw) if raw.is_empty() => Ok(0),
        Ok(raw) => raw
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0)
            .ok_or_else(|| format!("LF_CLOCK_AHEAD_MS is \"{raw}\": it must be a whole number of milliseconds")),
    }
}

/// How long the watch loop pauses after a movements module answered at once
/// with nothing (it cannot hold a watch) or did not answer, unless
/// LF_MOVEMENTS_REFRESH_MS says otherwise.
const DEFAULT_MOVEMENTS_REFRESH_MS: u64 = 5_000;
/// The shortest pause: `0` would ask such a module without a break.
const LEAST_WATCH_PAUSE: Duration = Duration::from_millis(100);

fn movements_watch_pause() -> Result<Duration, String> {
    watch_pause_of(std::env::var("LF_MOVEMENTS_REFRESH_MS").ok().as_deref())
}

fn watch_pause_of(raw: Option<&str>) -> Result<Duration, String> {
    let pause = match raw {
        None | Some("") => Duration::from_millis(DEFAULT_MOVEMENTS_REFRESH_MS),
        Some(raw) => raw
            .trim()
            .parse::<u64>()
            .map(Duration::from_millis)
            .map_err(|_| format!("LF_MOVEMENTS_REFRESH_MS is \"{raw}\": it must be a whole number of milliseconds"))?,
    };
    Ok(pause.max(LEAST_WATCH_PAUSE))
}

pub async fn open_session(project: Project, opening: &Opening<'_>) -> Result<Session, String> {
    let Opening { ephemeral, store, role } = *opening;
    let env: Vec<(String, String)> = std::env::vars().collect();
    let secrets = Secrets::open(&project, &env)?;
    let credentials = secrets.credentials();
    let files = scan_movements(&project)?;
    let parsed = Parsed::each(&files, &[]);
    let missing = missing_credentials(&parsed, &secrets);
    if !missing.is_empty() {
        return Err(missing.iter().map(|m| format!("{}:{}:{} {}", m.file.display(), m.line, m.column, m.message)).collect::<Vec<_>>().join("\n"));
    }
    let registered = |e: &crate::externals::External| crate::subscriptions::has_registered_webhook(credentials, &e.manifest.name);
    let externals = needed_externals(scan_externals(&project)?, &parsed, registered);
    // A run's segment starts from a copy of its file's parse, kept for the process.
    movement_engine::program::keep_parses(KEPT_PARSES);
    let loop_guard = crate::loop_guard::of_project(&project, credentials)?;
    crate::wake::install(crate::wake::of_project(&project, credentials)?);
    // Before any call: the manifest calls below ask it too.
    crate::limiter::install(crate::limiter::of_project(&project, credentials)?);
    // Before the externals and the slots' modules start, so they are told where it is.
    crate::listener::open_models_door(credentials).await?;
    // Before the externals start too: a browser module's address is handed to them.
    crate::remote_slots::install(&project, credentials).await?;
    let due_offset_ms = due_clock_offset()?;
    let watch_pause = movements_watch_pause()?;
    let (store, ephemeral_dir) = if ephemeral {
        let dir = std::env::temp_dir().join(format!("lf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        (open_store(&StoreSpec::Sqlite(dir.join("state.db")))?, Some(dir))
    } else {
        (open_store(store)?, None)
    };
    let store: std::rc::Rc<dyn RunHostStore> = store.into();
    // Before any module starts: what an earlier lf left running is
    // stopped, and what this one starts is listed in the store.
    crate::module_hosts::track_in(store.clone());
    // The files slot's module: @lf/local-files (crate::core), or one reached over the wire.
    let documents = Documents::with_module(&project.lf_dir, crate::remote_slots::files(&project, credentials)?);
    // The slots' modules the role starts now, with the externals: a
    // worker's every one, a door's the ones a door calls.
    // Each one's manifest is read as it starts: one outside the protocol
    // range lf speaks fails the open by name, before any work is claimed.
    let slots: Vec<crate::slot_client::SlotProcess> = crate::slot_client::slot_processes().into_iter().filter(|slot| role.starts_slot(&slot.kind)).collect();
    let slot_processes: Vec<ModuleProcess> = slots.iter().map(|slot| slot.process.clone()).collect();
    let (started, running) = tokio::join!(start_and_check(&slots), start_externals(&project, &externals, credentials, LOCAL_TENANT));
    let running: Vec<Rc<RunningExternal>> = running?.into_iter().map(Rc::new).collect();
    started?;
    let _slot_holds = slot_processes.iter().map(|process| process.hold(role.keep())).collect();
    let imported = imported_credentials(&parsed);
    let imported = &imported;
    let described = join_all(
        running
            .iter()
            .filter(|r| !r.is_plugin())
            .map(|r| async move { Ok::<_, String>((r.external.manifest.name.clone(), describe_external(r, credentials, imported, ConnectionSchemas::new()).await?)) })
            .collect(),
    )
    .await;
    let schemas = described.into_iter().collect::<Result<IndexMap<String, ConnectionSchemas>, String>>()?;
    // Scanned again after the externals start: one may have written a movement file.
    let files = scan_movements(&project)?;
    let parsed = Parsed::each(&files, &parsed);
    let catalog = catalog_of(&running, &schemas, credentials, &files);
    let mut listens = crate::routing::listens_across(&parsed);
    crate::listen_narrowing::resolve_listen_addresses(&mut listens, &running, credentials).await;
    let user = local_identity(&project.user, |k| std::env::var(k).ok());
    let public_url = project
        .public_url
        .clone()
        .or_else(|| crate::serve::host_url().map(str::to_string))
        .unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}"));
    let _holds = hold_all(&running, role.keep());
    let file_set = RefCell::new(Rc::new(FileSet { files, parsed, catalog, listens, running, schemas, errors: Default::default(), _holds }));
    Ok(Session {
        project,
        role,
        store,
        secrets: RefCell::new(Rc::new(secrets)),
        registrations: Default::default(),
        documents,
        file_set,
        due_offset_ms,
        user,
        public_url,
        ephemeral_dir,
        pool: Default::default(),
        loop_guard,
        _slot_holds,
        swept_at: Default::default(),
        watch_pause,
        refused: Default::default(),
        watch_failed: Default::default(),
    })
}

/// The checkpoint a cron listen's ticks are kept under; None for any other listen.
fn cron_subscription(file: &str, listen: &Listen) -> Option<String> {
    if listen.adapter != crate::units::CRON {
        return None;
    }
    let schedule = listen.config.get("schedule").and_then(Js::as_str)?;
    let timezone = listen.config.get("timezone").and_then(Js::as_str).unwrap_or("UTC");
    Some(format!("cron:{file}:{}:{schedule}:{timezone}", listen.movement_name))
}

/// The delivery an event came in, as its runs and its routing read it.
#[derive(Clone, Copy, Default)]
pub struct Delivered<'a> {
    /// The delivery's receipt; None for an event that came in none.
    pub id: Option<&'a str>,
    /// The connection it came for (crate::routing::Listen::hears); None
    /// reaches every listen.
    pub credential: Option<&'a str>,
    /// The webhook subscription it came through, by its key
    /// (crate::routing::subscription_key); None for a credential's own door,
    /// which the credential alone narrows.
    pub subscription: Option<&'a str>,
}

impl<'a> Delivered<'a> {
    /// What a kept event or a queued `fire_event` row says it came for,
    /// under delivery `id`. Rows from before rows named a connection or a
    /// subscription name none.
    pub fn of_row(row: &'a Js, id: Option<&'a str>) -> Delivered<'a> {
        let text = |key: &str| row.get(key).and_then(Js::as_str);
        Delivered { id, credential: text("credential"), subscription: text("subscription") }
    }

    /// Its connection and subscription, written into a kept event or a row.
    pub fn write_into(&self, row: &mut Obj) {
        if let Some(credential) = self.credential {
            row.insert("credential".into(), Js::str(credential));
        }
        if let Some(subscription) = self.subscription {
            row.insert("subscription".into(), Js::str(subscription));
        }
    }

    /// Whether `listen` takes it, under the module's `scope_keys`.
    fn reaches(&self, listen: &Listen, scope_keys: &[String]) -> bool {
        listen.hears_through(self.credential, self.subscription, scope_keys)
    }
}

/// The external's `subscriptionScopeKeys`, when it is running.
fn scope_keys_of(set: &FileSet, external: &str) -> Vec<String> {
    set.running.iter().find(|r| r.external.manifest.name == external).map(|r| r.subscription_scope_keys()).unwrap_or_default()
}

/// What firing one event came to: the runs it started, and a line for each
/// way it ran nothing: a listen it was a redelivery to (its `idempotencyKey`
/// seen there before) or an echo of, or mail no listen is keyed for.
#[derive(Default)]
pub struct Fired {
    pub outcomes: Vec<RunOutcome>,
    pub redelivered: Vec<String>,
}

impl Fired {
    /// The redeliveries' lines, then the runs as `report` writes them.
    pub fn report(&self, out: &mut impl Write) -> Result<i32, String> {
        for line in &self.redelivered {
            writeln!(out, "{line}").map_err(|e| e.to_string())?;
        }
        if self.outcomes.is_empty() && !self.redelivered.is_empty() {
            return Ok(0);
        }
        report(&self.outcomes, Returned::Shown, out)
    }
}

/// What one entry into a run came to (`RunOutcome`).
pub struct RunOutcome {
    pub run_id: String,
    pub file: String,
    pub movement: String,
    /// `fired`, `resumed`, or `called` (a callback's body; `error`: the body
    /// failed, and the run carries on).
    pub entry: &'static str,
    /// `completed`, `parked`, `failed` or `leaseLost`.
    pub status: String,
    pub writes: usize,
    pub captured: Option<Vec<Js>>,
    pub trace_entries: i64,
    pub error: Option<String>,
    /// What the movement returned, as the run's history keeps it
    /// (crate::returned), once the run has completed.
    pub returned: Option<Js>,
}

/// Whether a report shows what each completed run returned: yes to a person
/// who started or drove the run; no in a worker's log of the runs events
/// started, where it only sits in the run's history.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Returned {
    Shown,
    Withheld,
}

/// The most writes a run's history lists; its `writes` counts them all.
const LISTED_WRITES: usize = 100;

/// What a run entry has done so far: its writes, and how many segments ran.
#[derive(Default, Clone, Copy)]
struct Tally {
    writes: usize,
    stepped: usize,
}

/// The facts a run keeps so it can be resumed against the same program (`RunFacts`).
struct RunFacts {
    source: String,
    language_version: String,
    event: Js,
    movement_name: String,
    fired_at: String,
    /// A rehearsal (`--dry-run`): every segment of the run captures its
    /// writes, the ones after a park included.
    dry_run: bool,
}

impl RunFacts {
    fn to_js(&self) -> Js {
        let mut facts = obj! {
            "source" => Js::str(&self.source),
            "languageVersion" => Js::str(&self.language_version),
            "event" => self.event.clone(),
            "movementName" => Js::str(&self.movement_name),
            "firedAt" => Js::str(&self.fired_at),
        };
        if self.dry_run {
            facts.insert("dryRun".into(), Js::Bool(true));
        }
        Js::Obj(facts)
    }

    /// A run's facts, refused when its pin is one lf does not run.
    fn of_row(run_id: &str, input: &str) -> Result<RunFacts, String> {
        let facts = Js::parse(input.as_bytes()).map_err(|e| format!("run {run_id}: its facts are not JSON: {e}"))?;
        let text = |k: &str| facts.get(k).and_then(Js::as_str).map(str::to_string).ok_or_else(|| format!("run {run_id}: its facts have no {k}"));
        let language_version = match facts.get("languageVersion") {
            Some(Js::Str(pin)) => {
                let own = LANGUAGE_VERSION;
                match standing(pin, own) {
                    Standing::Compatible => pin.to_string(),
                    Standing::Newer => return Err(format!("run {run_id}: pinned to language {pin}, newer than this lf ({own}); upgrade lf")),
                    Standing::OlderKey | Standing::Malformed => {
                        return Err(format!("run {run_id}: pinned to language {pin}, which this lf ({own}) does not read; it cannot resume: upgrade its movement and fire it again"));
                    }
                }
            }
            // A store from before pins were versions wrote the integer 5 (the
            // only integer lf ever ran): read it once as this release, so a
            // parked run still resumes.
            Some(Js::Num(n)) if n.as_u64().is_some_and(|n| n >= 5) => LANGUAGE_VERSION.to_string(),
            Some(Js::Num(n)) => {
                return Err(format!("run {run_id}: pinned to the integer {n}, from before pins were releases, which lf does not run; it cannot resume: upgrade its movement and fire it again"));
            }
            _ => return Err(format!("run {run_id}: its facts have no languageVersion")),
        };
        Ok(RunFacts {
            source: text("source")?,
            language_version,
            event: facts.get("event").cloned().unwrap_or(Js::Null),
            movement_name: text("movementName")?,
            fired_at: text("firedAt")?,
            dry_run: facts.get("dryRun") == Some(&Js::Bool(true)),
        })
    }
}

impl Session {
    /// The files the session runs now, and what is built from them.
    pub fn file_set(&self) -> Rc<FileSet> {
        self.file_set.borrow().clone()
    }

    /// The secrets as last read: the installs (`credentials()`), the
    /// secrets module's then the environment's. Work holds what it took
    /// while a registration reads them again.
    pub fn secrets(&self) -> Rc<Secrets> {
        self.secrets.borrow().clone()
    }

    /// Read the secrets again, after lf wrote to them (crate::subscriptions).
    pub fn reload_secrets(&self) -> Result<(), String> {
        let read = Secrets::open(&self.project, &std::env::vars().collect::<Vec<_>>())?;
        self.secrets.replace(Rc::new(read));
        Ok(())
    }

    pub fn externals_in<'a>(&'a self, set: &'a FileSet, secrets: &'a Secrets) -> Externals<'a> {
        Externals { project: &self.project, running: &set.running, credentials: secrets.credentials(), documents: &self.documents, tenant: LOCAL_TENANT, loop_guard: self.loop_guard.as_deref() }
    }

    fn due_by(&self) -> String {
        iso(self.due_offset_ms)
    }

    /// Now, as this session judges what is due (`LF_CLOCK_AHEAD_MS` on).
    pub fn now_ms(&self) -> i64 {
        crate::limiter::now_ms() + self.due_offset_ms
    }

    /// Route one event to every listen it matches, and run each (`fireEvent`).
    /// An event with an `idempotencyKey` runs a listen once: a redelivery
    /// runs nothing. A dry run notes no receipt, so the real delivery after
    /// it still runs. Each run names the delivery the event came in, when it
    /// came in one, and only the listens of the connection it came for take it.
    pub async fn fire_event(&self, external: &str, event: &Js, dry_run: bool, delivered: Delivered<'_>) -> Result<Fired, String> {
        let set = self.file_set();
        let scope_keys = scope_keys_of(&set, external);
        self.fire_to(&set, external, event, Arrival::Pushed, dry_run, delivered.id, |l| delivered.reaches(l, &scope_keys)).await
    }

    /// `fire_event`, to the listens `to` keeps of those the event reaches.
    #[allow(clippy::too_many_arguments)] // the file set, the event and how it came, then the firing's own options
    async fn fire_to(&self, set: &FileSet, external: &str, event: &Js, arrival: Arrival, dry_run: bool, delivery_id: Option<&str>, to: impl Fn(&Listen) -> bool) -> Result<Fired, String> {
        let event_types = self.event_types_of(set, external).await?;
        let key = event.get("idempotencyKey").and_then(Js::as_str).filter(|k| !k.is_empty());
        let now_reads = RefCell::new(HashMap::new());
        let mut fired = Fired::default();
        let keyed = set.running.iter().any(|r| r.external.manifest.name == external && routes_by_key(&r.listen));
        let routed = |l: &Listen| !keyed || address_matches_key(event, &l.config);
        let heard: Vec<&Listen> = set.listens.iter().filter(|l| l.adapter == external && event_matches_trigger_scope(event, &l.config, arrival) && routed(l) && to(l)).collect();
        let (reached, misfit): (Vec<&Listen>, Vec<&Listen>) = heard.into_iter().partition(|l| l.takes(event));
        for listen in misfit {
            let declared = listen.payload.as_ref().map(|p| (p.name.as_str(), p.misfits(event.get("payload").unwrap_or(&Js::Null)).join("; "))).unwrap_or_default();
            fired.redelivered.push(format!("{}:{} declares the payload {}, which this event does not fit ({}): it runs nothing", listen.file, listen.movement_name, declared.0, declared.1));
        }
        if keyed && reached.is_empty() {
            fired.redelivered.push(unrouted_line(external, event));
        }
        for listen in reached {
            let run_id = uuid::Uuid::new_v4().to_string();
            let file = set.file(&listen.file);
            let pipeline = listen.pipeline();
            let receipt = key.filter(|_| !dry_run);
            let ran_before = |key: &str| format!("{}:{} has run the event {key} before: this delivery runs nothing", file.name, listen.movement_name);
            if !dry_run && self.is_own_echo(set, external, event, &pipeline, &now_reads).await {
                // The echo's receipt is noted all the same, so its redelivery
                // runs nothing however the record moves meanwhile.
                if let Some(key) = receipt
                    && !self.store.claim_event(&pipeline, key).map_err(|e| e.to_string())?
                {
                    fired.redelivered.push(ran_before(key));
                    continue;
                }
                let record = crate::loop_guard::event_record(event).unwrap_or_default();
                fired.redelivered.push(format!("{}:{} wrote the record {record} and it is unchanged since: this event is that write's echo and runs nothing", file.name, listen.movement_name));
                continue;
            }
            let trigger = trigger_event_of(&pipeline, external, event, &event_types, &iso(0));
            match self.run_listen(set, &run_id, listen, trigger, dry_run, receipt.map(|key| (pipeline.as_str(), key)), delivery_id).await? {
                Some(outcome) => fired.outcomes.push(outcome),
                None => fired.redelivered.push(ran_before(key.unwrap_or_default())),
            }
        }
        Ok(fired)
    }

    /// `lf run <movement>`: one invocation on the manual unit, to the listens
    /// that fire `movement` (`listen to manual fire <movement>`).
    pub async fn run_manual(&self, movement: &str, text: Option<&str>, dry_run: bool) -> Result<Fired, String> {
        let manual = |l: &Listen| l.adapter == crate::units::MANUAL && l.movement_name == movement;
        let set = self.file_set();
        if !set.listens.iter().any(manual) {
            return Err(format!("no listen fires '{movement}' on manual: add `listen to manual fire {movement}` to run it with `lf run {movement}`"));
        }
        let event = crate::units::manual_event(&iso(0), &self.user, text);
        self.fire_to(&set, crate::units::MANUAL, &event, Arrival::Pushed, dry_run, None, |l| l.movement_name == movement).await
    }

    /// The cron unit's due ticks (scale from zero): for each cron listen, the
    /// latest occurrence since the last one it was fired for, fired once —
    /// a tick missed while no worker ran fires on the next drain, and the
    /// occurrence's receipt keeps a second worker from firing it again. A
    /// listen seen for the first time starts from now: nothing before it is
    /// owed.
    async fn fire_due_ticks(&self, set: &FileSet, log: &mut impl Write) -> Result<Vec<RunOutcome>, String> {
        let names = set.running.iter().filter(|r| !r.is_plugin()).map(|r| r.external.manifest.name.as_str());
        if crate::units::unit_named(crate::units::CRON, names).is_none() {
            return Ok(Vec::new());
        }
        let now = iso(self.due_offset_ms);
        let now_ms = crate::units::ms_of(&now).ok_or("the clock reads no instant")?;
        let mut outcomes = Vec::new();
        for (index, listen) in set.listens.iter().enumerate() {
            let file = set.file(&listen.file);
            let Some(subscription) = cron_subscription(&file.name, listen) else { continue };
            let Some(schedule) = listen.config.get("schedule").and_then(Js::as_str) else { continue };
            let timezone = listen.config.get("timezone").and_then(Js::as_str);
            let after = self.store.inbound_checkpoint(&subscription).map_err(|e| e.to_string())?;
            let Some(after_ms) = after.as_ref().and_then(|c| c.get("after")).and_then(Js::as_str).and_then(crate::units::ms_of) else {
                self.store.save_inbound_checkpoint(&subscription, &Js::Obj(obj! { "after" => Js::str(&now) })).map_err(|e| e.to_string())?;
                continue;
            };
            let parsed = match crate::units::parse_schedule(schedule, timezone) {
                Ok(parsed) => parsed,
                Err(message) => {
                    let _ = writeln!(log, "{}:{} schedule \"{schedule}\": {message}", file.name, listen.movement_name);
                    continue;
                }
            };
            let Some(due_ms) = parsed.latest_in(after_ms, now_ms) else { continue };
            let due = crate::units::iso_of(due_ms);
            let event = crate::units::tick_event(&due, schedule, timezone);
            let fired = self.fire_to(set, crate::units::CRON, &event, Arrival::Pushed, false, None, |l| std::ptr::eq(l, &set.listens[index])).await?;
            self.store.save_inbound_checkpoint(&subscription, &Js::Obj(obj! { "after" => Js::str(&due) })).map_err(|e| e.to_string())?;
            outcomes.extend(fired.outcomes);
        }
        Ok(outcomes)
    }

    /// Give each polled listen not yet polled its `poll_listen` work row,
    /// due now. The row then lives as long as the listen: each poll releases
    /// it for the next interval, so whichever worker claims it (under the
    /// work lease, so never two at once) polls, and a poll due while no
    /// worker ran is one poll on the next drain. The row is queued only
    /// where none is (`enqueue_if_absent`): workers arming one listen at
    /// once queue it once, and an arm never moves the due time of the row
    /// another worker holds, which would poll it again at once.
    fn arm_polls(&self, set: &FileSet) -> Result<(), String> {
        for (_, _, subscription) in set.polled_listens() {
            // Polled before: its row is there, and its checkpoint says so.
            if self.store.inbound_checkpoint(&subscription).map_err(|e| e.to_string())?.is_some() {
                continue;
            }
            let payload = Js::Obj(obj! { "subscription" => Js::str(&subscription) });
            if self.store.enqueue_if_absent(POLL_WORK_KIND, &format!("{POLL_WORK_KIND}:{subscription}"), &payload, None, None).map_err(|e| e.to_string())? {
                crate::wake::queued(POLL_WORK_KIND, None);
            }
        }
        Ok(())
    }

    /// One poll of one listen's source: `poll({ config, checkpoint? })`, each
    /// event it returns fired to that listen as a webhook's is (a redelivered
    /// `idempotencyKey` runs nothing), then the source's checkpoint kept for
    /// the next poll — only once its events are in, so a failed poll is
    /// polled again from where the last good one ended.
    async fn poll_once(&self, set: &FileSet, listen: &Listen, running: &RunningExternal, subscription: &str) -> Result<Fired, String> {
        let state = self.store.inbound_checkpoint(subscription).map_err(|e| e.to_string())?;
        let params = poll_params(listen, state.as_ref());
        let secrets = self.secrets();
        let credentials = secrets.credentials();
        // Polled as its own connection: the credential its construction names, else the source's.
        let credential = match &listen.credential {
            Some(name) => Some(credentials.iter().find(|c| c.name == *name).ok_or_else(|| format!("no credential \"{name}\" in the secrets file"))?),
            None => credential_for(credentials, &listen.adapter),
        };
        let raw = rpc_in(running, credentials, credential, LOCAL_TENANT, "poll", params, running.position_settings(&listen.args)).await?;
        let answer = wire_results::check("poll", &listen.adapter, &raw)?;
        let mut fired = Fired::default();
        let events = answer.get("events").and_then(Js::as_array).unwrap_or(&[]);
        // A source's first poll only sets its mark (Gmail's does): say so,
        // or a listen that is live looks like one that is not.
        if state.is_none() && events.is_empty() {
            fired.redelivered.push(format!("{}: {}:{} armed; it fires on changes from now", listen.adapter, set.file(&listen.file).name, listen.movement_name));
        }
        for event in events {
            if event.get("eventType").and_then(Js::as_str).is_none() {
                note_unlabelled_poll_event(&listen.adapter);
            }
            let one = self.fire_to(set, &listen.adapter, event, Arrival::Polled, false, None, |l| std::ptr::eq(l, listen)).await?;
            fired.outcomes.extend(one.outcomes);
            fired.redelivered.extend(one.redelivered);
        }
        let mut kept = obj! { "armed" => Js::Bool(true) };
        if let Some(checkpoint) = answer.get("checkpoint").filter(|c| **c != Js::Null) {
            kept.insert("checkpoint".into(), checkpoint.clone());
        }
        self.store.save_inbound_checkpoint(subscription, &Js::Obj(kept)).map_err(|e| e.to_string())?;
        Ok(fired)
    }

    /// A `poll_listen` row: poll its listen, and say when it is next due — the
    /// listen's `every` (`pollIntervalSeconds` in the older language), else its source's interval. A row whose
    /// listen is gone is done, and its checkpoint forgotten.
    async fn poll_row(&self, set: &FileSet, subscription: &str) -> Result<(Next, Vec<RunOutcome>), String> {
        let Some((listen, running, _)) = set.polled_listens().find(|(_, _, s)| s == subscription) else {
            self.store.save_inbound_checkpoint(subscription, &Js::Null).map_err(|e| e.to_string())?;
            return Ok((Next::Done, Vec::new()));
        };
        let fired = self.poll_once(set, listen, running, subscription).await?;
        for line in &fired.redelivered {
            eprintln!("lf: {line}");
        }
        // `every: 5m` now, `pollIntervalSeconds: 300` before.
        let every = listen.config.get("every").and_then(Js::as_str).and_then(movement_engine::park::duration_ms).filter(|ms| *ms >= 1000.0).map(|ms| (ms / 1000.0) as u64);
        let seconds = every.or(match listen.config.get("pollIntervalSeconds") {
            Some(Js::Num(n)) => n.as_u64().filter(|s| *s > 0),
            _ => None,
        });
        let interval_ms = seconds.or(running.poll_interval_seconds).unwrap_or(1) as i64 * 1000;
        Ok((Next::DueAt(iso(self.due_offset_ms + interval_ms)), fired.outcomes))
    }

    /// `lf run --poll <movement>`: poll now, once, the source of every listen
    /// that fires `movement` on a polled source.
    pub async fn run_poll(&self, movement: &str) -> Result<Fired, String> {
        let set = self.file_set();
        let listens: Vec<_> = set.polled_listens().filter(|(l, _, _)| l.movement_name == movement).collect();
        if listens.is_empty() {
            return Err(format!("no listen on a polled source fires '{movement}': a source is polled when its manifest declares `poll`"));
        }
        let mut fired = Fired::default();
        for (listen, running, subscription) in listens {
            let one = self.poll_once(&set, listen, running, &subscription).await?;
            fired.outcomes.extend(one.outcomes);
            fired.redelivered.extend(one.redelivered);
        }
        Ok(fired)
    }

    async fn event_types_of(&self, set: &FileSet, external: &str) -> Result<Vec<Js>, String> {
        let Some(running) = set.running.iter().find(|r| r.external.manifest.name == external) else { return Ok(Vec::new()) };
        if !running.methods.iter().any(|m| m == "listEventTypes") {
            return Ok(Vec::new());
        }
        let raw = rpc(running, self.secrets().credentials(), LOCAL_TENANT, "listEventTypes", serde_json::json!({})).await?;
        let types = wire_results::check("listEventTypes", external, &raw)?;
        Ok(types.as_array().map(<[Js]>::to_vec).unwrap_or_default())
    }

    /// Start the run and step its first segment. With a `receipt` (the
    /// listen and the event's key), the receipt and the run are one write:
    /// None, and nothing run, for an event the listen has run before. The
    /// run names `delivery_id`, the delivery its event came in.
    #[allow(clippy::too_many_arguments)] // the file set it runs within, then the run's own inputs
    async fn run_listen(&self, set: &FileSet, run_id: &str, listen: &Listen, event: Js, dry_run: bool, receipt: Option<(&str, &str)>, delivery_id: Option<&str>) -> Result<Option<RunOutcome>, String> {
        let file = set.file(&listen.file);
        let fired_at = iso(0);
        let facts = RunFacts {
            source: file.source.clone(),
            language_version: self.project.language_version.clone(),
            event,
            movement_name: listen.movement_name.clone(),
            fired_at: fired_at.clone(),
            dry_run,
        };
        let input = facts.to_js().to_json();
        let start = RunStart { id: run_id, file: &file.name, movement: &facts.movement_name, started_at: &fired_at, input: &input, delivery_id };
        match receipt {
            None => self.store.start_run(&start).map_err(|e| e.to_string())?,
            Some((listen, key)) => {
                if !self.store.start_event_run(listen, key, &start).map_err(|e| e.to_string())? {
                    return Ok(None);
                }
            }
        }
        let tally = RefCell::new(Tally::default());
        let captured = RefCell::new(Vec::new());
        let held = with_run_lease(&*self.store, run_id, async |lease: &Lease| -> Result<bool, String> {
            let fence = Some(lease.token.as_str());
            let outcome = self
                .record_segment(set, run_id, &facts, Some(&lease.token), &tally, dry_run.then_some(&captured), Entry::Run, None)
                .await?;
            if let Settled::Continue = after_step(&*self.store, run_id, fence, &outcome)? {
                clear_if_quiescent(&*self.store, run_id, fence)?;
            }
            Ok(outcome == StepOutcome::LeaseLost)
        })
        .await?;
        // A fresh run's row is new: nobody else can hold its lease.
        let Some(lease_lost) = held else { return Err(run_busy(run_id)) };
        let mut outcome = self.settled_outcome(run_id, "fired", *tally.borrow(), lease_lost?)?;
        if dry_run {
            outcome.captured = Some(captured.into_inner());
        }
        Ok(Some(outcome))
    }

    /// Run one segment and record what it came to on the run's row
    /// (`recordSegment`). `completing` is the leaf whose own row goes after
    /// its step (None for a fresh firing).
    #[allow(clippy::too_many_arguments)] // the TypeScript's input object, spelled out
    async fn record_segment(
        &self,
        set: &FileSet,
        run_id: &str,
        facts: &RunFacts,
        fence: Option<&str>,
        tally: &RefCell<Tally>,
        captured: Option<&RefCell<Vec<Js>>>,
        entry: Entry,
        completing: Option<&str>,
    ) -> Result<StepOutcome, String> {
        tally.borrow_mut().stepped += 1;
        let ran = match self.segment(set, run_id, facts, fence, entry).await {
            Ok(ran) => ran,
            Err(Ended::LeaseLost) => return Ok(StepOutcome::LeaseLost),
            Err(Ended::Failed(message)) => {
                self.store.mark_failed(run_id, &message).map_err(|e| e.to_string())?;
                return Ok(StepOutcome::Failed(message));
            }
        };
        if let Some(captured) = captured {
            captured.borrow_mut().extend(ran.captured.iter().cloned());
        }
        tally.borrow_mut().writes += ran.writes;
        let at = iso(0);
        if ran.cancelled {
            let reason = self.store.cancel_request(run_id).map_err(|e| e.to_string())?.flatten();
            return Ok(StepOutcome::Cancelled(reason));
        }
        // What the run's earlier segments settled with, this entry's and any
        // before it (a resume, a callback's continuation): the run's history
        // counts and lists every write it made, and keeps what it returned.
        let before = self.store.run(run_id).map_err(|e| e.to_string())?.and_then(|row| row.outcome).and_then(|text| Js::parse(text.as_bytes()).ok()).unwrap_or(Js::Null);
        let earlier = match before.get("writes") {
            Some(Js::Num(n)) => n.as_u64().unwrap_or(0),
            _ => 0,
        };
        let writes = earlier + ran.writes as u64;
        let mut outcome = obj! { "writes" => Js::Num(writes.into()) };
        let mut listed: Vec<Js> = before.get("writeRecords").and_then(Js::as_array).map(<[Js]>::to_vec).unwrap_or_default();
        listed.extend(ran.write_records.into_iter());
        listed.truncate(LISTED_WRITES);
        outcome.insert("writeRecords".into(), Js::Arr(listed));
        // The body returns in one segment; a later one (a callback's body, a
        // branch the run still waited on) keeps what it returned.
        if let Some(returned) = ran.returned.or_else(|| before.get("returned").cloned()) {
            outcome.insert("returned".into(), returned);
        }
        let outcome = Js::Obj(outcome);
        if let Some(address) = ran.parked_address {
            self.store.settle_run(run_id, "parked", &outcome, &at).map_err(|e| e.to_string())?;
            return Ok(StepOutcome::Parked { address: Some(address), deferred_race_frames: ran.deferred_race_frames });
        }
        let complete = match completing {
            None => run_quiescent(&*self.store, run_id)?,
            Some(leaf) => run_complete_without(&*self.store, run_id, leaf)?,
        };
        self.store.settle_run(run_id, if complete { "completed" } else { "parked" }, &outcome, &at).map_err(|e| e.to_string())?;
        Ok(StepOutcome::Completed { deferred_race_frames: ran.deferred_race_frames })
    }

    /// One engine segment of the run, entered as `entry`, under `fence`.
    async fn segment(&self, set: &FileSet, run_id: &str, facts: &RunFacts, fence: Option<&str>, entry: Entry) -> Result<Ran, Ended> {
        let secrets = self.secrets();
        let externals = self.externals_in(set, &secrets);
        let segment_id = uuid::Uuid::new_v4().to_string();
        let host = SegmentHost::new(SegmentHostParts {
            segment_id: segment_id.clone(),
            run_id: run_id.to_string(),
            fence: fence.map(str::to_string),
            store: &*self.store,
            adapters: SegmentAdapters::new(&segment_id, &externals),
            documents: &self.documents,
            user: self.user.clone(),
            public_url: self.public_url.clone(),
        });
        let input = SegmentInput {
            source: &facts.source,
            language_version: &facts.language_version,
            movement_name: &facts.movement_name,
            event: &facts.event,
            fired_at: &facts.fired_at,
            catalog: &set.catalog,
            dry_run: facts.dry_run,
            entry,
            cost_cap_microdollars: self.project.cost_cap_microdollars,
        };
        let ran = run_segment(&host, input).await;
        self.remember_writes(run_id, &host.adapters.wrote.borrow());
        ran
    }

    /// The record writes a segment made, told to the loop guard for its
    /// movement's listens (crate::loop_guard), whether or not the segment
    /// then failed: the writes were made. Failing to tell it only means
    /// their echoes fire.
    fn remember_writes(&self, run_id: &str, wrote: &[Wrote]) {
        let (Some(guard), false) = (&self.loop_guard, wrote.is_empty()) else { return };
        let remembering = || -> Result<(), String> {
            let row = self.store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
            let writer = format!("listen:{}:{}", row.file, row.movement);
            wrote.iter().try_for_each(|one| guard.record_write(one, &writer))
        };
        if let Err(message) = remembering() {
            eprintln!("lf: telling the loop guard run {run_id}'s writes: {message} (their echoes will fire)");
        }
    }

    /// Whether `event` is only the echo of `writer`'s own write, as the loop
    /// guard says (crate::loop_guard). When the guard needs the record as it
    /// stands, it is read once per event and type, into `now_reads`. Any
    /// doubt (no guard, no readRecord, a failed read or answer) fires.
    async fn is_own_echo(&self, set: &FileSet, external: &str, event: &Js, writer: &str, now_reads: &RefCell<HashMap<String, Option<Js>>>) -> bool {
        let (Some(guard), Some(external_id)) = (&self.loop_guard, crate::loop_guard::event_record(event)) else { return false };
        let asked = Asked { adapter: external, external_id, writer, current: None };
        let record_type = match guard.is_echo(&asked) {
            Ok(Answer::Echo(echo)) => return echo,
            Ok(Answer::Read { record_type }) => record_type,
            Err(message) => return self.guard_failed(&message),
        };
        let read = now_reads.borrow().get(&record_type).cloned();
        let record = match read {
            Some(record) => record,
            None => {
                let record = self.read_record(set, external, &record_type, external_id).await;
                now_reads.borrow_mut().insert(record_type.clone(), record.clone());
                record
            }
        };
        let Some(record) = record else { return false };
        match guard.is_echo(&Asked { current: Some(Current { record_type: &record_type, record: &record }), ..asked }) {
            Ok(answer) => answer == Answer::Echo(true),
            Err(message) => self.guard_failed(&message),
        }
    }

    fn guard_failed(&self, message: &str) -> bool {
        eprintln!("lf: the loop guard: {message} (the event fires)");
        false
    }

    /// The record as it stands now, or None when it can not be read.
    async fn read_record(&self, set: &FileSet, external: &str, record_type: &str, external_id: &str) -> Option<Js> {
        let running = set.running.iter().find(|r| !r.is_plugin() && r.external.manifest.name == external)?;
        if !running.methods.iter().any(|m| m == "readRecord") {
            return None;
        }
        let params = serde_json::json!({ "recordType": record_type, "externalId": external_id });
        let read = match rpc(running, self.secrets().credentials(), LOCAL_TENANT, "readRecord", params).await {
            Ok(raw) => wire_results::check("readRecord", external, &raw),
            Err(message) => Err(message),
        };
        match read {
            Ok(record) => Some(record),
            Err(message) => {
                eprintln!("lf: {external}: reading {record_type} {external_id} to tell an echo of a write from a change: {message} (it fires)");
                None
            }
        }
    }

    /// Where a run stands once an entry into it is over, as its row says. A
    /// run still parked re-arms its timer row at its earliest parked timer.
    fn settled_outcome(&self, run_id: &str, entry: &'static str, tally: Tally, lease_lost: bool) -> Result<RunOutcome, String> {
        let row = self.store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
        let trace_entries = self.store.trace_len(run_id).map_err(|e| e.to_string())?;
        let mut outcome = RunOutcome {
            run_id: run_id.to_string(),
            file: row.file.clone(),
            movement: row.movement.clone(),
            entry,
            status: String::new(),
            writes: tally.writes,
            captured: None,
            trace_entries,
            error: None,
            returned: None,
        };
        if lease_lost {
            outcome.status = "leaseLost".into();
            return Ok(outcome);
        }
        match row.status.as_str() {
            "completed" => {
                outcome.status = "completed".into();
                outcome.returned = crate::returned::of_outcome(row.outcome.as_deref());
            }
            "failed" => {
                outcome.status = "failed".into();
                let error = row.outcome.as_deref().and_then(|o| Js::parse(o.as_bytes()).ok()).and_then(|o| o.get("error").and_then(Js::as_str).map(str::to_string));
                outcome.error = Some(error.unwrap_or_else(|| "failed".into()));
            }
            "parked" | "running" => {
                if let Some(wake_at) = next_timer_wake(&*self.store, run_id)? {
                    arm_timer_wake(&*self.store, run_id, &wake_at)?;
                }
                outcome.status = "parked".into();
            }
            other => return Err(format!("run {run_id} has status {other}")),
        }
        Ok(outcome)
    }

    /// Step a parked run's leaves through one of the core's drains, under the
    /// run's lease. Ok(None) when the run is not parked or none of its leaves
    /// was stepped; Err(busy) when another process holds it.
    async fn drive_parked_run(&self, set: &FileSet, run_id: &str, drain: Drain) -> Result<Parked, String> {
        if self.store.run(run_id).map_err(|e| e.to_string())?.is_none() {
            return Err(format!("no run {run_id}"));
        }
        let held = with_run_lease(&*self.store, run_id, async |lease: &Lease| -> Result<Option<(Tally, bool, Option<Vec<Js>>)>, String> {
            let Some(stepper) = self.parked_stepper(set, run_id, lease)? else { return Ok(None) };
            let lease_lost = match &drain {
                Drain::EveryParkedLeaf => {
                    let parked = self.store.leaves(run_id, true, None, None).map_err(|e| e.to_string())?;
                    // Resuming a run paused at its cost cap resets its usage,
                    // as the platform's explicit resume does (limit_resume.ts).
                    if parked.iter().any(|l| l.reason == "limit") {
                        self.store.reset_spend_baseline(run_id).map_err(|e| e.to_string())?;
                    }
                    let leaves: Vec<String> = parked.into_iter().map(|l| l.address).collect();
                    drain_run(&*self.store, run_id, &leaves, None, lease, &stepper).await?
                }
                Drain::DueTimers => drain_due_timers(&*self.store, run_id, &self.due_by(), lease, &stepper).await?,
                Drain::Awaits(extra) => drain_awaits(&*self.store, run_id, extra, lease, &stepper).await?,
            };
            Ok(Some((*stepper.tally.borrow(), lease_lost, stepper.rehearsed())))
        })
        .await?;
        let Some(held) = held else { return Ok(Parked::Busy) };
        let Some((tally, lease_lost, captured)) = held? else { return Ok(Parked::NotStepped) };
        if tally.stepped == 0 {
            return Ok(Parked::NotStepped);
        }
        let mut outcome = self.settled_outcome(run_id, "resumed", tally, lease_lost)?;
        outcome.captured = captured;
        Ok(Parked::Stepped(Box::new(outcome)))
    }

    /// A parked run's step for the core's drains, under the lease. None when
    /// the run is not parked.
    fn parked_stepper<'a>(&'a self, set: &'a FileSet, run_id: &str, lease: &'a Lease) -> Result<Option<LeafStepper<'a>>, String> {
        let Some(row) = self.store.run(run_id).map_err(|e| e.to_string())? else { return Ok(None) };
        if row.status != "parked" {
            return Ok(None);
        }
        let facts = RunFacts::of_row(run_id, &row.input)?;
        Ok(Some(LeafStepper { session: self, set, run_id: run_id.to_string(), facts, lease, tally: RefCell::new(Tally::default()), captured: RefCell::new(Vec::new()) }))
    }

    /// `lf resume <run>`: every parked leaf of the run, now.
    pub async fn resume_run(&self, run_id: &str) -> Result<RunOutcome, String> {
        let row = self.store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
        if row.status != "parked" {
            return Err(format!("run {run_id} is {}, not parked", row.status));
        }
        match self.drive_parked_run(&self.file_set(), run_id, Drain::EveryParkedLeaf).await? {
            Parked::Busy => Err(run_busy(run_id)),
            Parked::NotStepped => Err(format!("run {run_id} is parked but has no parked leaf")),
            Parked::Stepped(outcome) => Ok(*outcome),
        }
    }

    /// `lf resume` with no run: drain the due work, then step what is due in
    /// every parked run: its timers that have come, and its awaits that can
    /// resolve now. A timer not yet due stays parked, so a timeout arm
    /// beside an approval never fires early; `lf resume <run>` runs a run's
    /// every leaf out.
    pub async fn resume_all(&self, log: &mut impl Write) -> Result<Vec<RunOutcome>, String> {
        let set = self.file_set();
        let (_, mut outcomes) = self.drain_work_in(&set, WORK_ROWS_PER_DRAIN, log).await?;
        for run_id in self.parked_runs()? {
            for drain in [Drain::DueTimers, Drain::Awaits(Vec::new())] {
                match self.drive_parked_run(&set, &run_id, drain).await? {
                    Parked::Busy => return Err(run_busy(&run_id)),
                    Parked::NotStepped => {}
                    Parked::Stepped(outcome) => outcomes.push(*outcome),
                }
            }
        }
        Ok(outcomes)
    }

    /// The runs parked now, most recent first.
    pub fn parked_runs(&self) -> Result<Vec<String>, String> {
        Ok(self.store.runs(1000).map_err(|e| e.to_string())?.into_iter().filter(|r| r.status == "parked").map(|r| r.id).collect())
    }

    /// Drain the work queue once: up to `limit` due rows are leased, done,
    /// and completed (or released for a retry when their run is held
    /// elsewhere or they failed). How many rows were claimed, and what the
    /// runs they stepped came to.
    pub async fn drain_work(&self, limit: i64, log: &mut impl Write) -> Result<(usize, Vec<RunOutcome>), String> {
        self.drain_work_in(&self.file_set(), limit, log).await
    }

    async fn drain_work_in(&self, set: &FileSet, limit: i64, log: &mut impl Write) -> Result<(usize, Vec<RunOutcome>), String> {
        let mut outcomes = if self.pool.fires_cron() { self.fire_due_ticks(set, log).await? } else { Vec::new() };
        if self.pool.takes(POLL_WORK_KIND) {
            self.arm_polls(set)?;
        }
        let due_by = self.due_by();
        let claim = ClaimDue { limit, lease_ms: WORK_LEASE_MS, due_by: Some(&due_by), kinds: self.pool.work_kinds() };
        self.sweep_lost_runs(log).await?;
        let due = self.store.claim_due(&claim).map_err(|e| e.to_string())?;
        let claimed_rows = due.len();
        for claimed in due {
            let failed = if past_cap(&claimed) {
                give_up_work(&*self.store, &claimed, "its last attempts never finished (each worker stopped, or outran its lease)").await?
            } else {
                match self.do_work(set, &claimed.kind, &claimed.payload).await {
                    Ok((next, done)) => {
                        outcomes.extend(done);
                        let again = match next {
                            Next::Done => None,
                            Next::Busy => Some((iso(BUSY_RETRY_MS), Release::Busy)),
                            Next::DueAt(at) => Some((at, Release::Rescheduled)),
                        };
                        match &again {
                            None => self.store.complete(&claimed.id, &claimed.claim),
                            Some((at, why)) => self.store.release_work(&claimed.id, &claimed.claim, Some(at), *why),
                        }
                        .map_err(|e| e.to_string())?;
                        if let Some((at, _)) = &again {
                            crate::wake::queued(&claimed.kind, Some(at));
                        }
                        continue;
                    }
                    Err(message) => {
                        let _ = writeln!(log, "work {} failed (attempt {}): {message}", claimed.key, claimed.attempts);
                        work_failed(&*self.store, &claimed, &message).await?
                    }
                }
            };
            if let FailedWork::GaveUp { reason, runs } = failed {
                for run_id in runs {
                    let _ = writeln!(log, "run {run_id} failed: {reason}");
                }
                let _ = writeln!(log, "work {} is dead: {reason}", claimed.key);
            }
        }
        Ok((claimed_rows, outcomes))
    }

    /// The lost-run sweep (crate::run_host::fail_lost_runs) and the delivery
    /// retention sweep, at most once per LOST_RUN_SWEEP_EVERY.
    async fn sweep_lost_runs(&self, log: &mut impl Write) -> Result<(), String> {
        if self.swept_at.get().is_some_and(|at| at.elapsed() < LOST_RUN_SWEEP_EVERY) {
            return Ok(());
        }
        self.swept_at.set(Some(std::time::Instant::now()));
        for run_id in fail_lost_runs(&*self.store, WORK_ROWS_PER_DRAIN).await? {
            let _ = writeln!(log, "run {run_id} failed: {WORKER_LOST}");
        }
        let retain_ms = i64::from(self.project.delivery_retain_days) * 86_400_000;
        self.store.sweep_deliveries(&iso(-retain_ms), WORK_ROWS_PER_DRAIN).map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn do_work(&self, set: &FileSet, kind: &str, payload: &Js) -> Result<(Next, Vec<RunOutcome>), String> {
        let text = |k: &str| payload.get(k).and_then(Js::as_str).map(str::to_string).ok_or_else(|| format!("a {kind} row has no {k}"));
        match kind {
            "fire_event" => {
                let event = payload.get("event").cloned().ok_or("a fire_event row has no event")?;
                let external = text("external")?;
                // Rows queued before deliveries were kept name none, and
                // rows queued before they named their connection name none.
                let delivery_id = payload.get("deliveryId").and_then(Js::as_str);
                let delivered = Delivered::of_row(payload, delivery_id);
                let scope_keys = scope_keys_of(set, &external);
                let fired = self.fire_to(set, &external, &event, Arrival::Pushed, false, delivery_id, |l| delivered.reaches(l, &scope_keys)).await?;
                for line in &fired.redelivered {
                    eprintln!("lf: {line}");
                }
                if let Some(id) = delivery_id
                    && fired.outcomes.is_empty()
                    && fired.redelivered.is_empty()
                {
                    eprintln!("lf: {}", no_listen_line(id, &external));
                }
                Ok((Next::Done, fired.outcomes))
            }
            "resume_timer" => {
                let run_id = text("runId")?;
                if self.store.run(&run_id).map_err(|e| e.to_string())?.is_none() {
                    return Ok((Next::Done, Vec::new()));
                }
                Ok(match self.drive_parked_run(set, &run_id, Drain::DueTimers).await? {
                    Parked::Busy => (Next::Busy, Vec::new()),
                    Parked::NotStepped => (Next::Done, Vec::new()),
                    Parked::Stepped(outcome) => (Next::Done, vec![*outcome]),
                })
            }
            "wake_await" => {
                let adapter_type = text("adapterType")?;
                let team = payload.get("teamId").and_then(Js::as_str).unwrap_or(self.store.tenant()).to_string();
                let key = text("correlationKey")?;
                let parks = self.store.correlated(&adapter_type, &team, &key).map_err(|e| e.to_string())?;
                let mut by_run: IndexMap<String, Vec<String>> = IndexMap::new();
                for park in parks {
                    by_run.entry(park.run_id).or_default().push(park.address);
                }
                let (mut busy, mut outcomes) = (false, Vec::new());
                for (run_id, addresses) in by_run {
                    match self.drive_parked_run(set, &run_id, Drain::Awaits(addresses)).await? {
                        Parked::Busy => busy = true,
                        Parked::NotStepped => {}
                        Parked::Stepped(outcome) => outcomes.push(*outcome),
                    }
                }
                Ok((if busy { Next::Busy } else { Next::Done }, outcomes))
            }
            "fire_callback" => {
                let index = payload.get("callIndex").and_then(|n| if let Js::Num(n) = n { n.as_u64() } else { None });
                let index = index.ok_or("a fire_callback row has no callIndex")? as usize;
                Ok(match self.run_recorded_body(set, &text("callbackId")?, index).await? {
                    BodyRun::Ran(outcomes) => (Next::Done, outcomes),
                    BodyRun::Busy => (Next::Busy, Vec::new()),
                    BodyRun::Refused => (Next::Done, Vec::new()),
                })
            }
            POLL_WORK_KIND => self.poll_row(set, &text("subscription")?).await,
            crate::subscriptions::REFRESH_WORK_KIND => Ok((
                match crate::subscriptions::refresh_row(self, payload).await? {
                    Some(at) => Next::DueAt(at),
                    None => Next::Done,
                },
                Vec::new(),
            )),
            other => Err(format!("not a work kind: {other}")),
        }
    }
}

/// What becomes of a work row once it is done.
enum Next {
    /// Deleted (unless something re-armed it meanwhile).
    Done,
    /// Its run was held elsewhere: tried again shortly.
    Busy,
    /// Kept, due again then (a polled listen's next poll).
    DueAt(String),
}

/// Which of a parked run's leaves a drain steps.
enum Drain {
    EveryParkedLeaf,
    DueTimers,
    /// The awaits resolvable now: those a woken key names, and those whose
    /// callback has a landed call.
    Awaits(Vec<String>),
}

/// `drainAwaits`: step every currently resolvable await leaf of one run under
/// the caller's lease, the callback-backed ones (`callbackAwaitKeeper`) and
/// the `extra` ones the caller already knows are resolvable, each once.
async fn drain_awaits(store: &dyn RunHostStore, run_id: &str, extra: &[String], lease: &Lease, stepper: &impl Stepper) -> Result<bool, String> {
    let mut addresses = resolvable_awaits(store, run_id).map_err(|e| e.to_string())?;
    for address in extra {
        if !addresses.contains(address) {
            addresses.push(address.clone());
        }
    }
    if addresses.is_empty() {
        return Ok(false);
    }
    drain_run(store, run_id, &addresses, None, lease, stepper).await
}

enum Parked {
    Busy,
    NotStepped,
    Stepped(Box<RunOutcome>),
}

fn run_busy(run_id: &str) -> String {
    format!("run {run_id} is being stepped by another lf process right now; try again in a moment")
}

/// A parked run's leaves, stepped one segment each (`parkedStepper`).
struct LeafStepper<'a> {
    session: &'a Session,
    set: &'a FileSet,
    run_id: String,
    facts: RunFacts,
    lease: &'a Lease,
    tally: RefCell<Tally>,
    /// A rehearsal's writes, captured by the leaves it stepped.
    captured: RefCell<Vec<Js>>,
}

impl LeafStepper<'_> {
    /// What the stepped leaves of a rehearsal captured; None for a real run.
    fn rehearsed(&self) -> Option<Vec<Js>> {
        self.facts.dry_run.then(|| self.captured.take())
    }
}

impl Stepper for LeafStepper<'_> {
    async fn step(&self, request: StepRequest) -> StepOutcome {
        let completing = request.completing_address().to_string();
        let entry = match request {
            StepRequest::Leaf { state, reenter, .. } => Entry::Resume { state, reenter },
            StepRequest::Race { frame_address, state } => Entry::Settle { state, frame_address },
        };
        let recorded = self
            .session
            .record_segment(self.set, &self.run_id, &self.facts, Some(&self.lease.token), &self.tally, self.facts.dry_run.then_some(&self.captured), entry, Some(&completing))
            .await;
        recorded.unwrap_or_else(StepOutcome::Failed)
    }
}

// ── Refreshing the files ────────────────────────────────────────────────────

/// What a refresh's header says before it lists why nothing was taken.
const KEPT: &str = "movements: kept the files lf has;";

/// How a listing differs from the files held, each by path, in the listing's
/// order: the files whose version is the one held, those to read (a new
/// path, a moved version, or no version said), and the held paths not listed.
#[derive(Debug, PartialEq)]
struct Changes {
    unchanged: Vec<String>,
    to_read: Vec<String>,
    removed: Vec<String>,
}

fn path_of(file: &MovementFile) -> String {
    format!("{}{MOVEMENT_EXTENSION}", file.name)
}

fn listing_changes(held: &[MovementFile], listed: &[Listed]) -> Changes {
    let held_at = |path: &str| held.iter().find(|f| path_of(f) == path);
    let (unchanged, to_read) = listed.iter().partition::<Vec<&Listed>, _>(|l| l.version.is_some() && held_at(&l.path).is_some_and(|f| f.version == l.version));
    let removed = held.iter().map(path_of).filter(|path| !listed.iter().any(|l| &l.path == path)).collect();
    let paths = |listed: Vec<&Listed>| listed.into_iter().map(|l| l.path.clone()).collect();
    Changes { unchanged: paths(unchanged), to_read: paths(to_read), removed }
}

/// Each file's error diagnostics against `catalog`, in the files' order.
/// Each file's error diagnostics against `catalog`, in the files' order:
/// every file checked, whichever changed, since imports link across files.
/// `parsed` is each file's reading, so a file is not parsed again for it.
fn error_diagnostics(files: &[MovementFile], parsed: &[Rc<Parsed>], catalog: &Js) -> Result<Vec<Vec<crate::check::FileDiagnostic>>, String> {
    use movement_parser::catalog::types::CatalogSnapshot;
    let catalog = CatalogSnapshot::load(&movement_parser::util::form::read_json_text(&catalog.to_json())).map_err(|e| format!("the catalog does not load: {e}"))?;
    files.iter().zip(parsed).map(|(file, parsed)| Ok(check_parsed(file, &parsed.program, &catalog)?.into_iter().filter(|d| d.severity == "error").collect())).collect()
}

/// Each file's count of check errors against the set's own catalog, by name.
fn file_errors(set: &FileSet) -> Result<BTreeMap<String, usize>, String> {
    let diagnostics = error_diagnostics(&set.files, &set.parsed, &set.catalog)?;
    Ok(set.files.iter().zip(diagnostics).map(|(file, errors)| (file.name.clone(), errors.len())).collect())
}

/// How long a watch asks the movements module to hold: the contract's cap.
const WATCH_WAIT: Duration = crate::movements_slot::WATCH_WAIT_CAP;
/// An answer with nothing in it, back sooner than this, is a module that
/// answered at once rather than held: the loop pauses before it asks again.
const ANSWERED_AT_ONCE: Duration = Duration::from_secs(1);

/// The listing the events say there is now: each one applied, in order, to
/// the files (path, version) lf last saw listed. An add or a change without
/// a version is a file listed without one, which is read and compared.
fn apply_events(held: &[Listed], events: &[Change]) -> Vec<Listed> {
    let mut listing = held.to_vec();
    for change in events {
        match change.kind {
            ChangeKind::Added | ChangeKind::Changed => match listing.iter_mut().find(|l| l.path == change.path) {
                Some(listed) => listed.version = change.version.clone(),
                None => listing.push(Listed { path: change.path.clone(), version: change.version.clone() }),
            },
            ChangeKind::Removed => listing.retain(|l| l.path != change.path),
        }
    }
    ordered(listing)
}

impl Session {
    /// `lf serve` and `lf drain`'s one refresher, for the process's life:
    /// the module's cursor taken, then the files listed once (so nothing
    /// changed between the open and the cursor is missed), then each change
    /// it reports taken as a listing is (`take_listing`). A `resync` starts
    /// over from the cursor; a failure is said once and asked again after
    /// the pause.
    pub async fn watch_movements(&self, log: &mut impl Write) -> std::convert::Infallible {
        let env: Vec<(String, String)> = std::env::vars().collect();
        let store = loop {
            match crate::movements_slot::of_project(&self.project, &env) {
                Ok(store) => break store,
                Err(message) => {
                    self.watch_failure(log, &message);
                    tokio::time::sleep(self.watch_pause).await;
                }
            }
        };
        let mut cursor = None;
        loop {
            if let Some(pause) = self.watch_once(&*store, &mut cursor, log).await {
                tokio::time::sleep(pause).await;
            }
        }
    }

    /// One step of the watch loop: the pause it owes before the next.
    pub(crate) async fn watch_once(&self, store: &dyn MovementsStore, cursor: &mut Option<String>, log: &mut impl Write) -> Option<Duration> {
        let Some(from) = cursor.clone() else {
            match store.watch(None, Duration::ZERO).await {
                Ok(Watched::Events { cursor: now, .. }) => {
                    match self.refresh_movements_now(store, log).await {
                        Ok(true) => {}
                        Ok(false) => return Some(self.watch_pause),
                        Err(message) => {
                            let _ = writeln!(log, "movements: {message}");
                        }
                    }
                    *cursor = Some(now);
                    return None;
                }
                Ok(Watched::Resync) => self.watch_failure(log, "it answered resync to a watch without a cursor"),
                Err(message) => self.watch_failure(log, &message),
            }
            return Some(self.watch_pause);
        };
        let asked = Instant::now();
        match store.watch(Some(&from), WATCH_WAIT).await {
            Ok(Watched::Events { cursor: next, events }) => {
                self.watch_failed.replace(None);
                *cursor = Some(next);
                if events.is_empty() {
                    return (asked.elapsed() < ANSWERED_AT_ONCE).then_some(self.watch_pause);
                }
                let seen: Vec<Listed> = match &*self.refused.borrow() {
                    Some(pairs) => pairs.iter().map(|(path, version)| Listed { path: path.clone(), version: Some(version.clone()).filter(|v| !v.is_empty()) }).collect(),
                    None => self.file_set().files.iter().map(|f| Listed { path: path_of(f), version: f.version.clone() }).collect(),
                };
                if let Err(message) = self.take_listing(apply_events(&seen, &events), store, log).await {
                    let _ = writeln!(log, "movements: {message}");
                }
                None
            }
            Ok(Watched::Resync) => {
                self.watch_failed.replace(None);
                *cursor = None;
                None
            }
            Err(message) => {
                self.watch_failure(log, &message);
                Some(self.watch_pause)
            }
        }
    }

    /// Why the watch loop got nothing from the module.
    fn watch_failure(&self, log: &mut impl Write, message: &str) {
        self.say_once(log, format!("{KEPT} the movements module did not answer watch: {message}"));
    }

    /// A failure line, said once until the module answers again.
    fn say_once(&self, log: &mut impl Write, line: String) {
        if self.watch_failed.borrow().as_deref() != Some(line.as_str()) {
            let _ = writeln!(log, "{line}");
        }
        self.watch_failed.replace(Some(line));
    }

    /// One `list`, and a `read` only for a file whose listed version
    /// moved: false when the module did not list (said once).
    pub(crate) async fn refresh_movements_now(&self, store: &dyn MovementsStore, log: &mut impl Write) -> Result<bool, String> {
        match store.list() {
            Ok(listed) => {
                self.watch_failed.replace(None);
                self.take_listing(ordered(listed), store, log).await.map(|()| true)
            }
            Err(message) => {
                self.say_once(log, format!("{KEPT} the movements module did not answer: {message}"));
                Ok(false)
            }
        }
    }

    /// A listing taken: a `read` only for a file whose listed version moved.
    /// A changed set is taken whole or not at all: imports link across
    /// files, so a partly taken set may be one that never existed together.
    /// One that does not check (a file has more errors than it had) keeps
    /// the running set, said once; work begun before a swap finishes on the
    /// files it began with.
    async fn take_listing(&self, listed: Vec<Listed>, store: &dyn MovementsStore, log: &mut impl Write) -> Result<(), String> {
        let set = self.file_set();
        let changes = listing_changes(&set.files, &listed);
        if changes.to_read.is_empty() && changes.removed.is_empty() {
            self.refused.replace(None);
            return Ok(());
        }
        let listed_pairs: Option<Vec<(String, String)>> = listed.iter().map(|l| Some((l.path.clone(), l.version.clone()?))).collect();
        if listed_pairs.is_some() && *self.refused.borrow() == listed_pairs {
            return Ok(());
        }

        let mut read = HashMap::new();
        for path in &changes.to_read {
            read.insert(path.clone(), store.read(path)?);
        }
        let held = |path: &str| set.files.iter().find(|f| path_of(f) == path);
        let (mut files, mut changed, mut pairs) = (Vec::new(), Vec::new(), Vec::new());
        for listed in &listed {
            let file = match read.remove(&listed.path) {
                None => held(&listed.path).expect("an unchanged file is held").clone(),
                // Gone between the list and the read.
                Some(None) => continue,
                Some(Some(text)) => match held(&listed.path) {
                    Some(kept) if kept.source == text.text => kept.clone(),
                    kept => {
                        changed.push(format!("movements: {} {}", listed.path, if kept.is_some() { "changed" } else { "added" }));
                        movement_file(&self.project.movements_dir, &listed.path, text)
                    }
                },
            };
            pairs.push((listed.path.clone(), listed.version.clone().or_else(|| file.version.clone()).unwrap_or_default()));
            files.push(file);
        }
        for gone in set.files.iter().filter(|f| !files.iter().any(|kept| kept.name == f.name)) {
            changed.push(format!("movements: {} removed", path_of(gone)));
        }
        if changed.is_empty() {
            self.refused.replace(None);
            return Ok(());
        }
        if self.refused.borrow().as_ref() == Some(&pairs) {
            return Ok(());
        }

        let parsed = Parsed::each(&files, &set.parsed);
        let secrets = self.secrets();
        let missing = missing_credentials(&parsed, &secrets);
        if !missing.is_empty() {
            return self.refuse(log, pairs, missing.iter().map(missing_line).collect());
        }
        let credentials = secrets.credentials();
        let registered = |e: &External| crate::subscriptions::has_registered_webhook(credentials, &e.manifest.name);
        let needed = needed_externals(scan_externals(&self.project)?, &parsed, registered);
        let is_needed = |name: &str| needed.iter().any(|e| e.manifest.name == name);
        let new_externals: Vec<&External> = needed.iter().filter(|e| !set.running.iter().any(|r| r.external.manifest.name == e.manifest.name)).collect();
        // An external no file imports now leaves the set; its process stops
        // once no set holds it (the runs begun on this one end).
        let (mut running, mut schemas): (Vec<Rc<RunningExternal>>, IndexMap<String, ConnectionSchemas>) = (
            set.running.iter().filter(|r| is_needed(&r.external.manifest.name)).cloned().collect(),
            set.schemas.iter().filter(|(name, _)| is_needed(name)).map(|(name, schema)| (name.clone(), schema.clone())).collect(),
        );
        let dropped = set.running.iter().filter(|r| !is_needed(&r.external.manifest.name)).map(|r| format!("movements: dropped {}, which no file imports now", r.external.manifest.name));
        let imported = imported_credentials(&parsed);
        // A connection the files newly make, of a module already running, is
        // described now; the ones described before are kept.
        for r in running.iter().filter(|r| !r.is_plugin()) {
            let name = &r.external.manifest.name;
            let known = schemas.shift_remove(name).unwrap_or_default();
            match describe_external(r, credentials, &imported, known).await {
                Ok(described) => {
                    schemas.insert(name.clone(), described);
                }
                Err(message) => {
                    self.refused.replace(Some(pairs));
                    let _ = writeln!(log, "{KEPT} {name}, which they import, did not describe: {message}");
                    return Ok(());
                }
            }
        }
        let mut started = Vec::new();
        // What this refresh starts is held until the set takes it: a set
        // not taken lets go of it, and so stops it.
        let mut starting = Vec::new();
        for external in new_externals {
            let name = &external.manifest.name;
            match self.start_external(external, &imported).await {
                Ok((one, schema)) => {
                    starting.extend(hold_all(std::slice::from_ref(&one), Keep::Idle));
                    running.push(one);
                    schemas.extend(schema.map(|s| (name.clone(), s)));
                    started.push(format!("movements: started {name}"));
                }
                Err(message) => {
                    self.refused.replace(Some(pairs));
                    let _ = writeln!(log, "{KEPT} {name}, which they import, did not start: {message}");
                    return Ok(());
                }
            }
        }

        let catalog = catalog_of(&running, &schemas, credentials, &files);
        let baseline = match set.errors.get() {
            Some(counts) => counts.clone(),
            None => {
                let counts = file_errors(&set)?;
                let _ = set.errors.set(counts.clone());
                counts
            }
        };
        let (mut counts, mut rose) = (BTreeMap::new(), Vec::new());
        for (file, errors) in files.iter().zip(error_diagnostics(&files, &parsed, &catalog)?) {
            if errors.len() > baseline.get(&file.name).copied().unwrap_or(0) {
                rose.extend(errors.iter().map(|d| format!("{}:{}:{} {} {} {}", file.path.display(), d.line, d.column, d.severity, d.code, d.message)));
            }
            counts.insert(file.name.clone(), errors.len());
        }
        if !rose.is_empty() {
            return self.refuse(log, pairs, rose);
        }

        let mut listens = crate::routing::listens_across(&parsed);
        crate::listen_narrowing::resolve_listen_addresses(&mut listens, &running, credentials).await;
        let _holds = hold_all(&running, self.role.keep());
        let taken = Rc::new(FileSet { files, parsed, catalog, listens, running, schemas, errors: OnceCell::from(counts), _holds });
        self.file_set.replace(taken.clone());
        self.refused.replace(None);
        drop(starting);
        for line in changed.into_iter().chain(dropped).chain(started) {
            let _ = writeln!(log, "{line}");
        }
        // A cron listen that returns is then seen for the first time, and owes nothing.
        let crons = |s: &FileSet| s.listens.iter().filter_map(|l| cron_subscription(&l.file, l)).collect::<BTreeSet<_>>();
        for left in crons(&set).difference(&crons(&taken)) {
            self.store.save_inbound_checkpoint(left, &Js::Null).map_err(|e| e.to_string())?;
        }
        if self.role.registers_webhooks() {
            for line in crate::subscriptions::follow_refresh(self, &set, &taken).await {
                let _ = writeln!(log, "{line}");
            }
        }
        Ok(())
    }

    /// One external a refreshed set newly imports, started and described.
    async fn start_external(&self, external: &External, imported: &crate::secrets::Imported) -> Result<(Rc<RunningExternal>, Option<ConnectionSchemas>), String> {
        let secrets = self.secrets();
        let credentials = secrets.credentials();
        let one = start_externals(&self.project, std::slice::from_ref(external), credentials, LOCAL_TENANT).await?.into_iter().next().ok_or("it did not answer its manifest")?;
        let schema = match one.is_plugin() {
            true => None,
            false => Some(describe_external(&one, credentials, imported, ConnectionSchemas::new()).await?),
        };
        Ok((Rc::new(one), schema))
    }

    /// A set not taken: why, said once, after the header.
    fn refuse(&self, log: &mut impl Write, pairs: Vec<(String, String)>, why: Vec<String>) -> Result<(), String> {
        self.refused.replace(Some(pairs));
        let _ = writeln!(log, "{KEPT} the new ones do not check:");
        for line in why {
            let _ = writeln!(log, "{line}");
        }
        Ok(())
    }
}

// ── Callbacks ───────────────────────────────────────────────────────────────

/// How long after a call its durable rows (its body's, its awaiters' wake)
/// come due. Its body runs at once when the run is free; the rows matter only
/// if this process dies first, so they wait well past a normal body.
const CALLBACK_BACKSTOP_MS: i64 = 30_000;

/// What calling a callback came to (`CallOutcome`).
pub struct Called {
    pub call: CallOutcome,
    /// The body waits on its work row, due now, for whichever lf process
    /// drains next: the run was being stepped elsewhere, or the door only
    /// records (`lf serve --doors-only`).
    pub queued: bool,
    pub outcomes: Vec<RunOutcome>,
}

/// Whether a recorded call's body ran (`RecordedBodyRun`). `Busy`: another
/// process holds the run, or the lease went before the body began, so the
/// body is left to its work row.
enum BodyRun {
    Ran(Vec<RunOutcome>),
    Busy,
    Refused,
}

/// What a body segment came to (`CallbackBodyOutcome`): a failed body fails
/// its segment, never the run.
enum BodyOutcome {
    /// With a rehearsal's captured writes.
    Ran(Option<Vec<Js>>),
    Failed(String),
    Cancelled(Option<String>),
    LeaseLost,
}

/// What `runCallbackBody` came to under the lease.
enum UnderLease {
    /// `stepped`: the awaits the call woke, and a rehearsal's writes they captured.
    Ran { outcome: BodyOutcome, body: Tally, stepped: Option<(Tally, Option<Vec<Js>>)> },
    NotStarted,
    /// Its callback is gone or closed, the call is not there or already
    /// started, or its run has ended.
    Refused,
}

impl Session {
    /// Call a callback (`callCallback`): validate and record the call (its
    /// body queued with it), then run the body now under the run's lease and
    /// wake whatever awaits the callback. The door (`POST /api/cb/<id>`) and
    /// `lf call` both come here.
    pub async fn call_callback(&self, id: &str, values: &Obj) -> Result<Called, String> {
        let backstop = iso(CALLBACK_BACKSTOP_MS);
        let call = record_callback_call(&*self.store, id, values, &backstop, &backstop).map_err(|e| e.to_string())?;
        let CallOutcome::Recorded { callback, call_index } = &call else { return Ok(Called { call, queued: false, outcomes: Vec::new() }) };
        let (callback_id, team_id, call_index) = (callback.id.clone(), callback.team_id.clone(), *call_index);
        match self.run_recorded_body(&self.file_set(), &callback_id, call_index).await? {
            BodyRun::Ran(outcomes) => Ok(Called { call, queued: false, outcomes }),
            BodyRun::Refused => Ok(Called { call, queued: false, outcomes: Vec::new() }),
            BodyRun::Busy => {
                // Held elsewhere: its row, due now, runs it once the run is free.
                queue_body(&*self.store, &callback_id, &team_id, call_index, &iso(0)).map_err(|e| e.to_string())?;
                Ok(Called { call, queued: true, outcomes: Vec::new() })
            }
        }
    }

    /// Call a callback without running its body (the door under `lf serve
    /// --doors-only`, on compute frozen once it answers): the call recorded
    /// with its body's row due now, and the wake slot told, so a worker runs
    /// the body and wakes the callback's awaits.
    pub fn queue_callback(&self, id: &str, values: &Obj) -> Result<Called, String> {
        let call = record_callback_call(&*self.store, id, values, &iso(0), &iso(CALLBACK_BACKSTOP_MS)).map_err(|e| e.to_string())?;
        let queued = matches!(call, CallOutcome::Recorded { .. });
        Ok(Called { call, queued, outcomes: Vec::new() })
    }

    /// Run one recorded call's body under its run's lease, then the awaits
    /// it resolves (`runRecordedBody`).
    async fn run_recorded_body(&self, set: &FileSet, callback_id: &str, call_index: usize) -> Result<BodyRun, String> {
        let store_error = |e: crate::store::StoreError| e.to_string();
        let Some(callback) = self.store.callback(callback_id).map_err(store_error)? else { return Ok(BodyRun::Refused) };
        let Some(row) = self.store.run(&callback.run_id).map_err(store_error)? else { return Ok(BodyRun::Refused) };
        let run_id = row.id.clone();
        let held = with_run_lease(&*self.store, &run_id, async |lease: &Lease| self.callback_body_under(set, &row, callback_id, call_index, lease).await).await?;
        let Some(under) = held else { return Ok(BodyRun::Busy) };
        let (outcome, body, stepped) = match under? {
            UnderLease::NotStarted => return Ok(BodyRun::Busy),
            UnderLease::Refused => return Ok(BodyRun::Refused),
            UnderLease::Ran { outcome, body, stepped } => (outcome, body, stepped),
        };
        // One call is one entry into its run: the body and the awaits it
        // woke are reported together, their writes summed.
        let (woke, woke_captured) = stepped.filter(|(t, _)| t.stepped > 0).unwrap_or_default();
        let tally = Tally { writes: body.writes + woke.writes, stepped: body.stepped + woke.stepped };
        let mut called = self.settled_outcome(&run_id, "called", tally, matches!(outcome, BodyOutcome::LeaseLost))?;
        match outcome {
            BodyOutcome::Failed(error) => called.error = Some(format!("the callback's body failed: {error}")),
            BodyOutcome::Ran(captured) => called.captured = captured.map(|body| body.into_iter().chain(woke_captured.into_iter().flatten()).collect()),
            BodyOutcome::Cancelled(_) | BodyOutcome::LeaseLost => {}
        }
        Ok(BodyRun::Ran(vec![called]))
    }

    /// `runCallbackBody`: everything that decides whether the body runs is
    /// read again here, under the lease; the body is marked started before it
    /// runs (at most once after start, a crash included), and the run's
    /// awaits on the callback are woken last, so what the body wrote is
    /// there for the continuation that reads it.
    async fn callback_body_under(&self, set: &FileSet, row: &crate::store::RunRow, callback_id: &str, call_index: usize, lease: &Lease) -> Result<UnderLease, String> {
        let store_error = |e: crate::store::StoreError| e.to_string();
        let fence = Some(lease.token.as_str());
        let Some(callback) = self.store.callback(callback_id).map_err(store_error)? else { return Ok(UnderLease::Refused) };
        let Some(call) = crate::callbacks::ledger(&callback).map_err(store_error)?.into_iter().nth(call_index) else { return Ok(UnderLease::Refused) };
        if refusal(&callback, CallFor::RecordedCall, &iso(0)).is_some() {
            return Ok(UnderLease::Refused);
        }
        if call.body_started_at.is_some() {
            return Ok(UnderLease::Refused);
        }
        let open = self.store.run(&callback.run_id).map_err(store_error)?.is_some_and(|r| r.status == "parked" || r.status == "running");
        if !open {
            return Ok(UnderLease::Refused);
        }
        if lease.is_lost() || !self.store.mark_callback_body_started(callback_id, call_index as i64, fence).map_err(store_error)? {
            return Ok(UnderLease::NotStarted);
        }
        let mut body = Tally::default();
        let outcome = self.callback_body_segment(set, row, &callback.state, &call.values, call_index, lease, &mut body).await?;
        match &outcome {
            BodyOutcome::LeaseLost => return Ok(UnderLease::Ran { outcome, body, stepped: None }),
            BodyOutcome::Cancelled(reason) => {
                fail_run(&*self.store, &callback.run_id, reason.as_deref().unwrap_or(CANCELLED_BY_OPERATOR), fence)?;
                return Ok(UnderLease::Ran { outcome, body, stepped: None });
            }
            BodyOutcome::Ran(_) | BodyOutcome::Failed(_) => {}
        }
        let parks: Vec<String> = self
            .store
            .correlated(CALLBACK_AWAIT_TYPE, &callback.team_id, &callback.id)
            .map_err(store_error)?
            .into_iter()
            .filter(|p| p.run_id == callback.run_id)
            .map(|p| p.address)
            .collect();
        if parks.is_empty() {
            return Ok(UnderLease::Ran { outcome, body, stepped: None });
        }
        let Some(stepper) = self.parked_stepper(set, &callback.run_id, lease)? else { return Ok(UnderLease::Ran { outcome, body, stepped: None }) };
        drain_awaits(&*self.store, &callback.run_id, &parks, lease, &stepper).await?;
        let stepped = *stepper.tally.borrow();
        Ok(UnderLease::Ran { outcome, body, stepped: Some((stepped, stepper.rehearsed())) })
    }

    /// A callback's body (`callbackBodySegment`): one engine segment entered
    /// at the callback, with the call's values.
    #[allow(clippy::too_many_arguments)] // the file set it runs within, then the body's own inputs
    async fn callback_body_segment(&self, set: &FileSet, row: &crate::store::RunRow, state: &Js, values: &Obj, call_index: usize, lease: &Lease, tally: &mut Tally) -> Result<BodyOutcome, String> {
        if !matches!(state.get("version"), Some(Js::Num(_))) {
            return Ok(BodyOutcome::Failed("the callback holds no state to run its body from".into()));
        }
        let facts = RunFacts::of_row(&row.id, &row.input)?;
        tally.stepped += 1;
        let entry = Entry::Fire { state: state.clone(), values: values.clone(), call_index };
        Ok(match self.segment(set, &row.id, &facts, Some(&lease.token), entry).await {
            Err(Ended::LeaseLost) => BodyOutcome::LeaseLost,
            Err(Ended::Failed(message)) => BodyOutcome::Failed(message),
            Ok(ran) => {
                tally.writes += ran.writes;
                if ran.cancelled {
                    BodyOutcome::Cancelled(self.store.cancel_request(&row.id).map_err(|e| e.to_string())?.flatten())
                } else {
                    BodyOutcome::Ran(facts.dry_run.then_some(ran.captured))
                }
            }
        })
    }
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/// What `lf cancel` came to (`CancelOutcome`).
pub enum Cancelled {
    /// The run was not being stepped: it is settled failed now.
    Now,
    /// Another lf process is stepping it: its segment stops at the next
    /// statement boundary, and the run settles failed there.
    Requested,
}

/// `lf cancel <run>` (`cancelRun`): stamp the operator's request on the run's
/// row, then settle it through the core's cancel path (failed with the
/// reason, its live state torn down, its callbacks revoked) when no one
/// holds it. Settling starts no segment, so it needs no session.
pub async fn cancel_run(store: &dyn RunHostStore, run_id: &str, reason: Option<&str>) -> Result<Cancelled, String> {
    let row = store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    if row.status != "running" && row.status != "parked" {
        return Err(format!("run {run_id} is {}; there is nothing to cancel", row.status));
    }
    store.request_cancel(run_id, reason).map_err(|e| e.to_string())?;
    let held = with_run_lease(store, run_id, async |lease: &Lease| settle_if_cancel_requested(store, run_id, Some(&lease.token))).await?;
    match held {
        None => Ok(Cancelled::Requested),
        Some(settled) => settled.map(|_| Cancelled::Now),
    }
}

/// `report`: each outcome's line, its error and a dry run's writes; the exit
/// code 1 when any failed.
pub fn report(outcomes: &[RunOutcome], returned: Returned, out: &mut impl Write) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    if outcomes.is_empty() {
        writeln!(out, "no listen matched").map_err(io)?;
    }
    for o in outcomes {
        let entries = if o.trace_entries == 1 { "entry" } else { "entries" };
        let error = o.error.as_ref().map(|e| format!("\n  {e}")).unwrap_or_default();
        let verb = if o.entry == "called" { "called" } else { "run" };
        writeln!(out, "{verb} {} {}:{} {} — {} write(s), {} trace {entries}{error}", o.run_id, o.file, o.movement, o.status, o.writes, o.trace_entries).map_err(io)?;
        if let (Returned::Shown, Some(value)) = (returned, &o.returned) {
            writeln!(out, "  {}", crate::returned::shown(value)).map_err(io)?;
        }
        for w in o.captured.iter().flatten() {
            writeln!(out, "  dry run, not written: {}", w.to_json()).map_err(io)?;
        }
    }
    Ok(if outcomes.iter().any(|o| o.status == "failed") { 1 } else { 0 })
}

/// An event file: which external it came from, and the event (`EventFile`).
pub fn read_event_file(path: &std::path::Path) -> Result<(String, Js), String> {
    let text = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let file = Js::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let external = file.get("external").and_then(Js::as_str).filter(|s| !s.is_empty()).ok_or_else(|| format!("{}: external: expected a non-empty string", path.display()))?;
    let event = match file.get("event") {
        // `payload` first, as the schema parses it, then the rest in order.
        Some(Js::Obj(map)) => {
            let mut ordered: Obj = obj! { "payload" => map.get("payload").cloned().unwrap_or(Js::Null) };
            for (k, v) in map {
                if k != "payload" {
                    ordered.insert(k.clone(), v.clone());
                }
            }
            if !map.contains_key("payload") {
                ordered.shift_remove("payload");
            }
            Js::Obj(ordered)
        }
        _ => return Err(format!("{}: event: expected an object", path.display())),
    };
    Ok((external.to_string(), event))
}

/// What a drain says of a delivery's event that no listen takes: the
/// delivery is kept (`lf deliveries` lists it) and ran nothing.
fn no_listen_line(delivery_id: &str, external: &str) -> String {
    format!("delivery {delivery_id}: no listen takes its {external} event; it is kept and ran nothing")
}

/// A poll event with no `eventType` (a module older than adapter protocol
/// 2.3) still reaches the listen that polled it; lf says so once per module
/// per process, so an unlabelled source is never silent.
fn note_unlabelled_poll_event(module: &str) {
    static NOTED: std::sync::LazyLock<std::sync::Mutex<std::collections::BTreeSet<String>>> = std::sync::LazyLock::new(Default::default);
    let first = NOTED.lock().map(|mut noted| noted.insert(module.to_string())).unwrap_or(false);
    if first {
        eprintln!("{module}: a polled event carries no eventType; it was delivered to the listen that polled it — label poll events (adapter protocol 2.3)");
    }
}

/// `poll`'s params (adapter protocol 2): the listen's options, the checkpoint
/// the previous poll left, and `movementId`. Locally the listener is the
/// listen's pipeline, `listen:<file>:<movement>`: a movement's name alone
/// would not tell it from a same-named movement in another file.
fn poll_params(listen: &Listen, state: Option<&Js>) -> serde_json::Value {
    let mut params = serde_json::json!({ "config": crate::wire::json_of_js(&Js::Obj(listen.config.clone())), "movementId": listen.pipeline() });
    if let Some(checkpoint) = state.and_then(|s| s.get("checkpoint")) {
        params["checkpoint"] = crate::wire::json_of_js(checkpoint);
    }
    params
}

#[cfg(test)]
mod tests {
    fn facts_with(pin: &str) -> String {
        format!(r#"{{"source":"s","languageVersion":{pin},"movementName":"m","firedAt":"t"}}"#)
    }

    #[test]
    fn a_stored_pin_resumes_by_its_standing_and_an_old_integer_is_read_once() {
        let version = |pin: &str| RunFacts::of_row("r", &facts_with(pin)).map(|f| f.language_version);
        assert_eq!(version(&format!("\"{LANGUAGE_VERSION}\"")), Ok(LANGUAGE_VERSION.to_string()));
        assert_eq!(version("5"), Ok(LANGUAGE_VERSION.to_string()));
        assert!(version("\"0.13.0\"").unwrap_err().contains("newer than this lf"));
        assert!(version("\"0.11.0\"").unwrap_err().contains("upgrade its movement and fire it again"));
        assert!(version("4").unwrap_err().contains("upgrade its movement and fire it again"));
    }

    use super::*;

    #[test]
    fn a_run_from_a_queued_delivery_names_it() {
        let root = std::env::temp_dir().join(format!("lf-runs-delivery-{}", uuid::Uuid::new_v4()));
        crate::init::run(&root, &mut Vec::new()).unwrap();
        // The project's own (empty) secrets, never the home directory's.
        let secrets = root.join(".lf/secrets.yaml");
        std::fs::write(&secrets, "{}\n").unwrap();
        std::fs::set_permissions(&secrets, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async {
            let project = crate::project::load_project(&root).unwrap();
            let session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role: Role::Command }).await.unwrap();
            let event = crate::units::manual_event(&iso(0), &session.user, None);
            let row = |delivery_id: Option<&str>| {
                let mut payload = obj! { "external" => Js::str(crate::units::MANUAL), "event" => event.clone() };
                if let Some(id) = delivery_id {
                    payload.insert("deliveryId".into(), Js::str(id));
                }
                Js::Obj(payload)
            };
            let delivery_of = |outcomes: &[RunOutcome]| {
                assert_eq!(outcomes.len(), 1, "the starter movement's manual listen takes it");
                session.store.run(&outcomes[0].run_id).unwrap().unwrap().delivery_id
            };
            let set = session.file_set();
            let (_, outcomes) = session.do_work(&set, "fire_event", &row(Some("d-1"))).await.unwrap();
            assert_eq!(delivery_of(&outcomes).as_deref(), Some("d-1"));
            let (_, outcomes) = session.do_work(&set, "fire_event", &row(None)).await.unwrap();
            assert_eq!(delivery_of(&outcomes), None, "a row queued before deliveries were kept names none");
        });
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_delivery_no_listen_takes_is_said_to_run_nothing() {
        assert_eq!(no_listen_line("d-1", "acme"), "delivery d-1: no listen takes its acme event; it is kept and ran nothing");
    }

    fn polled(config: Obj) -> Listen {
        Listen { file: "alerts".into(), adapter: "system".into(), config, movement_name: "alerts".into(), credential: None, args: Vec::new(), payload: None, address: Ok(Default::default()) }
    }

    #[test]
    fn a_poll_request_names_the_listening_pipeline_and_carries_the_checkpoint() {
        let listen = polled(obj! { "every" => Js::str("5m") });
        let first = poll_params(&listen, None);
        assert_eq!(first["movementId"], "listen:alerts:alerts");
        assert_eq!(first["config"]["every"], "5m");
        assert!(first.get("checkpoint").is_none());
        let state = Js::Obj(obj! { "armed" => Js::Bool(true), "checkpoint" => Js::str("c1") });
        assert_eq!(poll_params(&listen, Some(&state))["checkpoint"], "c1");
    }

    fn identity(configured: (Option<&str>, Option<&str>), env: &[(&str, &str)]) -> (String, String) {
        let configured = (configured.0.map(str::to_string), configured.1.map(str::to_string));
        let user = local_identity(&configured, |k| env.iter().find(|(name, _)| *name == k).map(|(_, v)| v.to_string()));
        let text = |value: Option<&Js>| value.and_then(Js::as_str).unwrap_or_default().to_string();
        (text(user.get("principal").and_then(|p| p.get("id"))), text(user.get("email")))
    }

    #[test]
    fn the_acting_user_is_the_environments_then_lf_yamls_then_the_os_users() {
        let os = [("USER", "ada")];
        assert_eq!(identity((None, None), &os), ("local:ada".into(), "ada@localhost".into()));
        assert_eq!(identity((Some("grace"), Some("grace@acme.test")), &os), ("local:grace".into(), "grace@acme.test".into()));
        let overridden = [("USER", "ada"), ("LF_USER", "linus"), ("LF_USER_EMAIL", "linus@acme.test")];
        assert_eq!(identity((Some("grace"), Some("grace@acme.test")), &overridden), ("local:linus".into(), "linus@acme.test".into()));
        // Each part on its own: a name override keeps lf.yaml's email.
        assert_eq!(identity((Some("grace"), Some("grace@acme.test")), &[("LF_USER", "linus")]), ("local:linus".into(), "grace@acme.test".into()));
        assert_eq!(identity((None, None), &[("USERNAME", "win")]), ("local:win".into(), "win@localhost".into()));
        assert_eq!(identity((None, None), &[]), ("local:lf".into(), "lf@localhost".into()));
    }

    // ── A long-running session's refresh ────────────────────────────────────

    fn held(name: &str, version: &str) -> MovementFile {
        MovementFile { name: name.into(), path: format!("/m/{name}.mvt").into(), source: String::new(), version: Some(version.into()) }
    }

    fn listed(path: &str, version: Option<&str>) -> crate::movements_slot::Listed {
        crate::movements_slot::Listed { path: path.into(), version: version.map(str::to_string) }
    }

    #[test]
    fn the_refresh_reads_only_what_the_listing_changed() {
        let files = [held("a", "1"), held("lib/b", "2"), held("c", "3")];
        let same = listing_changes(&files, &[listed("a.mvt", Some("1")), listed("lib/b.mvt", Some("2")), listed("c.mvt", Some("3"))]);
        assert_eq!((same.unchanged, same.to_read, same.removed), (vec!["a.mvt".into(), "lib/b.mvt".into(), "c.mvt".into()], vec![], vec![]));
        let moved = listing_changes(&files, &[listed("a.mvt", Some("1")), listed("lib/b.mvt", Some("9")), listed("c.mvt", Some("3"))]);
        assert_eq!((moved.unchanged, moved.to_read), (vec!["a.mvt".to_string(), "c.mvt".into()], vec!["lib/b.mvt".to_string()]));
        let unsaid = listing_changes(&files, &[listed("a.mvt", None), listed("lib/b.mvt", Some("2")), listed("c.mvt", Some("3"))]);
        assert_eq!(unsaid.to_read, vec!["a.mvt".to_string()], "a file listed with no version is read every time");
        let gone = listing_changes(&files, &[listed("a.mvt", Some("1")), listed("d.mvt", Some("4"))]);
        assert_eq!((gone.unchanged, gone.to_read, gone.removed), (vec!["a.mvt".to_string()], vec!["d.mvt".to_string()], vec!["lib/b.mvt".to_string(), "c.mvt".into()]));
        let order = listing_changes(&files, &[listed("z.mvt", Some("5")), listed("c.mvt", Some("3")), listed("y.mvt", None), listed("a.mvt", Some("1"))]);
        assert_eq!((order.unchanged, order.to_read), (vec!["c.mvt".to_string(), "a.mvt".into()], vec!["z.mvt".to_string(), "y.mvt".into()]), "the listing's order");
    }

    #[test]
    fn the_refresh_interval_is_a_whole_number_of_milliseconds() {
        let ms = std::time::Duration::from_millis;
        assert_eq!(watch_pause_of(None), Ok(ms(DEFAULT_MOVEMENTS_REFRESH_MS)));
        assert_eq!(watch_pause_of(Some("")), Ok(ms(DEFAULT_MOVEMENTS_REFRESH_MS)));
        assert_eq!(watch_pause_of(Some("0")), Ok(ms(100)), "never less than 100 ms");
        assert_eq!(watch_pause_of(Some(" 250 ")), Ok(ms(250)));
        for raw in ["-1", "1.5", "5s", "soon"] {
            assert_eq!(watch_pause_of(Some(raw)), Err(format!("LF_MOVEMENTS_REFRESH_MS is \"{raw}\": it must be a whole number of milliseconds")));
        }
    }

    #[test]
    fn apply_events_moves_the_listing() {
        let seen = [listed("a.mvt", Some("1")), listed("lib/b.mvt", Some("2")), listed("c.mvt", Some("3"))];
        let event = |kind, path: &str, version: Option<&str>| Change { kind, path: path.into(), version: version.map(str::to_string) };
        let events = [
            event(ChangeKind::Changed, "a.mvt", Some("9")),
            event(ChangeKind::Removed, "c.mvt", None),
            event(ChangeKind::Added, "a/d.mvt", Some("4")),
            event(ChangeKind::Added, "e.mvt", None),
            event(ChangeKind::Removed, "e.mvt", None),
            event(ChangeKind::Changed, "lib/b.mvt", None),
        ];
        assert_eq!(
            apply_events(&seen, &events),
            [listed("a/d.mvt", Some("4")), listed("a.mvt", Some("9")), listed("lib/b.mvt", None)],
            "in order, the later event winning; a change without a version is a file to read; the walk's order"
        );
        assert_eq!(apply_events(&seen, &[]), ordered(seen.to_vec()));
    }

    /// A movements module that answers each watch from a script (the
    /// folder's own watch once the script is spent) and counts its lists.
    struct Scripted {
        folder: crate::movements_slot::FolderMovements,
        answers: RefCell<std::collections::VecDeque<Result<Watched, String>>>,
        lists: Cell<usize>,
    }

    impl Scripted {
        fn over(root: &std::path::Path, answers: Vec<Result<Watched, String>>) -> Scripted {
            Scripted { folder: crate::movements_slot::FolderMovements::at(&root.join("movements")), answers: RefCell::new(answers.into()), lists: Cell::new(0) }
        }
    }

    impl MovementsStore for Scripted {
        fn list(&self) -> Result<Vec<Listed>, String> {
            self.lists.set(self.lists.get() + 1);
            self.folder.list()
        }
        fn read(&self, path: &str) -> Result<Option<crate::movements_slot::Text>, String> {
            self.folder.read(path)
        }
        fn write(&self, path: &str, text: &str, expected: Option<&str>) -> Result<crate::movements_slot::Written, crate::movements_slot::WriteError> {
            self.folder.write(path, text, expected)
        }
        fn watch<'a>(&'a self, cursor: Option<&'a str>, wait: Duration) -> crate::secrets_family::LocalFuture<'a, Result<Watched, String>> {
            match self.answers.borrow_mut().pop_front() {
                Some(answer) => Box::pin(async move { answer }),
                None => self.folder.watch(cursor, wait),
            }
        }
    }

    fn events(cursor: &str, events: Vec<Change>) -> Result<Watched, String> {
        Ok(Watched::Events { cursor: cursor.into(), events })
    }

    async fn step(session: &Session, store: &dyn MovementsStore, cursor: &mut Option<String>) -> (Option<Duration>, String) {
        let mut log = Vec::new();
        let pause = session.watch_once(store, cursor, &mut log).await;
        (pause, String::from_utf8(log).unwrap())
    }

    #[test]
    fn an_event_swaps_the_set() {
        let root = refresh_project(&[("hello.mvt", MANUAL_V1)]);
        with_session(&root.clone(), async |session| {
            let store = crate::movements_slot::FolderMovements::at(&root.join("movements"));
            let mut cursor = None;
            assert_eq!(step(session, &store, &mut cursor).await, (None, String::new()), "the cursor taken, then one list: nothing changed since the open");
            assert!(cursor.is_some());
            let v2 = MANUAL_V1.replace("v1", "v2");
            put(&root, "hello.mvt", &v2);
            let asked = std::time::Instant::now();
            let (pause, log) = step(session, &store, &mut cursor).await;
            assert_eq!((pause, log.as_str()), (None, "movements: hello.mvt changed\n"), "an event is taken, with no pause after it");
            assert!(asked.elapsed() < Duration::from_secs(3), "the edit is seen at once: {:?}", asked.elapsed());
            assert_eq!(returns(session, "hello").await, "v2");
        });
    }

    #[test]
    fn a_resync_lists_once() {
        let root = refresh_project(&[("hello.mvt", MANUAL_V1)]);
        with_session(&root.clone(), async |session| {
            let v2 = MANUAL_V1.replace("v1", "v2");
            let store = Scripted::over(&root, vec![events("e:0", vec![]), Ok(Watched::Resync), events("e2:0", vec![])]);
            let mut cursor = None;
            assert_eq!(step(session, &store, &mut cursor).await, (None, String::new()));
            assert_eq!((store.lists.get(), cursor.as_deref()), (1, Some("e:0")), "the cursor first, then one list");
            put(&root, "hello.mvt", &v2);
            assert_eq!(step(session, &store, &mut cursor).await, (None, String::new()), "resync: no pause, nothing said");
            assert_eq!((store.lists.get(), cursor.as_deref()), (1, None), "listed on the next step, from a new cursor");
            assert_eq!(step(session, &store, &mut cursor).await, (None, "movements: hello.mvt changed\n".to_string()), "the list sees what the events missed");
            assert_eq!((store.lists.get(), cursor.as_deref()), (2, Some("e2:0")));
            assert_eq!(returns(session, "hello").await, "v2");
        });
    }

    #[test]
    fn a_failing_watch_is_reported_once_and_retried() {
        let root = refresh_project(&[("hello.mvt", MANUAL_V1)]);
        with_session(&root.clone(), async |session| {
            let down = || Err("the movements module acme: movements.watch: could not be reached".to_string());
            let at_once = events("e:1", vec![]);
            let store = Scripted::over(&root, vec![events("e:0", vec![]), down(), down(), at_once, down()]);
            let mut cursor = None;
            step(session, &store, &mut cursor).await;
            let said = "movements: kept the files lf has; the movements module did not answer watch: the movements module acme: movements.watch: could not be reached\n";
            let pause = Some(session.watch_pause);
            assert_eq!(step(session, &store, &mut cursor).await, (pause, said.to_string()));
            assert_eq!(step(session, &store, &mut cursor).await, (pause, String::new()), "said once");
            assert_eq!(cursor.as_deref(), Some("e:0"), "retried with the same cursor");
            assert_eq!(step(session, &store, &mut cursor).await, (pause, String::new()), "an empty answer at once: the pause");
            assert_eq!(cursor.as_deref(), Some("e:1"));
            assert_eq!(step(session, &store, &mut cursor).await, (pause, said.to_string()), "said again after an answer");
            let malformed = Scripted::over(&root, vec![Err(crate::movements_slot::watched_of("the movements module acme", &Js::parse(br#"{"secret":"text"}"#).unwrap()).unwrap_err())]);
            let (_, log) = step(session, &malformed, &mut cursor).await;
            assert_eq!(log, "movements: kept the files lf has; the movements module did not answer watch: the movements module acme: movements.watch answered an object with secret, not the slot's shape\n", "named by its shape");
        });
    }

    // ── Module processes ────────────────────────────────────────────────────

    /// A project whose movements each import one of `names`: each an
    /// lf-acme copy (examples/lf-acme) that waits `start_delay` seconds
    /// before it starts, as a slow module does.
    fn acme_project(names: &[&str], start_delay: &str) -> std::path::PathBuf {
        let root = refresh_project(&[]);
        let server = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/lf-acme/externals/acme_crm/server.mjs")).unwrap();
        let mut secrets = String::new();
        for name in names {
            let dir = root.join("externals").join(name);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("server.mjs"), server.replace("'acme_crm'", &format!("'{name}'"))).unwrap();
            let manifest = format!(
                "name: {name}\nkind: adapter\nprotocol: 2\ncommand: [sh, -c, \"sleep {start_delay}; exec node server.mjs\"]\nauth: {{ kind: bearer, field: token }}\nenv:\n  ACME_CRM_STATE: \"{{lf}}/state.json\"\n"
            );
            std::fs::write(dir.join("lf-external.yaml"), manifest).unwrap();
            secrets.push_str(&format!("{name}:\n  external: {name}\n  token: dev-token\n"));
            put(&root, &format!("{name}.mvt"), &acme_movement(name));
        }
        std::fs::write(root.join(".lf/secrets.yaml"), secrets).unwrap();
        root
    }

    fn acme_movement(name: &str) -> String {
        format!("import {{ {name} }} from adapters\nimport {{ {name} as cred }} from credentials\n\ncrm = connect {name} using cred\n\nfunction welcome(company: <crm-[:Company]->>) {{\n  write crm-[:Company]-> {{ Name: \"Welcome ${{company.Name}}\" }}\n}}\n\nlisten to crm {{ events: [\"company.created\"] }} fire welcome\n")
    }

    /// `body` on a session over `root` opened as `role`.
    fn with_session_as(root: &std::path::Path, role: Role, body: impl AsyncFnOnce(&mut Session)) {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async {
            let project = crate::project::load_project(root).unwrap();
            let mut session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role }).await.unwrap();
            body(&mut session).await;
        });
        std::fs::remove_dir_all(root).ok();
    }

    fn processes(set: &FileSet) -> Vec<(String, crate::module_hosts::ModuleProcess)> {
        set.running
            .iter()
            .filter_map(|r| match &r.reach {
                Reach::Process(process) => Some((r.external.manifest.name.clone(), process.clone())),
                Reach::Url(_) => None,
            })
            .collect()
    }

    #[test]
    fn a_drain_starts_its_modules_together_and_keeps_them_up() {
        let root = acme_project(&["acme_a", "acme_b", "acme_c"], "1");
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async {
            let project = crate::project::load_project(&root).unwrap();
            let opened = Instant::now();
            let session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role: Role::Drain }).await.unwrap();
            let took = opened.elapsed();
            // One after another, three one-second starts take three seconds and more.
            assert!(took < Duration::from_millis(2500), "the three modules started together, in {took:?}");
            let started = processes(&session.file_set());
            assert_eq!(started.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["acme_a", "acme_b", "acme_c"]);
            for (name, process) in &started {
                assert!(process.is_running() && process.is_kept_up(), "{name} is up and kept up for the drain's life");
            }
            drop(session);
            for (name, process) in &started {
                assert!(!process.is_kept_up(), "{name} is let go with the drain");
            }
        });
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_command_leaves_its_modules_to_stop_when_idle() {
        let root = acme_project(&["acme_d"], "0");
        with_session_as(&root.clone(), Role::Command, async |session| {
            for (name, process) in processes(&session.file_set()) {
                assert!(process.is_running() && !process.is_kept_up(), "{name} is up, and stops when idle");
            }
        });
    }

    #[test]
    fn an_external_no_file_imports_stops_after_the_swap_and_starts_again_when_imported() {
        let root = acme_project(&["acme_e"], "0");
        with_session_as(&root.clone(), Role::Drain, async |session| {
            let [(_, process)] = &processes(&session.file_set())[..] else { panic!("acme_e runs") };
            let process = process.clone();
            remove(&root, "acme_e.mvt");
            assert_eq!(refreshed(session).await, "movements: acme_e.mvt removed\nmovements: dropped acme_e, which no file imports now\n");
            assert!(session.file_set().running.is_empty(), "the set has no externals");
            assert!(!process.is_running(), "its process stopped once no set held it");

            put(&root, "acme_e.mvt", &acme_movement("acme_e"));
            assert_eq!(refreshed(session).await, "movements: acme_e.mvt added\nmovements: started acme_e\n");
            assert!(process.is_running() && process.is_kept_up(), "imported again, it runs, kept up by the drain's new set");
        });
    }

    #[test]
    fn a_run_on_the_previous_set_keeps_its_external_until_it_lets_the_set_go() {
        let root = acme_project(&["acme_f"], "0");
        with_session_as(&root.clone(), Role::Command, async |session| {
            let begun = session.file_set();
            let [(_, process)] = &processes(&begun)[..] else { panic!("acme_f runs") };
            let process = process.clone();
            remove(&root, "acme_f.mvt");
            assert_eq!(refreshed(session).await, "movements: acme_f.mvt removed\nmovements: dropped acme_f, which no file imports now\n");
            assert!(process.is_running(), "a run still holds the set it began on");
            drop(begun);
            assert!(!process.is_running(), "the last holder let it go: stopped");
        });
    }

    #[test]
    fn an_external_a_refused_set_started_is_stopped_with_it() {
        let root = acme_project(&["acme_g"], "0");
        let server = std::fs::read_to_string(root.join("externals/acme_g/server.mjs")).unwrap();
        // A second module only a broken file imports.
        let dir = root.join("externals/acme_h");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("server.mjs"), server.replace("'acme_g'", "'acme_h'")).unwrap();
        std::fs::write(dir.join("lf-external.yaml"), std::fs::read_to_string(root.join("externals/acme_g/lf-external.yaml")).unwrap().replace("acme_g", "acme_h")).unwrap();
        let secrets = std::fs::read_to_string(root.join(".lf/secrets.yaml")).unwrap();
        std::fs::write(root.join(".lf/secrets.yaml"), format!("{secrets}acme_h:\n  external: acme_h\n  token: dev-token\n")).unwrap();
        with_session_as(&root.clone(), Role::Command, async |session| {
            put(&root, "acme_h.mvt", &acme_movement("acme_h").replace("company.Name", "company.Nope"));
            let log = refreshed(session).await;
            assert!(log.starts_with("movements: kept the files lf has; the new ones do not check:\n"), "{log}");
            assert!(!crate::module_hosts::external_is_running("acme_h"), "the module only the refused set imported was stopped with it");
            assert!(crate::module_hosts::external_is_running("acme_g"), "the running set's module runs on");
        });
    }

    /// A synthetic movement of some forty lines, its manual listen firing `name`.
    fn synthetic_movement(name: &str, salt: &str) -> String {
        let mut text = String::from("import { greet } from \"lib/greet\"\n\n");
        for helper in 0..6 {
            text.push_str(&format!(
                "function {name}_step{helper}(word: <text>) {{\n  greeting = greet(\"${{word}} {salt} {helper}\")\n  if (greeting == \"\") {{\n    fail(\"nothing to say\")\n  }}\n  return greeting\n}}\n\n"
            ));
        }
        text.push_str(&format!("function {name}(run: <manual-[:Invocation]->>) {{\n  return {name}_step0(\"{name}\")\n}}\n\nlisten to manual fire {name}\n"));
        text
    }

    /// The refresh's and a run's cost over a 200-file set: run with
    /// `cargo test --release -p listen-fire --bin lf -- --ignored --nocapture measure_a_large_set`.
    #[test]
    #[ignore]
    fn measure_a_large_set() {
        const FILES: usize = 200;
        let mut files: Vec<(String, String)> = (0..FILES).map(|i| (format!("m{i:03}.mvt"), synthetic_movement(&format!("m{i:03}"), "v1"))).collect();
        files.push(("lib/greet.mvt".into(), "export function greet(name: <text>) {\n  return \"Hello, ${name}!\"\n}\n".into()));
        let borrowed: Vec<(&str, &str)> = files.iter().map(|(p, t)| (p.as_str(), t.as_str())).collect();
        let root = refresh_project(&borrowed);
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async {
            let project = crate::project::load_project(&root).unwrap();
            let opened = Instant::now();
            let session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role: Role::Command }).await.unwrap();
            eprintln!("open: {:?}", opened.elapsed());
            // Warm: the first refresh counts each file's errors.
            put(&root, "m000.mvt", &synthetic_movement("m000", "warm"));
            assert_eq!(refreshed(&session).await, "movements: m000.mvt changed\n");
            let mut took = Vec::new();
            for round in 0..5 {
                put(&root, "m001.mvt", &synthetic_movement("m001", &format!("v{round}")));
                let started = Instant::now();
                assert_eq!(refreshed(&session).await, "movements: m001.mvt changed\n");
                took.push(started.elapsed());
            }
            eprintln!("refresh, one file of {FILES} changed: {took:?}");
            let source = synthetic_movement("m002", "v1");
            let parse_each = || {
                let parses = Instant::now();
                for _ in 0..100 {
                    movement_engine::program::parse(&source).unwrap();
                }
                parses.elapsed() / 100
            };
            movement_engine::program::keep_parses(0);
            eprintln!("the engine's parse of one file: {:?}", parse_each());
            movement_engine::program::keep_parses(KEPT_PARSES);
            eprintln!("the engine's parse of one file, kept: {:?}", parse_each());
            let mut runs = Vec::new();
            for _ in 0..5 {
                let started = Instant::now();
                assert_eq!(returns(&session, "m002").await, "Hello, m002 v1 0!");
                runs.push(started.elapsed());
            }
            eprintln!("a run of m002: {runs:?}");
        });
        std::fs::remove_dir_all(root).ok();
    }

    const MANUAL_V1: &str = "function hello(run: <manual-[:Invocation]->>) {\n  return \"v1\"\n}\nlisten to manual fire hello\n";

    /// A started project (`lf init`, its own empty secrets) with `files`
    /// written into its movements folder.
    fn refresh_project(files: &[(&str, &str)]) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("lf-runs-refresh-{}", uuid::Uuid::new_v4()));
        crate::init::run(&root, &mut Vec::new()).unwrap();
        let secrets = root.join(".lf/secrets.yaml");
        std::fs::write(&secrets, "{}\n").unwrap();
        std::fs::set_permissions(&secrets, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        for (path, text) in files {
            put(&root, path, text);
        }
        root
    }

    fn put(root: &std::path::Path, path: &str, text: &str) {
        let at = root.join("movements").join(path);
        std::fs::create_dir_all(at.parent().unwrap()).unwrap();
        std::fs::write(at, text).unwrap();
    }

    fn remove(root: &std::path::Path, path: &str) {
        std::fs::remove_file(root.join("movements").join(path)).unwrap();
    }

    /// `body` on a session over `root`, as lf serve runs one: one thread, one LocalSet.
    fn with_session(root: &std::path::Path, body: impl AsyncFnOnce(&mut Session)) {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async {
            let project = crate::project::load_project(root).unwrap();
            let mut session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role: Role::Command }).await.unwrap();
            body(&mut session).await;
        });
        std::fs::remove_dir_all(root).ok();
    }

    async fn refreshed(session: &Session) -> String {
        let mut log = Vec::new();
        let env: Vec<(String, String)> = std::env::vars().collect();
        let store = crate::movements_slot::of_project(&session.project, &env).unwrap();
        session.refresh_movements_now(&*store, &mut log).await.unwrap();
        String::from_utf8(log).unwrap()
    }

    /// What the one run `movement` started returned, its value as text.
    async fn returns(session: &Session, movement: &str) -> String {
        let fired = session.run_manual(movement, None, false).await.unwrap();
        assert_eq!(fired.outcomes.len(), 1, "one listen fires {movement}");
        let outcome = &fired.outcomes[0];
        assert_eq!(outcome.status, "completed", "{:?}", outcome.error);
        outcome.returned.as_ref().and_then(|r| r.get("value")).and_then(Js::as_str).unwrap_or_default().to_string()
    }

    #[test]
    fn a_changed_file_runs_its_new_text_after_a_refresh() {
        let root = refresh_project(&[("hello.mvt", MANUAL_V1)]);
        with_session(&root.clone(), async |session| {
            assert_eq!(returns(session, "hello").await, "v1");
            put(&root, "hello.mvt", &MANUAL_V1.replace("v1", "v2"));
            assert_eq!(refreshed(session).await, "movements: hello.mvt changed\n");
            assert_eq!(returns(session, "hello").await, "v2");
            assert_eq!(refreshed(session).await, "", "nothing changed since");
        });
    }

    #[test]
    fn a_refresh_reads_again_only_the_files_whose_text_changed_and_checks_them_all() {
        let root = refresh_project(&[("hello.mvt", MANUAL_V1), ("other.mvt", &MANUAL_V1.replace("hello", "other"))]);
        with_session(&root.clone(), async |session| {
            let before = session.file_set();
            put(&root, "hello.mvt", &MANUAL_V1.replace("v1", "v2"));
            assert_eq!(refreshed(session).await, "movements: hello.mvt changed\n");
            let after = session.file_set();
            assert!(!Rc::ptr_eq(&after.parsed[0], &before.parsed[0]), "the changed file is read again");
            assert!(Rc::ptr_eq(&after.parsed[1], &before.parsed[1]), "the unchanged one keeps its reading");
            assert_eq!(after.listens.iter().map(|l| (l.file.as_str(), l.movement_name.as_str())).collect::<Vec<_>>(), [("hello", "hello"), ("other", "other")]);
            assert_eq!(returns(session, "hello").await, "v2");
            // An unchanged file a change breaks is still checked, and refused.
            put(&root, "lib/greet.mvt", "export function greet(name: <text>) {\n  return name\n}\n");
            put(&root, "other.mvt", "import { greet } from \"lib/greet\"\n\nfunction other(run: <manual-[:Invocation]->>) {\n  return greet(\"o\")\n}\nlisten to manual fire other\n");
            assert_eq!(refreshed(session).await, "movements: lib/greet.mvt added\nmovements: other.mvt changed\n");
            put(&root, "lib/greet.mvt", "export function greet(name: <number>) {\n  return name\n}\n");
            let log = refreshed(session).await;
            assert!(log.starts_with("movements: kept the files lf has; the new ones do not check:\n") && log.contains("other.mvt:"), "{log}");
        });
    }

    #[test]
    fn a_new_files_manual_listen_runs_after_a_refresh() {
        let root = refresh_project(&[("hello.mvt", MANUAL_V1)]);
        with_session(&root.clone(), async |session| {
            assert!(session.run_manual("extra", None, false).await.is_err(), "no listen fires extra yet");
            put(&root, "extra.mvt", &MANUAL_V1.replace("hello", "extra").replace("v1", "extra"));
            assert_eq!(refreshed(session).await, "movements: extra.mvt added\n");
            assert_eq!(returns(session, "extra").await, "extra");
        });
    }

    #[test]
    fn a_removed_files_cron_stops_and_its_parked_run_still_resumes() {
        let tick = "function tock(t: <cron-[:Tick]->>) {\n  fail(\"tick ${t.`Fired at`} on ${t.`Schedule`}\")\n}\nlisten to cron { schedule: \"* * * * *\" } fire tock\n";
        let nap = "function nap(run: <manual-[:Invocation]->>) {\n  await sleep(1h)\n  return \"woke\"\n}\nlisten to manual fire nap\n";
        let root = refresh_project(&[("tick.mvt", tick), ("nap.mvt", nap)]);
        with_session(&root.clone(), async |session| {
            let subscription = "cron:tick:tock:* * * * *:UTC";
            session.drain_work(WORK_ROWS_PER_DRAIN, &mut Vec::new()).await.unwrap();
            assert!(session.store.inbound_checkpoint(subscription).unwrap().is_some(), "the first sighting saved now");
            let fired = session.run_manual("nap", None, false).await.unwrap();
            assert_eq!(fired.outcomes[0].status, "parked");
            let nap_run = fired.outcomes[0].run_id.clone();

            remove(&root, "tick.mvt");
            remove(&root, "nap.mvt");
            assert_eq!(refreshed(session).await, "movements: nap.mvt removed\nmovements: tick.mvt removed\n");
            assert_eq!(session.store.inbound_checkpoint(subscription).unwrap(), None, "a cron that left is forgotten");

            session.due_offset_ms = 2 * 3_600_000;
            let (_, outcomes) = session.drain_work(WORK_ROWS_PER_DRAIN, &mut Vec::new()).await.unwrap();
            let woke = outcomes.iter().find(|o| o.run_id == nap_run).expect("the parked run resumed");
            assert_eq!(woke.status, "completed", "{:?}", woke.error);
            assert_eq!(woke.returned.as_ref().and_then(|r| r.get("value")).and_then(Js::as_str), Some("woke"));
            let runs = session.store.runs(1000).unwrap();
            assert!(!runs.iter().any(|r| r.file == "tick"), "the removed cron fired nothing");
        });
    }

    #[test]
    fn a_broken_edit_keeps_the_previous_text_running_and_warns_once() {
        let root = refresh_project(&[("hello.mvt", MANUAL_V1)]);
        with_session(&root.clone(), async |session| {
            put(&root, "hello.mvt", "function hello(");
            let log = refreshed(session).await;
            let lines: Vec<&str> = log.lines().collect();
            assert_eq!(lines[0], "movements: kept the files lf has; the new ones do not check:", "{log}");
            assert!(lines[1].contains("hello.mvt:") && lines[1].contains(" error MOV_PARSE "), "{log}");
            assert_eq!(returns(session, "hello").await, "v1", "the previous text runs");
            assert_eq!(refreshed(session).await, "", "warned once");

            put(&root, "hello.mvt", &MANUAL_V1.replace("v1", "v3"));
            assert_eq!(refreshed(session).await, "movements: hello.mvt changed\n");
            assert_eq!(returns(session, "hello").await, "v3");

            put(&root, "lib/greet.mvt", "export function greet(name: <text>) {\n  return \"Hello, ${name}!\"\n}\n");
            put(&root, "hello.mvt", "import { greet } from \"lib/greet\"\n\nfunction hello(run: <manual-[:Invocation]->>) {\n  return greet(\"v4\")\n}\nlisten to manual fire hello\n");
            assert_eq!(refreshed(session).await, "movements: hello.mvt changed\nmovements: lib/greet.mvt added\n");
            assert_eq!(returns(session, "hello").await, "Hello, v4!");

            put(&root, "lib/greet.mvt", "export function greet(name: <number>) {\n  return \"Hello, ${name}!\"\n}\n");
            let log = refreshed(session).await;
            assert!(log.starts_with("movements: kept the files lf has; the new ones do not check:\n"), "{log}");
            assert!(log.lines().skip(1).all(|l| l.contains("hello.mvt:")), "the importer it breaks is named: {log}");
            assert_eq!(returns(session, "hello").await, "Hello, v4!", "the set that checked runs on");
        });
    }
}

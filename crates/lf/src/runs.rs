//! A session — one project opened for running: its secrets, externals,
//! catalog, files and listens — and the entry points the run commands share:
//! an event routed to the listens it matches and run, a parked run resumed,
//! the work queue drained and a run cancelled, and the
//! line each run is reported by (`report`).

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Write;
use std::rc::Rc;
use std::time::{Duration, Instant};

use indexmap::IndexMap;

use crate::catalog::{ConnectionSchemas, catalog_of};
use crate::check::{LOCAL_TENANT, check_parsed, describe_external, missing_line};
use crate::documents::Documents;
use crate::externals::{External, Reach, RunningExternal, needed_externals, rpc_in, scan_externals, start_externals};
use crate::module_hosts::{Hold, Keep, ModuleProcess};
use movement_engine::executor::join_all;
use crate::json::{Js, Obj};
use crate::obj;
use crate::project::Project;
use movement_parser::version::{LANGUAGE_VERSION, Standing, standing};
use crate::remote::{Externals, SegmentAdapters};
use crate::arrivals::{ArrivalIn, arrival_receipt_key};
use crate::routing::{Listen, arrival_trigger_of};
use movement_engine::listen_judge::Verdict;
use crate::run_host::{
    BUSY_RETRY_MS, CANCELLED_BY_OPERATOR, FailedWork, Lease, Settled, StepOutcome, StepRequest, Stepper, WORKER_LOST, after_step, arm_timer_wake,
    clear_if_quiescent, drain_due_timers, drain_run, fail_lost_runs, give_up_work, next_timer_wake, past_cap, run_complete_without, run_quiescent,
    settle_if_cancel_requested, with_run_lease, work_failed,
};
use crate::secrets::{Secrets, credential_for, imported_credentials, missing_credentials};
use crate::segment::{Ended, Entry, Ran, SegmentHost, SegmentHostParts, SegmentInput, commit, run_segment};
use crate::movements_slot::{Change, ChangeKind, Listed, MovementsStore, Watched, movement_file, ordered};
use crate::sources::{MOVEMENT_EXTENSION, MovementFile, Parsed, scan_movements};
use crate::backend::{RunHostStore, StoreSpec, open_store};
use crate::edge_polls::EDGE_POLL_WORK_KIND;
use crate::store::{ClaimDue, DeliverySource, EventReceipt, NewDelivery, NewWork, Release, RunSettle, RunStart, SETTLE_RACE_WORK_KIND, iso, iso_at};
use module_wire::results as wire_results;

/// How many files' parses a session's runs keep (movement_engine::program::keep_parses):
/// a run's segment starts from a copy of its file's, a fifth of parsing it.
const KEPT_PARSES: usize = 128;

/// How many due work rows one drain of `listen-fire resume` or `listen-fire serve` claims.
pub const WORK_ROWS_PER_DRAIN: i64 = 100;

/// How long a work row's claim lasts (`LEASE_TTL_MS`).
const WORK_LEASE_MS: i64 = 60_000;
/// How often a drain looks for runs whose worker was lost (the platform's
/// `run_orphan_sweep` interval).
const LOST_RUN_SWEEP_EVERY: std::time::Duration = std::time::Duration::from_secs(30);
/// Where `listen-fire serve` listens unless told otherwise (`DEFAULT_PORT`).
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
    /// What each listen with an earlier hop the host resolves is watched
    /// under now, by its pipeline (crate::resolve): its heads, none for one
    /// never resolved, or suspended; the records its hops reported per record
    /// hang off, by the hop's edge, each of which that edge is watched under;
    /// and, for a listen over a union, each member's.
    watching: RefCell<BTreeMap<String, crate::resolve::Resolution>>,
    pub running: Vec<Rc<RunningExternal>>,
    schemas: IndexMap<String, ConnectionSchemas>,
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

/// The set's claim on each external's process listen-fire started.
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
    /// Each file's reading, in the files' order.
    pub fn parsed(&self) -> &[Rc<Parsed>] {
        &self.parsed
    }

    /// The file a listen is in. Its listens are read from its own files, so
    /// every listen's file is there.
    pub fn file(&self, name: &str) -> &MovementFile {
        self.files.iter().find(|f| f.name == name).unwrap_or_else(|| panic!("no file {name} in the set its listen was read from"))
    }

    /// Whether an arrival under the record `key` is the listen's to judge:
    /// one with no hop the host resolves watches every record; one that has
    /// watches its heads, and a listen over a union whatever any member
    /// watches.
    pub fn watches_under(&self, listen: &Listen, key: &Option<String>) -> bool {
        let watches = |member: usize, plan: &movement_parser::listen_plan::ListenPlan| !crate::edge_polls::resolves_plan(plan) || self.member_heads(listen, member, plan).contains(key);
        listen.plan.member_plans().iter().enumerate().any(|(member, plan)| watches(member, plan))
    }

    /// The scopes one traversal of a listen on a traversal (its own, or
    /// member `member`'s of a union, `plan`) is watched in: the heads its
    /// resolved hops matched, or the whole connection (`None`) for one with
    /// no hop the host resolves.
    pub fn member_heads(&self, listen: &Listen, member: usize, plan: &movement_parser::listen_plan::ListenPlan) -> Vec<Option<String>> {
        if !crate::edge_polls::resolves_plan(plan) {
            return vec![None];
        }
        self.member_watching(listen, member).heads.into_iter().map(Some).collect()
    }

    /// The records the hop on `edge` of one traversal of the listen hangs
    /// off, which that edge is watched under for it (crate::resolve
    /// `reported_per_record`).
    pub fn parents(&self, listen: &Listen, member: usize, edge: &str) -> Vec<Option<String>> {
        self.member_watching(listen, member).parents.remove(edge).unwrap_or_default().into_iter().map(Some).collect()
    }

    fn member_watching(&self, listen: &Listen, member: usize) -> crate::resolve::Watching {
        self.watching.borrow().get(&listen.pipeline()).map(|kept| kept.watching(&listen.plan, member)).unwrap_or_default()
    }

    /// What the listen is watched under, its heads and parents and its
    /// members': to tell whether a resolve moved them.
    pub fn watched(&self, listen: &Listen) -> (Vec<String>, BTreeMap<String, Vec<String>>, Vec<crate::resolve::Watching>) {
        let kept = self.watching.borrow().get(&listen.pipeline()).cloned().unwrap_or_default();
        (kept.heads, kept.parents, kept.members)
    }

    /// Watch the listen from now under what `resolution` lists
    /// (crate::resolve): whether that is not what it was watched under.
    pub fn watch(&self, listen: &Listen, resolution: &crate::resolve::Resolution) -> bool {
        let kept = crate::resolve::Resolution { resolved_at: None, failure: None, ..resolution.clone() };
        self.watching.borrow_mut().insert(listen.pipeline(), kept.clone()).is_none_or(|before| before != kept)
    }
}

/// What a session is opened for, which its module processes follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// One command (`listen-fire run`, `listen-fire resume`, …): a module stops when idle.
    Command,
    /// `listen-fire drain`: every module the files use is started as the session
    /// opens and kept up for the worker's life, so no run pays a start.
    Drain,
    /// `listen-fire serve`: a module stops when idle, and starts again for the
    /// delivery or the run that needs it; a refresh registers the webhooks
    /// the new listens need (crate::subscriptions).
    Serve,
    /// `listen-fire serve --doors-only`: as `Serve`, and the slots' modules a door
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
/// session keeps its own in a temporary state file instead), its role, and
/// whether it routes what arrives to the listens.
pub struct Opening<'s> {
    pub ephemeral: bool,
    pub store: &'s StoreSpec,
    pub role: Role,
    /// It hands deliveries and arrivals to the listens that take them
    /// (`serve`, `drain`, `run --webhook`, `resume` of every due run): a
    /// project that does not check is refused, never served in part. One
    /// that runs a named function or run (`run <function>`, `run --event`,
    /// `resume <run>`) opens a project with check errors, its listens as
    /// read.
    pub routes_listens: bool,
}

/// The line that closes a refusal of files that do not check.
const RUN_CHECK: &str = "run `listen-fire check`, and fix its errors: listen-fire serves a project only once it checks";

/// A walk of a plan's hops with no run (`Session::read_positions`): the
/// program it is walked in, the connection it starts from, its hops, and the
/// most distinct records its last hop may land on before it stops (None:
/// every one).
pub struct Walk<'a> {
    pub source: &'a str,
    pub connection: &'a str,
    pub hops: &'a [movement_parser::listen_plan::PlanHop],
    pub limit: Option<usize>,
}

pub struct Session {
    pub project: Project,
    pub role: Role,
    pub store: std::rc::Rc<dyn RunHostStore>,
    /// Never borrowed across an await: a webhook registration replaces it
    /// with what it wrote (crate::subscriptions).
    secrets: RefCell<Rc<Secrets>>,
    /// What `listen-fire serve` has said of its webhooks' registration, so a failure
    /// a refresh meets again is not said again.
    pub registrations: crate::subscriptions::Registrations,
    pub documents: Documents,
    /// Never borrowed across an await: a refresh may replace it meanwhile.
    file_set: RefCell<Rc<FileSet>>,
    /// `LF_CLOCK_AHEAD_MS`: what is due is judged this far ahead.
    due_offset_ms: i64,
    /// The principal every event acts as (`localIdentity`).
    user: Js,
    /// The temporary folder an ephemeral session's state lives in.
    ephemeral_dir: Option<std::path::PathBuf>,
    /// The work this session's drains take (`listen-fire drain --kinds`): all of it,
    /// unless a pool is named.
    pub pool: crate::drain::Pool,
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
    /// The lines said once in this session (`says_once`).
    said: RefCell<BTreeSet<String>>,
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
    let Opening { ephemeral, store, role, routes_listens } = *opening;
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
    // Before any module starts: what an earlier listen-fire left running is
    // stopped, and what this one starts is listed in the store.
    crate::module_hosts::track_in(store.clone());
    // A worker or a server keeps the release it opens the store under, once
    // per release (`records.releases`).
    if !matches!(role, Role::Command) {
        crate::records_door::note_release(&*store, &iso(0))?;
    }
    // The files slot's module: @lf/local-files (crate::core), or one reached over the wire.
    let documents = Documents::with_module(&project.lf_dir, crate::remote_slots::files(&project, credentials)?);
    // The slots' modules the role starts now, with the externals: a
    // worker's every one, a door's the ones a door calls.
    // Each one's manifest is read as it starts: one outside the protocol
    // range listen-fire speaks fails the open by name, before any work is claimed.
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
    let crate::routing::Listens { listens, unwatched } = crate::routing::listens_across(&parsed, &catalog);
    if routes_listens {
        let mut why = not_checking(&files, &parsed, &catalog, unwatched)?;
        if !why.is_empty() {
            why.push(RUN_CHECK.to_string());
            return Err(why.join("\n"));
        }
    }
    let user = local_identity(&project.user, |k| std::env::var(k).ok());
    let _holds = hold_all(&running, role.keep());
    let file_set = Rc::new(FileSet { files, parsed, catalog, listens, watching: Default::default(), running, schemas, _holds });
    let set = file_set.clone();
    // What the records door reads, and keeps its facts in the write ledger for
    // as long as a writer's own are kept.
    crate::records_door::install(store.clone(), crate::loop_breaker::kept_ms(&project, &set));
    let file_set = RefCell::new(file_set);
    let session = Session {
        project,
        role,
        store,
        secrets: RefCell::new(Rc::new(secrets)),
        registrations: Default::default(),
        documents,
        file_set,
        due_offset_ms,
        user,
        ephemeral_dir,
        pool: Default::default(),
        _slot_holds,
        swept_at: Default::default(),
        watch_pause,
        refused: Default::default(),
        watch_failed: Default::default(),
        said: Default::default(),
    };
    let opening = if routes_listens { crate::resolve::Opening::Routing } else { crate::resolve::Opening::Kept };
    for line in crate::resolve::open(&session, &set, opening).await? {
        eprintln!("listen-fire: {line}");
    }
    Ok(session)
}

/// What a run names of the delivery its event came in: the delivery's
/// receipt, and the arrival log's mark when it was kept (its trigger's waits
/// read from there). None of either for an event that came in no delivery.
#[derive(Clone, Copy, Default)]
pub struct CameIn<'a> {
    pub delivery_id: Option<&'a str>,
    pub trigger_mark: Option<i64>,
    /// The runs whose writes caused it, oldest first (crate::loop_breaker):
    /// none for one nothing in the write ledger caused.
    pub chain: &'a [String],
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
    /// The arrival log's mark before the delivery's own arrivals were
    /// logged (`arrivalMark`): a run it starts reads its trigger's waits from
    /// there, its trigger's own arrival noted on them as it was kept.
    pub arrival_mark: Option<i64>,
    /// The runs the delivery's arrivals fire, minted as it was kept, each
    /// `{ pipeline, receipt, runId }` (`runs`): their waits on their
    /// triggers were opened then, under these ids.
    pub minted: Option<&'a Js>,
    /// A replay of an arrival through one listen (crate::listen_replay): its
    /// arrivals are judged by the listen it minted a run for alone.
    pub replay: Option<Replay<'a>>,
}

/// A replay of a kept delivery through one listen (`listen-fire listens
/// replay`), as its row carries it (`replay`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Replay<'a> {
    /// The delivery it replays, which keeps the request: a listen that
    /// still cannot judge the arrival names it, to be replayed again.
    pub of: &'a str,
    /// Which judging of the arrival by the listen this is: 1 for the first
    /// replay (0 is its delivery's own).
    pub attempt: u32,
    /// Run again though the listen ran the arrival before (`--force`): the
    /// run takes a receipt of its own.
    pub again: bool,
}

impl<'a> Replay<'a> {
    fn of_row(row: &'a Js) -> Option<Replay<'a>> {
        let replay = row.get("replay")?;
        let attempt = match replay.get("attempt") {
            Some(Js::Num(n)) => u32::try_from(n.as_u64()?).ok()?,
            _ => return None,
        };
        Some(Replay { of: replay.get("of")?.as_str()?, attempt, again: Js::is_true(replay.get("again")) })
    }

    fn to_js(self) -> Js {
        Js::Obj(obj! { "of" => Js::str(self.of), "attempt" => Js::Num(self.attempt.into()), "again" => Js::Bool(self.again) })
    }
}

impl<'a> Delivered<'a> {
    /// What a run it starts names of it.
    pub fn came_in(&self) -> CameIn<'a> {
        CameIn { delivery_id: self.id, trigger_mark: self.arrival_mark, chain: &[] }
    }

    /// What a kept event or a queued `fire_event` row says it came for,
    /// under delivery `id`. Rows from before rows named a connection or a
    /// subscription name none.
    pub fn of_row(row: &'a Js, id: Option<&'a str>) -> Delivered<'a> {
        let text = |key: &str| row.get(key).and_then(Js::as_str);
        let arrival_mark = match row.get("arrivalMark") {
            Some(Js::Num(mark)) => mark.as_i64(),
            _ => None,
        };
        Delivered { id, credential: text("credential"), subscription: text("subscription"), arrival_mark, minted: row.get("runs"), replay: Replay::of_row(row) }
    }

    /// Which judging of its arrivals this is (crate::records_door::UnjudgedArrival::attempt).
    pub fn attempt(&self) -> u32 {
        self.replay.map_or(0, |replay| replay.attempt)
    }

    /// The receipt a run of the arrival `receipt` takes: its own, unless the
    /// delivery replays it again (`--force`), which takes one of its own.
    fn claimed(&self, receipt: &str) -> String {
        match (self.replay, self.id) {
            (Some(Replay { again: true, .. }), Some(id)) => format!("{receipt}#replay:{id}"),
            _ => receipt.to_string(),
        }
    }

    /// The run minted for `pipeline` to run the arrival `receipt`, when the
    /// delivery minted one.
    pub fn minted_run(&self, pipeline: &str, receipt: &str) -> Option<String> {
        self.minted?.as_array()?.iter().find_map(|run| {
            (run.get("pipeline").and_then(Js::as_str) == Some(pipeline) && run.get("receipt").and_then(Js::as_str) == Some(receipt)).then(|| run.get("runId").and_then(Js::as_str).map(str::to_string))?
        })
    }

    /// The pipelines of the listens the delivery minted runs for.
    pub fn minted_pipelines(&self) -> BTreeSet<&'a str> {
        self.minted.and_then(Js::as_array).unwrap_or_default().iter().filter_map(|run| run.get("pipeline").and_then(Js::as_str)).collect()
    }

    /// Every run the delivery minted, by id.
    pub fn minted_runs(&self) -> Vec<String> {
        self.minted.and_then(Js::as_array).unwrap_or_default().iter().filter_map(|run| run.get("runId").and_then(Js::as_str).map(str::to_string)).collect()
    }

    /// Its connection and subscription, and the replay it is, written into
    /// a kept event or a row.
    pub fn write_into(&self, row: &mut Obj) {
        if let Some(credential) = self.credential {
            row.insert("credential".into(), Js::str(credential));
        }
        if let Some(subscription) = self.subscription {
            row.insert("subscription".into(), Js::str(subscription));
        }
        if let Some(replay) = self.replay {
            row.insert("replay".into(), replay.to_js());
        }
    }

}

/// Who runs the `fire_event` row a shared poll that fires keeps.
#[derive(Clone, Copy, PartialEq)]
enum PolledRow {
    /// A drain: the row is due now.
    Drained,
    /// The caller (`listen-fire run --poll`), which then completes it: due a
    /// run lease out, so a drain takes it only if the caller died.
    RunHere,
}

/// One poll of a shared key's edge (`poll_edge_once`): what it ran itself
/// (the arming poll's line, or the judging of a page that minted no run),
/// the credential it polled as, and the row it kept for the runs it minted.
/// An arrival's receipt key (crate::arrivals::arrival_receipt_key).
fn receipt_of(arrival: &ArrivalIn) -> String {
    arrival_receipt_key(&arrival.edge, arrival.key.as_deref(), arrival.identity.as_deref().unwrap_or_default(), arrival.version.as_deref())
}

/// The listens sharing a key with no cursor that its last poll did not
/// arm, `armed` being the pipelines it did. A checkpoint kept before it
/// named them armed each listen then sharing it: none has joined.
fn joined_since(set: &FileSet, shared: &crate::edge_polls::Shared, armed: Option<&Js>) -> Vec<usize> {
    let Some(armed) = armed.and_then(Js::as_array) else { return Vec::new() };
    shared.fires.iter().copied().filter(|i| !armed.iter().any(|p| p.as_str() == Some(set.listens[*i].pipeline().as_str()))).collect()
}

struct EdgePolled {
    fired: Fired,
    polled_as: Option<String>,
    row: Option<NewWork>,
    /// When the module said the edge is next worth polling (`pollAgainAt`).
    poll_again_at: Option<i64>,
}

/// Which listens an arrival is judged against, and which it lists again.
#[derive(Clone, Copy)]
enum JudgedBy<'a> {
    /// Every listen on its edge that hears the connection it came for; and
    /// every listen on that connection with a resolved hop on its edge,
    /// whose module reports that edge's changes, is listed again.
    Every,
    /// Those sharing one poll or subscription (crate::edge_polls::Shared).
    Sharing(&'a crate::edge_polls::Shared),
    /// A poll's row: the listens it minted runs for, as it judged them
    /// against those sharing the poll; those sharing it that resolve again
    /// on its edge do, while the poll is still shared.
    Minted(Option<&'a crate::edge_polls::Shared>),
}

/// The arrivals the poll or subscription for `key` reported, each that
/// names no record it is under taken as under its head
/// (crate::arrivals::under_head).
fn under_scope(arrivals: &[ArrivalIn], key: &crate::edge_polls::PollKey) -> Vec<ArrivalIn> {
    crate::arrivals::under_head(arrivals, key.scope.as_deref())
}

/// What firing one event came to: the runs it started, and a line for each
/// way it ran nothing: a listen it was a redelivery to (its `idempotencyKey`
/// seen there before) or an echo of, or an arrival that is not what its
/// listen states it is.
#[derive(Default)]
pub struct Fired {
    pub outcomes: Vec<RunOutcome>,
    pub redelivered: Vec<String>,
}

/// The line an arrival every listen on its edge skips by its WHERE is told
/// with (mail sent to a key no listen names): with its values of the owned
/// fields those WHEREs compare, the ones only its module reads.
fn unmatched_line(adapter: &str, arrival: &ArrivalIn, skipped: &[&Listen]) -> String {
    let owned = |listen: &Listen| listen.plan.member_plans().iter().filter_map(|plan| plan.hops.last()).flat_map(|hop| hop.owned.clone()).collect::<Vec<_>>();
    let compared: BTreeSet<String> = skipped.iter().flat_map(|l| owned(l)).collect();
    let fields = arrival.landing.as_ref().and_then(|landing| landing.get("fields"));
    let held: Vec<String> = compared.iter().filter_map(|field| fields?.get(field).map(|value| format!("its {field} is {}", value.to_json()))).collect();
    let about = if held.is_empty() { String::new() } else { format!(" ({})", held.join(", ")) };
    let identity = arrival.identity.as_deref().unwrap_or_default();
    format!("{adapter}: the arrival {identity} on {}{about} matches the WHERE of no listen on it: it runs nothing", arrival.edge)
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
        report(&self.outcomes, Results::Shown, out)
    }
}

/// What one entry into a run came to (`RunOutcome`).
pub struct RunOutcome {
    pub run_id: String,
    pub file: String,
    pub movement: String,
    /// `fired`, `resumed` or `rerun`.
    pub entry: &'static str,
    /// `completed`, `parked`, `failed` or `leaseLost`.
    pub status: String,
    /// Each write this entry made, as the run's history lists it
    /// (crate::segment's `write_summary`).
    pub writes: Vec<Js>,
    pub captured: Option<Vec<Js>>,
    pub trace_entries: i64,
    pub error: Option<String>,
    /// What the movement returned, as the run's history keeps it
    /// (crate::returned), once the run has completed.
    pub returned: Option<Js>,
}

/// Whether a report shows what each run wrote and, once completed,
/// returned: yes to a person who started or drove the run; no in a worker's
/// log of the runs events started, where they only sit in the run's history.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Results {
    Shown,
    Withheld,
}

/// The most writes a run's history lists; its `writes` counts them all.
const LISTED_WRITES: usize = 100;

/// The run's outcome once a segment's writes are added to what its earlier
/// segments settled with (`before`, this attempt's and any before it: a
/// resume, a branch's continuation): the run's history counts and lists
/// every write it made, and keeps what it returned.
fn with_writes(before: Option<&str>, writes: usize, records: Vec<Js>, returned: Option<Js>) -> Js {
    let before = before.and_then(|text| Js::parse(text.as_bytes()).ok()).unwrap_or(Js::Null);
    let earlier = match before.get("writes") {
        Some(Js::Num(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    };
    let mut outcome = obj! { "writes" => Js::Num((earlier + writes as u64).into()) };
    let mut listed: Vec<Js> = before.get("writeRecords").and_then(Js::as_array).map(<[Js]>::to_vec).unwrap_or_default();
    listed.extend(records);
    listed.truncate(LISTED_WRITES);
    outcome.insert("writeRecords".into(), Js::Arr(listed));
    // The body returns in one segment; a later one (a branch the run still
    // waited on) keeps what it returned.
    if let Some(returned) = returned.or_else(|| before.get("returned").cloned()) {
        outcome.insert("returned".into(), returned);
    }
    Js::Obj(outcome)
}

/// The outcome of a run that failed with `message`: what it settled with
/// before, the writes its failed segment made (`committed`) beside them.
fn failed_outcome(before: Option<&str>, committed: &[Js], message: &str) -> Js {
    let mut outcome = match before.and_then(|text| Js::parse(text.as_bytes()).ok()) {
        Some(Js::Obj(outcome)) => outcome,
        _ => Obj::new(),
    };
    if !committed.is_empty()
        && let Js::Obj(writes) = with_writes(before, committed.len(), committed.to_vec(), None)
    {
        outcome.extend(writes);
    }
    outcome.insert("error".into(), Js::str(message));
    Js::Obj(outcome)
}

/// What a run entry has done so far: its writes, as the run's history
/// lists them, and how many segments ran.
#[derive(Default)]
struct Tally {
    writes: Vec<Js>,
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
    /// The arrival log's mark the delivery that started the run carried
    /// (`arrivalMark`): its first segment's trigger record entered there.
    /// Never kept: only the first segment reads it.
    trigger_mark: Option<i64>,
    /// The runs before it in its chain of writes and arrivals, oldest first
    /// (crate::loop_breaker): its writes are kept at this depth.
    chain: Vec<String>,
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
        if !self.chain.is_empty() {
            facts.insert("chain".into(), Js::strings(self.chain.clone()));
        }
        Js::Obj(facts)
    }

    /// A run's facts, refused when its pin is one listen-fire does not run.
    fn of_row(run_id: &str, input: &str) -> Result<RunFacts, String> {
        let facts = Js::parse(input.as_bytes()).map_err(|e| format!("run {run_id}: its facts are not JSON: {e}"))?;
        let text = |k: &str| facts.get(k).and_then(Js::as_str).map(str::to_string).ok_or_else(|| format!("run {run_id}: its facts have no {k}"));
        let language_version = match facts.get("languageVersion") {
            Some(Js::Str(pin)) => {
                let own = LANGUAGE_VERSION;
                match standing(pin, own) {
                    Standing::Compatible => pin.to_string(),
                    Standing::Newer => return Err(format!("run {run_id}: pinned to language {pin}, newer than this listen-fire ({own}); upgrade listen-fire")),
                    Standing::OlderKey | Standing::Malformed => {
                        return Err(format!("run {run_id}: pinned to language {pin}, which this listen-fire ({own}) does not read; it cannot resume: upgrade its movement and fire it again"));
                    }
                }
            }
            // A store from before pins were versions wrote the integer 5 (the
            // only integer listen-fire ever ran): read it once as this release, so a
            // parked run still resumes.
            Some(Js::Num(n)) if n.as_u64().is_some_and(|n| n >= 5) => LANGUAGE_VERSION.to_string(),
            Some(Js::Num(n)) => {
                return Err(format!("run {run_id}: pinned to the integer {n}, from before pins were releases, which listen-fire does not run; it cannot resume: upgrade its movement and fire it again"));
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
            trigger_mark: None,
            chain: crate::loop_breaker::chain_in(&facts),
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

    /// Read the secrets again, after listen-fire wrote to them (crate::subscriptions).
    pub fn reload_secrets(&self) -> Result<(), String> {
        let read = Secrets::open(&self.project, &std::env::vars().collect::<Vec<_>>())?;
        self.secrets.replace(Rc::new(read));
        Ok(())
    }

    pub fn externals_in<'a>(&'a self, set: &'a FileSet, secrets: &'a Secrets) -> Externals<'a> {
        Externals { project: &self.project, running: &set.running, credentials: secrets.credentials(), documents: &self.documents, tenant: LOCAL_TENANT }
    }

    fn due_by(&self) -> String {
        iso(self.due_offset_ms)
    }

    /// Judge what is due `ms` ahead of now, as `LF_CLOCK_AHEAD_MS` does.
    #[cfg(test)]
    pub(crate) fn judge_due_ahead(&mut self, ms: i64) {
        self.due_offset_ms = ms;
    }

    /// Now, as this session judges what is due (`LF_CLOCK_AHEAD_MS` on).
    pub fn now_ms(&self) -> i64 {
        crate::limiter::now_ms() + self.due_offset_ms
    }

    /// Judge each arrival that landed against every listen on its edge that
    /// hears the connection it came for (Listen::fires), and run each listen
    /// it fires with its landing as the parameter. The same arrival delivered
    /// again runs a listen once (its receipt, `arrival_receipt_key`). An
    /// arrival a listen's filter refuses runs nothing, said once per listen;
    /// one the judge cannot decide runs nothing either, its reason said once
    /// per delivery. One delivered through a webhook for an edge's arrivals
    /// (crate::subscriptions) is judged only against the listens sharing
    /// that webhook's key: the module may have applied that key's filter.
    pub async fn fire_arrivals(&self, adapter: &str, arrivals: &[ArrivalIn], delivered: Delivered<'_>) -> Result<Fired, String> {
        let set = self.file_set();
        self.follow_kept_heads(&set).await?;
        // A replay puts its arrivals through the listen it minted a run for, alone.
        if delivered.replay.is_some() {
            return self.fire_arrivals_to(&set, adapter, arrivals, delivered, JudgedBy::Minted(None)).await;
        }
        let through_edge = delivered.subscription.filter(|key| crate::subscriptions::is_edge_webhook(self.secrets().credentials(), adapter, key));
        let Some(subscription) = through_edge else {
            return self.fire_arrivals_to(&set, adapter, arrivals, delivered, JudgedBy::Every).await;
        };
        let Some((key, shared)) = crate::edge_polls::sharing_subscription(&set, subscription) else {
            // Its webhook outlived its listens (its removal failed, or is
            // still to come): said once, as its deliveries run nothing.
            let line = format!("{adapter}: a delivery reached webhook {subscription}, which no listen shares any more: it runs nothing until the webhook is removed");
            let mut fired = Fired::default();
            if self.says_once(&line) {
                fired.redelivered.push(line);
            }
            return Ok(fired);
        };
        let arrivals = under_scope(arrivals, &key);
        self.fire_arrivals_to(&set, adapter, &arrivals, delivered, JudgedBy::Sharing(&shared)).await
    }

    /// A shared poll's `fire_event` row (crate::edge_polls, its subscription
    /// `subscription`), as a drain runs it: judged only against the listens
    /// the poll minted runs for, since the module filtered the page for its
    /// key; and the listens sharing the poll that resolve on its edge resolve
    /// again, as `fire_arrivals` has them.
    async fn fire_polled(&self, adapter: &str, arrivals: &[ArrivalIn], delivered: Delivered<'_>, subscription: &str) -> Result<Fired, String> {
        let set = self.file_set();
        self.follow_kept_heads(&set).await?;
        let keys = crate::edge_polls::polled_keys(&set);
        let shared = keys.iter().find(|(key, _)| crate::edge_polls::poll_subscription(key) == subscription).map(|(_, shared)| shared);
        self.fire_arrivals_to(&set, adapter, arrivals, delivered, JudgedBy::Minted(shared)).await
    }

    /// `fire_arrivals`, to the listens `judged_by` keeps of those on the edge.
    async fn fire_arrivals_to(&self, set: &FileSet, adapter: &str, arrivals: &[ArrivalIn], delivered: Delivered<'_>, judged_by: JudgedBy<'_>) -> Result<Fired, String> {
        let mut fired = Fired::default();
        let now_ms = self.now_ms() as f64;
        let minted = delivered.minted_pipelines();
        let fires = |listen: &Listen| match judged_by {
            JudgedBy::Every => true,
            JudgedBy::Sharing(shared) => shared.fires.iter().any(|i| std::ptr::eq(listen, &set.listens[*i])),
            // Also still sharing the poll: a listen edited since the row was kept
            // was not judged against a page the module filtered for the old key.
            JudgedBy::Minted(shared) => minted.contains(listen.pipeline().as_str()) && shared.is_none_or(|shared| shared.fires.iter().any(|i| std::ptr::eq(listen, &set.listens[*i]))),
        };
        let mut started = BTreeSet::new();
        let mut paused: HashMap<String, bool> = HashMap::new();
        // A poll's page lists again what an earlier one did: that a listen
        // has taken it before is said only under LF_LOG=debug there.
        let polled = matches!(judged_by, JudgedBy::Minted(_));
        let taken_before = |fired: &mut Fired, line: String| match polled {
            true => crate::log::debug(|| line),
            false => fired.redelivered.push(line),
        };
        for arrival in arrivals.iter().filter(|a| !a.gone) {
            let identity = arrival.identity.as_deref().unwrap_or_default();
            // Whether a listen on the edge takes it, and what was said of
            // the listens it does not fit: said only when none takes it.
            let (mut taken, mut skipped, mut misfit_lines) = (false, Vec::new(), Vec::new());
            for listen in set.listens.iter().filter(|l| l.is_on(adapter, &arrival.edge) && fires(l)) {
                let file = set.file(&listen.file);
                let named = format!("{}:{}", file.name, listen.movement_name);
                // A listen whose earlier hops the host resolves is watched
                // under its heads alone.
                if !set.watches_under(listen, &arrival.key) {
                    crate::log::debug(|| format!("{named}: the arrival {identity} on {} is under no record it watches: it runs nothing", arrival.edge));
                    continue;
                }
                let Some(verdict) = listen.fires(arrival, delivered.credential, now_ms) else { continue };
                match verdict {
                    Verdict::Fires => {}
                    // Said only under LF_LOG=debug: one line per arrival and
                    // listen would flood a busy edge's output with lines that
                    // say nothing went wrong.
                    Verdict::Skips { hop, reason } => {
                        crate::log::debug(|| match &reason {
                            Some(reason) => format!("{named}: the arrival {identity} on {} is not this listen's at hop {}: {reason}: nothing is owed, and it runs nothing", arrival.edge, hop + 1),
                            None => format!("{named}: the arrival {identity} on {} does not match the WHERE of hop {}: nothing is owed, and it runs nothing", arrival.edge, hop + 1),
                        });
                        skipped.push(listen);
                        continue;
                    }
                    Verdict::Undecided { reason } => {
                        taken = true;
                        self.note_unjudged(set, adapter, listen, arrival, &delivered, &reason)?;
                        let line = format!("{named}: an arrival on {} cannot be judged ({reason}): it runs nothing", arrival.edge);
                        if !fired.redelivered.contains(&line) {
                            fired.redelivered.push(line);
                        }
                        continue;
                    }
                }
                let misfits = listen.misfits(arrival);
                if !misfits.is_empty() {
                    let declared = listen.payload.as_ref().map(|p| p.name.as_str()).unwrap_or_default();
                    misfit_lines.push(format!("{named}: the arrival {identity} on {} is not a {declared} ({}): it runs nothing", arrival.edge, misfits.join("; ")));
                    continue;
                }
                taken = true;
                let pipeline = listen.pipeline();
                // Read once per listen and delivery: a pause this delivery
                // makes is noted below.
                let is_paused = match paused.get(&pipeline) {
                    Some(known) => *known,
                    None => {
                        let known = self.store.listen_state(&pipeline).map_err(|e| e.to_string())?.is_some_and(|state| state.paused.is_some());
                        paused.insert(pipeline.clone(), known);
                        known
                    }
                };
                let receipt = arrival_receipt_key(&arrival.edge, arrival.key.as_deref(), identity, arrival.version.as_deref());
                let claimed = delivered.claimed(&receipt);
                // An arrival a listen does not run (paused, or at the depth
                // limit) takes its receipt as a run would, so a redelivery
                // of it is not counted twice, or taken for a new chain.
                if is_paused {
                    if self.store.claim_event(&EventReceipt::own(&pipeline, &claimed)).map_err(|e| e.to_string())? {
                        self.store.hold_listen_arrival(&pipeline).map_err(|e| e.to_string())?;
                        fired.redelivered.push(format!("{named}: the arrival {identity} on {} runs nothing, {}", arrival.edge, crate::loop_breaker::HELD));
                    } else {
                        taken_before(&mut fired, format!("{named} has taken the arrival {identity} on {} before: this delivery runs nothing", arrival.edge));
                    }
                    continue;
                }
                let chain = self.chain_before(adapter, listen, arrival)?;
                if chain.len() >= self.project.loop_depth {
                    if !self.store.claim_event(&EventReceipt::own(&pipeline, &claimed)).map_err(|e| e.to_string())? {
                        taken_before(&mut fired, format!("{named} has taken the arrival {identity} on {} before: this delivery runs nothing", arrival.edge));
                        continue;
                    }
                    let line = crate::loop_breaker::loop_line(&named, &chain);
                    self.store.set_listen_paused(&pipeline, Some(&line)).map_err(|e| e.to_string())?;
                    self.store.hold_listen_arrival(&pipeline).map_err(|e| e.to_string())?;
                    paused.insert(pipeline, true);
                    fired.redelivered.push(line);
                    continue;
                }
                let trigger = arrival_trigger_of(&pipeline, adapter, arrival, &iso(0));
                let run_id = delivered.minted_run(&pipeline, &receipt).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                let came_in = CameIn { chain: &chain, ..delivered.came_in() };
                match self.run_listen(set, &run_id, listen, trigger, false, Some((pipeline.as_str(), claimed.as_str())), came_in).await? {
                    Some(outcome) => {
                        started.insert(run_id);
                        fired.outcomes.push(outcome);
                    }
                    None => taken_before(&mut fired, format!("{named} has run the arrival {identity} on {} before: this delivery runs nothing", arrival.edge)),
                }
            }
            // A poll's row was judged when the poll minted its runs.
            // Said at the default level only on an edge whose sender chose
            // the address (mail to a key no listen names); on any other, a
            // busy edge's every delivery no listen takes would flood the output.
            if !taken && misfit_lines.is_empty() && !skipped.is_empty() && !matches!(judged_by, JudgedBy::Minted(_)) {
                let line = unmatched_line(adapter, arrival, &skipped);
                if skipped.iter().any(|listen| crate::edge_polls::addressed(set, listen)) {
                    fired.redelivered.push(line);
                } else {
                    crate::log::debug(|| line);
                }
            }
            if taken {
                for line in misfit_lines {
                    crate::log::debug(|| line);
                }
            } else {
                fired.redelivered.extend(misfit_lines);
            }
        }
        // A run the delivery minted that was never started (its listen no
        // longer fires the arrival, or another delivery ran it) never will:
        // the waits opened for it as the delivery was kept go. One an
        // earlier attempt at this row started is live, and keeps its state.
        for run_id in delivered.minted_runs().into_iter().filter(|id| !started.contains(id)) {
            if self.store.run(&run_id).map_err(|e| e.to_string())?.is_none() {
                self.store.drop_run_state(&run_id, None).map_err(|e| e.to_string())?;
            }
        }
        // A module that reports its parents' changes reports them as
        // arrivals on the parents' own edge: the listens filtering that
        // edge, on the connection they came for, resolve again.
        let edges: BTreeSet<&str> = arrivals.iter().map(|a| a.edge.as_str()).collect();
        let resolving: Vec<&Listen> = match judged_by {
            JudgedBy::Every => set
                .listens
                .iter()
                .filter(|l| l.adapter == adapter && l.hears(delivered.credential) && crate::resolve::pushed_parents(set, l).iter().any(|edge| edges.contains(edge.as_str())))
                .collect(),
            JudgedBy::Sharing(shared) | JudgedBy::Minted(Some(shared)) if !arrivals.is_empty() => shared.resolves.iter().map(|i| &set.listens[*i]).collect(),
            JudgedBy::Sharing(_) | JudgedBy::Minted(_) => Vec::new(),
        };
        for listen in resolving {
            if !self.re_resolve(set, listen).await? {
                crate::resolve::arm_again(self, listen)?;
            }
        }
        Ok(fired)
    }

    /// Keep that `listen` could not judge `arrival`, delivered in the kept
    /// delivery `delivered` (crate::records_door::UnjudgedArrival; for a
    /// replay, the delivery it replays), once per listen, arrival and
    /// attempt: the host's own failure, which `@lf/system` reports as
    /// `Arrival Not Judged`. It fails this listen alone; the
    /// arrival's other listens are judged as usual. Kept as long as a
    /// delivery is (`deliveries.retainDays`).
    pub(crate) fn note_unjudged(&self, set: &FileSet, adapter: &str, listen: &Listen, arrival: &ArrivalIn, delivered: &Delivered<'_>, reason: &str) -> Result<(), String> {
        let fact = self.unjudged_fact(set, adapter, listen, arrival, delivered, reason)?;
        let retain_ms = i64::from(self.project.delivery_retain_days) * 86_400_000;
        self.store.note_unjudged(&fact, &iso(-retain_ms)).map_err(|e| format!("keeping that {}:{} could not judge an arrival on {}: {e}", fact.file, fact.movement, fact.edge))?;
        Ok(())
    }

    /// The fact that `listen` could not judge `arrival`, as `note_unjudged` keeps it.
    fn unjudged_fact(&self, set: &FileSet, adapter: &str, listen: &Listen, arrival: &ArrivalIn, delivered: &Delivered<'_>, reason: &str) -> Result<crate::records_door::UnjudgedArrival, String> {
        let identity = arrival.identity.as_deref().unwrap_or_default();
        Ok(crate::records_door::UnjudgedArrival {
            pipeline: listen.pipeline(),
            arrival: arrival_receipt_key(&arrival.edge, arrival.key.as_deref(), identity, arrival.version.as_deref()),
            file: set.file(&listen.file).name.clone(),
            movement: listen.movement_name.clone(),
            delivery_id: delivered.replay.map(|replay| replay.of).or(delivered.id).map(str::to_string),
            edge: arrival.edge.clone(),
            adapter: Some(adapter.to_string()),
            record_id: arrival.landing.as_ref().and_then(|landing| landing.get("recordId")).and_then(Js::as_str).map(str::to_string),
            landing: arrival.landing.clone(),
            reason: reason.to_string(),
            cause: self.chain_before(adapter, listen, arrival)?.pop(),
            at: iso(0),
            attempt: delivered.attempt(),
        })
    }

    /// The runs whose writes caused `arrival`, oldest first, as the write
    /// ledger has them (crate::loop_breaker): the chain the run it fires
    /// continues. A store that cannot answer fails the delivery, as every
    /// other store read does: a loop breaker that is silently off is worse
    /// than a delivery that is tried again.
    fn chain_before(&self, adapter: &str, listen: &Listen, arrival: &ArrivalIn) -> Result<Vec<String>, String> {
        // Over a union, what lands is of the type the member it fired under
        // lands on: the type the landing states, when one member's does.
        let landings: Vec<String> = listen.plan.member_plans().iter().filter_map(|plan| plan.hops.last().map(|hop| hop.to.clone())).collect();
        let stated = arrival.landing.as_ref().and_then(|landing| landing.get("recordType")).and_then(Js::as_str);
        let landing_type = stated.filter(|stated| landings.iter().any(|to| to == stated)).or(landings.first().map(String::as_str)).unwrap_or_default();
        let records = crate::loop_breaker::records_of(adapter, arrival, landing_type);
        if records.is_empty() {
            return Ok(Vec::new());
        }
        let since = iso_at(crate::loop_breaker::since_of(arrival, self.project.loop_window_ms, crate::limiter::now_ms()));
        crate::loop_breaker::chain_of(&*self.store, &records, &since)
            .map_err(|message| format!("what caused the arrival on {} for {}:{}: {message}", arrival.edge, listen.file, listen.movement_name))
    }

    /// Watch each listen on the heads the store keeps for it now
    /// (crate::resolve::watch_kept): another process may have resolved it.
    /// A server moves its webhooks with them.
    /// A server also tries again each registration that failed, once its
    /// backoff passed.
    pub async fn follow_kept_heads(&self, set: &FileSet) -> Result<(), String> {
        let moved = crate::resolve::watch_kept(self, set)?.moved;
        if !self.role.registers_webhooks() {
            return Ok(());
        }
        let lines = match moved {
            true => crate::subscriptions::reconcile(self).await,
            false => crate::subscriptions::retry_failed(self).await,
        };
        for line in lines {
            eprintln!("listen-fire: {line}");
        }
        Ok(())
    }

    /// Whether `line` is said for the first time in this session: a line
    /// said as each set opens is said once.
    pub fn says_once(&self, line: &str) -> bool {
        self.said.borrow_mut().insert(line.to_string())
    }

    /// `listen-fire run <movement>`: one invocation on the manual unit, an
    /// arrival on its `Invocations`, to the listens on it that fire
    /// `movement` (`listen to manual-[:Invocations]-> fire <movement>`).
    pub async fn run_manual(&self, movement: &str, text: Option<&str>, dry_run: bool) -> Result<Fired, String> {
        let set = self.file_set();
        let firing: Vec<usize> = set.listens.iter().enumerate().filter(|(_, l)| l.is_on(crate::units::MANUAL, crate::units::INVOCATIONS) && l.movement_name == movement).map(|(i, _)| i).collect();
        if firing.is_empty() {
            return Err(format!(
                "no listen fires '{movement}' on manual: add `listen to manual-[:{}]-> fire {movement}` to run it with `listen-fire run {movement}`",
                crate::units::INVOCATIONS
            ));
        }
        let arrival = crate::units::invocation(&iso(0), &self.user, text);
        let arrivals = crate::arrivals::arrivals_of(&Js::Obj(obj! { "arrivals" => Js::Arr(vec![arrival]) }))?;
        // Asked for by name, so a listen whose WHERE the invocation does not
        // match says so, and a rehearsal runs only what a run would.
        let mut fired = Fired::default();
        let now_ms = self.now_ms() as f64;
        let mut matched = Vec::new();
        for i in firing {
            let listen = &set.listens[i];
            let named = format!("{}:{}", set.file(&listen.file).name, listen.movement_name);
            match listen.fires(&arrivals[0], None, now_ms) {
                Some(Verdict::Fires) => matched.push(i),
                Some(Verdict::Skips { hop, reason: None }) => fired.redelivered.push(format!("{named}: the invocation does not match the WHERE of hop {}: it runs nothing", hop + 1)),
                Some(Verdict::Skips { hop, reason: Some(reason) }) => fired.redelivered.push(format!("{named}: the invocation is not this listen's at hop {}: {reason}: it runs nothing", hop + 1)),
                Some(Verdict::Undecided { reason }) => fired.redelivered.push(format!("{named}: the invocation cannot be judged ({reason}): it runs nothing")),
                None => {}
            }
        }
        if !dry_run {
            let only = crate::edge_polls::Shared { fires: matched, ..Default::default() };
            let ran = self.fire_arrivals_to(&set, crate::units::MANUAL, &arrivals, Delivered::default(), JudgedBy::Sharing(&only)).await?;
            fired.redelivered.extend(ran.redelivered);
            fired.outcomes = ran.outcomes;
            return Ok(fired);
        }
        // A rehearsal keeps no receipt: an invocation is never delivered twice.
        for listen in matched.iter().map(|i| &set.listens[*i]) {
            let trigger = arrival_trigger_of(&listen.pipeline(), crate::units::MANUAL, &arrivals[0], &iso(0));
            if let Some(outcome) = self.run_listen(&set, &uuid::Uuid::new_v4().to_string(), listen, trigger, true, None, CameIn::default()).await? {
                fired.outcomes.push(outcome);
            }
        }
        Ok(fired)
    }

    /// Give each shared poll without one its `poll_edge` work row, due
    /// now: the row then lives as long as some listen shares its key. A
    /// checkpoint does not stand for the row: `run --poll` polls and keeps
    /// one without queueing it. Each poll releases the row for the next
    /// interval, so whichever worker claims it (under the work lease, so
    /// never two at once) polls, and a poll due while no worker ran is one
    /// poll on the next drain. The row is queued only where none is
    /// (`enqueue_if_absent`): workers arming one key at once queue it once,
    /// and an arm never moves the due time of the row another worker holds.
    fn arm_edge_polls(&self, set: &FileSet) -> Result<(), String> {
        for key in crate::edge_polls::polled_keys(set).into_keys() {
            let subscription = crate::edge_polls::poll_subscription(&key);
            let mut payload = key.to_js();
            if let Js::Obj(members) = &mut payload {
                members.insert("subscription".into(), Js::str(&subscription));
            }
            if self.store.enqueue_if_absent(EDGE_POLL_WORK_KIND, &format!("{EDGE_POLL_WORK_KIND}:{subscription}"), &payload, None, None).map_err(|e| e.to_string())? {
                crate::wake::queued(EDGE_POLL_WORK_KIND, None);
            }
        }
        Ok(())
    }

    /// A `resolve_listen` row for each listen re-resolved on a clock
    /// (crate::resolve::every_ms), first due one interval from now: it was
    /// resolved as the set opened. A row there already is left as it is.
    fn arm_resolves(&self, set: &FileSet) -> Result<(), String> {
        use crate::resolve::RESOLVE_WORK_KIND;
        for listen in &set.listens {
            let Some(every) = crate::resolve::every_ms(set, listen, &self.project.resolve_every) else { continue };
            let due = iso(self.due_offset_ms + every);
            if self.store.enqueue_if_absent(RESOLVE_WORK_KIND, &crate::resolve::row_key(listen), &crate::resolve::row_payload(listen), Some(&due), None).map_err(|e| e.to_string())? {
                crate::wake::queued(RESOLVE_WORK_KIND, Some(&due));
            }
        }
        Ok(())
    }

    /// A `resolve_listen` row: resolve its listen again, and say when it is
    /// next due: an interval on for a listen re-resolved on a clock, else
    /// never (one armed by `crate::resolve::arm_again` runs once). A row
    /// whose listen is gone is done. A listen another process holds is tried
    /// again shortly, never done: that process's listing may predate what
    /// armed this row, or the process may be gone, its hold left to lapse.
    async fn resolve_row(&self, set: &FileSet, pipeline: &str) -> Result<(Next, Vec<RunOutcome>), String> {
        let Some(listen) = set.listens.iter().find(|l| l.pipeline() == pipeline && crate::edge_polls::resolves(l)) else { return Ok((Next::Done, Vec::new())) };
        if !self.re_resolve(set, listen).await? {
            return Ok((Next::Busy, Vec::new()));
        }
        let next = match crate::resolve::every_ms(set, listen, &self.project.resolve_every) {
            Some(every) => Next::DueAt(iso(self.due_offset_ms + every)),
            None => Next::Done,
        };
        Ok((next, Vec::new()))
    }

    /// Resolve the listen again (crate::resolve::resolve), say a failure that
    /// changed, and move the webhooks a server holds with its heads and the
    /// records its hops reported per record hang off. False:
    /// another process held it, and nothing was listed here.
    async fn re_resolve(&self, set: &FileSet, listen: &Listen) -> Result<bool, String> {
        let before = set.watched(listen);
        match crate::resolve::resolve(self, set, listen).await? {
            crate::resolve::Resolved::Elsewhere => return Ok(false),
            crate::resolve::Resolved::Kept(Some(line)) => eprintln!("listen-fire: {line}"),
            crate::resolve::Resolved::Kept(None) => {}
        }
        // A hop reported per record is subscribed to under each record it
        // hangs off, so parents that moved alone move webhooks too: a base
        // renamed into the WHERE with no table in it yet is watched for one.
        if self.role.registers_webhooks() && set.watched(listen) != before {
            for line in crate::subscriptions::reconcile(self).await {
                eprintln!("listen-fire: {line}");
            }
        }
        Ok(true)
    }

    /// A `poll_edge` row: poll its key's edge once for every listen sharing
    /// it, and say when it is next due: when its module said, if that is
    /// within its interval (crate::edge_polls::next_poll_at), so a cron tick
    /// is polled at its time. A row no listen shares any more is done, and
    /// its cursor forgotten.
    async fn poll_edge_row(&self, set: &FileSet, subscription: &str) -> Result<(Next, Vec<RunOutcome>), String> {
        let keys = crate::edge_polls::polled_keys(set);
        let Some((key, shared)) = keys.iter().find(|(key, _)| crate::edge_polls::poll_subscription(key) == subscription) else {
            self.store.save_inbound_checkpoint(subscription, &Js::Null).map_err(|e| e.to_string())?;
            return Ok((Next::Done, Vec::new()));
        };
        let polled = self.poll_edge_once(set, key, shared, PolledRow::Drained).await?;
        for line in &polled.fired.redelivered {
            eprintln!("listen-fire: {line}");
        }
        let interval_ms = crate::edge_polls::interval_ms(&self.project.poll_every, key, polled.polled_as.as_deref(), shared.declared.as_ref())?;
        let next = crate::edge_polls::next_poll_at(self.now_ms(), interval_ms, polled.poll_again_at);
        Ok((Next::DueAt(iso_at(next)), polled.fired.outcomes))
    }

    /// One poll of a shared key's edge: `poll({ edge, filter?, scope?,
    /// cursor? })`, as the credential the connection names (else its
    /// module's). The first only arms: its cursor is kept, and what it
    /// returns is what was there before, so it fires nothing. After that,
    /// a poll whose arrivals fire a listen sharing the key is kept as a
    /// delivery (`poll`), in one write: its receipt, its arrivals, a
    /// `fire_event` row carrying the runs it minted, their waits (from the
    /// mark before its arrivals, live while the row is queued, so another
    /// arrival of the same page answers a run it starts and only the run's
    /// own trigger does not) and its new cursor. The row runs those runs
    /// (`fire_polled`): a drain, or the caller (`row_runs`); the listens
    /// that could not judge an arrival are kept in that write too. A poll
    /// that fires nothing logs its arrivals and keeps its cursor, then
    /// judges them (a listen sharing the key may resolve again).
    async fn poll_edge_once(&self, set: &FileSet, key: &crate::edge_polls::PollKey, shared: &crate::edge_polls::Shared, row_runs: PolledRow) -> Result<EdgePolled, String> {
        let subscription = crate::edge_polls::poll_subscription(key);
        let subscription = subscription.as_str();
        let state = self.store.inbound_checkpoint(subscription).map_err(|e| e.to_string())?;
        let cursor = state.as_ref().and_then(|s| s.get("cursor"));
        let secrets = self.secrets();
        let credentials = secrets.credentials();
        let running = set.running.iter().find(|r| !r.is_plugin() && r.external.manifest.name == key.adapter);
        // The cron unit's clock, answered in process.
        let (answer, credential, resend_manifest) = match running {
            None if key.adapter == crate::units::CRON && key.edge == crate::units::TICKS => {
                let every_ms = crate::edge_polls::interval_ms(&self.project.poll_every, key, None, shared.declared.as_ref())?;
                let ticked = crate::units::poll_ticks(key.filter().as_ref(), cursor, crate::units::PollClock { now_ms: self.now_ms(), every_ms })?;
                for line in &ticked.unread {
                    eprintln!("listen-fire: {line}");
                }
                (ticked.answer, None, Js::Null)
            }
            None => return Err(format!("{}: not running, so its polled edge '{}' is not polled", key.adapter, key.edge)),
            Some(running) => {
                if !running.methods.iter().any(|m| m == "poll") {
                    return Err(format!("{}: its edge '{}' is polled, and it offers no `poll`: declare `poll` and answer `{{ edge, filter?, scope?, cursor? }}` (adapter protocol 2.6)", key.adapter, key.edge));
                }
                let credential = match &key.credential {
                    Some(name) => Some(credentials.iter().find(|c| c.name == *name).ok_or_else(|| format!("no credential \"{name}\" in the secrets file"))?),
                    None => credential_for(credentials, &key.adapter),
                };
                let mut params = serde_json::json!({ "edge": key.edge });
                if let Some(filter) = key.filter() {
                    params["filter"] = filter;
                }
                if let Some(scope) = &key.scope {
                    params["scope"] = serde_json::Value::String(scope.clone());
                }
                if let Some(cursor) = cursor {
                    params["cursor"] = crate::wire::json_of_js(cursor);
                }
                let raw = rpc_in(running, credentials, credential, LOCAL_TENANT, "poll", params, key.position_settings()).await?;
                (wire_results::check("poll", &key.adapter, &raw)?, credential, running.manifest_answer.clone())
            }
        };
        let arrivals = crate::arrivals::arrivals_of(&answer).map_err(|e| format!("{}: a poll of '{}' answered {e}", key.adapter, key.edge))?;
        let poll_again_at = match answer.get("pollAgainAt") {
            None => None,
            Some(at) => Some(at.as_str().and_then(crate::units::ms_of).ok_or_else(|| format!("{}: a poll of '{}' answered pollAgainAt {}: expected an instant (ISO 8601)", key.adapter, key.edge, at.to_json()))?),
        };
        let arrivals = under_scope(&arrivals, key);
        let cursorless = shared.declared.as_ref().is_some_and(|d| d.cursorless);
        let mut cursor = obj! { "armed" => Js::Bool(true) };
        if let Some(at) = answer.get("cursor").filter(|c| **c != Js::Null) {
            cursor.insert("cursor".into(), at.clone());
        }
        // An edge listed whole each time keeps what it listed and which
        // listens have seen it: the next poll judges only what is new, and a
        // listen that joins the key later arms on its first poll.
        if cursorless {
            cursor.insert("armedFor".into(), Js::Arr(shared.fires.iter().map(|i| Js::str(set.listens[*i].pipeline())).collect()));
            cursor.insert("listed".into(), Js::Arr(arrivals.iter().map(|a| Js::str(receipt_of(a))).collect()));
        }
        let checkpoint = Js::Obj(cursor);
        let polled_as = credential.map(|c| c.name.clone());
        let mut fired = Fired::default();
        let arming = |fired: &mut Fired, listens: &[usize]| {
            let named: Vec<String> = listens.iter().map(|i| &set.listens[*i]).map(|l| format!("{}:{}", set.file(&l.file).name, l.movement_name)).collect();
            if !named.is_empty() {
                fired.redelivered.push(format!("{}: {} armed; it fires on changes from now", key.adapter, named.join(", ")));
            }
        };
        if state.is_none() {
            arming(&mut fired, &shared.fires);
            // A cursor already keeps the backlog from firing; only an edge listed whole each time needs its receipts.
            if cursorless {
                self.note_seen_arrivals(set, &key.adapter, &arrivals, key.credential.as_deref(), &shared.fires)?;
            }
        } else {
            let (arrivals, shared) = match state.as_ref().filter(|_| cursorless) {
                Some(state) => {
                    let joined = joined_since(set, shared, state.get("armedFor"));
                    arming(&mut fired, &joined);
                    self.note_seen_arrivals(set, &key.adapter, &arrivals, key.credential.as_deref(), &joined)?;
                    let listed: Option<BTreeSet<&str>> = state.get("listed").and_then(Js::as_array).map(|seen| seen.iter().filter_map(Js::as_str).collect());
                    let fresh: Vec<ArrivalIn> = arrivals.iter().filter(|a| listed.as_ref().is_none_or(|seen| !seen.contains(receipt_of(a).as_str()))).cloned().collect();
                    (fresh, crate::edge_polls::Shared { fires: shared.fires.iter().copied().filter(|i| !joined.contains(i)).collect(), ..shared.clone() })
                }
                None => (arrivals, shared.clone()),
            };
            let (arrivals, shared) = (&arrivals, &shared);
            let (logged, at) = (crate::arrivals::logged(&arrivals), iso(0));
            let resend_window_ms = crate::externals::resend_window_ms(&self.project, &key.adapter, &resend_manifest);
            let log = crate::waits::DeliveryArrivals { team_id: LOCAL_TENANT, adapter_type: &key.adapter, arrivals: &logged, at: &at, resend_window_ms };
            let came_for = Delivered { credential: key.credential.as_deref(), ..Delivered::default() };
            let doors = crate::doors::LfDoors {
                listens: shared.fires.iter().map(|i| set.listens[*i].clone()).collect(),
                ..crate::doors::LfDoors::of_session(self, crate::doors::EventSink::Queue, &|| {})
            };
            let landed = doors.landed_for_listens(&key.adapter, came_for.credential, &arrivals);
            let crate::doors::Minted { runs: minted, mut waits, unjudged } = doors.mint_runs(&key.adapter, credential.map(|c| c.name.as_str()), came_for.credential, &landed).await?;
            // A page a listen could not judge is kept as a delivery too, so
            // the fact names one; its row judges only the listens it minted
            // runs for, so the others are noted here.
            if minted.as_array().is_some_and(|runs| !runs.is_empty()) || !unjudged.is_empty() {
                // A poll makes no request: the page it read is what the delivery keeps, for `listens replay`.
                let page = crate::inbound::Page { adapter: key.adapter.clone(), install: polled_as.clone(), credential: key.credential.clone(), arrivals: arrivals.clone() };
                let receipt = NewDelivery { id: uuid::Uuid::new_v4().to_string(), external_id: None, received_at: at.clone(), source: DeliverySource::Poll, inline: false, replay_of: None, events: Vec::new(), request: Some(page.to_js()) };
                let mut row = crate::doors::fire_arrivals_work(&key.adapter, &arrivals, Delivered { id: Some(&receipt.id), minted: Some(&minted), ..came_for });
                if let Js::Obj(payload) = &mut row.payload {
                    payload.insert("polled".into(), Js::str(subscription));
                }
                if row_runs == PolledRow::RunHere {
                    row.due_at = Some(iso(crate::run_host::RUN_LEASE_TTL_MS));
                }
                crate::doors::queued_by(&mut waits, &row.key);
                let delivered = Delivered { id: Some(&receipt.id), ..Delivered::default() };
                let facts = unjudged.iter().map(|one| self.unjudged_fact(set, &key.adapter, &doors.listens[one.listen], &landed[one.arrival], &delivered, &one.reason)).collect::<Result<Vec<_>, _>>()?;
                // The page, its runs, what no listen could judge and the cursor: one write.
                let kept = self
                    .store
                    .keep_delivery(subscription, Some(&checkpoint), &receipt, std::slice::from_ref(&row), Some(&log), &waits, &facts)
                    .map_err(|e| e.to_string())?
                    .ok_or("a poll's delivery was taken for a duplicate")?;
                crate::wake::queued_rows(std::slice::from_ref(&row));
                crate::wake::queued_rows(&kept.wakes);
                // As the store keeps it, for a caller that runs it.
                if let Js::Obj(payload) = &mut row.payload {
                    payload.insert("arrivalMark".into(), Js::Num(kept.arrival_mark.into()));
                }
                return Ok(EdgePolled { fired, polled_as, row: Some(row), poll_again_at });
            }
            // Logged, then the cursor kept, before any listen resolves again
            // (a call to the module that may outlast the row's lease): a
            // crash between the two polls the page again, and its arrivals,
            // logged within the module's re-send window, are not logged twice.
            let mark = self.store.arrival_mark().map_err(|e| e.to_string())?;
            crate::arrivals::log_and_wake(&*self.store, &log)?;
            self.store.save_inbound_checkpoint(subscription, &checkpoint).map_err(|e| e.to_string())?;
            let judged = self.fire_arrivals_to(set, &key.adapter, arrivals, Delivered { arrival_mark: Some(mark), ..came_for }, JudgedBy::Sharing(shared)).await?;
            fired.outcomes.extend(judged.outcomes);
            fired.redelivered.extend(judged.redelivered);
            return Ok(EdgePolled { fired, polled_as, row: None, poll_again_at });
        }
        self.store.save_inbound_checkpoint(subscription, &checkpoint).map_err(|e| e.to_string())?;
        Ok(EdgePolled { fired, polled_as, row: None, poll_again_at })
    }

    /// What the arming poll of an edge with no cursor saw is what each
    /// listen sharing it has already seen: its receipt is kept, without a
    /// run, so the next poll (which lists all of it again) fires only what
    /// is new.
    fn note_seen_arrivals(&self, set: &FileSet, adapter: &str, arrivals: &[ArrivalIn], credential: Option<&str>, sharing: &[usize]) -> Result<(), String> {
        if sharing.is_empty() {
            return Ok(());
        }
        let now_ms = self.now_ms() as f64;
        for arrival in arrivals.iter().filter(|a| !a.gone) {
            let receipt = arrival_receipt_key(&arrival.edge, arrival.key.as_deref(), arrival.identity.as_deref().unwrap_or_default(), arrival.version.as_deref());
            for listen in sharing.iter().map(|i| &set.listens[*i]).filter(|l| l.is_on(adapter, &arrival.edge)) {
                if matches!(listen.fires(arrival, credential, now_ms), Some(Verdict::Fires)) {
                    self.store.claim_event(&EventReceipt::own(&listen.pipeline(), &receipt)).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    /// `listen-fire run --poll <movement>`: poll now, once, each polled edge
    /// a listen that fires `movement` is on, through its shared key, once
    /// however many of the key's listens fire `movement`.
    pub async fn run_poll(&self, movement: &str) -> Result<Fired, String> {
        let set = self.file_set();
        let mut edges = crate::edge_polls::polled_keys(&set);
        edges.retain(|_, shared| shared.fires.iter().any(|i| set.listens[*i].movement_name == movement));
        if edges.is_empty() {
            return Err(format!("no listen on a polled edge fires '{movement}': an edge is polled when its module declares `delivery: polled`"));
        }
        let mut fired = Fired::default();
        for (key, shared) in &edges {
            let polled = self.poll_edge_once(&set, key, shared, PolledRow::RunHere).await?;
            fired.outcomes.extend(polled.fired.outcomes);
            fired.redelivered.extend(polled.fired.redelivered);
            // Run here, then done; one that fails is left to a drain, a run
            // lease from now.
            if let Some(row) = polled.row {
                let (_, outcomes) = self.do_work(&set, &row.kind, &row.payload).await?;
                fired.outcomes.extend(outcomes);
                if let Err(error) = self.store.complete_key(&row.key) {
                    eprintln!("listen-fire: the row of a poll's arrivals was not completed ({error}): a drain runs it again a run lease from now, and it starts no run twice");
                }
            }
        }
        Ok(fired)
    }

    /// Start the run and step its first segment. With a `receipt` (the
    /// listen and the event's key), the receipt and the run are one write:
    /// None, and nothing run, for an event the listen has run before. The
    /// run names the delivery its event came in (`came_in`).
    #[allow(clippy::too_many_arguments)] // the file set it runs within, then the run's own inputs
    async fn run_listen(
        &self,
        set: &FileSet,
        run_id: &str,
        listen: &Listen,
        event: Js,
        dry_run: bool,
        receipt: Option<(&str, &str)>,
        came_in: CameIn<'_>,
    ) -> Result<Option<RunOutcome>, String> {
        let file = set.file(&listen.file);
        let fired_at = iso(0);
        let facts = RunFacts {
            source: file.source.clone(),
            language_version: self.project.language_version.clone(),
            event,
            movement_name: listen.movement_name.clone(),
            fired_at: fired_at.clone(),
            dry_run,
            trigger_mark: came_in.trigger_mark,
            chain: came_in.chain.to_vec(),
        };
        let input = facts.to_js().to_json();
        let start = RunStart { id: run_id, file: &file.name, movement: &facts.movement_name, started_at: &fired_at, input: &input, delivery_id: came_in.delivery_id, team_id: None };
        match receipt {
            None => self.store.start_run(&start).map_err(|e| e.to_string())?,
            Some((listen, key)) => {
                if !self.store.start_event_run(&EventReceipt::own(listen, key), &start).map_err(|e| e.to_string())? {
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
        let mut outcome = self.settled_outcome(run_id, "fired", tally.into_inner(), lease_lost?)?;
        if dry_run {
            outcome.captured = Some(captured.into_inner());
        }
        Ok(Some(outcome))
    }

    /// Run one segment and record what it came to on the run's row
    /// (`recordSegment`), in the segment's own commit. `completing` is the
    /// leaf whose own row goes after its step (None for a fresh firing).
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
        let (ran, committed) = self.segment(set, run_id, facts, fence, entry, completing).await?;
        let ran = match ran {
            Ok(ran) => ran,
            Err(Ended::LeaseLost) => return Ok(StepOutcome::LeaseLost),
            Err(Ended::Failed(message)) => {
                tally.borrow_mut().writes.extend(committed);
                return Ok(StepOutcome::Failed(message));
            }
        };
        if let Some(captured) = captured {
            captured.borrow_mut().extend(ran.captured.iter().cloned());
        }
        tally.borrow_mut().writes.extend(ran.write_records);
        if ran.cancelled {
            let reason = self.store.cancel_request(run_id).map_err(|e| e.to_string())?.flatten();
            return Ok(StepOutcome::Cancelled(reason));
        }
        Ok(match ran.parked_address {
            Some(address) => StepOutcome::Parked { address: Some(address) },
            None => StepOutcome::Completed,
        })
    }

    /// The run fails with `message`, the writes its failed segment had
    /// already made (`committed`) kept beside the ones before it: a rerun
    /// reads them to say what the failed attempt already did. A run already
    /// settled stays, as `mark_failed` leaves it.
    fn fail_keeping_writes(&self, run_id: &str, message: &str, committed: &[Js]) -> Result<(), String> {
        if !committed.is_empty()
            && let Some(row) = self.store.run(run_id).map_err(|e| e.to_string())?
            && (row.status == "running" || row.status == "parked")
        {
            let outcome = with_writes(row.outcome.as_deref(), committed.len(), committed.to_vec(), None);
            self.store.settle_run(run_id, &row.status, &outcome, &iso(0)).map_err(|e| e.to_string())?;
        }
        self.store.mark_failed(run_id, message).map_err(|e| e.to_string())
    }

    /// One engine segment of the run, entered as `entry`, under `fence`, and
    /// the record writes the systems took during it, whatever it came to.
    /// Its end is kept in one write with where it leaves the run: completed
    /// when nothing of it is left but `completing`, the leaf (or the race's
    /// frame) the segment stepped (a fresh firing steps none); else parked.
    async fn segment(
        &self,
        set: &FileSet,
        run_id: &str,
        facts: &RunFacts,
        fence: Option<&str>,
        entry: Entry,
        completing: Option<&str>,
    ) -> Result<(Result<Ran, Ended>, Vec<Js>), String> {
        let secrets = self.secrets();
        let externals = self.externals_in(set, &secrets);
        let segment_id = uuid::Uuid::new_v4().to_string();
        let (resumed_leaf, resumed_state) = match &entry {
            Entry::Resume { address, state, .. } => (Some(address.clone()), Some(state.clone())),
            _ => (None, None),
        };
        let settling_race = match &entry {
            Entry::Settle { frame_address, .. } => Some(frame_address.clone()),
            _ => None,
        };
        let mut adapters = SegmentAdapters::new(&segment_id, &externals);
        adapters.ledger = Some(crate::loop_breaker::Ledger {
            store: &*self.store,
            run_id: run_id.to_string(),
            depth: u32::try_from(facts.chain.len()).unwrap_or(u32::MAX),
            forget_before: iso(-crate::loop_breaker::kept_ms(&self.project, set)),
        });
        let host = SegmentHost::new(SegmentHostParts {
            segment_id: segment_id.clone(),
            run_id: run_id.to_string(),
            fence: fence.map(str::to_string),
            store: &*self.store,
            adapters,
            documents: &self.documents,
            user: self.user.clone(),
            resumed_leaf,
            resumed_state,
            settling_race,
            keeps_trace: true,
        });
        let input = SegmentInput {
            source: &facts.source,
            language_version: &facts.language_version,
            movement_name: Some(&facts.movement_name),
            event: &facts.event,
            fired_at: &facts.fired_at,
            catalog: &set.catalog,
            dry_run: facts.dry_run,
            trigger_mark: facts.trigger_mark,
            entry,
            cost_cap_microdollars: self.project.cost_cap_microdollars,
        };
        let ran = run_segment(&host, input).await;
        let committed = host.adapters.committed.take();
        let ran = self.end_segment(&host, ran, &committed, completing)?;
        Ok((ran, committed))
    }

    /// The records `walk`'s hops land on, and each earlier hop's
    /// (crate::segment::read_positions): walked through the engine as a
    /// run's walk is, against the set's connections, with no run row and
    /// nothing kept.
    pub async fn read_positions(&self, set: &FileSet, walk: Walk<'_>) -> Result<crate::segment::Walked, String> {
        let secrets = self.secrets();
        let externals = self.externals_in(set, &secrets);
        let segment_id = uuid::Uuid::new_v4().to_string();
        let host = SegmentHost::new(SegmentHostParts {
            segment_id: segment_id.clone(),
            run_id: format!("read:{segment_id}"),
            fence: None,
            store: &*self.store,
            adapters: SegmentAdapters::new(&segment_id, &externals),
            documents: &self.documents,
            user: self.user.clone(),
            resumed_leaf: None,
            resumed_state: None,
            settling_race: None,
            keeps_trace: false,
        });
        let fired_at = iso(0);
        let input = SegmentInput {
            source: walk.source,
            language_version: &self.project.language_version,
            movement_name: None,
            event: &Js::Obj(Obj::new()),
            fired_at: &fired_at,
            catalog: &set.catalog,
            dry_run: false,
            trigger_mark: None,
            entry: Entry::Walk { connection: walk.connection.to_string(), hops: walk.hops.to_vec(), limit: walk.limit },
            cost_cap_microdollars: self.project.cost_cap_microdollars,
        };
        crate::segment::read_positions(&host, input).await
    }

    /// The segment's commit, carrying where it leaves the run: a resumed
    /// leaf is finished in the same write that settles the run, so a crash
    /// leaves either both or neither (the leaf resumed again). A race its
    /// arm won and left to the run to settle is owed in that write, and the
    /// run is not completed while it owes one. A segment that fails its run
    /// keeps none of its parks, and owes nothing.
    fn end_segment(&self, host: &SegmentHost<'_>, ran: Result<Ran, Ended>, committed: &[Js], completing: Option<&str>) -> Result<Result<Ran, Ended>, String> {
        let run_id = host.run_id.as_str();
        let ran = match ran {
            Ok(ran) => ran,
            Err(Ended::LeaseLost) => return Ok(Err(Ended::LeaseLost)),
            Err(Ended::Failed(message)) => return self.end_failed_segment(host, message, committed),
        };
        let before = || -> Result<Option<String>, String> { Ok(self.store.run(run_id).map_err(|e| e.to_string())?.and_then(|row| row.outcome)) };
        let (status, outcome) = if ran.cancelled {
            let reason = self.store.cancel_request(run_id).map_err(|e| e.to_string())?.flatten();
            host.discard_progress();
            ("failed", failed_outcome(before()?.as_deref(), &[], reason.as_deref().unwrap_or(CANCELLED_BY_OPERATOR)))
        } else {
            let outcome = with_writes(before()?.as_deref(), ran.writes, ran.write_records.clone(), ran.returned.clone());
            let ends = ran.parked_address.is_none() && !host.holds_progress() && ran.deferred_race_frames.is_empty() && self.nothing_left(run_id, completing)?;
            (if ends { "completed" } else { "parked" }, outcome)
        };
        let at = iso(0);
        let settle = Some(RunSettle { status, outcome: &outcome, at: &at });
        let owed_races = if ran.cancelled { &[][..] } else { &ran.deferred_race_frames[..] };
        match commit(host, settle, owed_races) {
            Ok(()) => Ok(Ok(ran)),
            Err(Ended::LeaseLost) => Ok(Err(Ended::LeaseLost)),
            // Refused, or a replay that diverged: nothing was written.
            Err(Ended::Failed(message)) => {
                self.fail_keeping_writes(run_id, &message, committed)?;
                Ok(Err(Ended::Failed(message)))
            }
        }
    }

    /// A segment that failed its run: the failure, with the writes it made,
    /// kept in its commit beside the end of the leaf it resumed. A run
    /// already settled stays, as `mark_failed` leaves it.
    fn end_failed_segment(&self, host: &SegmentHost<'_>, message: String, committed: &[Js]) -> Result<Result<Ran, Ended>, String> {
        let run_id = host.run_id.as_str();
        host.discard_progress();
        let row = self.store.run(run_id).map_err(|e| e.to_string())?;
        let Some(row) = row.filter(|row| row.status == "running" || row.status == "parked") else { return Ok(Err(Ended::Failed(message))) };
        let outcome = failed_outcome(row.outcome.as_deref(), committed, &message);
        let at = iso(0);
        match commit(host, Some(RunSettle { status: "failed", outcome: &outcome, at: &at }), &[]) {
            Ok(()) => {}
            Err(Ended::LeaseLost) => return Ok(Err(Ended::LeaseLost)),
            Err(Ended::Failed(_)) => self.fail_keeping_writes(run_id, &message, committed)?,
        }
        Ok(Err(Ended::Failed(message)))
    }

    /// Whether nothing of the run is left but `completing`: no join waits,
    /// no other leaf is parked, and the run owes no other race.
    fn nothing_left(&self, run_id: &str, completing: Option<&str>) -> Result<bool, String> {
        match completing {
            None => run_quiescent(&*self.store, run_id),
            Some(leaf) => run_complete_without(&*self.store, run_id, leaf),
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
    /// run's lease (see `Parked`).
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
                Drain::Awaits(addresses) => drain_run(&*self.store, run_id, addresses, None, lease, &stepper).await?,
                Drain::OwedRaces => drain_run(&*self.store, run_id, &[], None, lease, &stepper).await?,
            };
            Ok(Some((stepper.tally.take(), lease_lost, stepper.rehearsed())))
        })
        .await?;
        let Some(held) = held else { return Ok(Parked::Busy) };
        let Some((tally, lease_lost, captured)) = held? else { return Ok(Parked::NotStepped) };
        if tally.stepped == 0 {
            return Ok(if lease_lost { Parked::LeaseLost(None) } else { Parked::NotStepped });
        }
        let mut outcome = Box::new(self.settled_outcome(run_id, "resumed", tally, lease_lost)?);
        outcome.captured = captured;
        Ok(if lease_lost { Parked::LeaseLost(Some(outcome)) } else { Parked::Stepped(outcome) })
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

    /// `listen-fire resume <run>`: every parked leaf of the run, now.
    pub async fn resume_run(&self, run_id: &str) -> Result<RunOutcome, String> {
        let row = self.store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
        if row.status != "parked" {
            return Err(format!("run {run_id} is {}, not parked", row.status));
        }
        match self.drive_parked_run(&self.file_set(), run_id, Drain::EveryParkedLeaf).await? {
            Parked::Busy | Parked::LeaseLost(None) => Err(run_busy(run_id)),
            Parked::NotStepped => Err(format!("run {run_id} is parked but has no parked leaf")),
            Parked::Stepped(outcome) | Parked::LeaseLost(Some(outcome)) => Ok(*outcome),
        }
    }

    /// `listen-fire runs rerun <run>`: a failed run run again as its next attempt —
    /// its own event, the movement as the project holds it now (a fix to it
    /// takes effect), from the start — under the run's lease, so two reruns
    /// at once run once. Refused when the run's latest attempt did not fail
    /// (a rerun after a rerun that succeeded runs nothing), when another listen-fire
    /// holds the run, and, unless `force`, when the failed attempt already
    /// committed writes (a rerun from the start makes them again).
    pub async fn rerun(&self, run_id: &str, force: bool) -> Result<Rerun, String> {
        let set = self.file_set();
        let row = self.store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
        if row.status != "failed" {
            return Ok(Rerun::Refused(RerunRefused::NotFailed { status: row.status, attempt: row.attempt }));
        }
        let tally = RefCell::new(Tally::default());
        let captured = RefCell::new(Vec::new());
        let held = with_run_lease(&*self.store, run_id, async |lease: &Lease| -> Result<Result<(i64, bool, bool), RerunRefused>, String> {
            let fence = Some(lease.token.as_str());
            // Read again under the lease: another rerun may have run it meanwhile.
            let row = self.store.run(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
            if row.status != "failed" {
                return Ok(Err(RerunRefused::NotFailed { status: row.status, attempt: row.attempt }));
            }
            let committed = committed_writes(row.outcome.as_deref());
            if !committed.is_empty() && !force {
                return Ok(Err(RerunRefused::CommittedWrites { attempt: row.attempt, writes: committed }));
            }
            let facts = self.rerun_facts(&set, &row)?;
            let input = facts.to_js().to_json();
            let rerun = crate::store::Rerun { input: &input, at: &facts.fired_at, fence: &lease.token };
            let Some(attempt) = self.store.rerun_run(run_id, &rerun).map_err(|e| e.to_string())? else {
                return Ok(Err(RerunRefused::NotFailed { status: row.status, attempt: row.attempt }));
            };
            let outcome = self.record_segment(&set, run_id, &facts, fence, &tally, facts.dry_run.then_some(&captured), Entry::Run, None).await?;
            if let Settled::Continue = after_step(&*self.store, run_id, fence, &outcome)? {
                clear_if_quiescent(&*self.store, run_id, fence)?;
            }
            Ok(Ok((attempt, outcome == StepOutcome::LeaseLost, facts.dry_run)))
        })
        .await?;
        let Some(ran) = held else { return Ok(Rerun::Refused(RerunRefused::Busy)) };
        let (attempt, lease_lost, dry_run) = match ran? {
            Ok(ran) => ran,
            Err(refused) => return Ok(Rerun::Refused(refused)),
        };
        let mut outcome = self.settled_outcome(run_id, "rerun", tally.into_inner(), lease_lost)?;
        if dry_run {
            outcome.captured = Some(captured.into_inner());
        }
        Ok(Rerun::Ran { attempt, outcome: Box::new(outcome) })
    }

    /// A rerun's facts: the run's own event, and the movement's file as the
    /// project holds it now, at this release's language. The file must still
    /// have a listen that fires the movement, and check clean.
    fn rerun_facts(&self, set: &FileSet, row: &crate::store::RunRow) -> Result<RunFacts, String> {
        if !set.listens.iter().any(|l| l.file == row.file && l.movement_name == row.movement) {
            return Err(format!("run {}: no listen in {} fires {} now, so there is nothing to rerun it on", row.id, row.file, row.movement));
        }
        if let Some(errors) = file_errors(set)?.get(&row.file).filter(|n| **n > 0) {
            return Err(format!("run {}: {} has {errors} check error(s); fix them (listen-fire check), then rerun", row.id, row.file));
        }
        let first = Js::parse(row.input.as_bytes()).map_err(|e| format!("run {}: its facts are not JSON: {e}", row.id))?;
        Ok(RunFacts {
            source: set.file(&row.file).source.clone(),
            language_version: self.project.language_version.clone(),
            event: first.get("event").cloned().unwrap_or(Js::Null),
            movement_name: row.movement.clone(),
            fired_at: iso(0),
            dry_run: first.get("dryRun") == Some(&Js::Bool(true)),
            trigger_mark: None,
            chain: crate::loop_breaker::chain_in(&first),
        })
    }

    /// `listen-fire resume` with no run: drain the due work (the waits an
    /// arrival woke among it), then step what is due in every parked run:
    /// its timers that have come. A timer not yet due stays parked, so a timeout arm
    /// beside an approval never fires early; `listen-fire resume <run>` runs a run's
    /// every leaf out.
    pub async fn resume_all(&self, log: &mut impl Write) -> Result<Vec<RunOutcome>, String> {
        let set = self.file_set();
        let (_, mut outcomes) = self.drain_work_in(&set, WORK_ROWS_PER_DRAIN, log).await?;
        for run_id in self.parked_runs()? {
            match self.drive_parked_run(&set, &run_id, Drain::DueTimers).await? {
                Parked::Busy => return Err(run_busy(&run_id)),
                Parked::NotStepped | Parked::LeaseLost(None) => {}
                Parked::Stepped(outcome) | Parked::LeaseLost(Some(outcome)) => outcomes.push(*outcome),
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
        self.follow_kept_heads(set).await?;
        let mut outcomes = Vec::new();
        if self.pool.takes(EDGE_POLL_WORK_KIND) {
            self.arm_edge_polls(set)?;
        }
        if self.pool.takes(crate::resolve::RESOLVE_WORK_KIND) {
            self.arm_resolves(set)?;
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
    /// and arrival retention sweeps, at most once per LOST_RUN_SWEEP_EVERY.
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
        self.store.sweep_arrivals(WORK_ROWS_PER_DRAIN, None).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// One work row's work, as a worker that claimed it runs it: the runs
    /// it stepped.
    #[cfg(test)]
    pub(crate) async fn work_row(&self, kind: &str, payload: &Js) -> Result<Vec<RunOutcome>, String> {
        Ok(self.do_work(&self.file_set(), kind, payload).await?.1)
    }

    async fn do_work(&self, set: &FileSet, kind: &str, payload: &Js) -> Result<(Next, Vec<RunOutcome>), String> {
        let text = |k: &str| payload.get(k).and_then(Js::as_str).map(str::to_string).ok_or_else(|| format!("a {kind} row has no {k}"));
        match kind {
            "fire_event" if payload.get("arrivals").is_some() => {
                let external = text("external")?;
                let arrivals = crate::arrivals::arrivals_of(payload).map_err(|e| format!("a fire_event row's {e}"))?;
                let delivery_id = payload.get("deliveryId").and_then(Js::as_str);
                let delivered = Delivered::of_row(payload, delivery_id);
                let fired = match payload.get("polled").and_then(Js::as_str) {
                    Some(subscription) => self.fire_polled(&external, &arrivals, delivered, subscription).await?,
                    None => self.fire_arrivals(&external, &arrivals, delivered).await?,
                };
                for line in &fired.redelivered {
                    eprintln!("listen-fire: {line}");
                }
                Ok((Next::Done, fired.outcomes))
            }
            // A row queued before 0.13 for a listen in the settings form.
            "fire_event" => {
                eprintln!("listen-fire: {}", retired_event_line(&text("external")?));
                Ok((Next::Done, Vec::new()))
            }
            "resume_timer" => {
                let run_id = text("runId")?;
                if self.store.run(&run_id).map_err(|e| e.to_string())?.is_none() {
                    return Ok((Next::Done, Vec::new()));
                }
                Ok(self.drive_parked_run(set, &run_id, Drain::DueTimers).await?.row_next())
            }
            // A wait an arrival answered: its run re-enters the await parked
            // at the wait's address, which reads the arrival.
            "wake_await" if payload.get("waitId").is_some() => {
                let run_id = text("runId")?;
                if self.store.run(&run_id).map_err(|e| e.to_string())?.is_none() {
                    return Ok((Next::Done, Vec::new()));
                }
                Ok(self.drive_parked_run(set, &run_id, Drain::Awaits(vec![text("address")?])).await?.row_next())
            }
            // A race an arm won and left to its run to settle: the run is
            // driven with nothing to resume, so its drain settles what the
            // run owes. A row whose race was settled meanwhile finds it
            // owed no more, and steps nothing.
            SETTLE_RACE_WORK_KIND => {
                let run_id = text("runId")?;
                if self.store.run(&run_id).map_err(|e| e.to_string())?.is_none() {
                    return Ok((Next::Done, Vec::new()));
                }
                Ok(self.drive_parked_run(set, &run_id, Drain::OwedRaces).await?.row_next())
            }
            EDGE_POLL_WORK_KIND => self.poll_edge_row(set, &text("subscription")?).await,
            crate::resolve::RESOLVE_WORK_KIND => self.resolve_row(set, &text("pipeline")?).await,
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
    /// Its run was held elsewhere, or taken over while its drain ran, or
    /// its listen's resolve was held elsewhere: tried again shortly.
    Busy,
    /// Kept, due again then (a polled listen's next poll).
    DueAt(String),
}

/// Which of a parked run's leaves a drain steps.
enum Drain {
    EveryParkedLeaf,
    DueTimers,
    /// The awaits a wake names: arrivals landed on their waits.
    Awaits(Vec<String>),
    /// No leaf: only the races the run owes (as every drain ends).
    OwedRaces,
}

/// What driving a parked run came to.
enum Parked {
    /// Another process held the run's lease.
    Busy,
    /// The run was not parked, or none of its leaves was stepped.
    NotStepped,
    Stepped(Box<RunOutcome>),
    /// The run's lease went to another process inside the drain, with what
    /// was stepped before it went. That holder's lease claim parked the leaf
    /// this drain claimed again, and nothing else will wake it.
    LeaseLost(Option<Box<RunOutcome>>),
}

impl Parked {
    /// What becomes of the work row that drove the run. A row whose drain
    /// lost the lease is released, not completed: completing it would leave
    /// the leaf parked again with no row to wake it (and, for a
    /// `settle_race` row, would delete the race the run owes).
    fn row_next(self) -> (Next, Vec<RunOutcome>) {
        match self {
            Parked::Busy | Parked::LeaseLost(None) => (Next::Busy, Vec::new()),
            Parked::LeaseLost(Some(outcome)) => (Next::Busy, vec![*outcome]),
            Parked::NotStepped => (Next::Done, Vec::new()),
            Parked::Stepped(outcome) => (Next::Done, vec![*outcome]),
        }
    }
}

fn run_busy(run_id: &str) -> String {
    format!("run {run_id} is being stepped by another listen-fire process right now; try again in a moment")
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
            StepRequest::Leaf { address, state, reenter } => Entry::Resume { address, state, reenter },
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
const KEPT: &str = "movements: kept the files listen-fire has;";

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

/// Why a set does not check: each of its files' check errors, as `listen-fire
/// check` prints it, then each listen that would never fire
/// (crate::routing::Listens::unwatched). Empty for a set that checks.
fn not_checking(files: &[MovementFile], parsed: &[Rc<Parsed>], catalog: &Js, unwatched: Vec<String>) -> Result<Vec<String>, String> {
    let mut why = Vec::new();
    for (file, errors) in files.iter().zip(error_diagnostics(files, parsed, catalog)?) {
        why.extend(errors.iter().map(|d| crate::check::diagnostic_line(&file.path, d)));
    }
    why.extend(unwatched);
    Ok(why)
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
/// the files (path, version) listen-fire last saw listed. An add or a change without
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
    /// `listen-fire serve` and `listen-fire drain`'s one refresher, for the process's life:
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
    /// One that does not check (any check error, or a listen that would
    /// never fire) keeps the running set, said once; work begun before a
    /// swap finishes on the files it began with.
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
        let crate::routing::Listens { listens, unwatched } = crate::routing::listens_across(&parsed, &catalog);
        let why = not_checking(&files, &parsed, &catalog, unwatched)?;
        if !why.is_empty() {
            return self.refuse(log, pairs, why);
        }
            let _holds = hold_all(&running, self.role.keep());
        let taken = Rc::new(FileSet { files, parsed, catalog, listens, watching: Default::default(), running, schemas, _holds });
        for line in crate::resolve::open(self, &taken, crate::resolve::Opening::Reloaded).await? {
            let _ = writeln!(log, "listen-fire: {line}");
        }
        self.file_set.replace(taken.clone());
        crate::records_door::install(self.store.clone(), crate::loop_breaker::kept_ms(&self.project, &taken));
        self.refused.replace(None);
        drop(starting);
        for line in changed.into_iter().chain(dropped).chain(started) {
            let _ = writeln!(log, "{line}");
        }
        // A polled edge no listen shares any more forgets its cursor: a
        // listen that returns to it (a cron schedule put back) is then seen
        // for the first time, and owes nothing.
        let polled = |s: &FileSet| crate::edge_polls::polled_keys(s).keys().map(crate::edge_polls::poll_subscription).collect::<BTreeSet<_>>();
        for left in polled(&set).difference(&polled(&taken)) {
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
        let _ = writeln!(log, "{RUN_CHECK}");
        Ok(())
    }
}

// ── Rerun ───────────────────────────────────────────────────────────────────

/// What `listen-fire runs rerun` came to.
pub enum Rerun {
    /// The run ran again as `attempt`.
    Ran { attempt: i64, outcome: Box<RunOutcome> },
    Refused(RerunRefused),
}

/// Why a rerun ran nothing.
pub enum RerunRefused {
    /// The run's latest attempt did not fail.
    NotFailed { status: String, attempt: i64 },
    /// Another listen-fire process holds the run.
    Busy,
    /// The failed attempt committed these writes before it failed.
    CommittedWrites { attempt: i64, writes: Vec<Js> },
}

impl RerunRefused {
    /// Its name in `--json` (`refused`).
    pub fn kind(&self) -> &'static str {
        match self {
            RerunRefused::NotFailed { .. } => "notFailed",
            RerunRefused::Busy => "busy",
            RerunRefused::CommittedWrites { .. } => "committedWrites",
        }
    }

    pub fn message(&self, run_id: &str) -> String {
        match self {
            RerunRefused::NotFailed { status, attempt } => match status.as_str() {
                "completed" => format!("run {run_id} succeeded on attempt {attempt}; nothing to rerun"),
                other => format!("run {run_id} is {other} on attempt {attempt}; only a failed run is rerun"),
            },
            RerunRefused::Busy => format!("run {run_id} is held by another listen-fire process; it is being stepped or rerun there"),
            RerunRefused::CommittedWrites { attempt, writes } => {
                let mut message = format!("run {run_id}: attempt {attempt} committed {} write(s) before it failed, which a rerun from the start makes again:", writes.len());
                for write in writes {
                    message.push_str(&format!("\n  {}", write_line(write)));
                }
                message.push_str(&format!("\nrerun it anyway with listen-fire runs rerun {run_id} --force"));
                message
            }
        }
    }
}

/// One write as a refusal lists it: `<adapter> <record type> <record id>: <action>`.
fn write_line(write: &Js) -> String {
    let text = |key: &str| match write.get(key) {
        Some(Js::Str(s)) => s.clone(),
        Some(Js::Null) | None => "?".into(),
        Some(other) => other.to_json(),
    };
    format!("{} {} {}: {}", text("adapter"), text("recordType"), text("recordId"), text("action"))
}

/// The writes a settled outcome lists as committed.
fn committed_writes(outcome: Option<&str>) -> Vec<Js> {
    let outcome = outcome.and_then(|text| Js::parse(text.as_bytes()).ok()).unwrap_or(Js::Null);
    outcome.get("writeRecords").and_then(Js::as_array).unwrap_or(&[]).iter().filter(|w| w.get("committed") == Some(&Js::Bool(true))).cloned().collect()
}

// ── Cancel ──────────────────────────────────────────────────────────────────

/// What `listen-fire cancel` came to (`CancelOutcome`).
pub enum Cancelled {
    /// The run was not being stepped: it is settled failed now.
    Now,
    /// Another listen-fire process is stepping it: its segment stops at the next
    /// statement boundary, and the run settles failed there.
    Requested,
}

/// `listen-fire cancel <run>` (`cancelRun`): stamp the operator's request on the run's
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

/// `report`: each outcome's line, its error, what it returned, and a line
/// per write as `runs show` lists it (a dry run's marked not committed);
/// the exit code 1 when any failed.
pub fn report(outcomes: &[RunOutcome], results: Results, out: &mut impl Write) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    if outcomes.is_empty() {
        writeln!(out, "no listen matched").map_err(io)?;
    }
    let mut cut = false;
    for o in outcomes {
        let entries = if o.trace_entries == 1 { "entry" } else { "entries" };
        let error = o.error.as_ref().map(|e| format!("\n  {e}")).unwrap_or_default();
        writeln!(out, "run {} {}:{} {} — {} write(s), {} trace {entries}{error}", o.run_id, o.file, o.movement, o.status, o.writes.len(), o.trace_entries).map_err(io)?;
        if results == Results::Shown {
            if let Some(value) = &o.returned {
                writeln!(out, "  {}", crate::returned::shown(value)).map_err(io)?;
            }
            for write in o.writes.iter().take(LISTED_WRITES) {
                writeln!(out, "  {}", crate::run_show::write_line(write, &mut cut)).map_err(io)?;
            }
            if o.writes.len() > LISTED_WRITES {
                writeln!(out, "  … and {} more write(s), which the run's history counts but does not list", o.writes.len() - LISTED_WRITES).map_err(io)?;
            }
        }
    }
    if cut {
        writeln!(out, "{}", crate::run_show::cut_note()).map_err(io)?;
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
/// delivery is kept (`listen-fire deliveries` lists it) and ran nothing.
/// What an event comes to now that 0.13 retired the settings listen it
/// fired: nothing. A module that still answers events, or a row queued
/// before 0.13, is told so where it is read, never dropped silently.
pub fn retired_event_line(external: &str) -> String {
    format!("{external} delivered an event, which only a listen in the settings form heard, retired in 0.13: it runs nothing — a module delivers arrivals on its listenable edges")
}

#[cfg(test)]
mod tests {
    /// A replay's row says it is one, so a drain that takes it (its
    /// process died) still judges its listen alone; a forced one takes a
    /// receipt of its own, and a listen that still cannot judge it names the
    /// delivery that keeps the request.
    #[test]
    fn a_replay_row_reads_back_as_the_replay_it_is() {
        use super::{Delivered, Replay};
        use crate::json::Js;
        let mut row = crate::json::Obj::new();
        let replay = Replay { of: "d-1", attempt: 2, again: true };
        Delivered { replay: Some(replay), ..Delivered::default() }.write_into(&mut row);
        let row = Js::Obj(row);
        let read = Delivered::of_row(&row, Some("d-2"));
        assert_eq!(read.replay, Some(replay));
        assert_eq!(read.attempt(), 2);
        assert_eq!(read.claimed("Messages:C1:C1:1700.1:"), "Messages:C1:C1:1700.1:#replay:d-2");
        let unforced = Delivered { replay: Some(Replay { again: false, ..replay }), ..read };
        assert_eq!(unforced.claimed("Messages:C1:C1:1700.1:"), "Messages:C1:C1:1700.1:", "the listen's own receipt: one that ran it runs nothing");
        assert_eq!(Delivered::default().attempt(), 0, "a delivery's own judging");
    }

    fn facts_with(pin: &str) -> String {
        format!(r#"{{"source":"s","languageVersion":{pin},"movementName":"m","firedAt":"t"}}"#)
    }

    #[test]
    fn a_stored_pin_resumes_by_its_standing_and_an_old_integer_is_read_once() {
        let version = |pin: &str| RunFacts::of_row("r", &facts_with(pin)).map(|f| f.language_version);
        assert_eq!(version(&format!("\"{LANGUAGE_VERSION}\"")), Ok(LANGUAGE_VERSION.to_string()));
        assert_eq!(version("5"), Ok(LANGUAGE_VERSION.to_string()));
        let pins = crate::project::pins_against_this_release();
        assert!(version(&format!("\"{}\"", pins.newer)).unwrap_err().contains("newer than this listen-fire"));
        assert!(version(&format!("\"{}\"", pins.older_key)).unwrap_err().contains("upgrade its movement and fire it again"));
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
            let session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role: Role::Command, routes_listens: false }).await.unwrap();
            let row = |delivery_id: Option<&str>| {
                let arrival = crate::units::invocation(&iso(0), &session.user, None);
                let mut payload = obj! { "external" => Js::str(crate::units::MANUAL), "arrivals" => Js::Arr(vec![arrival]) };
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
            let said = "movements: kept the files listen-fire has; the movements module did not answer watch: the movements module acme: movements.watch: could not be reached\n";
            let pause = Some(session.watch_pause);
            assert_eq!(step(session, &store, &mut cursor).await, (pause, said.to_string()));
            assert_eq!(step(session, &store, &mut cursor).await, (pause, String::new()), "said once");
            assert_eq!(cursor.as_deref(), Some("e:0"), "retried with the same cursor");
            assert_eq!(step(session, &store, &mut cursor).await, (pause, String::new()), "an empty answer at once: the pause");
            assert_eq!(cursor.as_deref(), Some("e:1"));
            assert_eq!(step(session, &store, &mut cursor).await, (pause, said.to_string()), "said again after an answer");
            let malformed = Scripted::over(&root, vec![Err(crate::movements_slot::watched_of("the movements module acme", &Js::parse(br#"{"secret":"text"}"#).unwrap()).unwrap_err())]);
            let (_, log) = step(session, &malformed, &mut cursor).await;
            assert_eq!(log, "movements: kept the files listen-fire has; the movements module did not answer watch: the movements module acme: movements.watch answered an object with secret, not the slot's shape\n", "named by its shape");
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
        format!("import {{ {name} }} from adapters\nimport {{ {name} as cred }} from credentials\n\ncrm = connect {name} using cred\n\nfunction welcome(company: <crm-[:Company]->>) {{\n  write crm-[:Company]-> {{ Name: \"Welcome ${{company.Name}}\" }}\n}}\n\nlisten to crm-[:Company]-> fire welcome\n")
    }

    /// `body` on a session over `root` opened as `role`.
    fn with_session_as(root: &std::path::Path, role: Role, body: impl AsyncFnOnce(&mut Session)) {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async {
            let project = crate::project::load_project(root).unwrap();
            let mut session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role, routes_listens: false }).await.unwrap();
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
            let session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role: Role::Drain, routes_listens: false }).await.unwrap();
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
            assert!(log.starts_with("movements: kept the files listen-fire has; the new ones do not check:\n"), "{log}");
            assert!(!crate::module_hosts::external_is_running("acme_h"), "the module only the refused set imported was stopped with it");
            assert!(crate::module_hosts::external_is_running("acme_g"), "the running set's module runs on");
        });
    }

    /// A session over `root`, opened as `role`, routing the listens or not.
    async fn open_at(root: &std::path::Path, role: Role, routes_listens: bool) -> Result<Session, String> {
        let project = crate::project::load_project(root).unwrap();
        open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role, routes_listens }).await
    }

    /// `body` on one thread, as listen-fire serve runs a session; `root` removed after.
    fn on_one_thread(root: &std::path::Path, body: impl AsyncFnOnce()) {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, body());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_reload_whose_listen_on_a_traversal_does_not_check_is_refused_naming_it_and_the_running_listens_kept() {
        let root = acme_project(&["acme_i"], "0");
        on_one_thread(&root.clone(), async || {
            let session = open_at(&root, Role::Serve, true).await.unwrap();
            put(&root, "acme_i.mvt", &format!("{}listen to crm-[c:Company WHERE c.Bogus == \"x\"]-> fire welcome\n", acme_movement("acme_i")));
            let log = refreshed(&session).await;
            let lines: Vec<&str> = log.lines().collect();
            assert_eq!(lines[0], "movements: kept the files listen-fire has; the new ones do not check:", "{log}");
            assert!(lines[1].contains("acme_i.mvt:11:11 error MOV_UNKNOWN_PROPERTY "), "the check's own error first: {log}");
            assert!(lines.iter().any(|l| l.ends_with("/acme_i.mvt:11:1 the listen that fires welcome does not check, so nothing would fire it")), "{log}");
            assert_eq!(lines.last(), Some(&RUN_CHECK), "{log}");
            let kept = session.file_set();
            let served: Vec<&str> = kept.listens.iter().map(|l| l.file.as_str()).collect();
            assert_eq!(served, ["acme_i", "hello"], "the running set's listens are still served");
        });
    }

    #[test]
    fn a_session_that_routes_refuses_a_project_with_a_check_error_and_one_that_runs_a_function_opens_it() {
        let broken = "function other(run: <manual-[:Invocations]->>) {\n  return nowhere.Name\n}\nlisten to manual-[:Invocations]-> fire other\n";
        let root = refresh_project(&[("hello.mvt", MANUAL_V1), ("broken.mvt", broken)]);
        on_one_thread(&root.clone(), async || {
            let refused = open_at(&root, Role::Serve, true).await.err().expect("serving a project that does not check is refused");
            let lines: Vec<&str> = refused.lines().collect();
            assert!(lines.len() >= 2 && lines[..lines.len() - 1].iter().all(|l| l.contains("broken.mvt:2:") && l.contains(" error ")), "{refused}");
            assert_eq!(lines.last(), Some(&RUN_CHECK), "{refused}");
            assert!(open_at(&root, Role::Drain, true).await.is_err(), "nor is draining it");
            let session = open_at(&root, Role::Command, false).await.unwrap();
            assert_eq!(returns(&session, "hello").await, "v1", "a run of a function that checks");
        });
    }

    #[test]
    fn a_run_of_a_function_keeps_the_listens_that_check_of_a_project_whose_listen_on_a_traversal_does_not() {
        let watching = "function tick(run: <manual-[:Invocations]->>) {\n  return \"ticked\"\n}\nlisten to manual-[:Invocations]-> fire tick\nlisten to crm-[:Company]-> fire tick\n";
        let root = refresh_project(&[("hello.mvt", MANUAL_V1), ("watching.mvt", watching)]);
        on_one_thread(&root.clone(), async || {
            let refused = open_at(&root, Role::Serve, true).await.err().expect("serving it is refused");
            assert!(refused.lines().any(|l| l.ends_with("/watching.mvt:5:1 the listen that fires tick does not check, so nothing would fire it")), "{refused}");
            let session = open_at(&root, Role::Command, false).await.unwrap();
            assert_eq!(returns(&session, "hello").await, "v1", "a function of another file runs");
            let set = session.file_set();
            let read: Vec<(&str, &str)> = set.listens.iter().map(|l| (l.file.as_str(), l.movement_name.as_str())).collect();
            assert_eq!(read, [("hello", "hello"), ("watching", "tick")], "the file's listen that checks is read beside the one that does not");
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
        text.push_str(&format!("function {name}(run: <manual-[:Invocations]->>) {{\n  return {name}_step0(\"{name}\")\n}}\n\nlisten to manual-[:Invocations]-> fire {name}\n"));
        text
    }

    /// The refresh's and a run's cost over a 200-file set: run with
    /// `cargo test --release -p listen-fire --bin listen-fire -- --ignored --nocapture measure_a_large_set`.
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
            let session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role: Role::Command, routes_listens: false }).await.unwrap();
            eprintln!("open: {:?}", opened.elapsed());
            // Warm: the first refresh, untimed.
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

    const MANUAL_V1: &str = "function hello(run: <manual-[:Invocations]->>) {\n  return \"v1\"\n}\nlisten to manual-[:Invocations]-> fire hello\n";

    /// A started project (`listen-fire init`, its own empty secrets) with `files`
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

    /// `body` on a session over `root`, as listen-fire serve runs one: one thread, one LocalSet.
    fn with_session(root: &std::path::Path, body: impl AsyncFnOnce(&mut Session)) {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, async {
            let project = crate::project::load_project(root).unwrap();
            let mut session = open_session(project, &Opening { ephemeral: false, store: &StoreSpec::Sqlite(root.join(".lf/state.db")), role: Role::Command, routes_listens: false }).await.unwrap();
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
            put(&root, "other.mvt", "import { greet } from \"lib/greet\"\n\nfunction other(run: <manual-[:Invocations]->>) {\n  return greet(\"o\")\n}\nlisten to manual-[:Invocations]-> fire other\n");
            assert_eq!(refreshed(session).await, "movements: lib/greet.mvt added\nmovements: other.mvt changed\n");
            put(&root, "lib/greet.mvt", "export function greet(name: <number>) {\n  return name\n}\n");
            let log = refreshed(session).await;
            assert!(log.starts_with("movements: kept the files listen-fire has; the new ones do not check:\n") && log.contains("other.mvt:"), "{log}");
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

    /// A cron's shared poll is next due at its schedule's next tick when that
    /// comes within the poll's interval, so `serve` (draining every second)
    /// fires it on time and a drain's wake slot is told that time; with no
    /// tick near, at one interval, as before, never sooner.
    #[test]
    fn a_crons_poll_is_next_due_at_its_next_tick_within_its_interval() {
        let ticking = |schedule: &str| format!("function tock(t: <cron-[:Ticks]->>) {{\n  fail(\"tick ${{t.`Fired at`}}\")\n}}\nlisten to cron-[t:Ticks WHERE t.Schedule == \"{schedule}\"]-> fire tock\n");
        // The clock read 15 seconds before a minute's start.
        let ahead = |real: i64| (45_000 - real.rem_euclid(60_000)).rem_euclid(60_000);
        let next_due = |wake: &crate::wake::tests::Recording| {
            wake.told.borrow().iter().filter(|(_, kind)| kind == EDGE_POLL_WORK_KIND).find_map(|(when, _)| match when {
                crate::wake::When::At(at) => Some(*at),
                crate::wake::When::Now => None,
            })
        };
        let root = refresh_project(&[("tick.mvt", &ticking("* * * * *"))]);
        with_session(&root.clone(), async |session| {
            session.judge_due_ahead(ahead(crate::limiter::now_ms()));
            let wake = crate::wake::tests::recording();
            session.drain_work(WORK_ROWS_PER_DRAIN, &mut Vec::new()).await.unwrap();
            let now = session.now_ms();
            assert_eq!(next_due(&wake), Some(now - now.rem_euclid(60_000) + 60_000), "the arming poll says the next minute's start");
            crate::wake::install(None);
        });
        // An hourly schedule half an hour off: polled on its interval, a minute on.
        let real = crate::limiter::now_ms();
        let minute = ((real + ahead(real)) / 60_000 + 30).rem_euclid(60);
        let root = refresh_project(&[("tick.mvt", &ticking(&format!("{minute} * * * *")))]);
        with_session(&root.clone(), async |session| {
            session.judge_due_ahead(ahead(crate::limiter::now_ms()));
            let wake = crate::wake::tests::recording();
            let before = session.now_ms();
            session.drain_work(WORK_ROWS_PER_DRAIN, &mut Vec::new()).await.unwrap();
            let after = session.now_ms();
            let due = next_due(&wake).expect("the poll was released for its next");
            assert!((before + 60_000..=after + 60_000).contains(&due), "one interval on: {due} after {before}..{after}");
            crate::wake::install(None);
        });
    }

    #[test]
    fn a_removed_files_cron_stops_and_its_parked_run_still_resumes() {
        let tick = "function tock(t: <cron-[:Ticks]->>) {\n  fail(\"tick ${t.`Fired at`} on ${t.`Schedule`}\")\n}\nlisten to cron-[t:Ticks WHERE t.Schedule == \"* * * * *\"]-> fire tock\n";
        let nap = "function nap(run: <manual-[:Invocations]->>) {\n  await sleep(1h)\n  return \"woke\"\n}\nlisten to manual-[:Invocations]-> fire nap\n";
        let root = refresh_project(&[("tick.mvt", tick), ("nap.mvt", nap)]);
        with_session(&root.clone(), async |session| {
            let keys = crate::edge_polls::polled_keys(&session.file_set());
            assert_eq!(keys.keys().map(|k| (k.adapter.as_str(), k.edge.as_str())).collect::<Vec<_>>(), [("cron", "Ticks")], "the cron listen's ticks are one shared poll");
            let subscription = &crate::edge_polls::poll_subscription(keys.keys().next().unwrap());
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
            assert_eq!(lines[0], "movements: kept the files listen-fire has; the new ones do not check:", "{log}");
            assert!(lines[1].contains("hello.mvt:") && lines[1].contains(" error MOV_PARSE "), "{log}");
            assert_eq!(returns(session, "hello").await, "v1", "the previous text runs");
            assert_eq!(refreshed(session).await, "", "warned once");

            put(&root, "hello.mvt", &MANUAL_V1.replace("v1", "v3"));
            assert_eq!(refreshed(session).await, "movements: hello.mvt changed\n");
            assert_eq!(returns(session, "hello").await, "v3");

            put(&root, "lib/greet.mvt", "export function greet(name: <text>) {\n  return \"Hello, ${name}!\"\n}\n");
            put(&root, "hello.mvt", "import { greet } from \"lib/greet\"\n\nfunction hello(run: <manual-[:Invocations]->>) {\n  return greet(\"v4\")\n}\nlisten to manual-[:Invocations]-> fire hello\n");
            assert_eq!(refreshed(session).await, "movements: hello.mvt changed\nmovements: lib/greet.mvt added\n");
            assert_eq!(returns(session, "hello").await, "Hello, v4!");

            put(&root, "lib/greet.mvt", "export function greet(name: <number>) {\n  return \"Hello, ${name}!\"\n}\n");
            let log = refreshed(session).await;
            assert!(log.starts_with("movements: kept the files listen-fire has; the new ones do not check:\n"), "{log}");
            let named: Vec<&str> = log.lines().skip(1).filter(|l| *l != RUN_CHECK).collect();
            assert!(!named.is_empty() && named.iter().all(|l| l.contains("hello.mvt:")), "the importer it breaks is named: {log}");
            assert_eq!(returns(session, "hello").await, "Hello, v4!", "the set that checked runs on");
        });
    }
}

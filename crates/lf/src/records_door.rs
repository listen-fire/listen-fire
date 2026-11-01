//! The records door (docs/contracts/system-events.md, "The records door"):
//! facts about this host's runs and waits, read by a module listen-fire
//! started, at `{host}/api/public/adapter/{module}/records` under the host
//! token, beside the models, OCR and limits doors. It names no event kind:
//! which facts are events, and what they say, is the reading module's
//! (`@lf/system`).
//!
//! Every fact about a run it hands out is also kept in the write ledger
//! (crate::loop_breaker) as a write of that run, about the host's own
//! record of it (`Run`, its id), at the run's place in its chain: an
//! arrival a module reports `about` that run continues its chain, so a
//! failure handler failing on another's failures is a chain `loopDepth`
//! caps. Kept as the door reads it, not as each writer marks a run, because
//! a run is failed and a wait stranded by many writers, and the door is the
//! one place every such fact passes.
//!
//! The row is stamped with when the door hands the fact out, not with when
//! the fact happened: the module reports the event within the loop window
//! and the slowest poll of that moment, the bound every module's writes are
//! kept for, whatever its settle lag or however old the fact was. (A row
//! stamped with the fact's time could be swept before its event is judged.)
//! The door sweeps with the same bound as it keeps, so a project whose runs
//! write no records does not grow the ledger for good.

use std::cell::RefCell;
use std::rc::Rc;

use crate::backend::RunHostStore;
use crate::json::Js;
use crate::loop_breaker::LedgerWrite;
use crate::obj;
use crate::store::{Result, RunRow, Store, StoreError};
use crate::waits::{StrandedAfter, StrandedOf};

/// The door's last path segment: `{host}/api/public/adapter/{module}/records`.
pub const DOOR_VERB: &str = "records";

/// The most rows one read answers, whatever it asks.
const MOST_ROWS: i64 = 500;

/// Where a page of failed runs left off: its last run.
pub struct RunAfter<'a> {
    pub at: &'a str,
    pub run_id: &'a str,
}

/// A page of failed runs (`runs.failed`): failed after `after`, no later
/// than `until`, oldest first (ties by id).
pub struct FailedPage<'a> {
    pub after: Option<RunAfter<'a>>,
    pub until: &'a str,
    pub limit: i64,
}

/// A release the store was opened under, and when it first was.
#[derive(Debug, Clone, PartialEq)]
pub struct SeenRelease {
    pub version: String,
    pub at: String,
}

/// Where a page of releases left off: its last release.
pub struct ReleaseAfter<'a> {
    pub at: &'a str,
    pub version: &'a str,
}

/// A listen that could not judge an arrival (`unjudged.note`): its filter
/// reads a field the arrival's module could not read, or the arrival lacks a
/// record the filter reads. Kept once per listen and arrival: a redelivery,
/// or a drain running its row again, keeps nothing more.
#[derive(Debug, Clone, PartialEq)]
pub struct UnjudgedArrival {
    /// The listen, by its pipeline (crate::routing::Listen::pipeline).
    pub pipeline: String,
    /// The arrival, as the listen's receipt names it
    /// (crate::arrivals::arrival_receipt_key): its edge, record, identity and
    /// version.
    pub arrival: String,
    pub file: String,
    pub movement: String,
    /// The kept delivery it came in; None for one kept as no delivery.
    pub delivery_id: Option<String>,
    pub edge: String,
    /// The record that landed, when it names one.
    pub record_id: Option<String>,
    /// Why the listen could not judge it, as the judge said.
    pub reason: String,
    /// The run whose write caused the arrival (crate::loop_breaker), when
    /// one did: a run fired by the report continues its chain.
    pub cause: Option<String>,
    /// When the host found it could not judge it.
    pub at: String,
}

/// Where a page of unjudged arrivals left off: its last one.
pub struct UnjudgedAfter<'a> {
    pub at: &'a str,
    pub pipeline: &'a str,
    pub arrival: &'a str,
}

impl UnjudgedArrival {
    /// As the store slot and the records door carry it.
    pub fn to_js(&self) -> Js {
        let opt = |value: &Option<String>| value.as_deref().map_or(Js::Null, Js::str);
        Js::Obj(obj! {
            "pipeline" => Js::str(&self.pipeline),
            "arrival" => Js::str(&self.arrival),
            "file" => Js::str(&self.file),
            "movement" => Js::str(&self.movement),
            "deliveryId" => opt(&self.delivery_id),
            "edge" => Js::str(&self.edge),
            "recordId" => opt(&self.record_id),
            "reason" => Js::str(&self.reason),
            "cause" => opt(&self.cause),
            "at" => Js::str(&self.at),
        })
    }

    /// One read back off the store slot's wire; None when it is not one.
    pub fn from_js(value: &Js) -> Option<UnjudgedArrival> {
        let text = |key: &str| value.get(key).and_then(Js::as_str).map(str::to_string);
        let opt = |key: &str| match value.get(key) {
            None | Some(Js::Null) => Some(None),
            Some(Js::Str(text)) => Some(Some(text.to_string())),
            Some(_) => None,
        };
        Some(UnjudgedArrival {
            pipeline: text("pipeline")?,
            arrival: text("arrival")?,
            file: text("file")?,
            movement: text("movement")?,
            delivery_id: opt("deliveryId")?,
            edge: text("edge")?,
            record_id: opt("recordId")?,
            reason: text("reason")?,
            cause: opt("cause")?,
            at: text("at")?,
        })
    }
}

/// What the door reads and keeps its facts in the ledger by.
#[derive(Clone)]
struct Open {
    store: Rc<dyn RunHostStore>,
    /// How long the ledger keeps a write (crate::loop_breaker::kept_ms).
    kept_ms: i64,
}

thread_local! {
    /// The door, once the session is open.
    static OPEN: RefCell<Option<Open>> = const { RefCell::new(None) };
}

/// The door reads `store` from now on, and keeps its facts in the write
/// ledger for `kept_ms`. Called again when the session's files change what
/// `kept_ms` is.
pub fn install(store: Rc<dyn RunHostStore>, kept_ms: i64) {
    OPEN.with(|open| *open.borrow_mut() = Some(Open { store, kept_ms }));
}

/// Keep that the store was opened under this release (`releases.note`),
/// once per release.
pub fn note_release(store: &dyn RunHostStore, at: &str) -> std::result::Result<(), String> {
    store.note_release(movement_parser::version::LANGUAGE_VERSION, at).map(|_| ()).map_err(|e| format!("keeping the release this store is opened under: {e}"))
}

/// The door's answer to `body` (`{ method, params }`): its status and JSON.
/// The caller has checked the host token.
pub fn answer(body: &Js) -> (u16, Js) {
    let Some(Open { store, kept_ms }) = OPEN.with(|open| open.borrow().clone()) else {
        return refuse(503, "unavailable", "the records door opens with listen-fire's session; ask again".into());
    };
    let params = body.get("params").cloned().unwrap_or(Js::Obj(Default::default()));
    let answered = match body.get("method").and_then(Js::as_str) {
        Some("records.failedRuns") => failed_runs(&*store, kept_ms, &params),
        Some("records.pausedRuns") => Ok(Js::Arr(Vec::new())),
        Some("records.strandedWaits") => stranded_waits(&*store, kept_ms, &params),
        Some("records.releases") => releases(&*store, &params),
        Some("records.unjudgedArrivals") => unjudged_arrivals(&*store, kept_ms, &params),
        Some("records.webBaseUrl") => Ok(Js::Null),
        Some(other) => return refuse(400, "bad_request", format!("the records door has no method {other} ({METHODS})")),
        None => return refuse(400, "bad_request", format!("expected `method` ({METHODS})")),
    };
    match answered {
        Ok(result) => (200, Js::Obj(obj! { "result" => result })),
        Err(Failure::Params(message)) => refuse(400, "bad_request", message),
        Err(Failure::Store(message)) => refuse(502, "store_failed", message),
    }
}

const METHODS: &str = "records.failedRuns, records.pausedRuns, records.strandedWaits, records.releases, records.unjudgedArrivals, records.webBaseUrl";

fn refuse(status: u16, error: &str, message: String) -> (u16, Js) {
    (status, Js::Obj(obj! { "error" => Js::str(error), "message" => Js::Str(message) }))
}

enum Failure {
    Params(String),
    Store(String),
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Failure::Store(error.to_string())
    }
}

fn text<'a>(params: &'a Js, key: &str) -> std::result::Result<&'a str, Failure> {
    params.get(key).and_then(Js::as_str).ok_or_else(|| Failure::Params(format!("expected `{key}`, text")))
}

fn limit_of(params: &Js) -> std::result::Result<i64, Failure> {
    match params.get("limit") {
        Some(Js::Num(n)) => n.as_i64().filter(|n| *n > 0).map(|n| n.min(MOST_ROWS)).ok_or_else(|| Failure::Params("`limit`: a whole number, at least 1".into())),
        _ => Err(Failure::Params("expected `limit`, a whole number".into())),
    }
}

/// The run's facts as the store keeps them; none for a run it no longer holds.
fn facts_of(store: &dyn RunHostStore, run_id: &str) -> std::result::Result<Option<(RunRow, Js)>, Failure> {
    let Some(row) = store.run(run_id)? else { return Ok(None) };
    let facts = Js::parse(row.input.as_bytes()).unwrap_or(Js::Null);
    Ok(Some((row, facts)))
}

/// The listen whose arrival started the run (its pipeline), when one did.
fn listen_of(facts: &Js) -> Js {
    facts.get("event").and_then(|event| event.get("pipelineInputId")).and_then(Js::as_str).map_or(Js::Null, Js::str)
}

/// Keep a fact about `run_id`, handed out now, as the run's write of its own
/// record, and forget what the ledger keeps no longer (`kept_ms`). A run's
/// later fact replaces its earlier one: the same record, the same run, the
/// same place in its chain, only later.
fn keep_in_ledger(store: &dyn RunHostStore, run_id: &str, facts: &Js, kept_ms: i64) -> std::result::Result<(), Failure> {
    let depth = u32::try_from(crate::loop_breaker::chain_in(facts).len()).unwrap_or(u32::MAX);
    let write = LedgerWrite {
        adapter: crate::loop_breaker::HOST.into(),
        record_type: crate::loop_breaker::HOST_RUN.into(),
        external_id: run_id.into(),
        run_id: run_id.into(),
        depth,
        at: crate::store::iso(0),
    };
    store.ledger_write(&write, &crate::store::iso(-kept_ms)).map_err(|e| Failure::Store(format!("keeping run {run_id}'s fact in the write ledger: {e}")))
}

fn failed_runs(store: &dyn RunHostStore, kept_ms: i64, params: &Js) -> std::result::Result<Js, Failure> {
    let after = match params.get("after") {
        None | Some(Js::Null) => None,
        Some(after) => Some(RunAfter { at: text(after, "at")?, run_id: text(after, "runId")? }),
    };
    let page = FailedPage { after, until: text(params, "until")?, limit: limit_of(params)? };
    let mut rows = Vec::new();
    for run in store.failed_runs(&page)? {
        let facts = Js::parse(run.input.as_bytes()).unwrap_or(Js::Null);
        let at = run.finished_at.clone().unwrap_or_else(|| run.started_at.clone());
        let reason = run.outcome.as_deref().and_then(|o| Js::parse(o.as_bytes()).ok()).and_then(|o| o.get("error").and_then(Js::as_str).map(str::to_string)).unwrap_or_default();
        keep_in_ledger(store, &run.id, &facts, kept_ms)?;
        rows.push(Js::Obj(obj! {
            "runId" => Js::str(&run.id),
            "file" => Js::str(&run.file),
            "movement" => Js::str(&run.movement),
            "listen" => listen_of(&facts),
            "rehearsal" => Js::Bool(facts.get("dryRun") == Some(&Js::Bool(true))),
            "reason" => Js::Str(reason),
            "at" => Js::Str(at),
        }));
    }
    Ok(Js::Arr(rows))
}

fn stranded_waits(store: &dyn RunHostStore, kept_ms: i64, params: &Js) -> std::result::Result<Js, Failure> {
    let after = match params.get("after") {
        None | Some(Js::Null) => None,
        Some(after) => Some(StrandedAfter { at: text(after, "at")?, wait_id: text(after, "waitId")? }),
    };
    let mut rows = Vec::new();
    for wait in store.stranded_waits(&StrandedOf::Page { after, limit: limit_of(params)? })? {
        let ran = facts_of(store, &wait.run_id)?;
        if let Some((_, facts)) = &ran {
            keep_in_ledger(store, &wait.run_id, facts, kept_ms)?;
        }
        rows.push(Js::Obj(obj! {
            "waitId" => Js::str(&wait.wait_id),
            "runId" => Js::str(&wait.run_id),
            "file" => ran.as_ref().map_or(Js::Null, |(run, _)| Js::str(&run.file)),
            "movement" => ran.as_ref().map_or(Js::Null, |(run, _)| Js::str(&run.movement)),
            "listen" => ran.as_ref().map_or(Js::Null, |(_, facts)| listen_of(facts)),
            "adapterType" => Js::str(&wait.adapter_type),
            "edge" => Js::str(&wait.edge),
            "recordId" => wait.record_id.as_deref().map_or(Js::Null, Js::str),
            "parked" => Js::Bool(wait.parked),
            "at" => Js::str(&wait.at),
        }));
    }
    Ok(Js::Arr(rows))
}

fn releases(store: &dyn RunHostStore, params: &Js) -> std::result::Result<Js, Failure> {
    let after = match params.get("after") {
        None | Some(Js::Null) => None,
        Some(after) => Some(ReleaseAfter { at: text(after, "at")?, version: text(after, "version")? }),
    };
    let rows = store.releases(after.as_ref(), limit_of(params)?)?;
    Ok(Js::Arr(rows.into_iter().map(|r| Js::Obj(obj! { "version" => Js::Str(r.version), "at" => Js::Str(r.at) })).collect()))
}

/// The listens that could not judge an arrival, oldest first. A run whose
/// write caused the arrival is kept in the ledger as for any fact about a
/// run, so a run the report fires continues its chain.
fn unjudged_arrivals(store: &dyn RunHostStore, kept_ms: i64, params: &Js) -> std::result::Result<Js, Failure> {
    let after = match params.get("after") {
        None | Some(Js::Null) => None,
        Some(after) => Some(UnjudgedAfter { at: text(after, "at")?, pipeline: text(after, "pipeline")?, arrival: text(after, "arrival")? }),
    };
    let mut rows = Vec::new();
    for fact in store.unjudged_arrivals(after.as_ref(), limit_of(params)?)? {
        if let Some(cause) = &fact.cause
            && let Some((_, facts)) = facts_of(store, cause)?
        {
            keep_in_ledger(store, cause, &facts, kept_ms)?;
        }
        rows.push(fact.to_js());
    }
    Ok(Js::Arr(rows))
}

// ── In the state file ───────────────────────────────────────────────────────

impl Store {
    /// The failed runs `page` names, oldest failure first (ties by id).
    pub fn failed_runs(&self, page: &FailedPage<'_>) -> Result<Vec<RunRow>> {
        let until = crate::store::canonical_iso(page.until)?;
        let columns = crate::store::RUN_COLUMNS;
        let read = |sql: &str, params: &[&dyn rusqlite::ToSql]| -> Result<Vec<RunRow>> {
            let mut statement = self.db.prepare(sql)?;
            Ok(statement.query_map(params, crate::store::run_row)?.collect::<rusqlite::Result<Vec<_>>>()?)
        };
        match &page.after {
            None => read(&format!("select {columns} from run where status = 'failed' and finished_at <= ? order by finished_at, id limit ?"), &[&until, &page.limit]),
            Some(after) => {
                let at = crate::store::canonical_iso(after.at)?;
                read(
                    &format!("select {columns} from run where status = 'failed' and finished_at <= ? and (finished_at, id) > (?, ?) order by finished_at, id limit ?"),
                    &[&until, &at, &after.run_id, &page.limit],
                )
            }
        }
    }

    /// Keep `version` as a release the store was opened under, at `at`,
    /// unless it was before: whether it is new.
    pub fn note_release(&self, version: &str, at: &str) -> Result<bool> {
        let at = crate::store::canonical_iso(at)?;
        Ok(self.db.execute("insert into release_seen (version, seen_at) values (?, ?) on conflict do nothing", rusqlite::params![version, at])? == 1)
    }

    /// Keep that a listen could not judge an arrival, unless it was kept
    /// before (whether it is new), and forget what was kept before
    /// `forget_before`, as one write.
    pub fn note_unjudged(&self, fact: &UnjudgedArrival, forget_before: &str) -> Result<bool> {
        let at = crate::store::canonical_iso(&fact.at)?;
        let forget_before = crate::store::canonical_iso(forget_before)?;
        self.transaction(|db| {
            db.execute("delete from arrival_unjudged where noted_at < ?", rusqlite::params![forget_before])?;
            Ok(db.execute(
                "insert into arrival_unjudged (pipeline, arrival, file, movement, delivery_id, edge, record_id, reason, cause, noted_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing",
                rusqlite::params![fact.pipeline, fact.arrival, fact.file, fact.movement, fact.delivery_id, fact.edge, fact.record_id, fact.reason, fact.cause, at],
            )? == 1)
        })
    }

    /// The unjudged arrivals kept after `after`, oldest first (ties by
    /// listen, then arrival).
    pub fn unjudged_arrivals(&self, after: Option<&UnjudgedAfter<'_>>, limit: i64) -> Result<Vec<UnjudgedArrival>> {
        const COLUMNS: &str = "select pipeline, arrival, file, movement, delivery_id, edge, record_id, reason, cause, noted_at from arrival_unjudged";
        let row = |r: &rusqlite::Row<'_>| {
            Ok(UnjudgedArrival {
                pipeline: r.get(0)?,
                arrival: r.get(1)?,
                file: r.get(2)?,
                movement: r.get(3)?,
                delivery_id: r.get(4)?,
                edge: r.get(5)?,
                record_id: r.get(6)?,
                reason: r.get(7)?,
                cause: r.get(8)?,
                at: r.get(9)?,
            })
        };
        Ok(match after {
            None => self.db.prepare(&format!("{COLUMNS} order by noted_at, pipeline, arrival limit ?"))?.query_map(rusqlite::params![limit], row)?.collect::<rusqlite::Result<Vec<_>>>()?,
            Some(after) => self
                .db
                .prepare(&format!("{COLUMNS} where (noted_at, pipeline, arrival) > (?, ?, ?) order by noted_at, pipeline, arrival limit ?"))?
                .query_map(rusqlite::params![crate::store::canonical_iso(after.at)?, after.pipeline, after.arrival, limit], row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        })
    }

    /// The releases kept after `after`, oldest first (ties by version).
    pub fn releases(&self, after: Option<&ReleaseAfter<'_>>, limit: i64) -> Result<Vec<SeenRelease>> {
        let row = |r: &rusqlite::Row<'_>| Ok(SeenRelease { version: r.get(0)?, at: r.get(1)? });
        Ok(match after {
            None => self.db.prepare("select version, seen_at from release_seen order by seen_at, version limit ?")?.query_map(rusqlite::params![limit], row)?.collect::<rusqlite::Result<Vec<_>>>()?,
            Some(after) => self
                .db
                .prepare("select version, seen_at from release_seen where (seen_at, version) > (?, ?) order by seen_at, version limit ?")?
                .query_map(rusqlite::params![crate::store::canonical_iso(after.at)?, after.version, limit], row)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{RunStart, iso, iso_at};

    /// The loop window and the slowest poll lf.yaml would leave: 20s and 60s.
    const KEPT_MS: i64 = 80_000;

    fn state_file() -> Rc<dyn RunHostStore> {
        let dir = std::env::temp_dir().join(format!("lf-records-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Rc::new(Store::open(&dir.join("state.db")).unwrap())
    }

    #[cfg(feature = "postgres")]
    fn postgres() -> Option<Rc<dyn RunHostStore>> {
        let url = std::env::var("LF_TEST_PG").ok().filter(|u| !u.is_empty())?;
        crate::pg_store::PgStore::migrate(&url).unwrap();
        Some(Rc::new(crate::pg_store::PgStore::connect(&url, crate::backend::POSTGRES_TENANT).unwrap()))
    }

    /// An instant of its own for each run of a case, so a database a case
    /// ran over before holds nothing it reads.
    fn t0() -> i64 {
        1_793_000_000_000 + i64::from(uuid::Uuid::new_v4().as_bytes()[0]) * 86_400_000 + (crate::limiter::now_ms() % 86_400_000)
    }

    fn fail(store: &dyn RunHostStore, facts: &str, at: i64) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        store.start_run(&RunStart { id: &id, file: "ops", movement: "sync", started_at: &iso_at(at - 1000), input: facts, delivery_id: None, team_id: None }).unwrap();
        store.settle_run(&id, "failed", &Js::Obj(obj! { "error" => Js::str("boom") }), &iso_at(at)).unwrap();
        id
    }

    fn ask(method: &str, params: Js) -> (u16, Js) {
        answer(&Js::Obj(obj! { "method" => Js::str(method), "params" => params }))
    }

    fn ids(read: &Js) -> Vec<String> {
        read.get("result").and_then(Js::as_array).unwrap().iter().filter_map(|r| r.get("runId").and_then(Js::as_str)).map(str::to_string).collect()
    }

    fn failed_runs_are_read_oldest_first_after_a_mark_with_their_listen_and_kept_in_the_ledger(store: Rc<dyn RunHostStore>) {
        install(store.clone(), KEPT_MS);
        let t0 = t0();
        let mark = || Js::Obj(obj! { "at" => Js::Str(iso_at(t0)), "runId" => Js::str("00000000-0000-0000-0000-000000000000") });
        let facts = r#"{"event":{"pipelineInputId":"listen:ops:sync:0a1b2c3d"},"chain":["run-0"]}"#;
        let b = fail(&*store, facts, t0 + 2000);
        let a = fail(&*store, r#"{"dryRun":true}"#, t0 + 1000);
        let c = fail(&*store, "{}", t0 + 9000);
        let ok = uuid::Uuid::new_v4().to_string();
        store.start_run(&RunStart { id: &ok, file: "ops", movement: "sync", started_at: &iso_at(t0), input: "{}", delivery_id: None, team_id: None }).unwrap();
        store.settle_run(&ok, "completed", &Js::Obj(Default::default()), &iso_at(t0 + 1500)).unwrap();

        let (status, read) = ask("records.failedRuns", Js::Obj(obj! { "after" => mark(), "until" => Js::Str(iso_at(t0 + 5000)), "limit" => Js::Num(10.into()) }));
        assert_eq!(status, 200, "{}", read.to_json());
        assert_eq!(ids(&read), [a.clone(), b.clone()], "oldest first, none past `until`, no completed run");
        let rows = read.get("result").and_then(Js::as_array).unwrap();
        assert_eq!(rows[0].get("rehearsal"), Some(&Js::Bool(true)));
        assert_eq!(rows[1].get("listen").and_then(Js::as_str), Some("listen:ops:sync:0a1b2c3d"));
        assert_eq!(rows[1].get("reason").and_then(Js::as_str), Some("boom"));
        assert_eq!(rows[1].get("at").and_then(Js::as_str), Some(iso_at(t0 + 2000).as_str()));

        let after = obj! { "at" => Js::Str(iso_at(t0 + 1000)), "runId" => Js::str(&a) };
        let (_, next) = ask("records.failedRuns", Js::Obj(obj! { "after" => Js::Obj(after), "until" => Js::Str(iso_at(t0 + 9000)), "limit" => Js::Num(10.into()) }));
        assert_eq!(ids(&next), [b.clone(), c]);

        let about = crate::loop_breaker::LedgerRecord { adapter: crate::loop_breaker::HOST, record_type: crate::loop_breaker::HOST_RUN, external_id: &b };
        let deepest = store.deepest_write(&about, &iso(-60_000)).unwrap().unwrap();
        assert_eq!((deepest.run_id.as_str(), deepest.depth), (b.as_str(), 1), "the failure is the run's own write, at its place in its chain, as of its being handed out");
    }

    fn a_release_is_kept_once_and_read_after_a_mark(store: Rc<dyn RunHostStore>) {
        install(store.clone(), KEPT_MS);
        let t0 = t0();
        let (one, two) = (format!("0.13.{t0}"), format!("0.14.{t0}"));
        assert!(store.note_release(&one, &iso_at(t0)).unwrap());
        assert!(!store.note_release(&one, &iso_at(t0 + 5)).unwrap(), "once per release");
        assert!(store.note_release(&two, &iso_at(t0 + 10)).unwrap());
        // Only this case's: a database a case ran over before holds later releases of its own.
        let versions = |read: &Js| -> Vec<String> {
            read.get("result").and_then(Js::as_array).unwrap().iter().filter_map(|r| r.get("version").and_then(Js::as_str)).filter(|v| v.ends_with(&t0.to_string())).map(str::to_string).collect()
        };
        let (_, read) = ask("records.releases", Js::Obj(obj! { "after" => Js::Obj(obj! { "at" => Js::Str(iso_at(t0 - 1)), "version" => Js::str("") }), "limit" => Js::Num(10.into()) }));
        assert_eq!(versions(&read), [one.clone(), two.clone()]);
        let (_, next) = ask("records.releases", Js::Obj(obj! { "after" => Js::Obj(obj! { "at" => Js::Str(iso_at(t0)), "version" => Js::Str(one) }), "limit" => Js::Num(10.into()) }));
        assert_eq!(versions(&next), [two]);
    }

    fn an_arrival_about_a_fact_handed_out_continues_its_chain_however_old_the_fact_and_after_the_writers_sweep(store: Rc<dyn RunHostStore>) {
        install(store.clone(), KEPT_MS);
        let failed_at = crate::limiter::now_ms() - 600_000;
        let id = uuid::Uuid::new_v4().to_string();
        store.start_run(&RunStart { id: &id, file: "ops", movement: "sync", started_at: &iso_at(failed_at - 1000), input: r#"{"chain":["run-0"]}"#, delivery_id: None, team_id: None }).unwrap();
        store.settle_run(&id, "failed", &Js::Obj(obj! { "error" => Js::str("boom") }), &iso_at(failed_at)).unwrap();

        let page = Js::Obj(obj! { "after" => Js::Obj(obj! { "at" => Js::Str(iso_at(failed_at - 1)), "runId" => Js::str("00000000-0000-0000-0000-000000000000") }), "until" => Js::Str(iso_at(failed_at)), "limit" => Js::Num(10.into()) });
        assert_eq!(ids(&ask("records.failedRuns", page).1), [id.clone()]);

        // Another run writes a record: its sweep forgets what is older than the ledger keeps.
        let other = LedgerWrite { adapter: "acme".into(), record_type: "Company".into(), external_id: "c1".into(), run_id: "other".into(), depth: 0, at: iso(0) };
        store.ledger_write(&other, &iso(-KEPT_MS)).unwrap();

        let arrival = crate::arrivals::ArrivalIn {
            edge: "Events".into(),
            key: None,
            identity: Some("event-1".into()),
            version: None,
            landing: None,
            gone: false,
            parents: Vec::new(),
            about: Some(Js::parse(format!(r#"{{"recordType":"Run","externalId":"{id}"}}"#).as_bytes()).unwrap()),
            not_for: None,
            taken_applied: false,
            occurred_at: Some(iso_at(failed_at)),
        };
        let since = iso_at(crate::loop_breaker::since_of(&arrival, 20_000, crate::limiter::now_ms()));
        let chain = crate::loop_breaker::chain_of(&*store, &crate::loop_breaker::records_of("system", &arrival, "Event"), &since).unwrap();
        assert_eq!(chain, ["run-0".to_string(), id], "a failure ten minutes old, read now, is attributed: the chain continues and the cap applies");
    }

    fn unjudged(pipeline: &str, arrival: &str, at: i64, cause: Option<&str>) -> UnjudgedArrival {
        UnjudgedArrival {
            pipeline: pipeline.into(),
            arrival: arrival.into(),
            file: "chat".into(),
            movement: "heard".into(),
            delivery_id: Some("delivery-1".into()),
            edge: "Messages".into(),
            record_id: Some("C1:1700.1".into()),
            reason: "slack could not read Name of the Channels record the arrival carries, which this listen's filter reads".into(),
            cause: cause.map(str::to_string),
            at: iso_at(at),
        }
    }

    fn an_unjudged_arrival_is_kept_once_per_listen_and_read_after_a_mark_its_cause_kept_in_the_ledger(store: Rc<dyn RunHostStore>) {
        install(store.clone(), KEPT_MS);
        let t0 = t0();
        let (one, two) = (format!("listen:chat:heard:{t0}"), format!("listen:chat:other:{t0}"));
        let cause = fail(&*store, r#"{"chain":["run-0"]}"#, t0 - 5000);
        let first = unjudged(&one, "Messages:C1:C1:1700.1:", t0, Some(&cause));
        assert!(store.note_unjudged(&first, &iso_at(t0 - 1000)).unwrap());
        assert!(!store.note_unjudged(&UnjudgedArrival { at: iso_at(t0 + 5), reason: "again".into(), ..first.clone() }, &iso_at(t0 - 1000)).unwrap(), "once per listen and arrival");
        assert!(store.note_unjudged(&unjudged(&two, "Messages:C1:C1:1700.1:", t0 + 10, None), &iso_at(t0 - 1000)).unwrap(), "another listen's is its own");
        // Only this case's: a database a case ran over before holds others.
        let read = |after: Js| -> Vec<Js> {
            let (status, read) = ask("records.unjudgedArrivals", Js::Obj(obj! { "after" => after, "limit" => Js::Num(10.into()) }));
            assert_eq!(status, 200, "{}", read.to_json());
            read.get("result").and_then(Js::as_array).unwrap().iter().filter(|r| r.get("pipeline").and_then(Js::as_str).is_some_and(|p| p.ends_with(&t0.to_string()))).cloned().collect()
        };
        let rows = read(Js::Obj(obj! { "at" => Js::Str(iso_at(t0 - 1)), "pipeline" => Js::str(""), "arrival" => Js::str("") }));
        assert_eq!(rows, [first.to_js(), unjudged(&two, "Messages:C1:C1:1700.1:", t0 + 10, None).to_js()]);
        let next = read(Js::Obj(obj! { "at" => Js::Str(iso_at(t0)), "pipeline" => Js::str(&one), "arrival" => Js::str("Messages:C1:C1:1700.1:") }));
        assert_eq!(next.len(), 1);
        let about = crate::loop_breaker::LedgerRecord { adapter: crate::loop_breaker::HOST, record_type: crate::loop_breaker::HOST_RUN, external_id: &cause };
        let deepest = store.deepest_write(&about, &iso(-60_000)).unwrap().unwrap();
        assert_eq!((deepest.run_id.as_str(), deepest.depth), (cause.as_str(), 1), "the run whose write caused the arrival, at its place in its chain");
        // Kept as long as a delivery is: a later note forgets an older one.
        assert!(store.note_unjudged(&unjudged(&format!("listen:chat:late:{t0}"), "x", t0 + 20, None), &iso_at(t0 + 15)).unwrap());
        assert_eq!(read(Js::Null).iter().filter_map(|r| r.get("pipeline").and_then(Js::as_str)).collect::<Vec<_>>(), [format!("listen:chat:late:{t0}")]);
    }

    #[test]
    fn unjudged_arrivals_are_kept_in_the_state_file() {
        an_unjudged_arrival_is_kept_once_per_listen_and_read_after_a_mark_its_cause_kept_in_the_ledger(state_file());
    }

    #[cfg(feature = "postgres")]
    #[test]
    fn unjudged_arrivals_are_kept_over_postgres() {
        let Some(store) = postgres() else { return };
        an_unjudged_arrival_is_kept_once_per_listen_and_read_after_a_mark_its_cause_kept_in_the_ledger(store);
    }

    #[test]
    fn an_old_fact_handed_out_is_attributed_in_the_state_file() {
        an_arrival_about_a_fact_handed_out_continues_its_chain_however_old_the_fact_and_after_the_writers_sweep(state_file());
    }

    #[cfg(feature = "postgres")]
    #[test]
    fn an_old_fact_handed_out_is_attributed_over_postgres() {
        let Some(store) = postgres() else { return };
        an_arrival_about_a_fact_handed_out_continues_its_chain_however_old_the_fact_and_after_the_writers_sweep(store);
    }

    #[test]
    fn the_door_keeps_one_row_per_run_and_sweeps_what_the_ledger_no_longer_keeps() {
        let dir = std::env::temp_dir().join(format!("lf-records-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Rc::new(Store::open(&dir.join("state.db")).unwrap());
        install(store.clone(), KEPT_MS);
        let old = LedgerWrite { adapter: "acme".into(), record_type: "Company".into(), external_id: "c1".into(), run_id: "writer".into(), depth: 0, at: iso(-KEPT_MS - 5_000) };
        store.ledger_write(&old, &iso(-3_600_000)).unwrap();
        let record = crate::loop_breaker::LedgerRecord { adapter: "acme", record_type: "Company", external_id: "c1" };
        assert!(store.deepest_write(&record, &iso(-3_600_000)).unwrap().is_some());

        let failed_at = crate::limiter::now_ms() - 30_000;
        let id = fail(&*store, "{}", failed_at);
        let page = || Js::Obj(obj! { "after" => Js::Obj(obj! { "at" => Js::Str(iso_at(failed_at - 1)), "runId" => Js::str("00000000-0000-0000-0000-000000000000") }), "until" => Js::Str(iso_at(failed_at)), "limit" => Js::Num(10.into()) });
        for _ in 0..3 {
            assert_eq!(ids(&ask("records.failedRuns", page()).1), [id.clone()], "each poll that reads the fact, and each retry of one, reads it again");
        }
        assert!(store.deepest_write(&record, &iso(-3_600_000)).unwrap().is_none(), "the door sweeps by the bound the writers' sweeps use");
        let rows: i64 = store.db.query_row("select count(*) from write_ledger where run_id = ?", rusqlite::params![id], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "one row for the fact however often it is read");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn failed_runs_are_read_in_the_state_file() {
        failed_runs_are_read_oldest_first_after_a_mark_with_their_listen_and_kept_in_the_ledger(state_file());
    }

    #[test]
    fn releases_are_kept_in_the_state_file() {
        a_release_is_kept_once_and_read_after_a_mark(state_file());
    }

    /// Over Postgres when LF_TEST_PG names a database to set up and write into.
    #[cfg(feature = "postgres")]
    #[test]
    fn failed_runs_and_releases_are_read_over_postgres() {
        let Some(store) = postgres() else { return };
        failed_runs_are_read_oldest_first_after_a_mark_with_their_listen_and_kept_in_the_ledger(store.clone());
        a_release_is_kept_once_and_read_after_a_mark(store);
    }

    #[test]
    fn the_door_names_its_methods_and_refuses_what_it_cannot_read() {
        install(state_file(), KEPT_MS);
        assert_eq!(ask("records.everything", Js::Null).0, 400);
        assert_eq!(ask("records.failedRuns", Js::Obj(obj! { "limit" => Js::Num(1.into()) })).0, 400, "no `until`");
        assert_eq!(ask("records.pausedRuns", Js::Obj(obj! { "limit" => Js::Num(1.into()) })).1.get("result"), Some(&Js::Arr(vec![])), "listen-fire fails a run at its cost cap: it pauses none");
        assert_eq!(ask("records.webBaseUrl", Js::Null).1.get("result"), Some(&Js::Null), "listen-fire has no runs page");
    }
}

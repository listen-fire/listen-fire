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

thread_local! {
    /// The store the door reads: the session's, once it is open.
    static STORE: RefCell<Option<Rc<dyn RunHostStore>>> = const { RefCell::new(None) };
}

/// The door reads `store` from now on.
pub fn install(store: Rc<dyn RunHostStore>) {
    STORE.with(|kept| *kept.borrow_mut() = Some(store));
}

/// Keep that the store was opened under this release (`releases.note`),
/// once per release.
pub fn note_release(store: &dyn RunHostStore, at: &str) -> std::result::Result<(), String> {
    store.note_release(movement_parser::version::LANGUAGE_VERSION, at).map(|_| ()).map_err(|e| format!("keeping the release this store is opened under: {e}"))
}

/// The door's answer to `body` (`{ method, params }`): its status and JSON.
/// The caller has checked the host token.
pub fn answer(body: &Js) -> (u16, Js) {
    let Some(store) = STORE.with(|kept| kept.borrow().clone()) else {
        return refuse(503, "unavailable", "the records door opens with listen-fire's session; ask again".into());
    };
    let params = body.get("params").cloned().unwrap_or(Js::Obj(Default::default()));
    let answered = match body.get("method").and_then(Js::as_str) {
        Some("records.failedRuns") => failed_runs(&*store, &params),
        Some("records.pausedRuns") => Ok(Js::Arr(Vec::new())),
        Some("records.strandedWaits") => stranded_waits(&*store, &params),
        Some("records.releases") => releases(&*store, &params),
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

const METHODS: &str = "records.failedRuns, records.pausedRuns, records.strandedWaits, records.releases, records.webBaseUrl";

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

/// Keep a fact about `run_id`, true `at`, as the run's write of its own record.
fn keep_in_ledger(store: &dyn RunHostStore, run_id: &str, facts: &Js, at: &str) -> std::result::Result<(), Failure> {
    let depth = u32::try_from(crate::loop_breaker::chain_in(facts).len()).unwrap_or(u32::MAX);
    let write = LedgerWrite {
        adapter: crate::loop_breaker::HOST.into(),
        record_type: crate::loop_breaker::HOST_RUN.into(),
        external_id: run_id.into(),
        run_id: run_id.into(),
        depth,
        at: at.into(),
    };
    // Forgets nothing: the writers' own sweeps keep the ledger's window.
    store.ledger_write(&write, crate::store::EPOCH).map_err(|e| Failure::Store(format!("keeping run {run_id}'s fact in the write ledger: {e}")))
}

fn failed_runs(store: &dyn RunHostStore, params: &Js) -> std::result::Result<Js, Failure> {
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
        keep_in_ledger(store, &run.id, &facts, &at)?;
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

fn stranded_waits(store: &dyn RunHostStore, params: &Js) -> std::result::Result<Js, Failure> {
    let after = match params.get("after") {
        None | Some(Js::Null) => None,
        Some(after) => Some(StrandedAfter { at: text(after, "at")?, wait_id: text(after, "waitId")? }),
    };
    let mut rows = Vec::new();
    for wait in store.stranded_waits(&StrandedOf::Page { after, limit: limit_of(params)? })? {
        let ran = facts_of(store, &wait.run_id)?;
        if let Some((_, facts)) = &ran {
            keep_in_ledger(store, &wait.run_id, facts, &wait.at)?;
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
    use crate::store::{RunStart, iso_at};

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
        store.start_run(&RunStart { id: &id, file: "ops", movement: "sync", started_at: &iso_at(at - 1000), input: facts, delivery_id: None }).unwrap();
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
        install(store.clone());
        let t0 = t0();
        let mark = || Js::Obj(obj! { "at" => Js::Str(iso_at(t0)), "runId" => Js::str("00000000-0000-0000-0000-000000000000") });
        let facts = r#"{"event":{"pipelineInputId":"listen:ops:sync:0a1b2c3d"},"chain":["run-0"]}"#;
        let b = fail(&*store, facts, t0 + 2000);
        let a = fail(&*store, r#"{"dryRun":true}"#, t0 + 1000);
        let c = fail(&*store, "{}", t0 + 9000);
        let ok = uuid::Uuid::new_v4().to_string();
        store.start_run(&RunStart { id: &ok, file: "ops", movement: "sync", started_at: &iso_at(t0), input: "{}", delivery_id: None }).unwrap();
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
        let deepest = store.deepest_write(&about, &iso_at(t0)).unwrap().unwrap();
        assert_eq!((deepest.run_id.as_str(), deepest.depth), (b.as_str(), 1), "the failure is the run's own write, at its place in its chain");
    }

    fn a_release_is_kept_once_and_read_after_a_mark(store: Rc<dyn RunHostStore>) {
        install(store.clone());
        let t0 = t0();
        let (one, two) = (format!("0.13.{t0}"), format!("0.14.{t0}"));
        assert!(store.note_release(&one, &iso_at(t0)).unwrap());
        assert!(!store.note_release(&one, &iso_at(t0 + 5)).unwrap(), "once per release");
        assert!(store.note_release(&two, &iso_at(t0 + 10)).unwrap());
        let versions = |read: &Js| -> Vec<String> { read.get("result").and_then(Js::as_array).unwrap().iter().filter_map(|r| r.get("version").and_then(Js::as_str)).map(str::to_string).collect() };
        let (_, read) = ask("records.releases", Js::Obj(obj! { "after" => Js::Obj(obj! { "at" => Js::Str(iso_at(t0 - 1)), "version" => Js::str("") }), "limit" => Js::Num(10.into()) }));
        assert_eq!(versions(&read), [one.clone(), two.clone()]);
        let (_, next) = ask("records.releases", Js::Obj(obj! { "after" => Js::Obj(obj! { "at" => Js::Str(iso_at(t0)), "version" => Js::Str(one) }), "limit" => Js::Num(10.into()) }));
        assert_eq!(versions(&next), [two]);
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
        install(state_file());
        assert_eq!(ask("records.everything", Js::Null).0, 400);
        assert_eq!(ask("records.failedRuns", Js::Obj(obj! { "limit" => Js::Num(1.into()) })).0, 400, "no `until`");
        assert_eq!(ask("records.pausedRuns", Js::Obj(obj! { "limit" => Js::Num(1.into()) })).1.get("result"), Some(&Js::Arr(vec![])), "listen-fire fails a run at its cost cap: it pauses none");
        assert_eq!(ask("records.webBaseUrl", Js::Null).1.get("result"), Some(&Js::Null), "listen-fire has no runs page");
    }
}

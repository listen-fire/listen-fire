//! A run's waits on listenable edges, and the log of arrivals they read: the
//! rows the store trait's waits family keeps (crate::backend; the store
//! slot's `waits.*`, docs/contracts/store-slot.md), and the SQLite state
//! file's implementation of that family.
//!
//! - Every arrival a module reports is logged under a store-wide increasing
//!   seq, kept ARRIVAL_RETENTION_MS, and longer while a live wait reads it.
//! - A wait is one row: this run waits on this edge of this record. It reads
//!   the arrivals logged after its mark, a seq taken before the write that may
//!   cause them, so an arrival logged during the write still counts.
//! - A wait notes each arrival it judged, by identity and version, so each
//!   counts once. Per identity it keeps whether the record matched last time:
//!   an arrival counts when the record newly matches.
//! - Logging answers the waits parked on the arrival's record, so the host
//!   can wake their runs.

use rusqlite::{Connection, OptionalExtension, params};

use crate::json::Js;
use crate::store::{Store, StoreError};

type Result<T> = std::result::Result<T, StoreError>;

/// How long an arrival no live wait reads is kept.
pub const ARRIVAL_RETENTION_MS: i64 = 3_600_000;

/// One arrival a module reported on an edge of a record.
#[derive(Debug, Clone, PartialEq)]
pub struct NewArrival {
    pub edge: String,
    /// The record whose edge it arrived on.
    pub key: String,
    /// What the edge declares identifies an arrival. None: this report is an
    /// arrival of its own (its seq is its identity).
    pub identity: Option<String>,
    pub version: Option<String>,
    pub landing: Option<Js>,
    /// The record is gone: nothing more arrives on its edges.
    pub gone: bool,
}

/// A wait to open: `since` is the mark it reads arrivals after.
pub struct OpenWait<'a> {
    pub run_id: &'a str,
    pub team_id: &'a str,
    pub adapter_type: &'a str,
    pub edge: &'a str,
    pub key: &'a str,
    pub since: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoggedArrival {
    pub seq: i64,
    pub identity: String,
    pub version: Option<String>,
    /// `null` when the module reported none.
    pub landing: Js,
}

/// What a wait has yet to judge, in log order.
#[derive(Debug, Clone, PartialEq)]
pub struct WaitArrivals {
    /// A gone arrival was logged on the wait's record after its mark.
    pub gone: bool,
    pub arrivals: Vec<LoggedArrival>,
}

/// A wait parked at `address` that a logged arrival answers.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct WaitWake {
    pub run_id: String,
    pub wait_id: String,
    pub address: String,
}

// ── The family over the state file (the trait's SQLite implementation) ─────

impl Store {
    /// The latest seq logged; an arrival logged after this call is above it.
    pub fn arrival_mark(&self) -> Result<i64> {
        Ok(self.db.query_row("select coalesce(max(seq), 0) from arrival", [], |r| r.get(0))?)
    }

    pub fn log_arrivals(&self, team_id: &str, adapter_type: &str, arrivals: &[NewArrival], at: &str) -> Result<Vec<WaitWake>> {
        self.transaction(|db| {
            let mut log = db.prepare(
                "insert into arrival (team_id, adapter_type, edge, key, identity, version, landing, gone, logged_at)
                 values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )?;
            // A wait whose park has finished needs no wake: its leaf is gone.
            let mut parked = db.prepare(
                "select w.run_id, w.id, w.address from wait_row w
                 where w.team_id = ? and w.adapter_type = ? and w.edge = ? and w.key = ? and w.address is not null
                   and exists (select 1 from leaf l where l.run_id = w.run_id and l.address = w.address)
                 order by w.run_id, w.id",
            )?;
            let mut wakes: Vec<WaitWake> = Vec::new();
            for arrival in arrivals {
                let landing = arrival.landing.as_ref().map(Js::to_json);
                log.execute(params![
                    team_id,
                    adapter_type,
                    arrival.edge,
                    arrival.key,
                    arrival.identity,
                    arrival.version,
                    landing,
                    i64::from(arrival.gone),
                    at
                ])?;
                let answered = parked.query_map(params![team_id, adapter_type, arrival.edge, arrival.key], |r| {
                    Ok(WaitWake { run_id: r.get(0)?, wait_id: r.get(1)?, address: r.get(2)? })
                })?;
                for wake in answered {
                    let wake = wake?;
                    if !wakes.iter().any(|w| w.wait_id == wake.wait_id) {
                        wakes.push(wake);
                    }
                }
            }
            Ok(wakes)
        })
    }

    /// The wait's id. A run that already waits on this edge of this record
    /// keeps that wait, and its mark.
    pub fn open_wait(&self, wait: &OpenWait<'_>) -> Result<String> {
        let OpenWait { run_id, team_id, adapter_type, edge, key, since } = *wait;
        self.transaction(|db| {
            db.execute(
                "insert into wait_row (id, run_id, team_id, adapter_type, edge, key, since) values (?, ?, ?, ?, ?, ?, ?)
                 on conflict (run_id, team_id, adapter_type, edge, key) do nothing",
                params![uuid::Uuid::new_v4().to_string(), run_id, team_id, adapter_type, edge, key, since],
            )?;
            Ok(db.query_row(
                "select id from wait_row where run_id = ? and team_id = ? and adapter_type = ? and edge = ? and key = ?",
                params![run_id, team_id, adapter_type, edge, key],
                |r| r.get(0),
            )?)
        })
    }

    /// The arrivals after the wait's mark on its record's edge that it has
    /// not noted, the first of each identity and version only.
    pub fn wait_arrivals(&self, wait_id: &str) -> Result<WaitArrivals> {
        Self::require_wait(&self.db, wait_id)?;
        let gone = self.db.query_row(
            "select exists (select 1 from wait_row w join arrival a
               on a.team_id = w.team_id and a.adapter_type = w.adapter_type and a.edge = w.edge and a.key = w.key and a.seq > w.since
               where w.id = ? and a.gone = 1)",
            params![wait_id],
            |r| r.get::<_, bool>(0),
        )?;
        let mut statement = self.db.prepare(
            "select a.seq, coalesce(a.identity, cast(a.seq as text)), a.version, a.landing
             from wait_row w join arrival a
               on a.team_id = w.team_id and a.adapter_type = w.adapter_type and a.edge = w.edge and a.key = w.key and a.seq > w.since
             where w.id = ?1 and a.gone = 0
               and not exists (select 1 from wait_seen s
                 where s.wait_id = w.id and s.identity = coalesce(a.identity, cast(a.seq as text)) and s.version is a.version)
               and not exists (select 1 from arrival b
                 where b.team_id = a.team_id and b.adapter_type = a.adapter_type and b.edge = a.edge and b.key = a.key
                   and b.seq > w.since and b.seq < a.seq and b.gone = 0 and b.identity = a.identity and b.version is a.version)
             order by a.seq",
        )?;
        let rows = statement
            .query_map(params![wait_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let arrivals = rows
            .into_iter()
            .map(|(seq, identity, version, landing)| Ok(LoggedArrival { seq, identity, version, landing: landing_of(landing.as_deref())? }))
            .collect::<Result<Vec<_>>>()?;
        Ok(WaitArrivals { gone, arrivals })
    }

    /// Note that the wait judged this arrival, and whether its record
    /// matched. Whether it counts: it matched, and the record did not match
    /// at its last noted arrival. An arrival noted before counts no more.
    pub fn note_arrival(&self, wait_id: &str, identity: &str, version: Option<&str>, matched: bool) -> Result<bool> {
        self.transaction(|db| {
            Self::require_wait(db, wait_id)?;
            let noted = db
                .query_row("select 1 from wait_seen where wait_id = ? and identity = ? and version is ?", params![wait_id, identity, version], |_| Ok(()))
                .optional()?;
            if noted.is_some() {
                return Ok(false);
            }
            let matched_before = db
                .query_row("select matched from wait_seen where wait_id = ? and identity = ? order by id desc limit 1", params![wait_id, identity], |r| r.get::<_, bool>(0))
                .optional()?
                .unwrap_or(false);
            db.execute("insert into wait_seen (wait_id, identity, version, matched) values (?, ?, ?, ?)", params![wait_id, identity, version, matched])?;
            Ok(matched && !matched_before)
        })
    }

    /// Forget at most `limit` arrivals logged before `before` that no wait
    /// reads: how many went.
    pub fn sweep_arrivals(&self, before: &str, limit: i64) -> Result<i64> {
        let swept = self.db.execute(
            "delete from arrival where seq in (
               select a.seq from arrival a
               where a.logged_at < ?1
                 and not exists (select 1 from wait_row w
                   where w.team_id = a.team_id and w.adapter_type = a.adapter_type and w.edge = a.edge and w.key = a.key and w.since < a.seq)
               order by a.seq limit ?2)",
            params![before, limit],
        )?;
        Ok(i64::try_from(swept).unwrap_or(i64::MAX))
    }

    /// A wait park's row: the wait is parked at `address`.
    pub(crate) fn park_wait_in(db: &Connection, run_id: &str, address: &str, wait_id: &str) -> Result<()> {
        let parked = db.execute("update wait_row set address = ? where id = ? and run_id = ?", params![address, wait_id, run_id])?;
        if parked == 0 {
            return Err(StoreError::Invalid(format!("run {run_id} has no wait {wait_id}")));
        }
        Ok(())
    }

    /// A limit park at `address`: a wait parked there is parked no more.
    pub(crate) fn unpark_waits_in(db: &Connection, run_id: &str, address: &str) -> Result<()> {
        db.execute("update wait_row set address = null where run_id = ? and address = ?", params![run_id, address])?;
        Ok(())
    }

    pub(crate) fn drop_run_waits_in(db: &Connection, run_id: &str) -> Result<()> {
        db.execute("delete from wait_seen where wait_id in (select id from wait_row where run_id = ?)", params![run_id])?;
        db.execute("delete from wait_row where run_id = ?", params![run_id])?;
        Ok(())
    }

    fn require_wait(db: &Connection, wait_id: &str) -> Result<()> {
        match db.query_row("select 1 from wait_row where id = ?", params![wait_id], |_| Ok(())).optional()? {
            Some(()) => Ok(()),
            None => Err(StoreError::Invalid(format!("no wait {wait_id}"))),
        }
    }
}

pub(crate) fn landing_of(text: Option<&str>) -> Result<Js> {
    match text {
        None => Ok(Js::Null),
        Some(text) => Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored landing is not JSON: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    //! The cases are packages/engine-contracts/conformance/store-waits.json's,
    //! which every store runs; each case here runs one of them over a fresh
    //! state file.

    use std::collections::HashMap;

    use super::*;
    use crate::backend::RunHostStore;
    use crate::store::{Park, ParkKind, RunStart, iso};
    use crate::store_wire::int;

    const CASES: &str = include_str!("../../../packages/engine-contracts/conformance/store-waits.json");

    fn cases() -> Vec<Js> {
        Js::parse(CASES.as_bytes()).unwrap().get("cases").and_then(Js::as_array).unwrap().to_vec()
    }

    /// The test's name for a case: its words joined by underscores, without
    /// their punctuation.
    fn test_name(case: &str) -> String {
        case.chars().filter(|c| c.is_alphanumeric() || *c == ' ').map(|c| if c == ' ' { '_' } else { c }).collect()
    }

    fn state_file() -> Store {
        let dir = std::env::temp_dir().join(format!("lf-waits-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Store::open(&dir.join("state.db")).unwrap()
    }

    /// One case's names for the ids it makes: runs and teams a fresh uuid
    /// each, marks and waits as the store answered them.
    #[derive(Default)]
    struct Names {
        ids: HashMap<String, String>,
        marks: HashMap<String, i64>,
        waits: HashMap<String, String>,
    }

    impl Names {
        fn id(&mut self, name: &str) -> String {
            self.ids.entry(name.to_string()).or_insert_with(|| uuid::Uuid::new_v4().to_string()).clone()
        }

        fn wait(&self, name: &str) -> String {
            self.waits.get(name).unwrap_or_else(|| panic!("no wait named {name}")).clone()
        }
    }

    fn text<'a>(step: &'a Js, key: &str) -> &'a str {
        step.get(key).and_then(Js::as_str).unwrap_or_else(|| panic!("{key} in {}", step.to_json()))
    }

    fn opt_text<'a>(step: &'a Js, key: &str) -> Option<&'a str> {
        step.get(key).and_then(Js::as_str)
    }

    fn flag(step: &Js, key: &str) -> bool {
        Js::is_true(step.get(key))
    }

    fn list<'a>(step: &'a Js, key: &str) -> &'a [Js] {
        step.get(key).and_then(Js::as_array).unwrap_or_else(|| panic!("{key} in {}", step.to_json()))
    }

    fn run_case(store: &dyn RunHostStore, case: &Js) {
        let name = text(case, "case");
        let mut names = Names::default();
        let steps = list(case, "steps");
        for step in steps {
            if let Some(run) = opt_text(step, "run") {
                if names.ids.contains_key(run) {
                    continue;
                }
                let id = names.id(run);
                store.start_run(&RunStart { id: &id, file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None }).unwrap();
            }
        }
        for (index, step) in steps.iter().enumerate() {
            let at = format!("{name}, step {}", index + 1);
            let team = names.id(opt_text(step, "team").unwrap_or("t"));
            let adapter = opt_text(step, "adapter").unwrap_or("acme");
            match text(step, "do") {
                "mark" => {
                    names.marks.insert(text(step, "as").into(), store.arrival_mark().unwrap());
                }
                "log" => {
                    let arrivals: Vec<NewArrival> = list(step, "arrivals")
                        .iter()
                        .map(|a| NewArrival {
                            edge: text(a, "edge").into(),
                            key: text(a, "key").into(),
                            identity: opt_text(a, "identity").map(str::to_string),
                            version: opt_text(a, "version").map(str::to_string),
                            landing: a.get("landing").cloned(),
                            gone: flag(a, "gone"),
                        })
                        .collect();
                    let logged_at = iso(step.get("at").and_then(int).unwrap_or(0));
                    let mut wakes = store.log_arrivals(&team, adapter, &arrivals, &logged_at).unwrap();
                    let mut expected: Vec<WaitWake> = list(step, "wakes")
                        .iter()
                        .map(|w| WaitWake { run_id: names.id(text(w, "run")), wait_id: names.wait(text(w, "wait")), address: text(w, "address").into() })
                        .collect();
                    wakes.sort();
                    expected.sort();
                    assert_eq!(wakes, expected, "{at}: the wakes");
                }
                "open" => {
                    let since = names.marks[text(step, "since")];
                    let run = names.id(text(step, "run"));
                    let wait = OpenWait { run_id: &run, team_id: &team, adapter_type: adapter, edge: text(step, "edge"), key: text(step, "key"), since };
                    let id = store.open_wait(&wait).unwrap();
                    if let Some(same) = opt_text(step, "same") {
                        assert_eq!(id, names.wait(same), "{at}: the same wait");
                    } else {
                        assert!(!names.waits.values().any(|w| *w == id), "{at}: a new wait");
                    }
                    names.waits.insert(text(step, "as").into(), id);
                }
                "arrivals" => {
                    let got = store.wait_arrivals(&names.wait(text(step, "wait"))).unwrap();
                    assert_eq!(got.gone, flag(step, "gone"), "{at}: gone");
                    let expected = list(step, "arrivals");
                    assert_eq!(got.arrivals.len(), expected.len(), "{at}: {:?}", got.arrivals);
                    assert!(got.arrivals.windows(2).all(|pair| pair[0].seq < pair[1].seq), "{at}: in log order");
                    for (arrival, want) in got.arrivals.iter().zip(expected) {
                        if let Some(identity) = want.get("identity") {
                            assert_eq!(Some(arrival.identity.as_str()), identity.as_str(), "{at}: identity");
                        }
                        if let Some(version) = want.get("version") {
                            assert_eq!(arrival.version.as_deref(), version.as_str(), "{at}: version");
                        }
                        if let Some(landing) = want.get("landing") {
                            assert_eq!(&arrival.landing, landing, "{at}: landing");
                        }
                    }
                }
                "note" => {
                    let counts = store.note_arrival(&names.wait(text(step, "wait")), text(step, "identity"), opt_text(step, "version"), flag(step, "matched")).unwrap();
                    assert_eq!(counts, flag(step, "counts"), "{at}: counts");
                }
                "park" => {
                    let (run, wait) = (names.id(text(step, "run")), names.wait(text(step, "wait")));
                    let park = Park { run_id: &run, address: text(step, "address"), state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &wait } };
                    store.commit_park(&park).unwrap();
                }
                "deleteLeaves" => {
                    let addresses: Vec<String> = list(step, "addresses").iter().map(|a| a.as_str().unwrap().to_string()).collect();
                    store.delete_leaves(&names.id(text(step, "run")), &addresses).unwrap();
                }
                "drop" => {
                    assert!(store.drop_run_state(&names.id(text(step, "run")), None).unwrap(), "{at}: dropped");
                }
                "sweep" => {
                    store.sweep_arrivals(&iso(step.get("before").and_then(int).unwrap()), 1000).unwrap();
                }
                other => panic!("{at}: no step {other}"),
            }
        }
    }

    fn over_a_state_file(test: &str) {
        let case = cases().into_iter().find(|c| test_name(text(c, "case")) == test).unwrap_or_else(|| panic!("no case for {test}"));
        run_case(&state_file(), &case);
    }

    macro_rules! store_cases {
        ($($name:ident),* $(,)?) => {
            const CASE_TESTS: &[&str] = &[$(stringify!($name)),*];
            $( #[test] fn $name() { over_a_state_file(stringify!($name)) } )*
        };
    }

    store_cases! {
        an_arrival_logged_before_its_wait_opens_counts_when_the_mark_precedes_it,
        an_arrival_before_the_mark_is_not_the_waits,
        an_arrival_is_the_waits_only_on_its_own_record_edge_adapter_and_team,
        without_a_version_an_identity_is_one_arrival_and_with_one_each_version_is_another,
        an_arrival_without_an_identity_is_its_own,
        newly_matches_counts_once_until_it_stops_matching,
        a_noted_arrival_is_no_longer_listed,
        two_arrivals_on_one_wait_count_in_log_order,
        a_gone_arrival_marks_the_wait_gone,
        logging_answers_only_the_parked_waits_on_its_key,
        opening_a_wait_its_run_already_has_on_that_records_edge_is_the_same_wait_from_its_first_mark,
        rows_drop_with_their_run_and_the_sweep_spares_what_a_live_row_reads,
    }

    #[test]
    fn every_case_in_the_file_runs_here() {
        let named: Vec<String> = cases().iter().map(|c| test_name(text(c, "case"))).collect();
        let mut tested: Vec<String> = CASE_TESTS.iter().map(|t| t.to_string()).collect();
        let mut file = named.clone();
        tested.sort();
        file.sort();
        assert_eq!(tested, file);
    }

    /// The cases over Postgres, when LF_TEST_PG names a database to set up
    /// and write into (the cases' ids are fresh; the sweep forgets any
    /// arrival there no wait reads).
    #[cfg(feature = "postgres")]
    #[test]
    fn every_case_holds_over_postgres() {
        let Some(url) = std::env::var("LF_TEST_PG").ok().filter(|u| !u.is_empty()) else { return };
        crate::pg_store::PgStore::migrate(&url).unwrap();
        let store = crate::pg_store::PgStore::connect(&url, crate::backend::POSTGRES_TENANT).unwrap();
        for case in cases() {
            run_case(&store, &case);
        }
    }

    #[test]
    fn the_sweep_says_how_many_went_and_a_parked_unknown_wait_writes_nothing() {
        let store = state_file();
        store.start_run(&RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None }).unwrap();
        let arrival = |key: &str| NewArrival { edge: "Comments".into(), key: key.into(), identity: Some("k".into()), version: None, landing: None, gone: false };
        store.log_arrivals("t", "acme", &[arrival("a"), arrival("b"), arrival("c")], &iso(-2 * ARRIVAL_RETENTION_MS)).unwrap();
        assert_eq!(store.sweep_arrivals(&iso(-ARRIVAL_RETENTION_MS), 2).unwrap(), 2);
        assert_eq!(store.sweep_arrivals(&iso(-ARRIVAL_RETENTION_MS), 2).unwrap(), 1);
        let park = Park { run_id: "run-1", address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: "no-such-wait" } };
        assert!(matches!(store.commit_park(&park), Err(StoreError::Invalid(_))));
        assert!(store.leaves("run-1", false, None, None).unwrap().is_empty());
        assert!(matches!(store.wait_arrivals("no-such-wait"), Err(StoreError::Invalid(_))));
    }
}

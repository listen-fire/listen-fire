//! The loop breaker: a run's writes can cause arrivals that fire more runs
//! (a two-way sync, or a loop across programs). Each record write a run
//! makes is kept in the store's write ledger (`writes.record`) with the
//! run's place in its chain. An arrival on a record a run wrote, soon
//! enough after the write (lf.yaml's `loopWindow`), was caused by it: the
//! run it fires is the next in that run's chain. A chain may be `loopDepth`
//! runs long; the listen whose arrival would start the next is paused,
//! loudly (`LISTEN_LOOP`), until `listen-fire listens resume`.
//!
//! "Soon enough" is measured from the write to when the arrival happened at
//! its provider (`occurredAt`, adapter protocol 2.6), so an echo a poll finds
//! minutes later is still caught; an arrival that names no time is measured
//! to when listen-fire takes it. Only the window's start bounds the writes
//! matched: a provider's clock a little behind ours must not hide an echo,
//! so a write sent between a change and its arrival counts too. That errs
//! toward a longer chain, never toward a loop that runs on.
//!
//! A write that would change nothing is never sent (the engine reads the
//! record first where its module lists `readRecord`, and settles the write
//! `noop`), so a two-way sync's echo writes nothing and its chain ends.

use crate::arrivals::ArrivalIn;
use crate::backend::RunHostStore;
use crate::json::Js;
use crate::project::Project;
use crate::runs::FileSet;
use crate::store::{Result, Store};

/// One record write a run made (`writes.record`): `depth` is the run's
/// place in its chain (0: a run nothing in the ledger caused).
#[derive(Debug, Clone, PartialEq)]
pub struct LedgerWrite {
    pub adapter: String,
    pub record_type: String,
    pub external_id: String,
    pub run_id: String,
    pub depth: u32,
    /// When the write was sent.
    pub at: String,
}

/// Where a segment keeps each record write it sends, the moment its module
/// answers it (before anything else runs, so an echo the provider sends
/// right after finds it): its run, at the run's place in its chain.
pub struct Ledger<'a> {
    pub store: &'a dyn RunHostStore,
    pub run_id: String,
    pub depth: u32,
    /// Writes made before this are forgotten as one is kept (`kept_ms`).
    pub forget_before: String,
}

impl Ledger<'_> {
    /// Keep the write of `record`, sent `at` (before its provider can have
    /// stamped its echo). A store that cannot keep it fails the call: a
    /// write the ledger does not know would let its echo start a chain of
    /// its own, and a loop go unbroken.
    pub fn keep(&self, record: LedgerRecord<'_>, at: &str) -> std::result::Result<(), String> {
        let write = LedgerWrite {
            adapter: record.adapter.to_string(),
            record_type: record.record_type.to_string(),
            external_id: record.external_id.to_string(),
            run_id: self.run_id.clone(),
            depth: self.depth,
            at: at.to_string(),
        };
        self.store
            .ledger_write(&write, &self.forget_before)
            .map_err(|e| format!("keeping run {}'s write of {} {} in the write ledger failed after the write was sent: {e}", self.run_id, record.record_type, record.external_id))
    }
}

/// A record, as the ledger keys a write of it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LedgerRecord<'a> {
    pub adapter: &'a str,
    pub record_type: &'a str,
    pub external_id: &'a str,
}

/// The deepest write of a record within the window (`writes.depth`).
#[derive(Debug, Clone, PartialEq)]
pub struct Deepest {
    pub run_id: String,
    pub depth: u32,
}

/// What a delivery says of an arrival a paused listen does not run.
pub const HELD: &str = "held: the listen is paused (LISTEN_LOOP)";

/// The runs before a run in its chain, oldest first, as its facts keep
/// them (`chain`): none for a run nothing in the ledger caused.
pub fn chain_in(facts: &Js) -> Vec<String> {
    match facts.get("chain") {
        Some(Js::Arr(runs)) => runs.iter().filter_map(Js::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

/// The records an arrival is matched to writes by: the record it is about,
/// where its edge declares `attributes`, and its landing (by the landing's
/// `recordType`, else `landing_type`, the type the listened edge lands on).
pub fn records_of<'a>(adapter: &'a str, arrival: &'a ArrivalIn, landing_type: &'a str) -> Vec<LedgerRecord<'a>> {
    let about = arrival.about.as_ref().and_then(|about| Some((about.get("recordType")?.as_str()?, about.get("externalId")?.as_str()?)));
    let landing = arrival.landing.as_ref().and_then(|landing| {
        let record_type = landing.get("recordType").and_then(Js::as_str).unwrap_or(landing_type);
        Some((record_type, landing.get("recordId")?.as_str()?))
    });
    about.into_iter().chain(landing).map(|(record_type, external_id)| LedgerRecord { adapter, record_type, external_id }).collect()
}

/// The earliest write that can have caused `arrival` (epoch ms): `window_ms`
/// before it happened at its provider (`occurredAt`), or, when it names no
/// time, before `now_ms`, when listen-fire takes it.
pub fn since_of(arrival: &ArrivalIn, window_ms: i64, now_ms: i64) -> i64 {
    arrival.occurred_at.as_deref().and_then(crate::units::ms_of).unwrap_or(now_ms) - window_ms
}

/// The runs before the run `records` would fire, oldest first: the chain of
/// the run whose write of one of them, at or after `since`, is deepest, and
/// that run. None in the ledger: a chain of its own (empty).
pub fn chain_of(store: &dyn RunHostStore, records: &[LedgerRecord<'_>], since: &str) -> std::result::Result<Vec<String>, String> {
    let mut deepest: Option<Deepest> = None;
    for record in records {
        if let Some(found) = store.deepest_write(record, since).map_err(|e| e.to_string())?
            && deepest.as_ref().is_none_or(|d| found.depth > d.depth)
        {
            deepest = Some(found);
        }
    }
    let Some(cause) = deepest else { return Ok(Vec::new()) };
    let row = store.run(&cause.run_id).map_err(|e| e.to_string())?;
    let facts = row.as_ref().and_then(|row| Js::parse(row.input.as_bytes()).ok());
    let Some(facts) = facts else {
        return Err(format!("the write ledger names run {}, which the store holds no facts of", cause.run_id));
    };
    let mut chain = chain_in(&facts);
    chain.push(cause.run_id);
    Ok(chain)
}

/// The line a listen is paused with when `arrival`'s run would be the
/// `chain.len() + 1`th of its chain: past `loopDepth`.
pub fn loop_line(named: &str, chain: &[String]) -> String {
    format!(
        "LISTEN_LOOP: {named} is paused: this arrival would start run {} of a chain of writes and arrivals ({}); `listen-fire listens resume {named}` once the loop is broken",
        chain.len() + 1,
        chain.join(", ")
    )
}

/// How long a write is kept in the ledger, in milliseconds: the loop window,
/// and as long again as the slowest poll may take to find its echo.
pub fn kept_ms(project: &Project, set: &FileSet) -> i64 {
    let declared = crate::edge_polls::polled_keys(set).into_values().filter_map(|shared| shared.declared.and_then(|d| d.poll_every_seconds)).map(|s| s as i64 * 1000);
    let slowest = declared.chain(project.poll_every.values().copied()).max().unwrap_or(0);
    project.loop_window_ms + slowest
}

// ── The write ledger in the state file ──────────────────────────────────────

impl Store {
    /// Keep a run's record write, and forget every write made before
    /// `forget_before`, as one write.
    pub fn ledger_write(&self, write: &LedgerWrite, forget_before: &str) -> Result<()> {
        let at = crate::store::canonical_iso(&write.at)?;
        let forget_before = crate::store::canonical_iso(forget_before)?;
        self.transaction(|db| {
            db.execute("delete from write_ledger where at < ?", rusqlite::params![forget_before])?;
            db.execute(
                "insert into write_ledger (adapter, record_type, external_id, run_id, depth, at) values (?, ?, ?, ?, ?, ?)",
                rusqlite::params![write.adapter, write.record_type, write.external_id, write.run_id, write.depth, at],
            )?;
            Ok(())
        })
    }

    /// The deepest write of `record` made at or after `since`, the latest of
    /// those as deep.
    pub fn deepest_write(&self, record: &LedgerRecord<'_>, since: &str) -> Result<Option<Deepest>> {
        use rusqlite::OptionalExtension;
        let since = crate::store::canonical_iso(since)?;
        Ok(self
            .db
            .query_row(
                "select run_id, depth from write_ledger where adapter = ? and record_type = ? and external_id = ? and at >= ? order by depth desc, at desc limit 1",
                rusqlite::params![record.adapter, record.record_type, record.external_id, since],
                |r| Ok(Deepest { run_id: r.get(0)?, depth: r.get(1)? }),
            )
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{RunStart, iso_at};

    const T0: &str = "2026-10-31T10:00:00.000Z";

    fn ms(iso: &str) -> i64 {
        crate::units::ms_of(iso).unwrap()
    }

    fn at(offset_ms: i64) -> String {
        iso_at(ms(T0) + offset_ms)
    }

    fn state_file() -> (std::path::PathBuf, Store) {
        let dir = std::env::temp_dir().join(format!("lf-loop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("state.db")).unwrap();
        (dir, store)
    }

    /// A run started with the facts `chain` names before it.
    fn run(store: &dyn RunHostStore, chain: &[&str]) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let input = format!(r#"{{"chain":{}}}"#, serde_json::to_string(chain).unwrap());
        store.start_run(&RunStart { id: &id, file: "companies", movement: "note", started_at: T0, input: &input, delivery_id: None }).unwrap();
        id
    }

    fn write(store: &dyn RunHostStore, run_id: &str, depth: u32, record: (&str, &str), offset_ms: i64) {
        let write = LedgerWrite { adapter: "acme_crm".into(), record_type: record.0.into(), external_id: record.1.into(), run_id: run_id.into(), depth, at: at(offset_ms) };
        store.ledger_write(&write, &at(-3_600_000)).unwrap();
    }

    fn company_arrival(id: &str, occurred_at: Option<&str>) -> ArrivalIn {
        let landing = Js::parse(format!(r#"{{"recordId":"{id}","recordType":"Company","fields":{{"id":"{id}"}}}}"#).as_bytes()).unwrap();
        ArrivalIn {
            edge: "Company".into(),
            key: None,
            identity: Some(id.into()),
            version: None,
            landing: Some(landing),
            gone: false,
            parents: Vec::new(),
            about: None,
            not_for: None,
            taken_applied: false,
            occurred_at: occurred_at.map(str::to_string),
        }
    }

    /// The chain the arrival's run would continue, under `window_ms`, taken
    /// `now_offset_ms` after T0.
    fn chain_for(store: &dyn RunHostStore, arrival: &ArrivalIn, window_ms: i64, now_offset_ms: i64) -> Vec<String> {
        let since = iso_at(since_of(arrival, window_ms, ms(T0) + now_offset_ms));
        chain_of(store, &records_of("acme_crm", arrival, "Company"), &since).unwrap()
    }

    #[test]
    fn an_arrival_on_a_record_no_run_wrote_starts_a_chain_of_its_own() {
        let (dir, store) = state_file();
        assert_eq!(chain_for(&store, &company_arrival("company-1", None), 20_000, 0), Vec::<String>::new());
        let a = run(&store, &[]);
        write(&store, &a, 0, ("Company", "company-2"), 0);
        assert_eq!(chain_for(&store, &company_arrival("company-1", None), 20_000, 1_000), Vec::<String>::new(), "another record");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_arrival_on_a_record_a_run_wrote_within_the_window_continues_its_chain() {
        let (dir, store) = state_file();
        let a = run(&store, &[]);
        let b = run(&store, &[&a]);
        write(&store, &b, 1, ("Company", "company-1"), 0);
        assert_eq!(chain_for(&store, &company_arrival("company-1", None), 20_000, 5_000), [a.clone(), b.clone()], "taken 5s after the write");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// An echo arriving 30s after the write is more likely a person than a
    /// slow loopback under the default window; under `loopWindow: 60s` it is
    /// the write's.
    #[test]
    fn an_echo_past_the_window_is_not_the_writes_and_a_wider_window_takes_it() {
        let (dir, store) = state_file();
        let a = run(&store, &[]);
        write(&store, &a, 0, ("Company", "company-1"), 0);
        let echo = company_arrival("company-1", None);
        assert_eq!(chain_for(&store, &echo, crate::project::DEFAULT_LOOP_WINDOW_MS, 30_000), Vec::<String>::new());
        assert_eq!(chain_for(&store, &echo, 60_000, 30_000), [a.clone()]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A poll finds the echo minutes after it happened: it is measured from
    /// when it happened at its provider, not from when it was found.
    #[test]
    fn an_arrival_is_measured_from_when_it_happened_at_its_provider() {
        let (dir, store) = state_file();
        let a = run(&store, &[]);
        write(&store, &a, 0, ("Company", "company-1"), 0);
        let polled = company_arrival("company-1", Some(&at(2_000)));
        assert_eq!(chain_for(&store, &polled, 20_000, 300_000), [a.clone()], "happened 2s after the write, found 5m after");
        let late = company_arrival("company-1", Some("2026-10-31T10:00:45+00:00"));
        assert_eq!(chain_for(&store, &late, 20_000, 300_000), Vec::<String>::new(), "happened 45s after the write");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// An arrival about a record (a note about its company) is matched by
    /// that record and by its landing: the deepest write of either is its cause.
    #[test]
    fn the_deepest_write_of_the_record_it_is_about_or_its_landing_is_its_cause() {
        let (dir, store) = state_file();
        let a1 = run(&store, &[]);
        write(&store, &a1, 0, ("Note", "note-1"), 0);
        let b1 = run(&store, &[&a1]);
        write(&store, &b1, 1, ("Company", "company-1"), 100);
        let a2 = run(&store, &[&a1, &b1]);
        write(&store, &a2, 2, ("Note", "note-2"), 200);
        let mut note = company_arrival("note-2", None);
        note.edge = "Note".into();
        note.landing = Some(Js::parse(br#"{"recordId":"note-2","recordType":"Note","fields":{"Id":"note-2"}}"#).unwrap());
        note.about = Some(Js::parse(br#"{"recordType":"Company","externalId":"company-1"}"#).unwrap());
        let records = records_of("acme_crm", &note, "Note");
        assert_eq!(records.iter().map(|r| (r.record_type, r.external_id)).collect::<Vec<_>>(), [("Company", "company-1"), ("Note", "note-2")]);
        assert_eq!(chain_for(&store, &note, 20_000, 1_000), [a1.clone(), b1.clone(), a2.clone()]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A landing that names no type is the type the listened edge lands on.
    #[test]
    fn a_landing_naming_no_type_is_the_edges() {
        let mut arrival = company_arrival("company-1", None);
        arrival.landing = Some(Js::parse(br#"{"recordId":"company-1","fields":{}}"#).unwrap());
        let records = records_of("acme_crm", &arrival, "Company");
        assert_eq!(records, [LedgerRecord { adapter: "acme_crm", record_type: "Company", external_id: "company-1" }]);
        arrival.landing = Some(Js::parse(br#"{"fields":{}}"#).unwrap());
        assert_eq!(records_of("acme_crm", &arrival, "Company"), Vec::new(), "no record: nothing to match");
    }

    #[test]
    fn a_write_older_than_the_ledger_keeps_is_forgotten_as_the_next_is_kept() {
        let (dir, store) = state_file();
        let a = run(&store, &[]);
        write(&store, &a, 0, ("Company", "company-1"), 0);
        let later = LedgerWrite { adapter: "acme_crm".into(), record_type: "Company".into(), external_id: "company-2".into(), run_id: a.clone(), depth: 0, at: at(120_000) };
        store.ledger_write(&later, &at(60_000)).unwrap();
        let record = LedgerRecord { adapter: "acme_crm", record_type: "Company", external_id: "company-1" };
        assert_eq!(store.deepest_write(&record, &at(-3_600_000)).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_paused_line_names_the_run_it_would_start_and_the_chain() {
        let chain: Vec<String> = (1..=10).map(|n| format!("r{n}")).collect();
        assert_eq!(
            loop_line("companies:note", &chain),
            "LISTEN_LOOP: companies:note is paused: this arrival would start run 11 of a chain of writes and arrivals (r1, r2, r3, r4, r5, r6, r7, r8, r9, r10); `listen-fire listens resume companies:note` once the loop is broken"
        );
    }
}

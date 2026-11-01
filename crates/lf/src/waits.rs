//! A run's waits on listenable edges, and the log of arrivals they read: the
//! rows the store trait's waits family keeps (crate::backend; the store
//! slot's `waits.*`, docs/contracts/store-slot.md), and the SQLite state
//! file's implementation of that family.
//!
//! - Every arrival a module reports is logged under a store-wide increasing
//!   seq. The sweep (`sweep_arrivals`) forgets it once no live wait on its
//!   record's edge reads it and it is at or below the floor: the lowest mark
//!   a running step took when it claimed its run's lease, else the latest
//!   seq. Its identity outlives it for the module's re-send window, so a
//!   provider's re-send after the sweep is still a repeat.
//! - A wait is live while its run exists, or, for one a delivery opened for
//!   the run it queued (`DeliveryWait`), while that run's `fire_event` row
//!   is queued.
//! - A wait is one row: this run waits on this edge of this record. It reads
//!   the arrivals logged after its mark, a seq taken before the write that may
//!   cause them, so an arrival logged during the write still counts.
//! - A wait notes each arrival it judged, by identity and version, so each
//!   counts once. Per identity it keeps whether the record matched last time:
//!   an arrival counts when the record newly matches.
//! - Logging answers the waits parked on the arrival's record, so the host
//!   can wake their runs. A gone arrival (its record deleted) wakes none: it
//!   strands them, and they stay parked (docs/contracts/stranded-waits.md).
//!   The newest report on a record wins: an arrival logged after it wakes
//!   them and clears their stranding.
//! - A log and a park on one record's edge never interleave (the state file
//!   has one writer at a time; Postgres takes a lock on the record's edge),
//!   so a run that reads its wait's arrivals after parking misses none:
//!   either the log saw the park and answers it, or the read sees the
//!   arrival.

use rusqlite::{Connection, OptionalExtension, params};

use crate::json::Js;
use crate::obj;
use crate::store::{NewWork, Store, StoreError, canonical_iso, iso};

type Result<T> = std::result::Result<T, StoreError>;

/// One arrival a module reported on an edge of a record.
#[derive(Debug, Clone, PartialEq)]
pub struct NewArrival {
    pub edge: String,
    /// The record whose edge it arrived on.
    pub key: String,
    /// What the edge declares identifies an arrival. None: this report is an
    /// arrival of its own; its identity is `#` and its seq. Only such a report
    /// is named so by the log, which keeps it apart from a bare seq a module
    /// reports; a module identity of exactly `#` and a number could collide.
    pub identity: Option<String>,
    pub version: Option<String>,
    pub landing: Option<Js>,
    /// The record is gone: nothing more arrives on its edges.
    pub gone: bool,
}

/// A wait's judgment of one arrival (`waits.note`).
pub struct Noted<'a> {
    pub wait_id: &'a str,
    pub identity: &'a str,
    pub version: Option<&'a str>,
    /// Whether the arrival's record matched the wait's WHERE.
    pub matched: bool,
    /// The leaf the noting segment resumed, if it resumed one: the note is
    /// kept only when that segment's progress is (its `parks.commitSegment`,
    /// `parks.finishLeaf`, or a park at the leaf's address). Until then it is the segment's own; a
    /// segment that dies leaves it unkept, and the leaf's next claim drops
    /// it, so the arrival is read again rather than lost.
    pub leaf: Option<&'a str>,
    /// The run lease the noting segment holds: a segment that lost it
    /// notes nothing (`StoreError::LeaseLost`), so its note can never be
    /// kept by the segment that took the run over.
    pub fence: Option<&'a str>,
}

/// A wait to open: `since` is the mark it reads arrivals after.
pub struct OpenWait<'a> {
    pub run_id: &'a str,
    pub team_id: &'a str,
    pub adapter_type: &'a str,
    pub edge: &'a str,
    /// None: the record was gone when the wait opened (an `awaitKeys`
    /// answer of `{gone: true}`), so nothing can arrive on it.
    pub key: Option<&'a str>,
    /// The record waited on, by its id (None from an engine that names
    /// none): what a stranded wait says it lost.
    pub record_id: Option<&'a str>,
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
    pub arrivals: Vec<LoggedArrival>,
}

/// A wait parked at `address` that a logged arrival answers.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct WaitWake {
    pub run_id: String,
    pub wait_id: String,
    pub address: String,
}

/// A wait parked on a record whose newest report is that it went
/// (`waits.stranded`): it never resolves unless the record reports again,
/// and its run stays parked unless something else in it moves.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Stranded {
    pub wait_id: String,
    pub run_id: String,
    pub adapter_type: String,
    pub edge: String,
    /// None for a wait opened on a record already gone.
    pub key: Option<String>,
    /// The record waited on, by its id, when the wait was opened naming it.
    pub record_id: Option<String>,
    /// When the store found it parked on a deleted record.
    pub at: String,
    /// Whether its leaf is still parked: a race's other arm may have won.
    pub parked: bool,
}

/// What a `waits.log` did: the waits it answered, each now owed a wake, and
/// the waits it left stranded (a later arrival in the same log on the
/// record clears a stranding it made).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Logged {
    pub wakes: Vec<WaitWake>,
    pub stranded: Vec<Stranded>,
}

/// Which stranded waits `waits.stranded` answers, oldest stranded first.
#[derive(Debug, Clone, Copy)]
pub enum StrandedOf<'a> {
    /// The run's.
    Run(&'a str),
    /// Every run's, at most `limit`, after the wait `after` names.
    Page { after: Option<StrandedAfter<'a>>, limit: i64 },
}

/// Where a page of stranded waits left off: the last wait it answered.
#[derive(Debug, Clone, Copy)]
pub struct StrandedAfter<'a> {
    pub at: &'a str,
    pub wait_id: &'a str,
}

/// Arrivals to log (`waits.log`), and in a kept delivery
/// (`inbound.keepDelivery`'s `arrivals`), so a redelivery logs nothing again.
pub struct DeliveryArrivals<'a> {
    pub team_id: &'a str,
    pub adapter_type: &'a str,
    pub arrivals: &'a [NewArrival],
    pub at: &'a str,
    /// The module's re-send window: an identity logged is a repeat for this
    /// long after `at`, whether or not its entry was swept.
    pub resend_window_ms: i64,
}

/// A wait a kept delivery opens for a run it queued, before the run exists,
/// so a reply that lands while the run waits in the queue still counts
/// (`inbound.keepDelivery`'s `waits`). It reads the arrivals after the mark
/// taken before the delivery's own, and is live while the run's
/// `fire_event` row (`fire_key`) is queued or the run exists.
#[derive(Debug, Clone, PartialEq)]
pub struct DeliveryWait {
    pub run_id: String,
    pub edge: String,
    /// None: the record was gone when the delivery was kept.
    pub key: Option<String>,
    /// The run's trigger is this arrival of the delivery, on this wait's
    /// edge and record: noted as judged (not matching), so the run's own
    /// trigger never answers its wait.
    pub pre_noted: Option<PreNoted>,
    /// The key of the `fire_event` row, among the delivery's work, that
    /// queues the run.
    pub fire_key: String,
}

/// What keeping a delivery wrote (`inbound.keepDelivery`'s answer): the
/// `wake_await` rows its arrivals queued, and the mark before its arrivals,
/// which its `fire_event` rows carry as `arrivalMark`.
#[derive(Debug, Clone)]
pub struct KeptDelivery {
    pub wakes: Vec<NewWork>,
    pub arrival_mark: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PreNoted {
    pub identity: String,
    pub version: Option<String>,
}

/// A delivery's waits read from the mark before its arrivals, under their
/// team and adapter: waits sent without arrivals are refused by name, not
/// dropped.
pub fn refuse_waits_without_arrivals(arrivals: Option<&DeliveryArrivals<'_>>, waits: &[DeliveryWait]) -> crate::store::Result<()> {
    match (arrivals, waits) {
        (None, [_, ..]) => Err(crate::store::StoreError::Invalid("inbound.keepDelivery: `waits` came without `arrivals`; a delivery's waits are opened with its arrivals, under their team and adapter".into())),
        _ => Ok(()),
    }
}

/// The work rows a kept delivery's arrivals change and add: each
/// `fire_event` row carries `mark`, the mark before the delivery's own
/// arrivals, as its `arrivalMark` (a run it starts reads its waits'
/// arrivals after it; its trigger's own arrival is noted on them), and each
/// wait a logged arrival answers gets a `wake_await { waitId, runId,
/// address }` row (`wake_row`).
pub fn delivery_rows(work: &[NewWork], mark: i64, team_id: &str, wakes: &[WaitWake]) -> (Vec<NewWork>, Vec<NewWork>) {
    let marked = work
        .iter()
        .map(|row| {
            let mut row = row.clone();
            if let (true, Js::Obj(payload)) = (row.kind == "fire_event", &mut row.payload) {
                payload.insert("arrivalMark".into(), Js::Num(mark.into()));
            }
            row
        })
        .collect();
    (marked, wake_rows(team_id, wakes))
}

/// A `wake_await` row per wait, due now: the drain re-enters the run's
/// await parked at the wait's address, which reads its arrivals.
pub fn wake_rows(team_id: &str, wakes: &[WaitWake]) -> Vec<NewWork> {
    wakes.iter().map(|wake| wake_row(team_id, wake)).collect()
}

/// One wait's `wake_await` row: `{ waitId, runId, address }`.
pub fn wake_row(team_id: &str, wake: &WaitWake) -> NewWork {
    NewWork {
        kind: "wake_await".into(),
        key: format!("wake_await:{}", uuid::Uuid::new_v4()),
        payload: Js::Obj(obj! { "waitId" => Js::str(&wake.wait_id), "runId" => Js::str(&wake.run_id), "address" => Js::str(&wake.address) }),
        due_at: None,
        team_id: Some(team_id.to_string()),
    }
}

// ── The family over the state file (the trait's SQLite implementation) ─────

impl Store {
    /// The latest seq logged; an arrival logged after this call is above it.
    pub fn arrival_mark(&self) -> Result<i64> {
        Self::arrival_mark_in(&self.db)
    }

    pub(crate) fn arrival_mark_in(db: &Connection) -> Result<i64> {
        Ok(db.query_row("select coalesce(max(seq), 0) from arrival", [], |r| r.get(0))?)
    }

    /// The arrivals logged and a `wake_await` row queued for each wait they
    /// answer, in one transaction: a crash leaves both or neither.
    pub fn log_arrivals(&self, log: &DeliveryArrivals<'_>) -> Result<Logged> {
        self.transaction(|db| {
            let logged = Self::log_arrivals_in(db, log)?;
            for row in wake_rows(log.team_id, &logged.wakes) {
                Self::enqueue_in(db, &row.kind, &row.key, &row.payload, row.due_at.as_deref())?;
            }
            Ok(logged)
        })
    }

    pub(crate) fn log_arrivals_in(db: &Connection, log: &DeliveryArrivals<'_>) -> Result<Logged> {
        let DeliveryArrivals { team_id, adapter_type, arrivals, at, resend_window_ms } = *log;
        let at = &canonical_iso(at)?;
        let kept_until = &iso_after(at, resend_window_ms)?;
        {
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
            // A repeat: its identity and version already logged on its
            // record's edge within the module's re-send window (a sender's
            // retry), even if the sweep forgot its entry since.
            let mut logged = db.prepare(
                "select 1 from arrival_identity where team_id = ? and adapter_type = ? and edge = ? and key = ? and identity = ? and version is ? and kept_until > ?",
            )?;
            let mut identify = db.prepare(
                "insert into arrival_identity (team_id, adapter_type, edge, key, identity, version, kept_until) values (?, ?, ?, ?, ?, ?, ?)",
            )?;
            // A deleted record answers no wait: the waits parked on it are
            // stranded, once, and keep waiting.
            let mut strand = db.prepare(
                "update wait_row set stranded_at = ?
                 where team_id = ? and adapter_type = ? and edge = ? and key = ? and stranded_at is null and address is not null
                   and exists (select 1 from leaf l where l.run_id = wait_row.run_id and l.address = wait_row.address)
                 returning id, run_id, adapter_type, edge, key, record_id",
            )?;
            // The newest report on a record wins: one after a gone one says
            // the record is back (or never went), so its waits are not
            // stranded.
            let mut unstrand = db.prepare(
                "update wait_row set stranded_at = null
                 where team_id = ? and adapter_type = ? and edge = ? and key = ? and stranded_at is not null
                 returning id",
            )?;
            let mut answer = Logged::default();
            for arrival in arrivals {
                if let Some(identity) = &arrival.identity {
                    if logged.exists(params![team_id, adapter_type, arrival.edge, arrival.key, identity, arrival.version, at])? {
                        continue;
                    }
                    identify.execute(params![team_id, adapter_type, arrival.edge, arrival.key, identity, arrival.version, kept_until])?;
                }
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
                if arrival.gone {
                    let stranded = strand.query_map(params![at, team_id, adapter_type, arrival.edge, arrival.key], |r| {
                        Ok(Stranded { wait_id: r.get(0)?, run_id: r.get(1)?, adapter_type: r.get(2)?, edge: r.get(3)?, key: r.get(4)?, record_id: r.get(5)?, at: at.to_string(), parked: true })
                    })?;
                    for wait in stranded {
                        answer.stranded.push(wait?);
                    }
                    continue;
                }
                let unstranded = unstrand.query_map(params![team_id, adapter_type, arrival.edge, arrival.key], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                answer.stranded.retain(|wait| !unstranded.contains(&wait.wait_id));
                let answered = parked.query_map(params![team_id, adapter_type, arrival.edge, arrival.key], |r| {
                    Ok(WaitWake { run_id: r.get(0)?, wait_id: r.get(1)?, address: r.get(2)? })
                })?;
                for wake in answered {
                    let wake = wake?;
                    if !answer.wakes.iter().any(|w| w.wait_id == wake.wait_id) {
                        answer.wakes.push(wake);
                    }
                }
            }
            answer.stranded.sort();
            Ok(answer)
        }
    }

    /// The wait's id. A run that already waits on this edge of this record
    /// keeps that wait, and its mark; likewise one that already waits on
    /// this edge of a record already gone (no key). A wait with no record id
    /// (a delivery opened it) takes the one given; one with an id keeps it.
    pub fn open_wait(&self, wait: &OpenWait<'_>) -> Result<String> {
        let OpenWait { run_id, team_id, adapter_type, edge, key, record_id, since } = *wait;
        self.transaction(|db| {
            db.execute(
                "insert into wait_row (id, run_id, team_id, adapter_type, edge, key, record_id, since) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing",
                params![uuid::Uuid::new_v4().to_string(), run_id, team_id, adapter_type, edge, key, record_id, since],
            )?;
            // A delivery opens the wait before the run reaches its `await`, with
            // no record id; the run's own open then fills it in.
            db.execute(
                "update wait_row set record_id = ? where run_id = ? and team_id = ? and adapter_type = ? and edge = ? and key is ? and record_id is null",
                params![record_id, run_id, team_id, adapter_type, edge, key],
            )?;
            Ok(db.query_row(
                "select id from wait_row where run_id = ? and team_id = ? and adapter_type = ? and edge = ? and key is ?",
                params![run_id, team_id, adapter_type, edge, key],
                |r| r.get(0),
            )?)
        })
    }

    /// The arrivals after the wait's mark on its record's edge that it has
    /// not noted, the first of each identity and version only.
    pub fn wait_arrivals(&self, wait_id: &str) -> Result<WaitArrivals> {
        self.transaction(|db| Self::wait_arrivals_in(db, wait_id))
    }

    pub(crate) fn wait_arrivals_in(db: &Connection, wait_id: &str) -> Result<WaitArrivals> {
        Self::require_wait(db, wait_id)?;
        let mut statement = db.prepare(
            "select a.seq, coalesce(a.identity, '#' || a.seq), a.version, a.landing
             from wait_row w join arrival a
               on a.team_id = w.team_id and a.adapter_type = w.adapter_type and a.edge = w.edge and a.key = w.key and a.seq > w.since
             where w.id = ?1 and a.gone = 0
               and not exists (select 1 from wait_seen s
                 where s.wait_id = w.id and s.identity = coalesce(a.identity, '#' || a.seq) and s.version is a.version)
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
        Ok(WaitArrivals { arrivals })
    }

    /// The stranded waits `of` names, oldest stranded first (ties by id).
    pub fn stranded_waits(&self, of: &StrandedOf<'_>) -> Result<Vec<Stranded>> {
        const COLUMNS: &str = "select w.id, w.run_id, w.adapter_type, w.edge, w.key, w.stranded_at, w.record_id,
               w.address is not null and exists (select 1 from leaf l where l.run_id = w.run_id and l.address = w.address)
             from wait_row w where w.stranded_at is not null";
        let read = |r: &rusqlite::Row<'_>| {
            Ok(Stranded { wait_id: r.get(0)?, run_id: r.get(1)?, adapter_type: r.get(2)?, edge: r.get(3)?, key: r.get(4)?, at: r.get(5)?, record_id: r.get(6)?, parked: r.get(7)? })
        };
        let rows = match *of {
            StrandedOf::Run(run_id) => {
                self.db.prepare(&format!("{COLUMNS} and w.run_id = ? order by w.stranded_at, w.id"))?.query_map(params![run_id], read)?.collect::<rusqlite::Result<Vec<_>>>()?
            }
            StrandedOf::Page { after: None, limit } => {
                self.db.prepare(&format!("{COLUMNS} order by w.stranded_at, w.id limit ?"))?.query_map(params![limit], read)?.collect::<rusqlite::Result<Vec<_>>>()?
            }
            StrandedOf::Page { after: Some(StrandedAfter { at, wait_id }), limit } => self
                .db
                .prepare(&format!("{COLUMNS} and (w.stranded_at, w.id) > (?, ?) order by w.stranded_at, w.id limit ?"))?
                .query_map(params![canonical_iso(at)?, wait_id, limit], read)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        };
        Ok(rows)
    }

    /// Note that the wait judged this arrival, and whether its record
    /// matched. Whether it counts: it matched, and the record did not match
    /// at its last noted arrival. An arrival noted before counts no more.
    pub fn note_arrival(&self, noted: &Noted<'_>) -> Result<bool> {
        let Noted { wait_id, identity, version, matched, leaf, fence } = *noted;
        self.transaction(|db| {
            let run_id = Self::require_wait(db, wait_id)?;
            if let Some(fence) = fence
                && !Self::holds(db, &run_id, fence)?
            {
                return Err(StoreError::LeaseLost { run_id });
            }
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
            db.execute("insert into wait_seen (wait_id, identity, version, matched, leaf) values (?, ?, ?, ?, ?)", params![wait_id, identity, version, matched, leaf])?;
            Ok(matched && !matched_before)
        })
    }

    /// Forget at most `limit` arrivals no live wait on their record's edge
    /// reads that are at or below the floor (and `floor`, when given), and
    /// at most `limit` identities past their re-send window: how many
    /// arrivals went.
    pub fn sweep_arrivals(&self, limit: i64, floor: Option<i64>) -> Result<i64> {
        self.transaction(|db| {
            let now = iso(0);
            let swept = db.execute(
                &format!(
                    "delete from arrival where seq in (
                       select a.seq from arrival a
                       where a.seq <= ({FLOOR}) and (?3 is null or a.seq <= ?3)
                         and not exists (select 1 from wait_row w
                           where w.team_id = a.team_id and w.adapter_type = a.adapter_type and w.edge = a.edge and w.key = a.key and w.since < a.seq
                             and ({LIVE}))
                       order by a.seq limit ?2)"
                ),
                params![now, limit, floor],
            )?;
            db.execute("delete from arrival_identity where rowid in (select rowid from arrival_identity where kept_until < ?1 limit ?2)", params![now, limit])?;
            Ok(i64::try_from(swept).unwrap_or(i64::MAX))
        })
    }

    /// The waits a delivery opened for the runs it queued (`DeliveryWait`),
    /// in its write: each reads from `since`, and a pre-noted one has its
    /// run's trigger noted as judged.
    pub(crate) fn open_delivery_waits_in(db: &Connection, team_id: &str, adapter_type: &str, waits: &[DeliveryWait], since: i64) -> Result<()> {
        for wait in waits {
            let id = uuid::Uuid::new_v4().to_string();
            let opened = db.execute(
                "insert into wait_row (id, run_id, team_id, adapter_type, edge, key, since, fire_key) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing",
                params![id, wait.run_id, team_id, adapter_type, wait.edge, wait.key, since, wait.fire_key],
            )?;
            // Only a wait this write opened has its trigger noted.
            if let (1, Some(PreNoted { identity, version })) = (opened, &wait.pre_noted) {
                db.execute("insert into wait_seen (wait_id, identity, version, matched, leaf) values (?, ?, ?, 0, null)", params![id, identity, version])?;
            }
        }
        Ok(())
    }

    /// The waits a delivery opened for runs its `fire_event` row `fire_key`
    /// queued that never started, dropped as the row is buried.
    pub(crate) fn drop_unstarted_waits_in(db: &Connection, fire_key: &str) -> Result<()> {
        const UNSTARTED: &str = "select id from wait_row w where w.fire_key = ?1 and not exists (select 1 from run r where r.id = w.run_id)";
        db.execute(&format!("delete from wait_seen where wait_id in ({UNSTARTED})"), params![fire_key])?;
        db.execute(&format!("delete from wait_row where id in ({UNSTARTED})"), params![fire_key])?;
        Ok(())
    }

    /// A wait park's row: the wait is parked at `address`. Parked on a
    /// record already gone (the newest arrival logged on it after its mark
    /// is gone, or no key), it is stranded as it parks.
    pub(crate) fn park_wait_in(db: &Connection, run_id: &str, address: &str, wait_id: &str) -> Result<()> {
        let parked = db.execute("update wait_row set address = ? where id = ? and run_id = ?", params![address, wait_id, run_id])?;
        if parked == 0 {
            return Err(StoreError::Invalid(format!("run {run_id} has no wait {wait_id}")));
        }
        db.execute(
            "update wait_row set stranded_at = ? where id = ? and stranded_at is null
               and (key is null or coalesce((select a.gone from arrival a
                 where a.team_id = wait_row.team_id and a.adapter_type = wait_row.adapter_type and a.edge = wait_row.edge and a.key = wait_row.key
                   and a.seq > wait_row.since order by a.seq desc limit 1), 0) = 1)",
            params![iso(0), wait_id],
        )?;
        Ok(())
    }

    /// Anything parked at `address`: a wait parked there before is parked
    /// no more, so it is never woken for a park it no longer holds.
    pub(crate) fn unpark_waits_in(db: &Connection, run_id: &str, address: &str) -> Result<()> {
        db.execute("update wait_row set address = null where run_id = ? and address = ?", params![run_id, address])?;
        Ok(())
    }

    /// The notes a segment that resumed the run's leaf at `address` made,
    /// kept: its progress past the leaf is.
    pub(crate) fn keep_leaf_notes_in(db: &Connection, run_id: &str, address: &str) -> Result<()> {
        db.execute("update wait_seen set leaf = null where leaf = ? and wait_id in (select id from wait_row where run_id = ?)", params![address, run_id])?;
        Ok(())
    }

    /// The notes a segment that resumed the leaf at `address` made and never
    /// kept, dropped as the leaf is claimed again: that segment died.
    pub(crate) fn drop_leaf_notes_in(db: &Connection, run_id: &str, address: &str) -> Result<()> {
        db.execute("delete from wait_seen where leaf = ? and wait_id in (select id from wait_row where run_id = ?)", params![address, run_id])?;
        Ok(())
    }

    pub(crate) fn drop_run_waits_in(db: &Connection, run_id: &str) -> Result<()> {
        db.execute("delete from wait_seen where wait_id in (select id from wait_row where run_id = ?)", params![run_id])?;
        db.execute("delete from wait_row where run_id = ?", params![run_id])?;
        Ok(())
    }

    /// The run the wait is the run's.
    fn require_wait(db: &Connection, wait_id: &str) -> Result<String> {
        match db.query_row("select run_id from wait_row where id = ?", params![wait_id], |r| r.get::<_, String>(0)).optional()? {
            Some(run_id) => Ok(run_id),
            None => Err(StoreError::Invalid(format!("no wait {wait_id}"))),
        }
    }
}

/// The sweep's floor, `?1` being now: the lowest mark an unexpired run
/// lease took, else the latest seq. A running step took its marks after its
/// lease's, so what arrives while it runs is above it.
const FLOOR: &str = "select coalesce((select min(lease_mark) from run where lease_until > ?1 and lease_mark is not null), (select coalesce(max(seq), 0) from arrival))";

/// Whether the wait `w` is live: one its run opened lives as long as its
/// run's state; one a delivery opened (`fire_key`), while its run exists or
/// the `fire_event` row that queues it is there, not buried.
const LIVE: &str = "w.fire_key is null or exists (select 1 from run r where r.id = w.run_id) or exists (select 1 from work q where q.key = w.fire_key and q.dead_at is null)";

/// The instant `ms` after `at`, as `iso` writes it.
fn iso_after(at: &str, ms: i64) -> Result<String> {
    let at: jiff::Timestamp = at.parse().map_err(|e| StoreError::Invalid(format!("{at} is not an instant: {e}")))?;
    Ok(crate::store::iso_at(at.as_millisecond().saturating_add(ms)))
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
    use crate::store::{HeldJoin, HeldPark, HeldRace, Park, ParkKind, RunSettle, RunStart, SegmentCommit, iso};
    use crate::json::Obj;
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
        listed: HashMap<String, LoggedArrival>,
        /// Run leases taken, by name.
        leases: HashMap<String, String>,
    }

    impl Names {
        fn id(&mut self, name: &str) -> String {
            self.ids.entry(name.to_string()).or_insert_with(|| uuid::Uuid::new_v4().to_string()).clone()
        }

        fn wait(&self, name: &str) -> String {
            self.waits.get(name).unwrap_or_else(|| panic!("no wait named {name}")).clone()
        }

        fn listed(&self, name: &str) -> &LoggedArrival {
            self.listed.get(name).unwrap_or_else(|| panic!("no arrival named {name}"))
        }

        /// An arrival's or a note's identity: given, or a listed arrival's
        /// (`identityOf`), or a listed arrival's seq as bare text (`identityIsSeqOf`).
        fn identity(&self, step: &Js) -> Option<String> {
            if let Some(name) = opt_text(step, "identityOf") {
                return Some(self.listed(name).identity.clone());
            }
            if let Some(name) = opt_text(step, "identityIsSeqOf") {
                return Some(self.listed(name).seq.to_string());
            }
            opt_text(step, "identity").map(str::to_string)
        }

        /// A stranded wait as a case writes it: by its wait's and (`with_run`)
        /// its run's names.
        fn stranded(&self, wait: &Stranded, with_run: bool) -> Js {
            let name = |ids: &HashMap<String, String>, id: &str| ids.iter().find(|(_, v)| v.as_str() == id).map_or_else(|| id.to_string(), |(k, _)| k.clone());
            let mut shown = obj! { "wait" => Js::str(name(&self.waits, &wait.wait_id)), "edge" => Js::str(&wait.edge), "key" => wait.key.as_deref().map_or(Js::Null, Js::str), "recordId" => wait.record_id.as_deref().map_or(Js::Null, Js::str), "parked" => Js::Bool(wait.parked) };
            if with_run {
                shown.insert("run".into(), Js::str(name(&self.ids, &wait.run_id)));
            }
            Js::Obj(shown)
        }

        /// A case's stranded wait, its keys in the order `stranded` writes them.
        fn named_stranded(&self, want: &Js) -> Js {
            let mut shown = obj! { "wait" => want.get("wait").cloned().unwrap(), "edge" => want.get("edge").cloned().unwrap(), "key" => want.get("key").cloned().unwrap(), "recordId" => want.get("recordId").cloned().unwrap_or(Js::Null), "parked" => want.get("parked").cloned().unwrap() };
            if let Some(run) = want.get("run") {
                shown.insert("run".into(), run.clone());
            }
            Js::Obj(shown)
        }

        /// The step's list `key` of `{ run, wait, address }`.
        fn wakes(&mut self, step: &Js, key: &str) -> Vec<WaitWake> {
            list(step, key).iter().map(|w| WaitWake { run_id: self.id(text(w, "run")), wait_id: self.wait(text(w, "wait")), address: text(w, "address").into() }).collect()
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

    /// Claims the due rows of a kind of a team as its drain claims them.
    type ClaimRows<'a> = &'a dyn Fn(&str, &str) -> Vec<crate::store::ClaimedWork>;

    fn rows_due(kind: &str) -> crate::store::ClaimDue<'static> {
        let kinds: &'static [String] = Box::leak(Box::new([kind.to_string()]));
        crate::store::ClaimDue { limit: 1000, lease_ms: 60_000, due_by: None, kinds: Some(kinds) }
    }

    /// A step's arrival.
    fn new_arrival(names: &Names, a: &Js) -> NewArrival {
        NewArrival {
            edge: text(a, "edge").into(),
            key: text(a, "key").into(),
            identity: names.identity(a),
            version: opt_text(a, "version").map(str::to_string),
            landing: a.get("landing").cloned(),
            gone: flag(a, "gone"),
        }
    }

    /// A step's re-send window: the hour a module that declares none has,
    /// when the step gives none.
    fn resend_window_of(step: &Js) -> i64 {
        step.get("resendWindowMs").and_then(int).unwrap_or(crate::externals::DEFAULT_RESEND_WINDOW_MS)
    }

    /// The id of the wait `opened` names, as the run's own open would find it.
    fn wait_of(store: &dyn RunHostStore, opened: &OpenWait<'_>) -> String {
        store.open_wait(opened).unwrap()
    }

    fn run_case(store: &dyn RunHostStore, case: &Js, claim_rows: ClaimRows<'_>) {
        let claim_wakes = |team: &str| claim_rows(team, "wake_await");
        let name = text(case, "case");
        let mut names = Names::default();
        let steps = list(case, "steps");
        // A run a delivery minted is started only by a `start` step, as the
        // drain starts it.
        let unstarted: Vec<&str> = case.get("unstarted").and_then(Js::as_array).unwrap_or_default().iter().filter_map(Js::as_str).collect();
        for step in steps {
            if let Some(run) = opt_text(step, "run") {
                if names.ids.contains_key(run) || unstarted.contains(&run) {
                    continue;
                }
                let id = names.id(run);
                store.start_run(&RunStart { id: &id, file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
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
                    let arrivals: Vec<NewArrival> = list(step, "arrivals").iter().map(|a| new_arrival(&names, a)).collect();
                    let logged_at = iso(step.get("at").and_then(int).unwrap_or(0));
                    let log = DeliveryArrivals { team_id: &team, adapter_type: adapter, arrivals: &arrivals, at: &logged_at, resend_window_ms: resend_window_of(step) };
                    let Logged { mut wakes, stranded } = store.log_arrivals(&log).unwrap();
                    let mut expected = names.wakes(step, "wakes");
                    wakes.sort();
                    expected.sort();
                    assert_eq!(wakes, expected, "{at}: the wakes");
                    let mut stranded: Vec<String> = stranded.into_iter().map(|wait| wait.wait_id).collect();
                    let mut expected: Vec<String> = step.get("stranded").and_then(Js::as_array).unwrap_or_default().iter().map(|w| names.wait(w.as_str().unwrap())).collect();
                    stranded.sort();
                    expected.sort();
                    assert_eq!(stranded, expected, "{at}: the waits stranded");
                    if step.get("queued").is_some() {
                        let mut queued: Vec<WaitWake> = claim_wakes(&team)
                            .iter()
                            .map(|row| WaitWake { run_id: text(&row.payload, "runId").into(), wait_id: text(&row.payload, "waitId").into(), address: text(&row.payload, "address").into() })
                            .collect();
                        let mut expected = names.wakes(step, "queued");
                        queued.sort();
                        expected.sort();
                        assert_eq!(queued, expected, "{at}: the wake rows queued");
                    }
                }
                "open" => {
                    let since = names.marks[text(step, "since")];
                    let run = names.id(text(step, "run"));
                    let wait = OpenWait { run_id: &run, team_id: &team, adapter_type: adapter, edge: text(step, "edge"), key: opt_text(step, "key"), record_id: opt_text(step, "recordId"), since };
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
                        if let Some(name) = opt_text(want, "as") {
                            names.listed.insert(name.into(), arrival.clone());
                        }
                    }
                }
                "note" => {
                    let identity = names.identity(step).unwrap_or_else(|| panic!("{at}: no identity"));
                    let wait_id = names.wait(text(step, "wait"));
                    let fence = opt_text(step, "fence").map(|name| names.leases.get(name).unwrap_or_else(|| panic!("{at}: no lease named {name}")).clone());
                    let noted = Noted {
                        wait_id: &wait_id,
                        identity: &identity,
                        version: opt_text(step, "version"),
                        matched: flag(step, "matched"),
                        leaf: opt_text(step, "leaf"),
                        fence: fence.as_deref(),
                    };
                    match store.note_arrival(&noted) {
                        Err(StoreError::LeaseLost { .. }) if flag(step, "leaseLost") => {}
                        Ok(counts) if !flag(step, "leaseLost") => assert_eq!(counts, flag(step, "counts"), "{at}: counts"),
                        other => panic!("{at}: {other:?}"),
                    }
                }
                "park" => {
                    let (run, wait) = (names.id(text(step, "run")), names.wait(text(step, "wait")));
                    let park = Park { run_id: &run, address: text(step, "address"), state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &wait } };
                    store.commit_park(&park).unwrap();
                }
                "commitSegment" => {
                    let run = names.id(text(step, "run"));
                    let fence = opt_text(step, "fence").map(|name| names.leases.get(name).unwrap_or_else(|| panic!("{at}: no lease named {name}")).clone());
                    let parked: Vec<(String, Option<String>, Option<String>)> = list(step, "parks")
                        .iter()
                        .map(|park| (text(park, "address").to_string(), opt_text(park, "wait").map(|w| names.wait(w)), park.get("wakeAt").and_then(int).map(iso)))
                        .collect();
                    let parks = parked
                        .iter()
                        .map(|(address, wait, wake_at)| HeldPark {
                            address,
                            state: &Js::Null,
                            kind: match (wait, wake_at) {
                                (Some(wait_id), _) => ParkKind::Wait { wait_id },
                                (None, Some(wake_at)) => ParkKind::Timer { wake_at },
                                (None, None) => panic!("{at}: a park names its wait or its wakeAt"),
                            },
                        })
                        .collect();
                    let joins = step.get("joins").and_then(Js::as_array).unwrap_or_default().iter().map(|join| HeldJoin { frame_address: text(join, "frame"), pending: join.get("pending").and_then(int).unwrap() }).collect();
                    let (outcome, now) = (Js::Obj(Obj::new()), iso(0));
                    let settle = opt_text(step, "settle").map(|status| RunSettle { status, outcome: &outcome, at: &now });
                    let owed_races = step.get("owes").and_then(Js::as_array).unwrap_or_default().iter().map(|frame| HeldRace { frame_address: frame.as_str().unwrap(), state: &Js::Null }).collect();
                    let commit = SegmentCommit {
                        run_id: &run,
                        team_id: &team,
                        fence: fence.as_deref(),
                        resumed: opt_text(step, "resumed"),
                        joins,
                        parks,
                        settle,
                        owed_races,
                        settled_race: opt_text(step, "settles"),
                    };
                    match store.commit_segment(&commit) {
                        Err(StoreError::LeaseLost { .. }) if flag(step, "leaseLost") => {}
                        Err(_) if flag(step, "refused") => {}
                        Ok(mut wakes) if !flag(step, "leaseLost") && !flag(step, "refused") => {
                            let mut expected = names.wakes(step, "wakes");
                            wakes.sort();
                            expected.sort();
                            assert_eq!(wakes, expected, "{at}: the wakes");
                        }
                        other => panic!("{at}: {other:?}"),
                    }
                }
                "status" => {
                    let row = store.run(&names.id(text(step, "run"))).unwrap().unwrap_or_else(|| panic!("{at}: no run"));
                    assert_eq!(row.status, text(step, "status"), "{at}: the run's status");
                }
                "owed" => {
                    let owed: Vec<String> = store.owed_races(&names.id(text(step, "run"))).unwrap().into_iter().map(|race| race.frame_address).collect();
                    let expected: Vec<&str> = list(step, "races").iter().map(|frame| frame.as_str().unwrap()).collect();
                    assert_eq!(owed, expected, "{at}: the races owed");
                }
                "deleteFrames" => {
                    let frames: Vec<String> = list(step, "frames").iter().map(|f| f.as_str().unwrap().to_string()).collect();
                    store.delete_frames(&names.id(text(step, "run")), &frames).unwrap();
                }
                "pendingJoins" => {
                    assert_eq!(store.has_pending_joins(&names.id(text(step, "run"))).unwrap(), flag(step, "pending"), "{at}: pending joins");
                }
                "claim" => {
                    let claimed = store.claim_leaf(&names.id(text(step, "run")), text(step, "address"), None).unwrap();
                    let parked = step.get("parked").is_none_or(|parked| Js::is_true(Some(parked)));
                    assert_eq!(claimed.is_some(), parked, "{at}: the leaf is parked");
                }
                "lease" => {
                    let ttl = step.get("ttlMs").and_then(int).unwrap_or(60_000);
                    let token = store.claim_lease(&names.id(text(step, "run")), ttl).unwrap().unwrap_or_else(|| panic!("{at}: the lease is free"));
                    names.leases.insert(text(step, "as").into(), token);
                }
                "finish" => store.finish_leaf(&names.id(text(step, "run")), text(step, "address"), None).unwrap(),
                "lapse" => {
                    assert!(store.claim_lease(&names.id(text(step, "run")), 60_000).unwrap().is_some(), "{at}: the lease is free");
                }
                "deleteLeaves" => {
                    let addresses: Vec<String> = list(step, "addresses").iter().map(|a| a.as_str().unwrap().to_string()).collect();
                    store.delete_leaves(&names.id(text(step, "run")), &addresses).unwrap();
                }
                "drop" => {
                    assert!(store.drop_run_state(&names.id(text(step, "run")), None).unwrap(), "{at}: dropped");
                }
                "sweep" => {
                    let floor = opt_text(step, "floor").map(|name| names.marks[name]);
                    let swept = store.sweep_arrivals(step.get("limit").and_then(int).unwrap(), floor).unwrap();
                    assert_eq!(swept, step.get("expect").and_then(int).unwrap(), "{at}: how many the sweep forgot");
                }
                "keepDelivery" => {
                    let arrivals: Vec<NewArrival> = list(step, "arrivals").iter().map(|a| new_arrival(&names, a)).collect();
                    let fire = NewWork {
                        kind: "fire_event".into(),
                        key: format!("fire_event:{}", names.id(text(step, "fire"))),
                        payload: Js::Obj(Obj::new()),
                        due_at: None,
                        team_id: Some(team.clone()),
                    };
                    let waits: Vec<DeliveryWait> = list(step, "waits")
                        .iter()
                        .map(|w| DeliveryWait {
                            run_id: names.id(text(w, "run")),
                            edge: text(w, "edge").into(),
                            key: opt_text(w, "key").map(str::to_string),
                            pre_noted: w.get("preNoted").map(|n| PreNoted { identity: text(n, "identity").into(), version: opt_text(n, "version").map(str::to_string) }),
                            fire_key: fire.key.clone(),
                        })
                        .collect();
                    let receipt = crate::store::NewDelivery {
                        id: uuid::Uuid::new_v4().to_string(),
                        external_id: None,
                        received_at: iso(0),
                        source: crate::store::DeliverySource::Webhook,
                        inline: false,
                        replay_of: None,
                        events: vec![],
                        request: None,
                    };
                    let now = iso(0);
                    let log = DeliveryArrivals { team_id: &team, adapter_type: adapter, arrivals: &arrivals, at: &now, resend_window_ms: resend_window_of(step) };
                    let kept = store.keep_delivery(&names.id("subscription"), None, &receipt, std::slice::from_ref(&fire), Some(&log), &waits, &[]).unwrap().expect("kept");
                    assert_eq!(kept.arrival_mark, names.marks[text(step, "arrivalMark")], "{at}: the mark before its arrivals");
                    for (wait, want) in waits.iter().zip(list(step, "waits")) {
                        let opened = OpenWait { run_id: &wait.run_id, team_id: &team, adapter_type: adapter, edge: &wait.edge, key: wait.key.as_deref(), record_id: None, since: 0 };
                        names.waits.insert(text(want, "as").into(), wait_of(store, &opened));
                    }
                }
                "start" => {
                    let id = names.id(text(step, "minted"));
                    store.start_run(&RunStart { id: &id, file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
                }
                "bury" => {
                    let key = format!("fire_event:{}", names.id(text(step, "fire")));
                    let row = claim_rows(&team, "fire_event").into_iter().find(|row| row.key == key).unwrap_or_else(|| panic!("{at}: {key} is not queued"));
                    store.bury_work(&row.id, &row.claim, "gave up").unwrap();
                }
                "claimRow" => {
                    let key = format!("fire_event:{}", names.id(text(step, "fire")));
                    let row = claim_rows(&team, "fire_event").into_iter().find(|row| row.key == key).unwrap_or_else(|| panic!("{at}: {key} is not queued"));
                    if let Some(mark) = step.get("arrivalMark").and_then(Js::as_str) {
                        assert_eq!(row.payload.get("arrivalMark"), Some(&Js::Num(names.marks[mark].into())), "{at}: the row's mark is its delivery's");
                    }
                }
                "completeKey" => {
                    let key = format!("fire_event:{}", names.id(text(step, "fire")));
                    let expect = step.get("expect") == Some(&Js::Bool(true));
                    assert_eq!(store.complete_key(&key).unwrap(), expect, "{at}: whether {key} was completed");
                }
                "stranded" => {
                    let run = names.id(text(step, "run"));
                    let got: Vec<Js> = store.stranded_waits(&StrandedOf::Run(&run)).unwrap().iter().map(|wait| names.stranded(wait, false)).collect();
                    let expected: Vec<Js> = list(step, "waits").iter().map(|want| names.named_stranded(want)).collect();
                    assert_eq!(got, expected, "{at}: the run's stranded waits");
                }
                "everyStranded" => {
                    let limit = step.get("limit").and_then(int).unwrap();
                    let mut every: Vec<Stranded> = Vec::new();
                    loop {
                        let after = every.last().map(|last| StrandedAfter { at: &last.at, wait_id: &last.wait_id });
                        let page = store.stranded_waits(&StrandedOf::Page { after, limit }).unwrap();
                        assert!(page.len() as i64 <= limit, "{at}: a page of at most {limit}");
                        if page.is_empty() {
                            break;
                        }
                        every.extend(page);
                    }
                    assert!(every.windows(2).all(|pair| (&pair[0].at, &pair[0].wait_id) < (&pair[1].at, &pair[1].wait_id)), "{at}: oldest stranded first");
                    let named: Vec<&String> = names.waits.values().collect();
                    let got: Vec<Js> = every.iter().filter(|wait| named.contains(&&wait.wait_id)).map(|wait| names.stranded(wait, true)).collect();
                    let expected: Vec<Js> = list(step, "waits").iter().map(|want| names.named_stranded(want)).collect();
                    assert_eq!(got, expected, "{at}: every run's stranded waits");
                }
                other => panic!("{at}: no step {other}"),
            }
        }
    }

    fn over_a_state_file(test: &str) {
        let case = cases().into_iter().find(|c| test_name(text(c, "case")) == test).unwrap_or_else(|| panic!("no case for {test}"));
        let store = state_file();
        // The state file has one tenant: its drain claims every team's rows.
        run_case(&store, &case, &|_team, kind| store.claim_due(&rows_due(kind)).unwrap());
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
        an_arrival_without_an_identity_is_named_apart_from_a_bare_seq_a_module_reports,
        newly_matches_counts_once_until_it_stops_matching,
        a_noted_arrival_is_no_longer_listed,
        two_arrivals_on_one_wait_count_in_log_order,
        a_gone_arrival_strands_the_parked_waits_on_its_record_once_and_wakes_none_each_names_the_record_it_waited_on,
        a_wait_opened_without_a_record_id_takes_the_one_a_later_open_names_and_keeps_it,
        a_wait_parked_after_its_record_went_is_stranded_as_it_parks,
        a_wait_opened_on_a_record_already_gone_has_no_key_is_one_per_run_and_edge_nothing_wakes_it_and_it_is_stranded_as_it_parks,
        a_later_arrival_on_a_stranded_waits_record_wakes_the_parked_waits_on_it_and_strands_none_of_its_waits_any_more,
        a_gone_arrival_after_the_record_came_back_strands_its_parked_waits_again,
        in_one_log_the_last_report_on_a_record_decides_whether_its_waits_are_stranded,
        a_wait_parked_on_a_record_that_went_and_came_back_is_not_stranded_as_it_parks,
        every_runs_stranded_waits_page_by_page_in_the_order_they_were_stranded_a_wait_no_longer_parked_among_them,
        logging_answers_only_the_parked_waits_on_its_key,
        a_park_at_an_address_leaves_no_other_wait_of_its_run_parked_there,
        opening_a_wait_its_run_already_has_on_that_records_edge_is_the_same_wait_from_its_first_mark,
        rows_drop_with_their_run_and_the_sweep_spares_what_a_live_row_reads,
        an_arrival_logged_again_is_not_logged_twice_and_one_without_an_identity_is_never_a_repeat,
        a_note_made_by_a_segment_resuming_a_leaf_is_kept_when_the_leaf_finishes_and_dropped_when_the_leaf_is_claimed_again_after_that_segment_died,
        a_note_made_by_a_segment_that_parks_again_at_the_leaf_it_resumed_is_kept_with_that_park,
        a_segments_commit_that_parks_elsewhere_finishes_the_leaf_it_resumed_in_the_same_write_keeping_its_notes,
        a_segment_that_lost_the_runs_lease_notes_nothing_and_the_segment_that_took_the_run_over_reads_the_arrival,
        a_segments_commit_keeps_its_joins_its_parks_and_the_end_of_the_leaf_it_resumed_in_one_write_or_none_of_them,
        a_segments_commit_settles_its_run_in_the_same_write_or_leaves_the_leaf_it_resumed_to_be_resumed_again,
        a_segments_commit_wakes_each_wait_it_parks_whose_arrivals_are_unread_and_none_whose_record_is_gone,
        a_race_a_segment_owes_is_kept_in_its_commit_until_the_commit_that_settles_it_and_goes_with_its_frame,
        an_arrival_resent_after_its_entry_was_swept_is_a_repeat_within_the_modules_window,
        a_running_steps_mark_keeps_arrivals_above_it_from_the_sweep,
        the_floor_is_the_lowest_mark_the_running_steps_took,
        a_mark_the_callers_own_running_steps_hold_keeps_arrivals_above_it_from_the_sweep,
        a_wait_opened_at_delivery_keeps_arrivals_until_its_run_ends_and_burying_its_fire_row_drops_those_of_runs_that_never_started,
        a_fire_row_its_caller_ran_and_completed_by_key_drops_the_waits_of_runs_that_never_started,
        a_fire_row_a_live_claim_holds_is_not_completed_by_key_it_stays_queued_and_its_waits_stay_live,
    }

    /// The identities a store keeps are not read through the slot once
    /// their window has passed (a repeat is judged against the unexpired
    /// ones), so the state file is looked at here: the sweep forgets them.
    #[test]
    fn the_sweep_forgets_an_identity_once_its_re_send_window_has_passed() {
        let store = state_file();
        let arrival = |identity: &str| NewArrival { edge: "Charges".into(), key: "cus_1".into(), identity: Some(identity.into()), version: None, landing: None, gone: false };
        let log = |identity: &str, at_ms: i64| {
            let at = iso(at_ms);
            let arrivals = [arrival(identity)];
            store.log_arrivals(&DeliveryArrivals { team_id: "t", adapter_type: "acme", arrivals: &arrivals, at: &at, resend_window_ms: 3_600_000 }).unwrap();
        };
        log("lapsed", -7_200_000);
        log("held", 0);
        let kept = || -> Vec<String> {
            let mut select = store.db.prepare("select identity from arrival_identity order by identity").unwrap();
            select.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
        };
        assert_eq!(kept(), ["held", "lapsed"]);
        store.sweep_arrivals(10, None).unwrap();
        assert_eq!(kept(), ["held"]);
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
        // A Postgres store claims only its own tenant's rows: a case's team
        // (a fresh uuid) is claimed by a store of that tenant.
        let claim_rows = |team: &str, kind: &str| crate::pg_store::PgStore::connect(&url, team).unwrap().claim_due(&rows_due(kind)).unwrap();
        let client = crate::pg_store::connect_client(&url).unwrap();
        for case in cases() {
            // The cases share the database: what an earlier case left
            // sweepable goes, and its leases lapse, so a case's sweep counts
            // its own arrivals under its own floor.
            crate::pg_store::block_on(client.execute("update lf.trigger_run set lease_until = now() - interval '1 millisecond' where lease_until > now()", &[])).unwrap();
            while store.sweep_arrivals(10_000, None).unwrap() > 0 {}
            run_case(&store, &case, &claim_rows);
        }
        a_kept_delivery_logs_its_arrivals_once(&store);
    }

    /// A delivery's arrivals are logged in the write that keeps it: its
    /// `fire_event` rows carry the mark after them, a wait they answer gets
    /// its wake row (the answer), and a duplicate logs and wakes nothing.
    fn a_kept_delivery_logs_its_arrivals_once(store: &dyn RunHostStore) {
        use crate::store::{DeliverySource, NewDelivery};
        // The store's own team: its drain claims the rows.
        let (run, team, subscription) = (uuid::Uuid::new_v4().to_string(), store.tenant().to_string(), uuid::Uuid::new_v4().to_string());
        let key = format!("thread:{run}");
        store.start_run(&RunStart { id: &run, file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
        let wait = store.open_wait(&OpenWait { run_id: &run, team_id: &team, adapter_type: "acme", edge: "Comments", key: Some(&key), record_id: None, since: store.arrival_mark().unwrap() }).unwrap();
        store.commit_park(&Park { run_id: &run, address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &wait } }).unwrap();
        let receipt = || NewDelivery {
            id: uuid::Uuid::new_v4().to_string(),
            external_id: Some(format!("d-{run}")),
            received_at: iso(0),
            source: DeliverySource::Webhook,
            inline: false,
            replay_of: None,
            events: vec![],
            request: None,
        };
        let fire = NewWork { kind: "fire_event".into(), key: format!("fire_event:{run}"), payload: Js::Obj(obj! { "external" => Js::str("acme") }), due_at: None, team_id: Some(team.clone()) };
        let arrival = NewArrival { edge: "Comments".into(), key: key.clone(), identity: Some("k1".into()), version: None, landing: Some(Js::Null), gone: false };
        let (now, before) = (iso(0), store.arrival_mark().unwrap());
        let logged = DeliveryArrivals { team_id: &team, adapter_type: "acme", arrivals: std::slice::from_ref(&arrival), at: &now, resend_window_ms: crate::externals::DEFAULT_RESEND_WINDOW_MS };
        let kept = store.keep_delivery(&subscription, None, &receipt(), std::slice::from_ref(&fire), Some(&logged), &[], &[]).unwrap().expect("kept");
        let (wakes, mark) = (kept.wakes, store.arrival_mark().unwrap());
        assert_eq!(kept.arrival_mark, before, "the mark before the delivery's own arrival");
        assert_eq!(wakes.iter().map(|w| (w.kind.as_str(), w.payload.to_json())).collect::<Vec<_>>(), [("wake_await", format!(r#"{{"waitId":"{wait}","runId":"{run}","address":"s1"}}"#))]);
        assert_eq!(store.wait_arrivals(&wait).unwrap().arrivals.len(), 1);
        let due = crate::store::ClaimDue { limit: 1000, lease_ms: 60_000, due_by: None, kinds: None };
        let rows = store.claim_due(&due).unwrap();
        let fired = rows.iter().find(|r| r.key == fire.key).expect("the fire row");
        assert_eq!(fired.payload.get("arrivalMark"), Some(&Js::Num(before.into())), "the mark before the delivery's own arrival");
        assert!(rows.iter().any(|r| r.kind == "wake_await" && r.payload.get("waitId") == Some(&Js::str(&wait))));

        assert!(store.keep_delivery(&subscription, None, &receipt(), &[], Some(&logged), &[], &[]).unwrap().is_none(), "a duplicate");
        assert_eq!(store.arrival_mark().unwrap(), mark, "a duplicate logs nothing");
    }

    #[test]
    fn a_kept_delivery_logs_its_arrivals_once_in_the_state_file() {
        a_kept_delivery_logs_its_arrivals_once(&state_file());
    }

    /// A log in flight on a record's edge holds its lock (lf.lock_wait_key)
    /// until it commits: a wait's park there waits for it, so the run's read
    /// after parking sees the arrival. Driven by a second connection that
    /// takes the lock and writes the arrival as a log does, then commits late.
    #[cfg(feature = "postgres")]
    #[test]
    fn over_postgres_a_park_waits_for_a_log_on_its_record_to_commit() {
        use crate::pg_store::{PgStore, block_on, connect_client};
        use std::time::{Duration, Instant};
        let Some(url) = std::env::var("LF_TEST_PG").ok().filter(|u| !u.is_empty()) else { return };
        PgStore::migrate(&url).unwrap();
        let store = PgStore::connect(&url, crate::backend::POSTGRES_TENANT).unwrap();
        let (run, team) = (uuid::Uuid::new_v4().to_string(), uuid::Uuid::new_v4().to_string());
        store.start_run(&RunStart { id: &run, file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
        let since = store.arrival_mark().unwrap();
        let wait = store.open_wait(&OpenWait { run_id: &run, team_id: &team, adapter_type: "acme", edge: "Comments", key: Some("thread:c1"), record_id: None, since }).unwrap();
        let (locked, held) = std::sync::mpsc::channel();
        let logging = std::thread::spawn({
            let (url, team) = (url.clone(), team.clone());
            move || {
                let client = connect_client(&url).unwrap();
                block_on(client.batch_execute("begin")).unwrap();
                block_on(client.execute("select lf.lock_wait_key($1::text::uuid, 'acme', 'Comments', 'thread:c1')", &[&team])).unwrap();
                block_on(client.execute(
                    "insert into lf.arrival (team_id, adapter_type, edge, key, identity, gone, logged_at) values ($1::text::uuid, 'acme', 'Comments', 'thread:c1', 'k1', false, now())",
                    &[&team],
                ))
                .unwrap();
                locked.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(500));
                block_on(client.batch_execute("commit")).unwrap();
            }
        });
        held.recv().unwrap();
        let parking = Instant::now();
        store.commit_park(&Park { run_id: &run, address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &wait } }).unwrap();
        assert!(parking.elapsed() >= Duration::from_millis(400), "the park took its turn after the log");
        logging.join().unwrap();
        let read: Vec<String> = store.wait_arrivals(&wait).unwrap().arrivals.into_iter().map(|a| a.identity).collect();
        assert_eq!(read, ["k1"]);
    }

    /// A state file written before a wait could be stranded or keyless:
    /// its wait rows are kept, and both can be written.
    #[test]
    fn a_state_file_written_before_stranded_waits_keeps_its_waits() {
        let dir = std::env::temp_dir().join(format!("lf-waits-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "create table wait_row (id text primary key, run_id text not null, team_id text not null, adapter_type text not null,
                   edge text not null, key text not null, since integer not null, address text);
                 create unique index wait_row_edge on wait_row (run_id, team_id, adapter_type, edge, key);
                 create index wait_row_key on wait_row (team_id, adapter_type, edge, key);
                 insert into wait_row values ('w1', 'run-1', 't', 'acme', 'Comments', 'thread:c1', 0, null);",
            )
            .unwrap();
        let store = Store::open(&path).unwrap();
        store.start_run(&RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
        let kept = OpenWait { run_id: "run-1", team_id: "t", adapter_type: "acme", edge: "Comments", key: Some("thread:c1"), record_id: None, since: 5 };
        assert_eq!(store.open_wait(&kept).unwrap(), "w1");
        let keyless = store.open_wait(&OpenWait { key: None, ..kept }).unwrap();
        store.commit_park(&Park { run_id: "run-1", address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &keyless } }).unwrap();
        let stranded: Vec<String> = store.stranded_waits(&StrandedOf::Run("run-1")).unwrap().into_iter().map(|wait| wait.wait_id).collect();
        assert_eq!(stranded, [keyless]);
        // Opened again, it is rebuilt no more.
        drop(store);
        assert_eq!(Store::open(&path).unwrap().stranded_waits(&StrandedOf::Run("run-1")).unwrap().len(), 1);
    }

    /// Processes opening one state file written before stranded waits at
    /// once: one rebuilds the wait rows, and the rest, reading the table
    /// under the write lock, find it rebuilt and keep it.
    #[test]
    fn a_state_file_opened_by_many_at_once_is_rebuilt_once() {
        let dir = std::env::temp_dir().join(format!("lf-waits-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        Store::open(&path).unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch(
                "drop table wait_row;
                 create table wait_row (id text primary key, run_id text not null, team_id text not null, adapter_type text not null,
                   edge text not null, key text not null, since integer not null, address text);
                 create unique index wait_row_edge on wait_row (run_id, team_id, adapter_type, edge, key);
                 create index wait_row_key on wait_row (team_id, adapter_type, edge, key);
                 insert into wait_row values ('w1', 'run-1', 't', 'acme', 'Comments', 'thread:c1', 0, null);",
            )
            .unwrap();
        let opening = std::sync::Arc::new(std::sync::Barrier::new(8));
        let opened: Vec<_> = (0..8)
            .map(|_| {
                let (path, opening) = (path.clone(), opening.clone());
                std::thread::spawn(move || {
                    opening.wait();
                    Store::open(&path).map(|_| ())
                })
            })
            .collect();
        for open in opened {
            open.join().unwrap().unwrap();
        }
        let store = Store::open(&path).unwrap();
        let rows: Vec<(String, Option<String>)> =
            store.db.prepare("select id, stranded_at from wait_row").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        assert_eq!(rows, [("w1".to_string(), None)]);
        // A second rebuild would have renamed the rebuilt table, and its
        // indexes with it, before dropping it.
        let mut indexes: Vec<String> =
            store.db.prepare("select name from pragma_index_list('wait_row')").unwrap().query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        indexes.retain(|name| !name.starts_with("sqlite_autoindex"));
        indexes.sort();
        assert_eq!(indexes, ["wait_row_edge", "wait_row_key", "wait_row_keyless", "wait_row_stranded"]);
    }

    /// A log's `at` in another form than `iso` writes (an offset, no
    /// milliseconds) is kept as `iso` writes it, so the stranded times sort
    /// as the instants do and a page's cursor holds.
    #[test]
    fn a_stranded_time_is_written_as_iso_writes_it_whatever_form_the_log_gave() {
        let store = state_file();
        let wait_on = |run: &str, key: &str| {
            store.start_run(&RunStart { id: run, file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
            let wait = store.open_wait(&OpenWait { run_id: run, team_id: "t", adapter_type: "acme", edge: "Comments", key: Some(key), record_id: None, since: 0 }).unwrap();
            store.commit_park(&Park { run_id: run, address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &wait } }).unwrap();
            wait
        };
        let (early, late) = (wait_on("run-1", "thread:c1"), wait_on("run-2", "thread:c2"));
        let gone = |key: &str| NewArrival { edge: "Comments".into(), key: key.into(), identity: None, version: None, landing: None, gone: true };
        // 10:00 in UTC, written at an offset: as text it sorts after 10:30Z.
        let logged = store.log_arrivals(&DeliveryArrivals { team_id: "t", adapter_type: "acme", arrivals: &[gone("thread:c1")], at: "2026-10-31T11:00:00+01:00", resend_window_ms: crate::externals::DEFAULT_RESEND_WINDOW_MS }).unwrap();
        assert_eq!(logged.stranded.iter().map(|w| w.at.as_str()).collect::<Vec<_>>(), ["2026-10-31T10:00:00.000Z"]);
        store.log_arrivals(&DeliveryArrivals { team_id: "t", adapter_type: "acme", arrivals: &[gone("thread:c2")], at: "2026-10-31T10:30:00Z", resend_window_ms: crate::externals::DEFAULT_RESEND_WINDOW_MS }).unwrap();
        let page = |after: Option<StrandedAfter<'_>>| store.stranded_waits(&StrandedOf::Page { after, limit: 1 }).unwrap();
        let first = page(None);
        assert_eq!((first[0].wait_id.as_str(), first[0].at.as_str()), (early.as_str(), "2026-10-31T10:00:00.000Z"));
        let second = page(Some(StrandedAfter { at: "2026-10-31T11:00:00+01:00", wait_id: &early }));
        assert_eq!((second[0].wait_id.as_str(), second[0].at.as_str()), (late.as_str(), "2026-10-31T10:30:00.000Z"));
        assert!(matches!(store.log_arrivals(&DeliveryArrivals { team_id: "t", adapter_type: "acme", arrivals: &[gone("thread:c1")], at: "yesterday", resend_window_ms: crate::externals::DEFAULT_RESEND_WINDOW_MS }), Err(StoreError::Invalid(_))));
    }

    #[test]
    fn the_sweep_says_how_many_went_and_a_parked_unknown_wait_writes_nothing() {
        let store = state_file();
        store.start_run(&RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
        let arrival = |key: &str| NewArrival { edge: "Comments".into(), key: key.into(), identity: Some("k".into()), version: None, landing: None, gone: false };
        store.log_now("t", "acme", &[arrival("a"), arrival("b"), arrival("c")]).unwrap();
        assert_eq!(store.sweep_arrivals(2, None).unwrap(), 2);
        assert_eq!(store.sweep_arrivals(2, None).unwrap(), 1);
        let park = Park { run_id: "run-1", address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: "no-such-wait" } };
        assert!(matches!(store.commit_park(&park), Err(StoreError::Invalid(_))));
        assert!(store.leaves("run-1", false, None, None).unwrap().is_empty());
        assert!(matches!(store.wait_arrivals("no-such-wait"), Err(StoreError::Invalid(_))));
    }
}

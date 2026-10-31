//! The run host's backend over Postgres: the `@lf/postgres-store` core
//! module. Its tables live in a schema of its own, `lf`, which its setup
//! creates and migrates (`listen-fire connect @lf/postgres-store`, src/core.rs);
//! nothing of the hosted product's schema is read or written. The tables and
//! statements keep the hosted backend's shapes and meaning
//! (lf-platform's apps/api/src/services/movement_engine/run_host_store.ts
//! and work/store.ts), so the contract suite holds the two
//! to the same cases:
//!
//!   parks         lf.parked_run
//!   joins         lf.join_pending + join_branch_export
//!   leases        the lease columns of lf.trigger_run
//!   work          lf.work
//!   sources       lf.park_library_source
//!   pull cursors  lf.inbound_checkpoint
//!   listens' heads lf.listen_state
//!   receipts      lf.event_receipt
//!   deliveries    lf.delivery
//!   waits         lf.arrival + wait_row + wait_seen
//!   listen-fire's runs     lf.trigger_run (below)
//!
//! Held to the hosted backend's meaning by the run host's contract suite
//! (`listen-fire --contract-store postgres://…`). Leases and expiry are judged
//! by the database's clock, as the hosted backend judges them.
//!
//! One store is one tenant's: listen-fire's runs, and the work rows it enqueues and
//! claims, are its tenant's only, so a `drain` worker never claims another
//! tenant's work.
//!
//! listen-fire's run record on a `trigger_run` row: `trigger_id` is the listen's
//! pipeline (`listen:<file>:<movement>`), `trigger_payload` holds the file,
//! the movement and the run's facts (their JSON text verbatim, so a resume
//! reads exactly what the firing wrote), `nodes_written` its writes and
//! `failure_reason` its error. A completed run is `success`, as the hosted
//! product names it; listen-fire reads it back as `completed`. The trace is kept
//! where the hosted product keeps it: a movement step per segment on
//! `steps`, its entries at `diagnostics.trace`.
//!
//! Blocking, as the SQLite store is: the connection lives on its own thread
//! with its own runtime, and each call waits for its answer.

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};

use tokio_postgres::types::ToSql;
use tokio_postgres::{Client, Row};

use crate::backend::RunHostStore;
use crate::json::Js;
use crate::obj;
use crate::resolve::{ListenState, Resolution};
use crate::store::{
    BranchExport, ClaimDue, ClaimedWork, DeliveryQuery, DeliveryRow, DeliveryRun, DeliverySource, LeafRow, NewDelivery, NewWork, Park, ParkKind,
    HeldPark, OwedRace, Release, Rerun, Result, RunRow, RunSettle, RunStart, SETTLE_RACE_WORK_KIND, SegmentCommit, StoreError, WORK_KINDS, settle_race_work_key,
    settle_race_work_payload, timer_work_key, timer_work_payload,
};
use crate::waits::{DeliveryArrivals, DeliveryWait, KeptDelivery, Logged, LoggedArrival, Noted, OpenWait, Stranded, StrandedAfter, StrandedOf, WaitArrivals, WaitWake, delivery_rows, landing_of};

type Params<'a> = [&'a (dyn ToSql + Sync)];

/// An instant as `Date.toISOString` writes it, by the database's clock.
macro_rules! iso {
    ($column:literal) => {
        concat!("to_char(", $column, " at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")
    };
}

/// The run is still leased under the token (`leaseTokenIs`): compared as
/// text, so a token that is not a uuid holds nothing rather than failing.
const LEASED_TO: &str = "lease_token::text = ";

/// The rest of a statement finishing the run's leaf `$2` (`$1` the run)
/// where the `held` it follows has a row: the leaf deleted if resuming, the
/// notes its segment made kept.
const FINISHED: &str = "finished as (
   delete from lf.parked_run p
   where p.run_id = $1::text::uuid and p.address = $2::text and p.status = 'resuming' and exists (select 1 from held)
 )
 update lf.wait_seen s set leaf = null from lf.wait_row w
 where s.wait_id = w.id and w.run_id = $1::text::uuid and s.leaf = $2::text and exists (select 1 from held)";

/// The work row's version (`FIRST_VERSION` / `nextVersion`): millisecond-
/// exact, strictly increasing however close two writes land.
const NEXT_VERSION_OF_WORK: &str = "greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', work.updated_at) + interval '1 millisecond')";
const NEXT_VERSION_OF_W: &str = "greatest(date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', w.updated_at) + interval '1 millisecond')";

/// `hosted completed` is `success`; every other status listen-fire writes is the same word.
fn hosted_status(status: &str) -> &str {
    if status == "completed" { "success" } else { status }
}

fn lf_status(status: String) -> String {
    if status == "success" { "completed".into() } else { status }
}

pub(crate) fn failed(error: tokio_postgres::Error) -> StoreError {
    StoreError::Backend(match error.as_db_error() {
        Some(db) => format!("postgres: {}", db.message()),
        // The cause too: a refused certificate says why only there.
        None => match std::error::Error::source(&error) {
            Some(cause) => format!("postgres: {error}: {cause}"),
            None => format!("postgres: {error}"),
        },
    })
}

fn parse_text(text: &str) -> Result<Js> {
    Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored value is not JSON: {e}")))
}

/// Polls one future to its end on this thread. The client's futures only
/// wait on channels its connection thread answers, so nothing here needs
/// this thread's runtime.
pub(crate) fn block_on<F: Future>(future: F) -> F::Output {
    struct Unpark(std::thread::Thread);
    impl Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::park();
    }
}

/// The store's own schema, in order. Each runs once, in its own
/// transaction, under an advisory lock so two setups never race; the
/// applied ones are recorded in `lf.schema_migration`. Version 3 is retired,
/// never to be reused: it made `lf.write_echo`, which moved to the loop
/// guard, and databases that applied it record it as done.
const MIGRATIONS: &[(i32, &str)] = &[
    (1, include_str!("pg_store_schema_1.sql")),
    (2, include_str!("pg_store_schema_2.sql")),
    (4, include_str!("pg_store_schema_4.sql")),
    (5, include_str!("pg_store_schema_5.sql")),
    (6, include_str!("pg_store_schema_6.sql")),
    (7, include_str!("pg_store_schema_7.sql")),
    (8, include_str!("pg_store_schema_8.sql")),
    (9, include_str!("pg_store_schema_9.sql")),
    (10, include_str!("pg_store_schema_10.sql")),
    (11, include_str!("pg_store_schema_11.sql")),
    (12, include_str!("pg_store_schema_12.sql")),
    (13, include_str!("pg_store_schema_13.sql")),
];

/// The advisory lock the migrations run under: "lf-store" as a number.
const MIGRATION_LOCK: i64 = 0x6c66_2d73_746f_7265;

const RUN_COLUMNS: &str = concat!(
    "id::text, trigger_payload->>'file', trigger_payload->>'movement', status, ",
    iso!("started_at"),
    ", trigger_payload->>'facts', nodes_written::int8, failure_reason, returned::text, delivery_id::text, ",
    iso!("coalesce(completed_at, failed_at)"),
    ", write_records::text, attempt::int8, attempts::text"
);

fn run_of(row: &Row) -> Result<RunRow> {
    let id: String = row.get(0);
    let lf_field = |i: usize, name: &str| -> Result<String> {
        row.get::<_, Option<String>>(i).ok_or_else(|| StoreError::Invalid(format!("run {id} is not one of listen-fire's runs (its trigger_payload has no {name})")))
    };
    let status = lf_status(row.get(3));
    let failure: Option<String> = row.get(7);
    // A failed run keeps the writes it made: they were made.
    let mut outcome = crate::json::Obj::new();
    if status == "failed" {
        outcome.insert("error".into(), Js::str(failure.unwrap_or_default()));
    }
    outcome.insert("writes".into(), Js::Num(row.get::<_, i64>(6).into()));
    if let Some(records) = row.get::<_, Option<String>>(11) {
        outcome.insert("writeRecords".into(), parse_text(&records)?);
    }
    if let Some(returned) = row.get::<_, Option<String>>(8).filter(|_| status != "failed") {
        outcome.insert("returned".into(), parse_text(&returned)?);
    }
    let outcome = Js::Obj(outcome);
    let attempts = parse_text(row.get(13))?;
    Ok(RunRow {
        file: lf_field(1, "file")?,
        movement: lf_field(2, "movement")?,
        input: lf_field(5, "facts")?,
        started_at: row.get(4),
        outcome: Some(outcome.to_json()),
        delivery_id: row.get(9),
        finished_at: row.get(10),
        attempt: row.get(12),
        attempts: attempts.as_array().map(<[Js]>::to_vec).unwrap_or_default(),
        status,
        id,
    })
}

const DELIVERY_COLUMNS: &str = concat!("id::text, subscription_id, external_id, ", iso!("received_at"), ", source, inline, replay_of::text, event_count::int8");

/// A connection to a Postgres database, served from its own thread until the
/// client drops: the store's, and any module of listen-fire keeping its own tables there.
pub(crate) fn connect_client(url: &str) -> Result<Client> {
    let (sent, connected) = std::sync::mpsc::channel();
    let url = url.to_string();
    std::thread::Builder::new()
        .name("listen-fire postgres".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
                Ok(runtime) => runtime,
                Err(e) => return drop(sent.send(Err(StoreError::Backend(format!("no runtime for the connection: {e}"))))),
            };
            runtime.block_on(async move {
                let (config, tls) = match crate::pg_tls::config_of(&url) {
                    Ok(read) => read,
                    Err(message) => return drop(sent.send(Err(StoreError::Backend(message)))),
                };
                match config.connect(tls).await {
                    Ok((client, connection)) => {
                        if sent.send(Ok(client)).is_ok() {
                            // Ends when the client drops (or the server goes).
                            let _ = connection.await;
                        }
                    }
                    Err(error) => drop(sent.send(Err(failed(error)))),
                }
            });
        })
        .map_err(|e| StoreError::Backend(format!("no thread for the connection: {e}")))?;
    let client = connected.recv().map_err(|_| StoreError::Backend("the connection thread ended before it connected".into()))??;
    Ok(client)
}

pub struct PgStore {
    client: Client,
    tenant: String,
    /// Who holds a lease this process took: informational (the token fences).
    owner: String,
}

impl PgStore {
    /// Connect to a store whose schema is set up, the connection served from
    /// its own thread until the store drops.
    pub fn connect(url: &str, tenant: &str) -> Result<PgStore> {
        let store = PgStore::connect_unchecked(url, tenant)?;
        store.require_schema()?;
        Ok(store)
    }

    fn connect_unchecked(url: &str, tenant: &str) -> Result<PgStore> {
        let client = connect_client(url)?;
        Ok(PgStore {
            client,
            tenant: tenant.to_string(),
            owner: format!("lf:{}:{}", std::process::id(), &uuid::Uuid::new_v4().to_string()[..8]),
        })
    }

    /// The schema is the store's own, created by its setup: refused loudly
    /// when it is missing or behind this listen-fire.
    fn require_schema(&self) -> Result<()> {
        let latest = MIGRATIONS.last().map(|(v, _)| *v).unwrap_or(0);
        let present = self.query_opt("select 1 from information_schema.tables where table_schema = 'lf' and table_name = 'schema_migration'", &[])?.is_some();
        let applied: i32 = if present { self.query_opt("select coalesce(max(version), 0) from lf.schema_migration", &[])?.map(|r| r.get(0)).unwrap_or(0) } else { 0 };
        if applied >= latest {
            return Ok(());
        }
        Err(StoreError::Backend(format!(
            "this database's lf schema is {}: set the store up with `listen-fire connect @lf/postgres-store` (it creates and migrates the schema)",
            if applied == 0 { "missing".to_string() } else { format!("at version {applied}, this listen-fire needs {latest}") }
        )))
    }

    /// The store's setup: create the `lf` schema and apply every migration
    /// not yet applied. Idempotent; safe to run from two places at once.
    pub fn migrate(url: &str) -> Result<Vec<i32>> {
        let store = PgStore::connect_unchecked(url, crate::backend::POSTGRES_TENANT)?;
        let mut applied_now = Vec::new();
        block_on(store.client.batch_execute(&format!("select pg_advisory_lock({MIGRATION_LOCK})"))).map_err(failed)?;
        let outcome = (|| -> Result<()> {
            store.execute("create schema if not exists lf", &[])?;
            store.execute("create table if not exists lf.schema_migration (version integer primary key, applied_at timestamptz not null default now())", &[])?;
            let done: Vec<i32> = store.query("select version from lf.schema_migration", &[])?.iter().map(|r| r.get(0)).collect();
            for (version, sql) in MIGRATIONS {
                if done.contains(version) {
                    continue;
                }
                store.transaction(|| {
                    block_on(store.client.batch_execute(sql)).map_err(failed)?;
                    store.execute("insert into lf.schema_migration (version) values ($1)", &[version])?;
                    Ok(())
                })?;
                applied_now.push(*version);
            }
            Ok(())
        })();
        let _ = block_on(store.client.batch_execute(&format!("select pg_advisory_unlock({MIGRATION_LOCK})")));
        outcome.map(|()| applied_now)
    }

    fn query(&self, sql: &str, params: &Params<'_>) -> Result<Vec<Row>> {
        block_on(self.client.query(sql, params)).map_err(failed)
    }

    fn execute(&self, sql: &str, params: &Params<'_>) -> Result<u64> {
        block_on(self.client.execute(sql, params)).map_err(failed)
    }

    fn query_opt(&self, sql: &str, params: &Params<'_>) -> Result<Option<Row>> {
        Ok(self.query(sql, params)?.into_iter().next())
    }

    /// One transaction around `body`, rolled back when it fails. Calls are
    /// one at a time, so nothing else runs on the connection meanwhile.
    fn transaction<T>(&self, body: impl FnOnce() -> Result<T>) -> Result<T> {
        block_on(self.client.batch_execute("begin")).map_err(failed)?;
        match body() {
            Ok(value) => {
                block_on(self.client.batch_execute("commit")).map_err(failed)?;
                Ok(value)
            }
            Err(error) => {
                let _ = block_on(self.client.batch_execute("rollback"));
                Err(error)
            }
        }
    }

    /// The waits a delivery opened for the runs it queued, in its write
    /// (crate::waits::DeliveryWait).
    fn open_delivery_waits(&self, team_id: &str, adapter_type: &str, waits: &[DeliveryWait], since: i64) -> Result<()> {
        for wait in waits {
            let opened = self.query_opt(
                "insert into lf.wait_row (run_id, team_id, adapter_type, edge, key, since, fire_key)
                 values ($1::text::uuid, $2::text::uuid, $3::text, $4::text, $5::text, $6::int8, $7::text)
                 on conflict do nothing returning id::text",
                &[&wait.run_id, &team_id, &adapter_type, &wait.edge, &wait.key, &since, &wait.fire_key],
            )?;
            if let (Some(row), Some(noted)) = (opened, &wait.pre_noted) {
                let wait_id: String = row.get(0);
                self.execute(
                    "insert into lf.wait_seen (wait_id, identity, version, matched, leaf) values ($1::text::uuid, $2::text, $3::text, false, null)",
                    &[&wait_id, &noted.identity, &noted.version],
                )?;
            }
        }
        Ok(())
    }

    /// `waits.log` inside a transaction the caller holds (`log_arrivals`'s,
    /// or a delivery's keep).
    fn log_arrivals_unwrapped(&self, log: &DeliveryArrivals<'_>) -> Result<Logged> {
        let DeliveryArrivals { team_id, adapter_type, arrivals, at, resend_window_ms } = *log;
        // Each record's edge locked once, in one order, so two logs never
        // wait on each other; a park there waits for this log to commit.
        let mut keys: Vec<(&str, &str)> = arrivals.iter().map(|a| (a.edge.as_str(), a.key.as_str())).collect();
        keys.sort_unstable();
        keys.dedup();
        for (edge, key) in keys {
            self.execute("select lf.lock_wait_key($1::text::uuid, $2::text, $3::text, $4::text)", &[&team_id, &adapter_type, &edge, &key])?;
        }
        // A repeat: its identity and version already logged on its record's
        // edge within the module's re-send window (a sender's retry), even if
        // the sweep forgot its entry since.
        let mut answer = Logged::default();
        for arrival in arrivals {
            if arrival.identity.is_some() {
                let repeat = self.query_opt(
                    "select 1 from lf.arrival_identity
                     where team_id = $1::text::uuid and adapter_type = $2::text and edge = $3::text and key = $4::text
                       and identity = $5::text and version is not distinct from $6::text and kept_until > $7::text::timestamptz",
                    &[&team_id, &adapter_type, &arrival.edge, &arrival.key, &arrival.identity, &arrival.version, &at],
                )?;
                if repeat.is_some() {
                    continue;
                }
                self.execute(
                    "insert into lf.arrival_identity (team_id, adapter_type, edge, key, identity, version, kept_until)
                     values ($1::text::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text::timestamptz + $8::int8 * interval '1 millisecond')",
                    &[&team_id, &adapter_type, &arrival.edge, &arrival.key, &arrival.identity, &arrival.version, &at, &resend_window_ms],
                )?;
            }
            let landing = arrival.landing.as_ref().map(Js::to_json);
            self.execute(
                "insert into lf.arrival (team_id, adapter_type, edge, key, identity, version, landing, gone, logged_at)
                 values ($1::text::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text::json, $8::bool, $9::text::timestamptz)",
                &[&team_id, &adapter_type, &arrival.edge, &arrival.key, &arrival.identity, &arrival.version, &landing, &arrival.gone, &at],
            )?;
            // A deleted record answers no wait: the waits parked on it are
            // stranded, once, and keep waiting.
            if arrival.gone {
                let stranded = self.query(
                    concat!(
                        "update lf.wait_row w set stranded_at = date_trunc('milliseconds', $5::text::timestamptz)
                         where w.team_id = $1::text::uuid and w.adapter_type = $2::text and w.edge = $3::text and w.key = $4::text
                           and w.stranded_at is null and w.address is not null
                           and exists (select 1 from lf.parked_run p where p.run_id = w.run_id and p.address = w.address)
                         returning w.id::text, w.run_id::text, w.adapter_type, w.edge, w.key, ",
                        iso!("w.stranded_at")
                    ),
                    &[&team_id, &adapter_type, &arrival.edge, &arrival.key, &at],
                )?;
                answer.stranded.extend(stranded.iter().map(|r| Stranded {
                    wait_id: r.get(0),
                    run_id: r.get(1),
                    adapter_type: r.get(2),
                    edge: r.get(3),
                    key: r.get(4),
                    at: r.get(5),
                    parked: true,
                }));
                continue;
            }
            // The newest report on a record wins: one after a gone one says
            // the record is back (or never went), so its waits are not
            // stranded.
            let unstranded = self.query(
                "update lf.wait_row w set stranded_at = null
                 where w.team_id = $1::text::uuid and w.adapter_type = $2::text and w.edge = $3::text and w.key = $4::text and w.stranded_at is not null
                 returning w.id::text",
                &[&team_id, &adapter_type, &arrival.edge, &arrival.key],
            )?;
            answer.stranded.retain(|wait| !unstranded.iter().any(|r| r.get::<_, String>(0) == wait.wait_id));
            // A wait whose park has finished needs no wake: its leaf is gone.
            let answered = self.query(
                "select w.run_id::text, w.id::text, w.address from lf.wait_row w
                 where w.team_id = $1::text::uuid and w.adapter_type = $2::text and w.edge = $3::text and w.key = $4::text and w.address is not null
                   and exists (select 1 from lf.parked_run p where p.run_id = w.run_id and p.address = w.address)
                 order by w.run_id, w.id",
                &[&team_id, &adapter_type, &arrival.edge, &arrival.key],
            )?;
            for row in answered {
                let wake = WaitWake { run_id: row.get(0), wait_id: row.get(1), address: row.get(2) };
                if !answer.wakes.iter().any(|w| w.wait_id == wake.wait_id) {
                    answer.wakes.push(wake);
                }
            }
        }
        answer.stranded.sort();
        Ok(answer)
    }

    /// Why a fenced write wrote nothing (`notWritten`).
    fn not_written(run_id: &str, fence: Option<&str>) -> StoreError {
        match fence {
            Some(_) => StoreError::LeaseLost { run_id: run_id.to_string() },
            None => StoreError::Invalid(format!("run {run_id} has no trigger_run row to park on")),
        }
    }

    /// The run's row held for the transaction under `fence`: a lost lease
    /// writes nothing.
    fn hold_run(&self, run_id: &str, fence: Option<&str>) -> Result<()> {
        if let Some(fence) = fence {
            let held = self.query_opt(&format!("select id from lf.trigger_run where id = $1::text::uuid and {LEASED_TO}$2::text for update"), &[&run_id, &fence])?;
            if held.is_none() {
                return Err(Self::not_written(run_id, Some(fence)));
            }
        }
        Ok(())
    }

    /// `runs.settle`, in the caller's transaction.
    fn settle_run_unwrapped(&self, id: &str, settle: &RunSettle<'_>) -> Result<()> {
        let RunSettle { status, outcome, at } = *settle;
        let status = hosted_status(status);
        let writes = outcome.get("writes").and_then(|w| if let Js::Num(n) = w { n.as_i64() } else { None });
        let error = outcome.get("error").and_then(Js::as_str);
        let returned = outcome.get("returned").map(Js::to_json);
        let records = outcome.get("writeRecords").map(Js::to_json);
        self.execute(
            "update lf.trigger_run set
               status = $2::text,
               nodes_written = coalesce($3::int8, nodes_written),
               failure_reason = case when $2::text = 'failed' then $4::text else failure_reason end,
               completed_at = case when $2::text = 'success' then $5::text::timestamptz else completed_at end,
               failed_at = case when $2::text = 'failed' then $5::text::timestamptz else failed_at end,
               returned = $6::text::json,
               write_records = coalesce($7::text::json, write_records)
             where id = $1::text::uuid",
            &[&id, &status, &writes, &error, &at, &returned, &records],
        )?;
        Ok(())
    }

    /// One park's leaf and what wakes it, in the caller's transaction.
    fn park_unwrapped(&self, run_id: &str, park: &HeldPark<'_>) -> Result<()> {
        let HeldPark { address, state, ref kind } = *park;
        let wake_at = match kind {
            ParkKind::Timer { wake_at } => Some(*wake_at),
            ParkKind::Wait { .. } | ParkKind::Limit => None,
        };
        self.put_leaf(run_id, address, kind.reason(), wake_at, state, None)?;
        // Whatever parks here now, no wait parked here before is.
        self.execute("update lf.wait_row set address = null where run_id = $1::text::uuid and address = $2::text", &[&run_id, &address])?;
        // A segment that resumed the leaf here and parks here again keeps its notes.
        self.execute(
            "update lf.wait_seen s set leaf = null from lf.wait_row w where s.wait_id = w.id and w.run_id = $1::text::uuid and s.leaf = $2::text",
            &[&run_id, &address],
        )?;
        match kind {
            // The leaf is the truth; the work row only says when to look.
            ParkKind::Timer { wake_at } => self.enqueue_row("resume_timer", &timer_work_key(run_id), &timer_work_payload(run_id), Some(wake_at), &self.tenant),
            ParkKind::Wait { wait_id } => {
                // Takes turns with a log on the wait's record (lf.lock_wait_key).
                let locked = self.query_opt(
                    "select lf.lock_wait_key(team_id, adapter_type, edge, key) from lf.wait_row where id = $1::text::uuid and run_id = $2::text::uuid",
                    &[wait_id, &run_id],
                )?;
                if locked.is_none() {
                    return Err(StoreError::Invalid(format!("run {run_id} has no wait {wait_id}")));
                }
                self.execute("update lf.wait_row set address = $2::text where id = $1::text::uuid", &[wait_id, &address])?;
                // Parked on a record already gone (the newest arrival logged
                // on it after its mark is gone, or no key), it is stranded as
                // it parks.
                self.execute(
                    "update lf.wait_row w set stranded_at = date_trunc('milliseconds', now())
                     where w.id = $1::text::uuid and w.stranded_at is null
                       and (w.key is null or coalesce((select a.gone from lf.arrival a
                         where a.team_id = w.team_id and a.adapter_type = w.adapter_type and a.edge = w.edge and a.key = w.key and a.seq > w.since
                         order by a.seq desc limit 1), false))",
                    &[wait_id],
                )?;
                Ok(())
            }
            ParkKind::Limit => Ok(()),
        }
    }

    fn start_run_row(&self, run: &RunStart<'_>) -> Result<()> {
        let trigger = format!("listen:{}:{}", run.file, run.movement);
        self.execute(
            "insert into lf.trigger_run (id, team_id, trigger_id, trigger_type, status, started_at, trigger_payload, delivery_id)
             values ($1::text::uuid, $2::text::uuid, $3::text, 'webhook', 'running', $4::text::timestamptz,
                     jsonb_build_object('file', $5::text, 'movement', $6::text, 'facts', $7::text), $8::text::uuid)",
            &[&run.id, &self.tenant, &trigger, &run.started_at, &run.file, &run.movement, &run.input, &run.delivery_id],
        )?;
        Ok(())
    }

    /// The delivery row read with `DELIVERY_COLUMNS` (and its events at 8,
    /// when read), with its runs.
    fn delivery_of(&self, row: &Row, events: Option<Vec<Js>>) -> Result<DeliveryRow> {
        let id: String = row.get(0);
        let runs = self
            .query(
                "select id::text, status from lf.trigger_run where team_id = $1::text::uuid and delivery_id = $2::text::uuid order by started_at, id",
                &[&self.tenant, &id],
            )?
            .iter()
            .map(|r| DeliveryRun { id: r.get(0), status: lf_status(r.get(1)) })
            .collect();
        Ok(DeliveryRow {
            subscription_id: row.get(1),
            external_id: row.get(2),
            received_at: row.get(3),
            source: DeliverySource::of_wire(row.get(4))?,
            inline: row.get(5),
            replay_of: row.get(6),
            event_count: row.get(7),
            runs,
            events,
            id,
        })
    }

    fn enqueue_row(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: &str) -> Result<()> {
        if !WORK_KINDS.contains(&kind) {
            return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
        }
        let payload = payload.to_json();
        self.execute(
            &format!(
                "insert into lf.work (kind, key, team_id, payload, due_at, updated_at)
                 values ($1::text, $2::text, $3::text::uuid, $4::text::jsonb, coalesce($5::text::timestamptz, now()), date_trunc('milliseconds', clock_timestamp()))
                 on conflict (key) do update set
                   due_at = case when work.dead_at is not null then excluded.due_at
                                 when work.lease_until > now() then excluded.due_at else least(work.due_at, excluded.due_at) end,
                   payload = excluded.payload,
                   attempts = case when work.dead_at is null then work.attempts else 0 end,
                   dead_at = null,
                   dead_reason = null,
                   team_id = coalesce(excluded.team_id, work.team_id),
                   updated_at = {NEXT_VERSION_OF_WORK}"
            ),
            &[&kind, &key, &team_id, &payload, &due_at],
        )?;
        Ok(())
    }
}

/// A work claim's handle, as the hosted backend writes it: the lease taken
/// and the row version it saw.
fn work_claim(claim: &str) -> Result<(String, String)> {
    let not = || StoreError::Invalid(format!("not a work claim: {claim}"));
    let parsed = Js::parse(claim.as_bytes()).map_err(|_| not())?;
    let token = parsed.get("leaseToken").and_then(Js::as_str).ok_or_else(not)?;
    let version = parsed.get("claimedUpdatedAt").and_then(Js::as_str).ok_or_else(not)?;
    Ok((token.to_string(), version.to_string()))
}

impl RunHostStore for PgStore {
    fn tenant(&self) -> &str {
        &self.tenant
    }

    // ── listen-fire's run records ────────────────────────────────────────────────────

    fn start_run(&self, run: &RunStart<'_>) -> Result<()> {
        self.start_run_row(run)
    }

    fn start_event_run(&self, listen: &str, key: &str, run: &RunStart<'_>) -> Result<bool> {
        self.transaction(|| {
            if !self.claim_event(listen, key)? {
                return Ok(false);
            }
            self.start_run_row(run)?;
            Ok(true)
        })
    }

    /// Judged by the database's clock, as the leases are.
    fn lapsed_runs(&self, stale_ms: i64, limit: i64) -> Result<Vec<String>> {
        Ok(self
            .query(
                "select id::text from lf.trigger_run
                 where team_id = $1::text::uuid and status = 'running' and trigger_payload ? 'facts'
                   and (lease_until is null or lease_until < now()) and started_at < now() - $2::int8 * interval '1 millisecond'
                 order by started_at limit $3::int8",
                &[&self.tenant, &stale_ms, &limit],
            )?
            .iter()
            .map(|r| r.get(0))
            .collect())
    }
    fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()> {
        self.transaction(|| self.settle_run_unwrapped(id, &RunSettle { status, outcome, at }))
    }

    fn mark_parked(&self, id: &str) -> Result<()> {
        self.execute("update lf.trigger_run set status = 'parked' where id = $1::text::uuid and status in ('running', 'parked')", &[&id])?;
        Ok(())
    }

    fn mark_failed(&self, id: &str, message: &str) -> Result<()> {
        self.transaction(|| {
            self.execute(
                "update lf.trigger_run set status = 'failed', failed_at = now(), failure_reason = $2::text
                 where id = $1::text::uuid and status in ('running', 'parked')",
                &[&id, &message],
            )?;
            Ok(())
        })
    }

    fn rerun_run(&self, run_id: &str, rerun: &Rerun<'_>) -> Result<Option<i64>> {
        if uuid::Uuid::parse_str(run_id).is_err() {
            return Ok(None);
        }
        self.transaction(|| {
            // Held for the transaction: the lease cannot change hands
            // between the check and the write.
            let held = self.query_opt(
                &format!("select {RUN_COLUMNS} from lf.trigger_run where id = $1::text::uuid and team_id = $2::text::uuid and {LEASED_TO}$3::text for update"),
                &[&run_id, &self.tenant, &rerun.fence],
            )?;
            let Some(row) = held else { return Err(Self::not_written(run_id, Some(rerun.fence))) };
            let run = run_of(&row)?;
            if run.status != "failed" {
                return Ok(None);
            }
            let mut attempts = run.attempts.clone();
            attempts.push(crate::store::kept_attempt(&run));
            let attempts = Js::Arr(attempts).to_json();
            let next = run.attempt + 1;
            self.execute(
                "update lf.trigger_run set
                   status = 'running', attempt = $2::int8, attempts = $3::text::json,
                   trigger_payload = jsonb_set(trigger_payload, '{facts}', to_jsonb($4::text)),
                   started_at = $5::text::timestamptz, completed_at = null, failed_at = null, failure_reason = null,
                   nodes_written = 0, write_records = null, returned = null, cancel_requested_at = null, cancel_reason = null,
                   cost_cap_baseline_microdollars = round(coalesce((diagnostics ->> 'costMicrodollars')::float8, 0))::int8
                 where id = $1::text::uuid",
                &[&run_id, &next, &attempts, &rerun.input, &rerun.at],
            )?;
            Ok(Some(next))
        })
    }

    fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>> {
        let row = self.query_opt("select cancel_requested_at is not null, cancel_reason from lf.trigger_run where id = $1::text::uuid", &[&id])?;
        Ok(row.and_then(|r| r.get::<_, bool>(0).then(|| r.get(1))))
    }

    fn request_cancel(&self, id: &str, reason: Option<&str>) -> Result<()> {
        // As the state file does: only a run still going takes a request, and
        // the first one stands (a settled run has nothing left to cancel).
        self.execute(
            "update lf.trigger_run set cancel_requested_at = now(), cancel_reason = $2::text
             where id = $1::text::uuid and cancel_requested_at is null and status in ('running', 'parked')",
            &[&id, &reason],
        )?;
        Ok(())
    }

    fn run(&self, id: &str) -> Result<Option<RunRow>> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Ok(None);
        }
        self.query_opt(&format!("select {RUN_COLUMNS} from lf.trigger_run where id = $1::text::uuid and team_id = $2::text::uuid"), &[&id, &self.tenant])?
            .map(|r| run_of(&r))
            .transpose()
    }

    fn runs(&self, limit: i64) -> Result<Vec<RunRow>> {
        self.query(
            &format!("select {RUN_COLUMNS} from lf.trigger_run where team_id = $1::text::uuid and trigger_payload ? 'facts' order by started_at desc limit $2::int8"),
            &[&self.tenant, &limit],
        )?
        .iter()
        .map(run_of)
        .collect()
    }

    /// Where the hosted product keeps a run's trace: each segment's in its
    /// own movement step on `trigger_run.steps`, at `diagnostics.trace`
    /// (trigger_run.ts `movementStepDiagnostics`), so the hosted inspection
    /// reads listen-fire's runs as its own. A segment's later entries extend its step,
    /// found by the `segmentId` listen-fire keeps on it.
    fn append_trace(&self, run_id: &str, segment_id: &str, entries: &[Js]) -> Result<()> {
        let entries = Js::Arr(entries.to_vec()).to_json();
        self.execute(
            "update lf.trigger_run set steps = case
               when steps -> -1 ->> 'segmentId' = $2::text
                 then jsonb_set(steps, array[(jsonb_array_length(steps) - 1)::text, 'diagnostics', 'trace'],
                                coalesce(steps -> -1 -> 'diagnostics' -> 'trace', '[]'::jsonb) || $3::text::jsonb)
               else steps || jsonb_build_array(jsonb_build_object(
                 'tgId', trigger_id, 'tgName', null, 'sourceAdapterType', null, 'targetAdapterType', null,
                 'status', 'success', 'appliedActionPlans', '[]'::jsonb, 'errors', '[]'::jsonb, 'engine', 'interpreter',
                 'diagnostics', jsonb_build_object('trace', $3::text::jsonb), 'segmentId', $2::text))
             end
             where id = $1::text::uuid and team_id = $4::text::uuid",
            &[&run_id, &segment_id, &entries, &self.tenant],
        )?;
        Ok(())
    }

    /// The hosted product's run total: `diagnostics.costMicrodollars`
    /// (trigger_run.ts `runSpentMicrodollars`), less the cap's baseline.
    fn run_spent(&self, run_id: &str) -> Result<f64> {
        let row = self.query_opt(
            "select (coalesce((diagnostics ->> 'costMicrodollars')::float8, (diagnostics ->> 'costUsd')::float8 * 1000000, 0)
                     - cost_cap_baseline_microdollars)::float8
             from lf.trigger_run where id = $1::text::uuid and team_id = $2::text::uuid",
            &[&run_id, &self.tenant],
        )?;
        Ok(row.map_or(0.0, |r| r.get(0)))
    }

    fn add_run_spend(&self, run_id: &str, microdollars: f64) -> Result<()> {
        self.execute(
            "update lf.trigger_run set diagnostics = diagnostics
               || jsonb_build_object('costMicrodollars', coalesce((diagnostics ->> 'costMicrodollars')::float8, 0) + $2::float8)
               || jsonb_build_object('costUsd', (coalesce((diagnostics ->> 'costMicrodollars')::float8, 0) + $2::float8) / 1000000)
             where id = $1::text::uuid and team_id = $3::text::uuid",
            &[&run_id, &microdollars, &self.tenant],
        )?;
        Ok(())
    }

    /// `cost_cap_baseline_microdollars`, as limit_resume.ts sets it.
    fn reset_spend_baseline(&self, run_id: &str) -> Result<()> {
        self.execute(
            "update lf.trigger_run set cost_cap_baseline_microdollars = round(coalesce((diagnostics ->> 'costMicrodollars')::float8, 0))::int8
             where id = $1::text::uuid and team_id = $2::text::uuid",
            &[&run_id, &self.tenant],
        )?;
        Ok(())
    }

    fn trace_len(&self, run_id: &str) -> Result<i64> {
        let row = self.query_opt(
            "select coalesce(sum(jsonb_array_length(step -> 'diagnostics' -> 'trace')), 0)::int8
             from lf.trigger_run r, jsonb_array_elements(r.steps) as step
             where r.id = $1::text::uuid and r.team_id = $2::text::uuid and jsonb_typeof(step -> 'diagnostics' -> 'trace') = 'array'",
            &[&run_id, &self.tenant],
        )?;
        Ok(row.map_or(0, |r| r.get(0)))
    }

    fn trace_entries(&self, run_id: &str) -> Result<Option<Vec<Js>>> {
        let rows = self.query(
            "select t.entry::text
             from lf.trigger_run r,
                  jsonb_array_elements(r.steps) with ordinality as s(step, i),
                  jsonb_array_elements(case when jsonb_typeof(s.step -> 'diagnostics' -> 'trace') = 'array' then s.step -> 'diagnostics' -> 'trace' else '[]'::jsonb end)
                    with ordinality as t(entry, j)
             where r.id = $1::text::uuid and r.team_id = $2::text::uuid
             order by s.i, t.j",
            &[&run_id, &self.tenant],
        )?;
        rows.iter().map(|r| Js::parse(r.get::<_, String>(0).as_bytes()).map_err(StoreError::Backend)).collect::<Result<Vec<_>>>().map(Some)
    }

    // ── Parks ───────────────────────────────────────────────────────────────

    fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()> {
        let state = state.to_json();
        let written = self.query_opt(
            &format!(
                "insert into lf.parked_run (run_id, address, status, park_reason, wake_at, state)
                 select r.id, $2::text, 'parked', $3::text, $4::text::timestamptz, $5::text::jsonb
                 from lf.trigger_run r where r.id = $1::text::uuid and ($6::text is null or r.{LEASED_TO}$6::text)
                 on conflict (run_id, address) do update set
                   state = excluded.state, status = 'parked', park_reason = excluded.park_reason, wake_at = excluded.wake_at
                 returning id"
            ),
            &[&run_id, &address, &reason, &wake_at, &state, &fence],
        )?;
        if written.is_none() {
            return Err(Self::not_written(run_id, fence));
        }
        Ok(())
    }

    /// What a segment that resumed the leaf before noted and never kept (it
    /// died) is dropped as the leaf is claimed, so its arrivals are read again.
    fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>> {
        let row = self.query_opt(
            "with claimed as (
               update lf.parked_run set status = 'resuming', updated_at = now()
               where run_id = $1::text::uuid and address = $2::text and status = 'parked' and ($3::text is null or park_reason = $3::text)
               returning park_reason, coalesce(state, 'null'::jsonb)::text as state
             ), dropped as (
               delete from lf.wait_seen s using lf.wait_row w
               where s.wait_id = w.id and w.run_id = $1::text::uuid and s.leaf = $2::text and exists (select 1 from claimed)
             )
             select park_reason, state from claimed",
            &[&run_id, &address, &reason],
        )?;
        row.map(|r| Ok((r.get(0), parse_text(r.get(1))?))).transpose()
    }

    /// The leaf's resume is over: the notes its segment made are kept.
    fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()> {
        self.execute(&format!("with held as (select 1 from lf.trigger_run r where r.id = $1::text::uuid and ($3::text is null or r.{LEASED_TO}$3::text)), {FINISHED}"), &[&run_id, &address, &fence])?;
        Ok(())
    }

    fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>> {
        let rows = self.query(
            concat!(
                "select address, park_reason, status, ",
                iso!("wake_at"),
                " from lf.parked_run
                 where run_id = $1::text::uuid and (not $2::bool or status = 'parked') and ($3::text is null or park_reason = $3::text)
                   and ($4::text is null or (park_reason = 'timer' and wake_at <= $4::text::timestamptz))
                 order by created_at, address"
            ),
            &[&run_id, &parked_only, &reason, &due_by],
        )?;
        Ok(rows.iter().map(|r| LeafRow { address: r.get(0), reason: r.get(1), status: r.get(2), wake_at: r.get(3) }).collect())
    }

    fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()> {
        if addresses.is_empty() {
            return Ok(());
        }
        self.execute("delete from lf.parked_run where run_id = $1::text::uuid and address = any($2::text[])", &[&run_id, &addresses])?;
        Ok(())
    }

    /// One transaction; a fenced one holds the run's row for it, so the lease
    /// cannot change hands between the check and the writes.
    fn commit_park(&self, park: &Park<'_>) -> Result<()> {
        let Park { run_id, address, state, fence, kind } = *park;
        self.transaction(|| {
            self.hold_run(run_id, fence)?;
            self.park_unwrapped(run_id, &HeldPark { address, state, kind })?;
            self.mark_parked(run_id)
        })
    }

    /// As `commit_park`, the segment's held writes in one transaction.
    fn commit_segment(&self, commit: &SegmentCommit<'_>) -> Result<Vec<WaitWake>> {
        let SegmentCommit { run_id, team_id, fence, resumed, ref joins, ref parks, ref settle, ref owed_races, settled_race } = *commit;
        self.transaction(|| {
            self.hold_run(run_id, fence)?;
            // The waits' records' edges locked once, in one order, as a log
            // locks them, so a commit and a log never wait on each other.
            let wait_ids: Vec<&str> = parks.iter().filter_map(|park| if let ParkKind::Wait { wait_id } = park.kind { Some(wait_id) } else { None }).collect();
            let mut edges: Vec<(String, String, String, String)> = self
                .query(
                    "select team_id::text, adapter_type, edge, key from lf.wait_row where id::text = any($1::text[]) and run_id = $2::text::uuid",
                    &[&wait_ids, &run_id],
                )?
                .iter()
                .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
                .collect();
            edges.sort_unstable();
            for (team, adapter_type, edge, key) in &edges {
                self.execute("select lf.lock_wait_key($1::text::uuid, $2::text, $3::text, $4::text)", &[team, adapter_type, edge, key])?;
            }
            for join in joins {
                self.record_join(run_id, join.frame_address, join.pending, None)?;
            }
            for park in parks {
                self.park_unwrapped(run_id, park)?;
            }
            if let Some(resumed) = resumed.filter(|resumed| !parks.iter().any(|park| park.address == *resumed)) {
                self.execute(&format!("with held as (select 1), {FINISHED}"), &[&run_id, &resumed])?;
            }
            if !parks.is_empty() {
                self.mark_parked(run_id)?;
            }
            if let Some(settle) = settle {
                self.settle_run_unwrapped(run_id, settle)?;
            }
            if let Some(frame) = settled_race {
                self.execute("delete from lf.work where key = $1::text", &[&settle_race_work_key(run_id, frame)])?;
            }
            for race in owed_races {
                self.enqueue_row(SETTLE_RACE_WORK_KIND, &settle_race_work_key(run_id, race.frame_address), &settle_race_work_payload(run_id, race), None, team_id)?;
            }
            // Read in the write, so an arrival logged before it is read here
            // and one logged after it finds the wait parked.
            let mut wakes = Vec::new();
            for park in parks {
                let ParkKind::Wait { wait_id } = park.kind else { continue };
                let unread = self.wait_arrivals(wait_id)?;
                if !unread.arrivals.is_empty() {
                    let wake = WaitWake { run_id: run_id.to_string(), wait_id: wait_id.to_string(), address: park.address.to_string() };
                    let row = crate::waits::wake_row(team_id, &wake);
                    self.enqueue_row(&row.kind, &row.key, &row.payload, row.due_at.as_deref(), team_id)?;
                    wakes.push(wake);
                }
            }
            Ok(wakes)
        })
    }

    // ── Joins ───────────────────────────────────────────────────────────────

    fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()> {
        let recorded = self.query_opt(
            &format!(
                "insert into lf.join_pending (run_id, frame_address, pending)
                 select r.id, $2::text, $3::int8 from lf.trigger_run r
                 where r.id = $1::text::uuid and ($4::text is null or r.{LEASED_TO}$4::text)
                 on conflict (run_id, frame_address) do update set pending = excluded.pending, updated_at = now()
                 returning run_id"
            ),
            &[&run_id, &frame_address, &pending, &fence],
        )?;
        if recorded.is_none() {
            return Err(Self::not_written(run_id, fence));
        }
        Ok(())
    }

    /// The mark-closed decrement (`decrementJoin`): each branch claims its
    /// one decrement against its own export row, and the closer's address
    /// is kept on the frame, so a retry of the closer closes again and a
    /// sibling never does.
    fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool> {
        self.transaction(|| {
            let claimed = self.query_opt(
                "update lf.join_branch_export set decremented = true
                 where run_id = $1::text::uuid and frame_address = $2::text and branch_address = $3::text and decremented = false
                 returning 1",
                &[&run_id, &frame_address, &branch_address],
            )?;
            if claimed.is_some() {
                let updated = self.query_opt(
                    "update lf.join_pending set pending = pending - 1, updated_at = now()
                     where run_id = $1::text::uuid and frame_address = $2::text and pending > 0
                     returning pending::int8",
                    &[&run_id, &frame_address],
                )?;
                if let Some(updated) = updated {
                    if updated.get::<_, i64>(0) > 0 {
                        return Ok(false);
                    }
                    self.execute(
                        "update lf.join_pending set closed_by_address = $3::text where run_id = $1::text::uuid and frame_address = $2::text",
                        &[&run_id, &frame_address, &leaf_address],
                    )?;
                    return Ok(true);
                }
            }
            let row = self.query_opt(
                "select closed_by_address from lf.join_pending where run_id = $1::text::uuid and frame_address = $2::text",
                &[&run_id, &frame_address],
            )?;
            Ok(row.and_then(|r| r.get::<_, Option<String>>(0)).as_deref() == Some(leaf_address))
        })
    }

    fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()> {
        // The conflict update never touches `decremented`: a re-persist would
        // otherwise reset the branch's decrement claim.
        let exports = exports.to_json();
        self.execute(
            "insert into lf.join_branch_export (run_id, frame_address, branch_address, branch_index, exports)
             values ($1::text::uuid, $2::text, $3::text, $4::int8, $5::text::jsonb)
             on conflict (run_id, frame_address, branch_address) do update set
               exports = excluded.exports, branch_index = excluded.branch_index, updated_at = now()",
            &[&run_id, &frame_address, &branch_address, &branch_index, &exports],
        )?;
        Ok(())
    }

    fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>> {
        self.query(
            "select branch_address, branch_index::int8, exports::text from lf.join_branch_export
             where run_id = $1::text::uuid and frame_address = $2::text order by branch_index",
            &[&run_id, &frame_address],
        )?
        .iter()
        .map(|r| Ok(BranchExport { branch_address: r.get(0), branch_index: r.get(1), exports: parse_text(r.get(2))? }))
        .collect()
    }

    fn owed_races(&self, run_id: &str) -> Result<Vec<OwedRace>> {
        self.query(
            "select payload::text from lf.work where kind = $1::text and payload->>'runId' = $2::text order by created_at, key",
            &[&SETTLE_RACE_WORK_KIND, &run_id],
        )?
        .iter()
        .map(|r| {
            let payload: String = r.get(0);
            OwedRace::of_payload(&parse_text(&payload)?).ok_or_else(|| StoreError::Invalid(format!("a {SETTLE_RACE_WORK_KIND} row of run {run_id} that is not one: {payload}")))
        })
        .collect()
    }

    fn has_pending_joins(&self, run_id: &str) -> Result<bool> {
        Ok(self.query_opt("select 1 from lf.join_pending where run_id = $1::text::uuid and pending > 0 limit 1", &[&run_id])?.is_some())
    }

    fn frames(&self, run_id: &str) -> Result<Vec<String>> {
        Ok(self
            .query("select frame_address from lf.join_pending where run_id = $1::text::uuid order by frame_address", &[&run_id])?
            .iter()
            .map(|r| r.get(0))
            .collect())
    }

    fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()> {
        if frame_addresses.is_empty() {
            return Ok(());
        }
        self.transaction(|| {
            self.execute("delete from lf.join_pending where run_id = $1::text::uuid and frame_address = any($2::text[])", &[&run_id, &frame_addresses])?;
            self.execute("delete from lf.join_branch_export where run_id = $1::text::uuid and frame_address = any($2::text[])", &[&run_id, &frame_addresses])?;
            let owed: Vec<String> = frame_addresses.iter().map(|frame| settle_race_work_key(run_id, frame)).collect();
            self.execute("delete from lf.work where key = any($1::text[])", &[&owed])?;
            Ok(())
        })
    }

    // ── Waits on listenable edges ───────────────────────────────────────────

    fn arrival_mark(&self) -> Result<i64> {
        Ok(self.query_opt("select coalesce(max(seq), 0) from lf.arrival", &[])?.map(|r| r.get(0)).unwrap_or(0))
    }

    fn log_arrivals(&self, log: &DeliveryArrivals<'_>) -> Result<Logged> {
        self.transaction(|| {
            let logged = self.log_arrivals_unwrapped(log)?;
            for row in crate::waits::wake_rows(log.team_id, &logged.wakes) {
                self.enqueue_row(&row.kind, &row.key, &row.payload, row.due_at.as_deref(), log.team_id)?;
            }
            Ok(logged)
        })
    }

    /// A keyed wait is one per run and record's edge, a keyless one (its
    /// record already gone) one per run and edge: an open of either again
    /// is the first.
    fn open_wait(&self, wait: &OpenWait<'_>) -> Result<String> {
        let OpenWait { run_id, team_id, adapter_type, edge, key, since } = *wait;
        self.transaction(|| {
            self.execute(
                "insert into lf.wait_row (run_id, team_id, adapter_type, edge, key, since)
                 values ($1::text::uuid, $2::text::uuid, $3::text, $4::text, $5::text, $6::int8)
                 on conflict do nothing",
                &[&run_id, &team_id, &adapter_type, &edge, &key, &since],
            )?;
            let row = self.query_opt(
                "select id::text from lf.wait_row
                 where run_id = $1::text::uuid and team_id = $2::text::uuid and adapter_type = $3::text and edge = $4::text and key is not distinct from $5::text",
                &[&run_id, &team_id, &adapter_type, &edge, &key],
            )?;
            row.map(|r| r.get(0)).ok_or_else(|| StoreError::Invalid(format!("run {run_id}'s wait on {edge} of {} was not kept", key.unwrap_or("a record already gone"))))
        })
    }

    /// One statement, so the wait's existence and its arrivals are read at
    /// one instant.
    fn wait_arrivals(&self, wait_id: &str) -> Result<WaitArrivals> {
        let rows = self.query(
            "select w.id, a.seq, a.identity, a.version, a.landing
             from lf.wait_row w
             left join lateral (
               select a.seq, coalesce(a.identity, '#' || a.seq::text) as identity, a.version, a.landing::text as landing
               from lf.arrival a
               where a.team_id = w.team_id and a.adapter_type = w.adapter_type and a.edge = w.edge and a.key = w.key and a.seq > w.since and not a.gone
                 and not exists (select 1 from lf.wait_seen s
                   where s.wait_id = w.id and s.identity = coalesce(a.identity, '#' || a.seq::text) and s.version is not distinct from a.version)
                 and not exists (select 1 from lf.arrival b
                   where b.team_id = a.team_id and b.adapter_type = a.adapter_type and b.edge = a.edge and b.key = a.key
                     and b.seq > w.since and b.seq < a.seq and not b.gone and b.identity = a.identity and b.version is not distinct from a.version)
             ) a on true
             where w.id = $1::text::uuid
             order by a.seq",
            &[&wait_id],
        )?;
        if rows.is_empty() {
            return Err(StoreError::Invalid(format!("no wait {wait_id}")));
        }
        let arrivals = rows
            .iter()
            .filter_map(|r| r.get::<_, Option<i64>>(1).map(|seq| (seq, r)))
            .map(|(seq, r)| Ok(LoggedArrival { seq, identity: r.get(2), version: r.get(3), landing: landing_of(r.get::<_, Option<&str>>(4))? }))
            .collect::<Result<Vec<_>>>()?;
        Ok(WaitArrivals { arrivals })
    }

    fn stranded_waits(&self, of: &StrandedOf<'_>) -> Result<Vec<Stranded>> {
        const COLUMNS: &str = concat!(
            "select w.id::text, w.run_id::text, w.adapter_type, w.edge, w.key, ",
            iso!("w.stranded_at"),
            ", w.address is not null and exists (select 1 from lf.parked_run p where p.run_id = w.run_id and p.address = w.address)
             from lf.wait_row w join lf.trigger_run r on r.id = w.run_id
             where w.stranded_at is not null and r.team_id = $1::text::uuid"
        );
        let rows = match *of {
            StrandedOf::Run(run_id) => self.query(&format!("{COLUMNS} and w.run_id = $2::text::uuid order by w.stranded_at, w.id"), &[&self.tenant, &run_id])?,
            StrandedOf::Page { after: None, limit } => self.query(&format!("{COLUMNS} order by w.stranded_at, w.id limit $2::int8"), &[&self.tenant, &limit])?,
            StrandedOf::Page { after: Some(StrandedAfter { at, wait_id }), limit } => self.query(
                &format!("{COLUMNS} and (w.stranded_at, w.id) > ($2::text::timestamptz, $3::text::uuid) order by w.stranded_at, w.id limit $4::int8"),
                &[&self.tenant, &at, &wait_id, &limit],
            )?,
        };
        Ok(rows
            .iter()
            .map(|r| Stranded { wait_id: r.get(0), run_id: r.get(1), adapter_type: r.get(2), edge: r.get(3), key: r.get(4), at: r.get(5), parked: r.get(6) })
            .collect())
    }

    fn note_arrival(&self, noted: &Noted<'_>) -> Result<bool> {
        let Noted { wait_id, identity, version, matched, leaf, fence } = *noted;
        self.transaction(|| {
            let Some(waiting) = self.query_opt("select run_id::text from lf.wait_row where id = $1::text::uuid", &[&wait_id])? else {
                return Err(StoreError::Invalid(format!("no wait {wait_id}")));
            };
            let run_id: String = waiting.get(0);
            // A segment that lost the run's lease notes nothing. The run's row
            // is held (before the wait's, as a park holds them), so the lease
            // cannot change hands before the note is in.
            if let Some(fence) = fence {
                let held = self.query_opt(&format!("select id from lf.trigger_run where id = $1::text::uuid and {LEASED_TO}$2::text for update"), &[&run_id, &fence])?;
                if held.is_none() {
                    return Err(StoreError::LeaseLost { run_id });
                }
            }
            // Held for the transaction: two notes on one wait take turns.
            self.query_opt("select id from lf.wait_row where id = $1::text::uuid for update", &[&wait_id])?;
            let noted = self.query_opt(
                "select 1 from lf.wait_seen where wait_id = $1::text::uuid and identity = $2::text and version is not distinct from $3::text",
                &[&wait_id, &identity, &version],
            )?;
            if noted.is_some() {
                return Ok(false);
            }
            let matched_before: bool = self
                .query_opt(
                    "select matched from lf.wait_seen where wait_id = $1::text::uuid and identity = $2::text order by id desc limit 1",
                    &[&wait_id, &identity],
                )?
                .map(|r| r.get(0))
                .unwrap_or(false);
            self.execute(
                "insert into lf.wait_seen (wait_id, identity, version, matched, leaf) values ($1::text::uuid, $2::text, $3::text, $4::bool, $5::text)",
                &[&wait_id, &identity, &version, &matched, &leaf],
            )?;
            Ok(matched && !matched_before)
        })
    }

    /// The floor: the lowest mark an unexpired run lease took, else the
    /// latest seq. A wait is live while its run exists, or while the
    /// `fire_event` row that queues it (a wait a delivery opened) is there,
    /// not buried.
    fn sweep_arrivals(&self, limit: i64) -> Result<i64> {
        self.transaction(|| {
            let swept = self.execute(
                "delete from lf.arrival where seq in (
                   select a.seq from lf.arrival a
                   where a.seq <= coalesce((select min(lease_mark) from lf.trigger_run where lease_until > now() and lease_mark is not null),
                                           (select coalesce(max(seq), 0) from lf.arrival))
                     and not exists (select 1 from lf.wait_row w
                       where w.team_id = a.team_id and w.adapter_type = a.adapter_type and w.edge = a.edge and w.key = a.key and w.since < a.seq
                         and (exists (select 1 from lf.trigger_run r where r.id = w.run_id)
                              or exists (select 1 from lf.work q where q.key = w.fire_key and q.dead_at is null)))
                   order by a.seq limit $1::int8)",
                &[&limit],
            )?;
            self.execute(
                "delete from lf.arrival_identity where ctid in (select ctid from lf.arrival_identity where kept_until < now() limit $1::int8)",
                &[&limit],
            )?;
            Ok(i64::try_from(swept).unwrap_or(i64::MAX))
        })
    }


    // ── The run lease ───────────────────────────────────────────────────────

    /// One statement: taken only while free or lapsed, and in the same
    /// statement every leaf a dead holder left claimed goes back to parked.
    fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>> {
        let token = uuid::Uuid::new_v4().to_string();
        let claimed = self.query_opt(
            "with claimed as (
               update lf.trigger_run
               set lease_owner = $2::text, lease_until = now() + $3::int8 * interval '1 millisecond', lease_token = $4::text::uuid,
                   lease_mark = (select coalesce(max(seq), 0) from lf.arrival)
               where id = $1::text::uuid and (lease_until is null or lease_until < now())
               returning id
             ), returned as (
               update lf.parked_run set status = 'parked'
               where run_id in (select id from claimed) and status = 'resuming'
             )
             select id from claimed",
            &[&run_id, &self.owner, &ttl_ms, &token],
        )?;
        Ok(claimed.map(|_| token))
    }

    /// Also the run's heartbeat. A lapsed lease is not renewed: it is free.
    fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool> {
        let renewed = self.execute(
            &format!(
                "update lf.trigger_run set lease_until = now() + $3::int8 * interval '1 millisecond', last_heartbeat_at = now()
                 where id = $1::text::uuid and {LEASED_TO}$2::text and lease_until > now()"
            ),
            &[&run_id, &token, &ttl_ms],
        )?;
        Ok(renewed > 0)
    }

    fn release_lease(&self, run_id: &str, token: &str) -> Result<()> {
        self.execute(
            &format!("update lf.trigger_run set lease_owner = null, lease_until = null, lease_token = null where id = $1::text::uuid and {LEASED_TO}$2::text"),
            &[&run_id, &token],
        )?;
        Ok(())
    }

    fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool> {
        self.transaction(|| {
            if let Some(fence) = fence {
                // Held for the transaction: the lease cannot change hands
                // between the check and the deletes.
                let held = self.query_opt(
                    &format!("select id from lf.trigger_run where id = $1::text::uuid and {LEASED_TO}$2::text for update"),
                    &[&run_id, &fence],
                )?;
                if held.is_none() {
                    return Ok(false);
                }
            }
            // A wait's notes go with its row.
            for table in ["parked_run", "join_pending", "join_branch_export", "wait_row"] {
                self.execute(&format!("delete from lf.{table} where run_id = $1::text::uuid"), &[&run_id])?;
            }
            self.execute("delete from lf.work where kind = $1::text and payload->>'runId' = $2::text", &[&SETTLE_RACE_WORK_KIND, &run_id])?;
            Ok(true)
        })
    }

    // ── The work queue ──────────────────────────────────────────────────────

    fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: Option<&str>) -> Result<()> {
        self.enqueue_row(kind, key, payload, due_at, team_id.unwrap_or(&self.tenant))
    }

    fn enqueue_if_absent(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: Option<&str>) -> Result<bool> {
        if !WORK_KINDS.contains(&kind) {
            return Err(StoreError::Invalid(format!("not a work kind: {kind}")));
        }
        let (payload, team_id) = (payload.to_json(), team_id.unwrap_or(&self.tenant));
        let inserted = self.execute(
            "insert into lf.work (kind, key, team_id, payload, due_at, updated_at)
             values ($1::text, $2::text, $3::text::uuid, $4::text::jsonb, coalesce($5::text::timestamptz, now()), date_trunc('milliseconds', clock_timestamp()))
             on conflict (key) do nothing",
            &[&kind, &key, &team_id, &payload, &due_at],
        )?;
        Ok(inserted == 1)
    }

    /// One statement, so two drainers cannot race: SKIP LOCKED hands each a
    /// disjoint set, and MATERIALIZED fixes the selection before the update.
    fn claim_due(&self, claim: &ClaimDue<'_>) -> Result<Vec<ClaimedWork>> {
        let kinds = claim.kinds()?;
        let (due_by, limit, lease_ms) = (claim.due_by, claim.limit, claim.lease_ms);
        let rows = self.query(
            &format!(
                "with c as materialized (
                   select id from lf.work
                   where due_at <= coalesce($1::text::timestamptz, now()) and (lease_until is null or lease_until < now())
                     and dead_at is null and kind = any($2::text[]) and team_id = $3::text::uuid
                   order by due_at
                   limit $4::int8
                   for update skip locked
                 )
                 update lf.work w
                 set lease_owner = $5::text, lease_until = now() + $6::int8 * interval '1 millisecond', lease_token = gen_random_uuid(),
                     attempts = attempts + 1, updated_at = {NEXT_VERSION_OF_W}
                 from c where w.id = c.id
                 returning w.id::text, w.kind, w.key, w.payload::text, w.lease_token::text, {}, w.attempts::int8",
                iso!("w.updated_at")
            ),
            &[&due_by, &kinds, &self.tenant, &limit, &self.owner, &lease_ms],
        )?;
        rows.iter()
            .map(|r| {
                let claim = Js::Obj(obj! { "leaseToken" => Js::Str(r.get(4)), "claimedUpdatedAt" => Js::Str(r.get(5)) });
                Ok(ClaimedWork { id: r.get(0), kind: r.get(1), key: r.get(2), payload: parse_text(r.get(3))?, claim: claim.to_json(), attempts: r.get(6) })
            })
            .collect()
    }

    /// Deleted unless re-armed since the claim (its version moved): then
    /// its lease clears and it runs again at its due time.
    fn complete(&self, id: &str, claim: &str) -> Result<()> {
        let (token, version) = work_claim(claim)?;
        let held = "id = $1::text::uuid and lease_token::text = $2::text";
        self.execute(
            &format!("delete from lf.work where {held} and interval_ms is null and updated_at = $3::text::timestamptz"),
            &[&id, &token, &version],
        )?;
        self.execute(
            &format!(
                "update lf.work set lease_owner = null, lease_until = null, lease_token = null, attempts = 0, deferrals = 0,
                   due_at = case when interval_ms is null then due_at else now() + interval_ms * interval '1 millisecond' end
                 where {held}"
            ),
            &[&id, &token],
        )?;
        Ok(())
    }

    /// Unleased for a retry at `due_at`, unless re-armed since the claim. A
    /// busy run's release gives the attempt back (`deferWork`).
    fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>, why: Release) -> Result<()> {
        let (token, version) = work_claim(claim)?;
        let attempts = match why {
            Release::Failed => "attempts",
            Release::Busy => "greatest(attempts - 1, 0), deferrals = deferrals + 1",
            Release::Rescheduled => "0, deferrals = 0",
        };
        self.execute(
            &format!(
                "update lf.work set lease_owner = null, lease_until = null, lease_token = null, attempts = {attempts},
                   due_at = case when updated_at = $3::text::timestamptz then coalesce($4::text::timestamptz, due_at) else due_at end
                 where id = $1::text::uuid and lease_token::text = $2::text"
            ),
            &[&id, &token, &version, &due_at],
        )?;
        Ok(())
    }

    fn bury_work(&self, id: &str, claim: &str, reason: &str) -> Result<()> {
        let (token, version) = work_claim(claim)?;
        let held = "id = $1::text::uuid and lease_token::text = $2::text";
        self.transaction(|| {
            let buried = self.query_opt(
                &format!("update lf.work set dead_at = now(), dead_reason = $4::text where {held} and updated_at = $3::text::timestamptz returning key"),
                &[&id, &token, &version, &reason],
            )?;
            self.execute(&format!("update lf.work set lease_owner = null, lease_until = null, lease_token = null where {held}"), &[&id, &token])?;
            // The waits a delivery opened for runs this row queued that never
            // started go with it.
            if let Some(row) = buried {
                let key: String = row.get(0);
                self.execute(
                    "delete from lf.wait_row w where w.fire_key = $1::text and not exists (select 1 from lf.trigger_run r where r.id = w.run_id)",
                    &[&key],
                )?;
            }
            Ok(())
        })
    }

    // ── Library sources ─────────────────────────────────────────────────────

    fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()> {
        self.execute(
            "insert into lf.park_library_source (team_id, hash, source) values ($1::text::uuid, $2::text, $3::text) on conflict (team_id, hash) do nothing",
            &[&team_id, &hash, &source],
        )?;
        Ok(())
    }

    fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>> {
        Ok(self
            .query_opt("select source from lf.park_library_source where team_id = $1::text::uuid and hash = $2::text", &[&team_id, &hash])?
            .map(|r| r.get(0)))
    }

    fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>> {
        let row = self.query_opt(
            "select checkpoint::text from lf.inbound_checkpoint where team_id = $1::text::uuid and subscription_id = $2::text",
            &[&self.tenant, &subscription_id],
        )?;
        // A checkpoint saved as null is a forgotten one, as the state file reads it.
        Ok(row.map(|r| parse_text(r.get(0))).transpose()?.filter(|checkpoint| *checkpoint != Js::Null))
    }
    fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<()> {
        let text = checkpoint.to_json();
        self.execute(
            "insert into lf.inbound_checkpoint (team_id, subscription_id, checkpoint) values ($1::text::uuid, $2::text, $3::text::jsonb)
             on conflict (team_id, subscription_id) do update set checkpoint = excluded.checkpoint, updated_at = now()",
            &[&self.tenant, &subscription_id, &text],
        )?;
        Ok(())
    }

    fn listen_states(&self, pipelines: &[String]) -> Result<BTreeMap<String, ListenState>> {
        let rows = self.query("select pipeline, state::text from lf.listen_state where team_id = $1::text::uuid and pipeline = any($2::text[])", &[&self.tenant, &pipelines])?;
        rows.into_iter()
            .map(|r| {
                let (pipeline, text): (String, String) = (r.get(0), r.get(1));
                let state = ListenState::from_js(&parse_text(&text)?).ok_or_else(|| StoreError::Invalid(format!("a stored listen's state is not one: {text}")))?;
                Ok((pipeline, state))
            })
            .collect()
    }
    /// A listen never resolved is kept from its first hold, with nothing
    /// resolved.
    fn claim_listen_resolve(&self, pipeline: &str, ttl_ms: i64) -> Result<Option<String>> {
        let token = uuid::Uuid::new_v4().to_string();
        let empty = ListenState::default().to_js().to_json();
        let claimed = self.query_opt(
            "insert into lf.listen_state (team_id, pipeline, state, lease_token, lease_until)
             values ($1::text::uuid, $2::text, $3::text::jsonb, $4::text::uuid, now() + $5::int8 * interval '1 millisecond')
             on conflict (team_id, pipeline) do update set lease_token = excluded.lease_token, lease_until = excluded.lease_until
             where lf.listen_state.lease_until is null or lf.listen_state.lease_until < now()
             returning pipeline",
            &[&self.tenant, &pipeline, &empty, &token, &ttl_ms],
        )?;
        Ok(claimed.map(|_| token))
    }
    /// The resolution replaces the state but for `paused`, read in the same
    /// statement.
    fn save_listen_resolution(&self, pipeline: &str, token: &str, resolution: &Resolution) -> Result<bool> {
        let text = resolution.to_js().to_json();
        let saved = self.execute(
            "update lf.listen_state set state = $3::text::jsonb || jsonb_build_object('paused', state->'paused'), lease_token = null, lease_until = null, updated_at = now()
             where team_id = $1::text::uuid and pipeline = $2::text and lease_token = $4::text::uuid",
            &[&self.tenant, &pipeline, &text, &token],
        )?;
        Ok(saved > 0)
    }
    fn set_listen_paused(&self, pipeline: &str, paused: Option<&str>) -> Result<()> {
        let fresh = ListenState { paused: paused.map(str::to_string), ..Default::default() }.to_js().to_json();
        self.execute(
            "insert into lf.listen_state (team_id, pipeline, state) values ($1::text::uuid, $2::text, $3::text::jsonb)
             on conflict (team_id, pipeline) do update set state = lf.listen_state.state || jsonb_build_object('paused', $4::text), updated_at = now()",
            &[&self.tenant, &pipeline, &fresh, &paused],
        )?;
        Ok(())
    }

    /// The receipt first: a duplicate (its external id kept at its
    /// subscription before, even by a transaction still open, which the
    /// unique index waits on) writes nothing.
    fn keep_delivery(
        &self,
        subscription_id: &str,
        checkpoint: Option<&Js>,
        delivery: &NewDelivery,
        work: &[NewWork],
        arrivals: Option<&DeliveryArrivals<'_>>,
        waits: &[DeliveryWait],
    ) -> Result<Option<KeptDelivery>> {
        let events = Js::Arr(delivery.events.clone()).to_json();
        let event_count = i64::try_from(delivery.events.len()).unwrap_or(i64::MAX);
        self.transaction(|| {
            let inserted = self.query_opt(
                "insert into lf.delivery (id, team_id, subscription_id, external_id, received_at, source, inline, replay_of, events, event_count)
                 values ($1::text::uuid, $2::text::uuid, $3::text, $4::text, $5::text::timestamptz, $6::text, $7::bool, $8::text::uuid, $9::text::jsonb, $10::int8)
                 on conflict do nothing returning id",
                &[
                    &delivery.id,
                    &self.tenant,
                    &subscription_id,
                    &delivery.external_id,
                    &delivery.received_at,
                    &delivery.source.wire(),
                    &delivery.inline,
                    &delivery.replay_of,
                    &events,
                    &event_count,
                ],
            )?;
            if inserted.is_none() {
                return Ok(None);
            }
            if let Some(checkpoint) = checkpoint {
                self.save_inbound_checkpoint(subscription_id, checkpoint)?;
            }
            let mark = self.arrival_mark()?;
            let (work, wakes) = match arrivals {
                None => (work.to_vec(), Vec::new()),
                Some(a) => {
                    self.open_delivery_waits(a.team_id, a.adapter_type, waits, mark)?;
                    let logged = self.log_arrivals_unwrapped(a)?;
                    delivery_rows(work, mark, a.team_id, &logged.wakes)
                }
            };
            for row in work.iter().chain(&wakes) {
                self.enqueue_row(&row.kind, &row.key, &row.payload, row.due_at.as_deref(), row.team_id.as_deref().unwrap_or(&self.tenant))?;
            }
            Ok(Some(KeptDelivery { wakes, arrival_mark: mark }))
        })
    }

    fn forget_delivery_id(&self, id: &str) -> Result<()> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Ok(());
        }
        self.execute("update lf.delivery set external_id = null where id = $1::text::uuid and team_id = $2::text::uuid", &[&id, &self.tenant])?;
        Ok(())
    }

    fn deliveries(&self, query: &DeliveryQuery<'_>) -> Result<Vec<DeliveryRow>> {
        self.query(
            &format!(
                "select {DELIVERY_COLUMNS} from lf.delivery
                 where team_id = $1::text::uuid and ($2::text is null or subscription_id = $2::text) and ($3::text is null or received_at >= $3::text::timestamptz)
                 order by received_at desc, id desc limit $4::int8"
            ),
            &[&self.tenant, &query.subscription_id, &query.since, &query.limit],
        )?
        .iter()
        .map(|row| self.delivery_of(row, None))
        .collect()
    }

    fn delivery(&self, id: &str) -> Result<Option<DeliveryRow>> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Ok(None);
        }
        let Some(row) = self.query_opt(
            &format!("select {DELIVERY_COLUMNS}, events::text from lf.delivery where id = $1::text::uuid and team_id = $2::text::uuid"),
            &[&id, &self.tenant],
        )?
        else {
            return Ok(None);
        };
        let events = match parse_text(row.get(8))? {
            Js::Arr(events) => events,
            _ => return Err(StoreError::Invalid(format!("delivery {id}'s events are not a list"))),
        };
        self.delivery_of(&row, Some(events)).map(Some)
    }

    fn sweep_deliveries(&self, before: &str, limit: i64) -> Result<i64> {
        let swept = self.execute(
            "delete from lf.delivery where id in (
               select d.id from lf.delivery d
               where d.team_id = $1::text::uuid and d.received_at < $2::text::timestamptz
                 and not exists (select 1 from lf.trigger_run r where r.team_id = d.team_id and r.delivery_id = d.id and r.status in ('running', 'parked'))
                 and not exists (select 1 from lf.work w where w.team_id = d.team_id and w.kind = 'fire_event' and w.payload->>'deliveryId' = d.id::text)
               order by d.received_at limit $3::int8)",
            &[&self.tenant, &before, &limit],
        )?;
        Ok(i64::try_from(swept).unwrap_or(i64::MAX))
    }

    fn module_processes(&self) -> Result<crate::backend::ModuleProcesses> {
        let row = self.query_opt("select processes::text, version from lf.module_processes where team_id = $1::text::uuid", &[&self.tenant])?;
        Ok(match row {
            None => crate::backend::ModuleProcesses { processes: Js::Arr(Vec::new()), version: 0 },
            Some(row) => crate::backend::ModuleProcesses { processes: parse_text(row.get(0))?, version: row.get(1) },
        })
    }
    fn swap_module_processes(&self, version: i64, processes: &Js) -> Result<bool> {
        let text = processes.to_json();
        let written = if version == 0 {
            self.execute(
                "insert into lf.module_processes (team_id, processes, version) values ($1::text::uuid, $2::text::jsonb, 1) on conflict (team_id) do nothing",
                &[&self.tenant, &text],
            )?
        } else {
            self.execute(
                "update lf.module_processes set processes = $2::text::jsonb, version = version + 1, updated_at = now() where team_id = $1::text::uuid and version = $3",
                &[&self.tenant, &text, &version],
            )?
        };
        Ok(written == 1)
    }

    fn claim_event(&self, listen: &str, key: &str) -> Result<bool> {
        let inserted = self.execute(
            "insert into lf.event_receipt (team_id, listen, key) values ($1::text::uuid, $2::text, $3::text) on conflict do nothing",
            &[&self.tenant, &listen, &key],
        )?;
        Ok(inserted == 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_completed_run_is_the_hosted_products_success() {
        assert_eq!(hosted_status("completed"), "success");
        assert_eq!(hosted_status("parked"), "parked");
        assert_eq!(lf_status("success".into()), "completed");
        assert_eq!(lf_status("failed".into()), "failed");
    }

    #[test]
    fn a_work_claim_is_the_hosted_backends_handle() {
        let (token, version) = work_claim(r#"{"leaseToken":"t","claimedUpdatedAt":"2026-10-17T00:00:00.000Z"}"#).unwrap();
        assert_eq!((token.as_str(), version.as_str()), ("t", "2026-10-17T00:00:00.000Z"));
        assert!(work_claim("t/3").is_err());
    }

    /// Migration 10 over a database that holds the retired kinds of work:
    /// run again after its record is forgotten, as a 0.12 database meets it.
    /// Needs LF_TEST_PG to name a database to set up and write into.
    #[test]
    fn migration_10_drops_the_retired_work_rows() {
        let Some(url) = std::env::var("LF_TEST_PG").ok().filter(|u| !u.is_empty()) else { return };
        PgStore::migrate(&url).unwrap();
        let store = PgStore::connect(&url, crate::backend::POSTGRES_TENANT).unwrap();
        let tag = uuid::Uuid::new_v4().to_string();
        let keys = [("fire_callback", "{}", format!("legacy-fire:{tag}")), ("wake_await", r#"{"correlationKey":"k"}"#, format!("legacy-wake:{tag}")), ("wake_await", r#"{"waitId":"w1","runId":"r","address":"s1"}"#, format!("wait-wake:{tag}"))];
        for (kind, payload, key) in &keys {
            store.execute("insert into lf.work (kind, key, payload) values ($1, $2, $3::text::jsonb)", &[kind, key, payload]).unwrap();
        }
        store.execute("delete from lf.schema_migration where version = 10", &[]).unwrap();
        assert_eq!(PgStore::migrate(&url).unwrap(), [10]);
        let left: Vec<String> = store.query("select key from lf.work where key like '%' || $1", &[&tag]).unwrap().iter().map(|r| r.get(0)).collect();
        assert_eq!(left, [format!("wait-wake:{tag}")]);
        store.execute("delete from lf.work where key like '%' || $1", &[&tag]).unwrap();
    }

    #[test]
    fn block_on_runs_a_future_to_its_end() {
        assert_eq!(block_on(async { 41 + 1 }), 42);
    }
}

//! `listen-fire --contract-store <state.db|postgres://…>`: the run host's backend
//! families (crate::backend) served as a store module: the store slot's
//! methods (docs/contracts/store-slot.md) as adapter protocol 2 calls over
//! HTTP on a Unix socket (crate::slot_server), so the TypeScript contract
//! suite drives this store through its `RpcStoreBackend` (movement-engine
//! `services/run_host/rpc_store.ts`) and
//! holds it to the meaning every backend has. `--contract-store-slot` serves
//! the project's store slot instead, a store module's process included.
//!
//! A method is `<family>.<method>` as `RunHostStore` names it
//! (`parks.putLeaf`, `work.claimDue`, …), its params the TypeScript method's
//! one input object, its result the TypeScript method's answer (`null` for
//! none). The run records are `records.<method>` as `RunRecords` names them.
//! `runs.start` adds a run row, the contract's `newRun`; `runs.requestCancel`,
//! `runs.status` and `runs.complete` are the records backend's
//! `requestCancel`, `runStatus` and `completeRun`. A fenced write
//! refused because the lease is gone answers the error code
//! `run_lease_lost` (`data: { runId }`), which the client rethrows as the
//! core's `RunLeaseLost`. Requests are answered one at a time.

use crate::backend::{RunHostStore, StoreSpec, open_store};
use crate::json::Js;
use crate::obj;
use crate::slot_server::{Listen, Refusal};
use crate::store::{ClaimDue, DeliveryQuery, EventReceipt, HeldJoin, HeldPark, HeldRace, NewWork, Park, Release, Rerun, RunSettle, RunStart, SegmentCommit, StoreError, iso};
use crate::store_wire::{Wire, new_delivery, num, opt, park_kind, rows, to_rows};
use crate::waits::{DeliveryArrivals, DeliveryWait, NewArrival, Noted, OpenWait, StrandedAfter, StrandedOf};

/// The store slot's methods (docs/contracts/store-slot.md), as its manifest lists them.
pub const STORE_METHODS: &[&str] = &[
    "store.open", "runs.start", "runs.requestCancel", "runs.status", "runs.complete", "runs.settle", "runs.markParked", "runs.get",
    "runs.list", "runs.appendTrace", "runs.traceLength", "runs.spent", "runs.addSpend", "runs.resetSpendBaseline", "records.cancelRequest",
    "records.markFailed", "parks.putLeaf", "parks.claimLeaf", "parks.finishLeaf", "parks.leaves", "parks.deleteLeaves", "parks.commitSegment", "parks.owedRaces",
    "joins.recordJoin", "joins.decrementJoin", "joins.persistBranchExport", "joins.collectBranchExports", "joins.hasPendingJoins",
    "joins.frames", "joins.deleteFrames", "leases.claim", "leases.renew", "leases.release", "leases.dropRunState", "work.enqueue", "work.claimDue",
    "work.complete", "work.release", "sources.put", "sources.get", "inbound.checkpoint", "inbound.saveCheckpoint", "listens.states", "listens.claimResolve", "listens.saveResolution", "listens.setPaused", "listens.hold", "writes.record", "writes.depth", "processes.list",
    "processes.swap", "events.claim", "events.startRun", "runs.lapsed", "parks.commit", "work.bury", "inbound.keepDelivery",
    "inbound.deliveries", "inbound.delivery", "inbound.sweepDeliveries", "inbound.forgetDeliveryId", "work.enqueueIfAbsent", "work.completeKey",
    "runs.rerun", "waits.mark", "waits.log", "waits.open", "waits.arrivals", "waits.note", "waits.sweep", "waits.stranded",
    "runs.failed", "releases.note", "releases.list",
];

pub async fn serve(spec: &StoreSpec, listen: Listen) -> Result<(), String> {
    // The bridge stands in for a set-up store: a Postgres one's setup
    // (`listen-fire connect @lf/postgres-store`) is run first.
    #[cfg(feature = "postgres")]
    if let StoreSpec::Postgres { url, .. } = spec {
        crate::pg_store::PgStore::migrate(url).map_err(|e| format!("{}: {e}", spec.display()))?;
    }
    let store = open_store(spec)?;
    let manifest = crate::slot_server::manifest("@lf/contract-store", "store", STORE_METHODS);
    crate::slot_server::serve(listen, manifest, move |method, params, _settings| answer(&*store, method, params)).await
}

fn answer(store: &dyn RunHostStore, method: &str, params: &Js) -> Result<Js, Refusal> {
    match dispatch(store, method, &Params(params)) {
        Ok(result) => Ok(result),
        Err(Failure::Store(StoreError::LeaseLost { run_id })) => Err(Refusal {
            code: crate::store_module::LEASE_LOST.into(),
            message: "run lease lost; another instance may hold the run".into(),
            data: Some(Js::from(obj! { "runId" => Js::str(run_id) })),
        }),
        Err(Failure::Store(other)) => Err(Refusal::failed(describe(&other))),
        Err(Failure::Params(message)) => Err(Refusal::bad_request(format!("{method}: {message}"))),
        Err(Failure::Unknown) => Err(Refusal::unknown(method)),
    }
}

fn describe(error: &StoreError) -> String {
    match error {
        StoreError::LeaseLost { run_id } => format!("run lease lost: {run_id}"),
        StoreError::Invalid(message) => message.clone(),
        StoreError::Db(error) => error.to_string(),
        StoreError::Backend(message) => message.clone(),
    }
}

enum Failure {
    Store(StoreError),
    Params(String),
    Unknown,
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Failure::Store(error)
    }
}

/// One request's input object.
struct Params<'a>(&'a Js);

impl Params<'_> {
    fn str(&self, key: &str) -> Result<&str, Failure> {
        self.0.get(key).and_then(Js::as_str).ok_or_else(|| Failure::Params(format!("{key}: expected a string")))
    }

    /// An optional string; `null` reads as absent.
    fn opt_str(&self, key: &str) -> Result<Option<&str>, Failure> {
        match self.0.get(key) {
            None | Some(Js::Null) => Ok(None),
            Some(Js::Str(s)) => Ok(Some(s)),
            Some(_) => Err(Failure::Params(format!("{key}: expected a string"))),
        }
    }

    /// An optional list of strings; `null` reads as absent.
    fn opt_strings(&self, key: &str) -> Result<Option<Vec<String>>, Failure> {
        match self.0.get(key) {
            None | Some(Js::Null) => Ok(None),
            Some(Js::Arr(items)) => items.iter().map(|i| i.as_str().map(str::to_string)).collect::<Option<Vec<_>>>().map(Some).ok_or_else(|| Failure::Params(format!("{key}: expected a list of strings"))),
            Some(_) => Err(Failure::Params(format!("{key}: expected a list of strings"))),
        }
    }

    fn opt_int(&self, key: &str) -> Result<Option<i64>, Failure> {
        match self.0.get(key) {
            None | Some(Js::Null) => Ok(None),
            Some(value) => crate::store_wire::int(value).map(Some).ok_or_else(|| Failure::Params(format!("{key}: expected an integer"))),
        }
    }

    fn int(&self, key: &str) -> Result<i64, Failure> {
        self.0.get(key).and_then(crate::store_wire::int).ok_or_else(|| Failure::Params(format!("{key}: expected an integer")))
    }

    fn number(&self, key: &str) -> Result<f64, Failure> {
        match self.0.get(key) {
            Some(Js::Num(n)) => n.as_f64(),
            _ => None,
        }
        .ok_or_else(|| Failure::Params(format!("{key}: expected a number")))
    }

    fn flag(&self, key: &str) -> bool {
        Js::is_true(self.0.get(key))
    }

    /// A JSON value; absent (`undefined`) is stored as `null`, as `x ?? null`.
    fn value(&self, key: &str) -> Js {
        self.0.get(key).cloned().unwrap_or(Js::Null)
    }

    /// `runs.start`'s run, as `events.startRun` carries it too.
    fn run_start(&self) -> Result<RunStart<'_>, Failure> {
        Ok(RunStart {
            id: self.str("id")?,
            file: self.str("file")?,
            movement: self.str("movement")?,
            started_at: self.str("startedAt")?,
            input: self.str("input")?,
            delivery_id: self.opt_str("deliveryId")?,
            team_id: self.opt_str("teamId")?,
        })
    }

    fn receipt(&self) -> Result<EventReceipt<'_>, Failure> {
        Ok(EventReceipt { team_id: self.opt_str("teamId")?, listen: self.str("listen")?, key: self.str("key")? })
    }

    fn strings(&self, key: &str) -> Result<Vec<String>, Failure> {
        self.0
            .get(key)
            .and_then(Js::as_array)
            .and_then(|items| items.iter().map(|i| i.as_str().map(str::to_string)).collect::<Option<Vec<_>>>())
            .ok_or_else(|| Failure::Params(format!("{key}: expected an array of strings")))
    }
}

/// `parks.commitSegment`'s `settle`, when it is one.
fn run_settle(value: &Js) -> Option<RunSettle<'_>> {
    Some(RunSettle { status: value.get("status")?.as_str()?, outcome: value.get("outcome")?, at: value.get("at")?.as_str()? })
}

fn dispatch(store: &dyn RunHostStore, method: &str, p: &Params) -> Result<Js, Failure> {
    let none = Ok(Js::Null);
    match method {
        // The store wire's opening request: a store module reads its
        // settings from it; this bridge's store is named on its command line.
        "store.open" => Ok(Js::from(obj! { "tenant" => Js::str(store.tenant()) })),

        "runs.start" => {
            store.start_run(&p.run_start()?)?;
            none
        }
        "runs.requestCancel" => {
            store.request_cancel(p.str("runId")?, p.opt_str("reason")?)?;
            none
        }
        "runs.status" => Ok(store.run(p.str("runId")?)?.map(|r| Js::str(r.status)).unwrap_or(Js::str("missing"))),
        "runs.complete" => {
            store.settle_run(p.str("runId")?, "completed", &Js::Null, &iso(0))?;
            none
        }
        "runs.settle" => {
            store.settle_run(p.str("runId")?, p.str("status")?, &p.value("outcome"), p.str("at")?)?;
            none
        }
        "runs.rerun" => {
            let rerun = Rerun { input: p.str("input")?, at: p.str("at")?, fence: p.str("fence")? };
            Ok(match store.rerun_run(p.str("runId")?, &rerun)? {
                Some(attempt) => Js::from(obj! { "attempt" => Js::Num(attempt.into()) }),
                None => Js::Null,
            })
        }
        "runs.markParked" => {
            store.mark_parked(p.str("runId")?)?;
            none
        }
        "runs.get" => Ok(store.run(p.str("runId")?)?.as_ref().map(Wire::to_wire).unwrap_or(Js::Null)),
        "runs.list" => Ok(to_rows(&store.runs(p.int("limit")?)?)),
        "runs.appendTrace" => {
            let entries = p.value("entries");
            let entries = entries.as_array().ok_or_else(|| Failure::Params("entries: expected an array".into()))?;
            store.append_trace(p.str("runId")?, p.str("segmentId")?, entries)?;
            none
        }
        "runs.lapsed" => Ok(Js::strings(store.lapsed_runs(p.int("staleMs")?, p.int("limit")?)?)),
        "runs.traceLength" => Ok(Js::Num(store.trace_len(p.str("runId")?)?.into())),
        "runs.spent" => Ok(num(store.run_spent(p.str("runId")?)?)),
        "runs.addSpend" => {
            store.add_run_spend(p.str("runId")?, p.number("microdollars")?)?;
            none
        }
        "runs.resetSpendBaseline" => {
            store.reset_spend_baseline(p.str("runId")?)?;
            none
        }

        "records.cancelRequest" => Ok(match store.cancel_request(p.str("runId")?)? {
            None => Js::Null,
            Some(reason) => Js::from(obj! { "reason" => opt(reason.as_deref()) }),
        }),
        "records.markFailed" => {
            store.mark_failed(p.str("runId")?, p.str("message")?)?;
            none
        }
        "parks.putLeaf" => {
            store.put_leaf(p.str("runId")?, p.str("address")?, p.str("reason")?, p.opt_str("wakeAt")?, &p.value("state"), p.opt_str("fence")?)?;
            none
        }
        "parks.commit" => {
            let (state, kind) = (p.value("state"), p.value("park"));
            let kind = park_kind(&kind).ok_or_else(|| Failure::Params("park: expected { kind: timer | await | wait | limit, … }".into()))?;
            store.commit_park(&Park { run_id: p.str("runId")?, address: p.str("address")?, state: &state, fence: p.opt_str("fence")?, kind })?;
            none
        }
        "parks.commitSegment" => {
            let (joins, parks) = (p.value("joins"), p.value("parks"));
            let joins = joins
                .as_array()
                .and_then(|joins| {
                    joins.iter().map(|join| Some(HeldJoin { frame_address: join.get("frameAddress")?.as_str()?, pending: join.get("pending").and_then(crate::store_wire::int)? })).collect::<Option<Vec<_>>>()
                })
                .ok_or_else(|| Failure::Params("joins: expected a list of { frameAddress, pending }".into()))?;
            let parks = parks
                .as_array()
                .and_then(|parks| {
                    parks.iter().map(|park| Some(HeldPark { address: park.get("address")?.as_str()?, state: park.get("state")?, kind: park_kind(park.get("park")?)? })).collect::<Option<Vec<_>>>()
                })
                .ok_or_else(|| Failure::Params("parks: expected a list of { address, state, park: { kind: timer | await | wait | limit, … } }".into()))?;
            let settle = p.value("settle");
            let settle = match &settle {
                Js::Null => None,
                settle => Some(run_settle(settle).ok_or_else(|| Failure::Params("settle: expected null or { status, outcome, at }".into()))?),
            };
            // Absent: a caller from before races were owed in it.
            let owed_races = p.value("owedRaces");
            let owed_races = match &owed_races {
                Js::Null => Vec::new(),
                owed => owed
                    .as_array()
                    .and_then(|owed| owed.iter().map(|race| Some(HeldRace { frame_address: race.get("frameAddress")?.as_str()?, state: race.get("state")? })).collect::<Option<Vec<_>>>())
                    .ok_or_else(|| Failure::Params("owedRaces: expected a list of { frameAddress, state }".into()))?,
            };
            let commit = SegmentCommit {
                run_id: p.str("runId")?,
                team_id: p.str("teamId")?,
                fence: p.opt_str("fence")?,
                resumed: p.opt_str("resumed")?,
                joins,
                parks,
                settle,
                owed_races,
                settled_race: p.opt_str("settledRace")?,
            };
            Ok(to_rows(&store.commit_segment(&commit)?))
        }
        "parks.owedRaces" => Ok(Js::Arr(
            store
                .owed_races(p.str("runId")?)?
                .into_iter()
                .map(|race| Js::Obj(obj! { "frameAddress" => Js::str(race.frame_address), "state" => race.state }))
                .collect(),
        )),
        "parks.claimLeaf" => Ok(match store.claim_leaf(p.str("runId")?, p.str("address")?, p.opt_str("reason")?)? {
            None => Js::Null,
            Some((reason, state)) => Js::from(obj! { "reason" => Js::str(reason), "state" => state }),
        }),
        "parks.finishLeaf" => {
            store.finish_leaf(p.str("runId")?, p.str("address")?, p.opt_str("fence")?)?;
            none
        }
        "parks.leaves" => Ok(to_rows(&store.leaves(p.str("runId")?, p.flag("parkedOnly"), p.opt_str("reason")?, p.opt_str("dueBy")?)?)),
        "parks.deleteLeaves" => {
            store.delete_leaves(p.str("runId")?, &p.strings("addresses")?)?;
            none
        }

        "joins.recordJoin" => {
            store.record_join(p.str("runId")?, p.str("frameAddress")?, p.int("pending")?, p.opt_str("fence")?)?;
            none
        }
        "joins.decrementJoin" => {
            let closed = store.decrement_join(p.str("runId")?, p.str("frameAddress")?, p.str("branchAddress")?, p.str("leafAddress")?)?;
            Ok(Js::from(obj! { "closed" => Js::Bool(closed) }))
        }
        "joins.persistBranchExport" => {
            store.persist_branch_export(p.str("runId")?, p.str("frameAddress")?, p.str("branchAddress")?, p.int("branchIndex")?, &p.value("exports"))?;
            none
        }
        "joins.collectBranchExports" => Ok(to_rows(&store.collect_branch_exports(p.str("runId")?, p.str("frameAddress")?)?)),
        "joins.hasPendingJoins" => Ok(Js::Bool(store.has_pending_joins(p.str("runId")?)?)),
        "joins.frames" => Ok(Js::strings(store.frames(p.str("runId")?)?)),
        "joins.deleteFrames" => {
            store.delete_frames(p.str("runId")?, &p.strings("frameAddresses")?)?;
            none
        }

        "waits.mark" => Ok(Js::Num(store.arrival_mark()?.into())),
        "waits.log" => {
            let arrivals: Vec<NewArrival> =
                rows(&p.value("arrivals")).ok_or_else(|| Failure::Params("arrivals: expected a list of { edge, key, identity, version, landing, gone }".into()))?;
            let log = DeliveryArrivals { team_id: p.str("teamId")?, adapter_type: p.str("adapterType")?, arrivals: &arrivals, at: p.str("at")?, resend_window_ms: p.int("resendWindowMs")? };
            Ok(store.log_arrivals(&log)?.to_wire())
        }
        "waits.open" => {
            let wait = OpenWait {
                run_id: p.str("runId")?,
                team_id: p.str("teamId")?,
                adapter_type: p.str("adapterType")?,
                edge: p.str("edge")?,
                key: p.opt_str("key")?,
                record_id: p.opt_str("recordId")?,
                since: p.int("since")?,
            };
            Ok(Js::from(obj! { "waitId" => Js::str(store.open_wait(&wait)?) }))
        }
        "waits.arrivals" => Ok(store.wait_arrivals(p.str("waitId")?)?.to_wire()),
        "waits.stranded" => {
            let after = p.value("after");
            let of = match p.opt_str("runId")? {
                Some(run_id) => StrandedOf::Run(run_id),
                None => {
                    let after = match &after {
                        Js::Null => None,
                        after => Some(StrandedAfter {
                            at: after.get("at").and_then(Js::as_str).ok_or_else(|| Failure::Params("after.at: expected a string".into()))?,
                            wait_id: after.get("waitId").and_then(Js::as_str).ok_or_else(|| Failure::Params("after.waitId: expected a string".into()))?,
                        }),
                    };
                    StrandedOf::Page { after, limit: p.int("limit")? }
                }
            };
            Ok(to_rows(&store.stranded_waits(&of)?))
        }
        "waits.note" => {
            let noted = Noted {
                wait_id: p.str("waitId")?,
                identity: p.str("identity")?,
                version: p.opt_str("version")?,
                matched: p.flag("matched"),
                leaf: p.opt_str("leaf")?,
                fence: p.opt_str("fence")?,
            };
            Ok(Js::Bool(store.note_arrival(&noted)?))
        }
        "waits.sweep" => Ok(Js::from(obj! { "swept" => Js::Num(store.sweep_arrivals(p.int("limit")?, p.opt_int("floor")?)?.into()) })),

        "leases.claim" => Ok(match store.claim_lease(p.str("runId")?, p.int("ttlMs")?)? {
            None => Js::Null,
            Some(token) => Js::from(obj! { "token" => Js::str(token) }),
        }),
        "leases.renew" => Ok(Js::Bool(store.renew_lease(p.str("runId")?, p.str("token")?, p.int("ttlMs")?)?)),
        "leases.release" => {
            store.release_lease(p.str("runId")?, p.str("token")?)?;
            none
        }
        "leases.dropRunState" => Ok(Js::Bool(store.drop_run_state(p.str("runId")?, p.opt_str("fence")?)?)),

        "work.enqueue" => {
            store.enqueue(p.str("kind")?, p.str("key")?, &p.value("payload"), p.opt_str("dueAt")?, p.opt_str("teamId")?)?;
            none
        }
        "work.enqueueIfAbsent" => Ok(Js::Bool(store.enqueue_if_absent(p.str("kind")?, p.str("key")?, &p.value("payload"), p.opt_str("dueAt")?, p.opt_str("teamId")?)?)),
        "work.claimDue" => {
            let kinds = p.opt_strings("kinds")?;
            let claim = ClaimDue { limit: p.int("limit")?, lease_ms: p.int("leaseMs")?, due_by: p.opt_str("dueBy")?, kinds: kinds.as_deref() };
            Ok(to_rows(&store.claim_due(&claim)?))
        }
        "work.complete" => {
            store.complete(p.str("id")?, p.str("claim")?)?;
            none
        }
        "work.completeKey" => Ok(Js::Bool(store.complete_key(p.str("key")?)?)),
        "work.release" => {
            store.release_work(p.str("id")?, p.str("claim")?, p.opt_str("dueAt")?, Release::of_wire(p.opt_str("why")?)?)?;
            none
        }
        "work.bury" => {
            store.bury_work(p.str("id")?, p.str("claim")?, p.str("reason")?)?;
            none
        }

        "sources.put" => {
            store.put_source(p.str("teamId")?, p.str("hash")?, p.str("source")?)?;
            none
        }
        "sources.get" => Ok(opt(store.get_source(p.str("teamId")?, p.str("hash")?)?.as_deref())),

        "inbound.checkpoint" => Ok(match store.inbound_checkpoint(p.str("subscriptionId")?)? {
            None => Js::Null,
            Some(checkpoint) => Js::from(obj! { "checkpoint" => checkpoint }),
        }),
        "inbound.keepDelivery" => {
            let delivery = new_delivery(&p.value("delivery"))
                .ok_or_else(|| Failure::Params("delivery: expected { id, externalId?, receivedAt, source, inline, replayOf?, events }".into()))?;
            let work: Vec<NewWork> = rows(&p.value("work")).ok_or_else(|| Failure::Params("work: expected a list of { kind, key, payload, dueAt, teamId }".into()))?;
            let arrivals = match p.0.get("arrivals") {
                None => None,
                Some(given) => {
                    let text = |key: &str| given.get(key).and_then(Js::as_str).ok_or_else(|| Failure::Params(format!("arrivals.{key}: expected a text")));
                    let list: Vec<NewArrival> = rows(given.get("arrivals").unwrap_or(&Js::Null))
                        .ok_or_else(|| Failure::Params("arrivals.arrivals: expected a list of { edge, key, identity, version, landing, gone }".into()))?;
                    let window = given.get("resendWindowMs").and_then(crate::store_wire::int).ok_or_else(|| Failure::Params("arrivals.resendWindowMs: expected a whole number".into()))?;
                    Some((text("teamId")?.to_string(), text("adapterType")?.to_string(), list, text("at")?.to_string(), window))
                }
            };
            let logged = arrivals.as_ref().map(|(team_id, adapter_type, arrivals, at, resend_window_ms)| DeliveryArrivals {
                team_id,
                adapter_type,
                arrivals,
                at,
                resend_window_ms: *resend_window_ms,
            });
            let waits: Vec<DeliveryWait> = match p.0.get("waits") {
                None => Vec::new(),
                Some(given) => rows(given).ok_or_else(|| Failure::Params("waits: expected a list of { runId, edge, key, fireKey, preNoted? }".into()))?,
            };
            let Some(kept) = store.keep_delivery(p.str("subscriptionId")?, p.0.get("checkpoint"), &delivery, &work, logged.as_ref(), &waits)? else {
                return Ok(Js::from(obj! { "kept" => Js::Bool(false) }));
            };
            let mut answer = obj! { "kept" => Js::Bool(true), "arrivalMark" => Js::Num(kept.arrival_mark.into()) };
            if logged.is_some() {
                answer.insert("wakes".into(), to_rows(&kept.wakes));
            }
            Ok(Js::from(answer))
        }
        "inbound.deliveries" => {
            let query = DeliveryQuery { subscription_id: p.opt_str("subscriptionId")?, since: p.opt_str("since")?, limit: p.int("limit")? };
            Ok(to_rows(&store.deliveries(&query)?))
        }
        "inbound.delivery" => Ok(store.delivery(p.str("id")?)?.as_ref().map(Wire::to_wire).unwrap_or(Js::Null)),
        "inbound.sweepDeliveries" => Ok(Js::Num(store.sweep_deliveries(p.str("before")?, p.int("limit")?)?.into())),
        "inbound.forgetDeliveryId" => {
            store.forget_delivery_id(p.str("id")?)?;
            none
        }
        "inbound.saveCheckpoint" => {
            store.save_inbound_checkpoint(p.str("subscriptionId")?, &p.value("checkpoint"))?;
            none
        }

        "listens.states" => {
            let states = store.listen_states(&p.strings("pipelines")?)?;
            Ok(Js::Obj(states.into_iter().map(|(pipeline, state)| (pipeline, state.to_js())).collect()))
        }
        "listens.claimResolve" => Ok(store.claim_listen_resolve(p.str("pipeline")?, p.int("ttlMs")?)?.map(|token| Js::Obj(obj! { "token" => Js::Str(token) })).unwrap_or(Js::Null)),
        "listens.saveResolution" => {
            let resolution = crate::resolve::Resolution::from_js(&p.value("resolution"))
                .ok_or_else(|| Failure::Params("resolution: expected { heads, resolvedAt, failure }".into()))?;
            Ok(Js::Bool(store.save_listen_resolution(p.str("pipeline")?, p.str("token")?, &resolution)?))
        }
        "listens.setPaused" => {
            store.set_listen_paused(p.str("pipeline")?, p.opt_str("paused")?)?;
            none
        }
        "listens.hold" => {
            store.hold_listen_arrival(p.str("pipeline")?)?;
            none
        }

        "writes.record" => {
            let depth = u32::try_from(p.int("depth")?).map_err(|_| Failure::Params("depth: expected a whole number, at least 0".into()))?;
            let write = crate::loop_breaker::LedgerWrite {
                adapter: p.str("adapter")?.to_string(),
                record_type: p.str("recordType")?.to_string(),
                external_id: p.str("externalId")?.to_string(),
                run_id: p.str("runId")?.to_string(),
                depth,
                at: p.str("at")?.to_string(),
            };
            store.ledger_write(&write, p.str("forgetBefore")?)?;
            none
        }
        "writes.depth" => {
            let record = crate::loop_breaker::LedgerRecord { adapter: p.str("adapter")?, record_type: p.str("recordType")?, external_id: p.str("externalId")? };
            Ok(store.deepest_write(&record, p.str("since")?)?.map(|d| Js::Obj(obj! { "runId" => Js::Str(d.run_id), "depth" => Js::Num(d.depth.into()) })).unwrap_or(Js::Null))
        }

        "runs.failed" => {
            let after = match p.value("after") {
                Js::Null => None,
                after => Some((after.get("at").and_then(Js::as_str).map(str::to_string), after.get("runId").and_then(Js::as_str).map(str::to_string))),
            };
            let after = match &after {
                None => None,
                Some((Some(at), Some(run_id))) => Some(crate::records_door::RunAfter { at, run_id }),
                Some(_) => return Err(Failure::Params("after: expected { at, runId }".into())),
            };
            Ok(to_rows(&store.failed_runs(&crate::records_door::FailedPage { after, until: p.str("until")?, limit: p.int("limit")? })?))
        }
        "releases.note" => Ok(Js::Bool(store.note_release(p.str("version")?, p.str("at")?)?)),
        "releases.list" => {
            let after = match p.value("after") {
                Js::Null => None,
                after => Some((after.get("at").and_then(Js::as_str).map(str::to_string), after.get("version").and_then(Js::as_str).map(str::to_string))),
            };
            let after = match &after {
                None => None,
                Some((Some(at), Some(version))) => Some(crate::records_door::ReleaseAfter { at, version }),
                Some(_) => return Err(Failure::Params("after: expected { at, version }".into())),
            };
            let rows = store.releases(after.as_ref(), p.int("limit")?)?;
            Ok(Js::Arr(rows.into_iter().map(|r| Js::Obj(obj! { "version" => Js::Str(r.version), "at" => Js::Str(r.at) })).collect()))
        }

        "processes.list" => {
            let list = store.module_processes()?;
            Ok(Js::from(obj! { "processes" => list.processes, "version" => Js::Num(list.version.into()) }))
        }
        "processes.swap" => Ok(Js::Bool(store.swap_module_processes(p.int("version")?, &p.value("processes"))?)),

        "events.claim" => Ok(Js::Bool(store.claim_event(&p.receipt()?)?)),
        "events.startRun" => Ok(Js::Bool(store.start_event_run(&p.receipt()?, &p.run_start()?)?)),

        _ => Err(Failure::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{DeliverySource, NewDelivery, NewWork, Park, ParkKind, RunStart, Store};
    use crate::store_wire::{delivery_params, event_run_params, int, open_wait_params, park_params, receipt_params};
    use crate::waits::WaitArrivals;

    fn state_file() -> Store {
        let dir = std::env::temp_dir().join(format!("lf-contract-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Store::open(&dir.join("state.db")).unwrap()
    }

    fn call(store: &dyn RunHostStore, method: &str, params: crate::json::Obj) -> Js {
        answer(store, method, &Js::from(params)).unwrap_or_else(|refusal| panic!("{method}: {}", refusal.message))
    }

    /// A delivery's arrivals cross with it, and its wakes come back; a
    /// delivery without them answers as it always has.
    #[test]
    fn a_deliverys_arrivals_cross_the_store_wire() {
        let store = state_file();
        let receipt = |id: &str| obj! { "id" => Js::str(id), "externalId" => Js::str("d-1"), "receivedAt" => Js::str(iso(0)), "source" => Js::str("webhook"), "inline" => Js::Bool(false), "events" => Js::Arr(vec![]) };
        let arrivals = Js::from(obj! {
            "teamId" => Js::str("t"),
            "adapterType" => Js::str("acme"),
            "arrivals" => Js::parse(br#"[{"edge":"Comments","key":"thread:c1","identity":"k1","version":null,"landing":null,"gone":false}]"#).unwrap(),
            "at" => Js::str(iso(0)),
            "resendWindowMs" => Js::Num(3_600_000.into()),
        });
        let params = |id: &str| obj! { "subscriptionId" => Js::str("sub"), "delivery" => Js::from(receipt(id)), "work" => Js::Arr(vec![]), "arrivals" => arrivals.clone() };
        assert_eq!(call(&store, "inbound.keepDelivery", params("11111111-1111-4111-8111-111111111111")).to_json(), r#"{"kept":true,"arrivalMark":0,"wakes":[]}"#);
        assert_eq!(call(&store, "inbound.keepDelivery", params("22222222-2222-4222-8222-222222222222")).to_json(), r#"{"kept":false}"#);
        assert_eq!(call(&store, "waits.mark", obj! {}).to_json(), "1", "logged once");
        let plain = obj! { "subscriptionId" => Js::str("sub"), "delivery" => Js::from(obj! { "id" => Js::str("33333333-3333-4333-8333-333333333333"), "receivedAt" => Js::str(iso(0)), "source" => Js::str("webhook"), "inline" => Js::Bool(false), "events" => Js::Arr(vec![]) }), "work" => Js::Arr(vec![]) };
        assert_eq!(call(&store, "inbound.keepDelivery", plain).to_json(), r#"{"kept":true,"arrivalMark":1}"#);
    }

    /// The write ledger as a store module's client sends it: the deepest
    /// write of a record since an instant, and none past what it forgot.
    #[test]
    fn the_write_ledger_crosses_the_store_wire() {
        let store = state_file();
        let record = |run: &str, depth: i64, at: &str, forget_before: &str| {
            obj! {
                "adapter" => Js::str("acme_crm"),
                "recordType" => Js::str("Company"),
                "externalId" => Js::str("company-1"),
                "runId" => Js::str(run),
                "depth" => Js::Num(depth.into()),
                "at" => Js::str(at),
                "forgetBefore" => Js::str(forget_before),
            }
        };
        let depth = |since: &str| {
            call(&store, "writes.depth", obj! { "adapter" => Js::str("acme_crm"), "recordType" => Js::str("Company"), "externalId" => Js::str("company-1"), "since" => Js::str(since) })
        };
        assert_eq!(call(&store, "writes.record", record("r1", 0, "2026-10-31T10:00:00.000Z", "2026-10-31T09:00:00.000Z")), Js::Null);
        assert_eq!(call(&store, "writes.record", record("r2", 1, "2026-10-31T10:00:05.000Z", "2026-10-31T09:00:00.000Z")), Js::Null);
        assert_eq!(depth("2026-10-31T09:59:50.000Z"), Js::from(obj! { "runId" => Js::str("r2"), "depth" => Js::Num(1.into()) }));
        assert_eq!(depth("2026-10-31T10:00:06.000Z"), Js::Null, "nothing written since");
        let refused = answer(&store, "writes.record", &Js::from(record("r3", -1, "2026-10-31T10:00:06.000Z", "2026-10-31T09:00:00.000Z"))).err().unwrap();
        assert_eq!(refused.message, "writes.record: depth: expected a whole number, at least 0");
        call(&store, "writes.record", record("r3", 0, "2026-10-31T10:01:00.000Z", "2026-10-31T10:00:30.000Z"));
        assert_eq!(depth("2026-10-31T09:59:50.000Z"), Js::from(obj! { "runId" => Js::str("r3"), "depth" => Js::Num(0.into()) }), "the earlier writes are forgotten");
    }

    /// The composite writes as a store module's client sends them
    /// (crate::store_module), served over listen-fire's own store.
    #[test]
    fn the_composite_writes_cross_the_store_wire() {
        let store = state_file();
        let receipt = NewDelivery {
            id: uuid::Uuid::new_v4().to_string(),
            external_id: Some("x-1".into()),
            received_at: iso(0),
            source: DeliverySource::Webhook,
            inline: false,
            replay_of: None,
            events: vec![Js::str("e-1")],
        };
        let run = RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(-120_000), input: "{}", delivery_id: Some(&receipt.id), team_id: None };
        assert_eq!(call(&store, "events.startRun", event_run_params(&EventReceipt::own("listen:f:m", "d-1"), &run)), Js::Bool(true));
        assert_eq!(call(&store, "runs.get", obj! { "runId" => Js::str("run-1") }).get("deliveryId"), Some(&Js::str(&receipt.id)));
        assert_eq!(call(&store, "events.startRun", event_run_params(&EventReceipt::own("listen:f:m", "d-1"), &run)), Js::Bool(false));
        // Another team's receipt of the same listen and key is its own.
        let theirs = EventReceipt { team_id: Some("globex"), ..EventReceipt::own("listen:f:m", "d-1") };
        assert_eq!(call(&store, "events.claim", receipt_params(&theirs)), Js::Bool(true));
        assert_eq!(call(&store, "events.claim", receipt_params(&theirs)), Js::Bool(false));
        assert_eq!(call(&store, "runs.lapsed", obj! { "staleMs" => Js::Num(60_000.into()), "limit" => Js::Num(10.into()) }), Js::strings(["run-1"]));

        let token = store.claim_lease("run-1", 60_000).unwrap().unwrap();
        let wake_at = iso(60_000);
        let park = Park { run_id: "run-1", address: "s1", state: &Js::Null, fence: Some(&token), kind: ParkKind::Timer { wake_at: &wake_at } };
        call(&store, "parks.commit", park_params(&park));
        assert_eq!(store.run("run-1").unwrap().unwrap().status, "parked");
        let lost = Park { fence: Some("gone"), ..park };
        let refused = answer(&store, "parks.commit", &Js::from(park_params(&lost))).err().unwrap();
        assert_eq!(refused.code, crate::store_module::LEASE_LOST);

        let work = NewWork { kind: "wake_await".into(), key: "w".into(), payload: Js::Null, due_at: Some(iso(-1_000)), team_id: None };
        let keep = |checkpoint: &str, delivery: &NewDelivery, work: &[NewWork]| {
            let params = obj! {
                "subscriptionId" => Js::str("sub"),
                "checkpoint" => Js::str(checkpoint),
                "delivery" => Js::from(delivery_params(delivery)),
                "work" => crate::store_wire::to_rows(work),
            };
            call(&store, "inbound.keepDelivery", params)
        };
        let kept = Js::from(obj! { "kept" => Js::Bool(true), "arrivalMark" => Js::Num(0.into()) });
        assert_eq!(keep("c", &receipt, std::slice::from_ref(&work)), kept);
        let again = NewDelivery { id: uuid::Uuid::new_v4().to_string(), ..receipt.clone() };
        let other_row = NewWork { key: "w2".into(), ..work.clone() };
        assert_eq!(keep("c2", &again, &[other_row]), Js::from(obj! { "kept" => Js::Bool(false) }), "a redelivery under the same external id");
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), Some(Js::str("c")));
        let unnamed = NewDelivery { id: uuid::Uuid::new_v4().to_string(), external_id: Some("x-2".into()), ..receipt.clone() };
        assert_eq!(keep("c", &unnamed, &[]), kept);
        assert_eq!(call(&store, "inbound.forgetDeliveryId", obj! { "id" => Js::str(&unnamed.id) }), Js::Null);
        assert_eq!(store.delivery(&unnamed.id).unwrap().unwrap().external_id, None, "a failed inline delivery's retry is its own");
        let kept = call(&store, "inbound.delivery", obj! { "id" => Js::str(&receipt.id) });
        assert_eq!(kept.get("events"), Some(&Js::Arr(vec![Js::str("e-1")])));
        assert_eq!(kept.get("runs").and_then(|r| r.as_array()).map(<[Js]>::len), Some(1));
        let listed = call(&store, "inbound.deliveries", obj! { "subscriptionId" => Js::str("sub"), "since" => Js::Null, "limit" => Js::Num(10.into()) });
        assert_eq!(listed.as_array().map(<[Js]>::len), Some(2));
        assert_eq!(listed.as_array().unwrap()[0].get("events"), None, "a listing carries no events");
        let claimed = call(&store, "work.claimDue", obj! { "limit" => Js::Num(10.into()), "leaseMs" => Js::Num(60_000.into()), "kinds" => Js::strings(["wake_await"]) });
        let row = claimed.as_array().unwrap()[0].clone();
        assert_eq!(row.get("attempts"), Some(&Js::Num(1.into())));
        let (id, claim) = (row.get("id").unwrap().clone(), row.get("claim").unwrap().clone());
        call(&store, "work.release", obj! { "id" => id.clone(), "claim" => claim, "dueAt" => Js::str(iso(-1_000)), "why" => Js::str("busy") });
        let again = call(&store, "work.claimDue", obj! { "limit" => Js::Num(10.into()), "leaseMs" => Js::Num(60_000.into()), "kinds" => Js::strings(["wake_await"]) });
        let row = again.as_array().unwrap()[0].clone();
        assert_eq!(row.get("attempts"), Some(&Js::Num(1.into())), "a busy release gave its attempt back");
        call(&store, "work.bury", obj! { "id" => id, "claim" => row.get("claim").unwrap().clone(), "reason" => Js::str("gave up") });
        assert_eq!(call(&store, "work.claimDue", obj! { "limit" => Js::Num(10.into()), "leaseMs" => Js::Num(60_000.into()) }), Js::Arr(vec![]));
    }

    /// A wait's round trip as a store module's client sends it: the mark,
    /// an arrival logged, the wait opened and parked, its arrivals read and
    /// noted.
    #[test]
    fn a_wait_crosses_the_store_wire() {
        let store = state_file();
        store.start_run(&RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None, team_id: None }).unwrap();
        let mark = call(&store, "waits.mark", obj! {});
        let arrival = |identity: &str| NewArrival {
            edge: "Comments".into(),
            key: "thread:c1".into(),
            identity: Some(identity.into()),
            version: Some("1".into()),
            landing: Some(Js::from(obj! { "Body" => Js::str("lunch?") })),
            gone: false,
        };
        let log = |identity: &str| {
            let params = obj! { "teamId" => Js::str("t"), "adapterType" => Js::str("acme"), "arrivals" => to_rows(&[arrival(identity)]), "at" => Js::str(iso(0)), "resendWindowMs" => Js::Num(3_600_000.into()) };
            call(&store, "waits.log", params)
        };
        let logged = |wakes: Vec<Js>| Js::from(obj! { "wakes" => Js::Arr(wakes), "stranded" => Js::Arr(vec![]) });
        assert_eq!(log("k1"), logged(vec![]));
        let wait = OpenWait { run_id: "run-1", team_id: "t", adapter_type: "acme", edge: "Comments", key: Some("thread:c1"), record_id: None, since: int(&mark).unwrap() };
        let opened = call(&store, "waits.open", open_wait_params(&wait));
        let wait_id = opened.get("waitId").and_then(Js::as_str).unwrap().to_string();
        let park = Park { run_id: "run-1", address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &wait_id } };
        call(&store, "parks.commit", park_params(&park));
        let wake = obj! { "runId" => Js::str("run-1"), "waitId" => Js::str(&wait_id), "address" => Js::str("s1") };
        assert_eq!(log("k2"), logged(vec![Js::from(wake)]));
        let read = call(&store, "waits.arrivals", obj! { "waitId" => Js::str(&wait_id) });
        let arrivals = WaitArrivals::from_wire(&read).unwrap();
        assert_eq!(arrivals.arrivals.iter().map(|a| a.identity.as_str()).collect::<Vec<_>>(), ["k1", "k2"]);
        assert_eq!(arrivals.arrivals[0].landing, Js::from(obj! { "Body" => Js::str("lunch?") }));
        let note = |identity: &str| obj! { "waitId" => Js::str(&wait_id), "identity" => Js::str(identity), "version" => Js::str("1"), "matched" => Js::Bool(true) };
        assert_eq!(call(&store, "waits.note", note("k1")), Js::Bool(true));
        assert_eq!(call(&store, "waits.note", note("k1")), Js::Bool(false));
        let read = WaitArrivals::from_wire(&call(&store, "waits.arrivals", obj! { "waitId" => Js::str(&wait_id) })).unwrap();
        assert_eq!(read.arrivals.iter().map(|a| a.identity.as_str()).collect::<Vec<_>>(), ["k2"]);
        assert_eq!(call(&store, "waits.sweep", obj! { "limit" => Js::Num(10.into()) }), Js::from(obj! { "swept" => Js::Num(0.into()) }), "the wait reads both");
    }

    #[test]
    fn every_method_served_is_listed() {
        for method in [
            "events.startRun",
            "runs.lapsed",
            "parks.commit",
            "parks.owedRaces",
            "work.bury",
            "work.completeKey",
            "inbound.keepDelivery",
            "inbound.deliveries",
            "inbound.delivery",
            "inbound.sweepDeliveries",
            "inbound.forgetDeliveryId",
            "waits.mark",
            "waits.log",
            "waits.open",
            "waits.arrivals",
            "waits.note",
            "waits.sweep",
            "waits.stranded",
            "writes.record",
            "writes.depth",
        ] {
            assert!(STORE_METHODS.contains(&method), "{method}");
        }
    }
}

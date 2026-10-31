//! A store module listen-fire does not build in: the store slot filled by a
//! third-party module (crate::core), spoken to over the store slot's
//! methods (docs/contracts/store-slot.md) carried as adapter protocol 2
//! calls (crate::slot_client) — the methods `listen-fire --contract-store` serves
//! (crate::contract_store), opened by `store.open` with the module's
//! settings. Every call blocks until the module answers, as the other
//! stores' calls do, so the rules over the store (crate::run_host) read
//! alike over all three.

use std::collections::BTreeMap;

use crate::backend::RunHostStore;
use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::obj;
use crate::slot_client::SlotClient;
use module_wire::envelope::METHOD_NOT_IMPLEMENTED_CODE;
use crate::store::{
    BranchExport, ClaimDue, ClaimedWork, DeliveryQuery, DeliveryRow, LeafRow, NewDelivery, NewWork, OwedRace, Park, Release, Rerun, Result, RunRow, RunStart, SegmentCommit,
    StoreError,
};
use crate::store_wire::{Wire, delivery_params, event_run_params, int, num, open_wait_params, opt, park_params, rows, run_start_params, segment_commit_params, stranded_params, to_rows};
use crate::waits::{DeliveryArrivals, DeliveryWait, KeptDelivery, Logged, Noted, OpenWait, Stranded, StrandedOf, WaitArrivals, WaitWake};

/// The error code a fenced write answers when the run's lease is gone
/// (`RunLeaseLost`), its `data` `{ runId }`.
pub const LEASE_LOST: &str = "run_lease_lost";

pub struct ProcessStore {
    tenant: String,
    client: SlotClient,
}

impl ProcessStore {
    /// Reach the module (started in its folder, or at its url) and open it
    /// with its settings.
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessStore> {
        let client = SlotClient::start("store", name, process, settings).map_err(StoreError::Backend)?;
        let mut store = ProcessStore { tenant: String::new(), client };
        let opened = store.call("store.open", obj! { "settings" => Js::from(store.client.settings()) })?;
        store.tenant = opened.get("tenant").and_then(Js::as_str).map(str::to_string).ok_or_else(|| store.malformed("store.open", &opened))?;
        Ok(store)
    }

    fn call(&self, method: &str, params: Obj) -> Result<Js> {
        self.client.call(method, params).map_err(|error| self.refused(method, error))
    }

    fn refused(&self, method: &str, error: crate::slot_client::SlotError) -> StoreError {
        if error.code == LEASE_LOST {
            let run_id = error.data.as_ref().and_then(|d| d.get("runId")).and_then(Js::as_str).unwrap_or_default();
            return StoreError::LeaseLost { run_id: run_id.to_string() };
        }
        if error.stands_alone() {
            return StoreError::Backend(error.message);
        }
        StoreError::Backend(format!("{}: {method}: {}", self.client.label, error.message))
    }

    fn malformed(&self, method: &str, answer: &Js) -> StoreError {
        StoreError::Backend(format!("{}: {method} answered {}, not its result's shape", self.client.label, answer.to_json()))
    }

    fn unit(&self, method: &str, params: Obj) -> Result<()> {
        self.call(method, params).map(|_| ())
    }

    fn flag(&self, method: &str, params: Obj) -> Result<bool> {
        match self.call(method, params)? {
            Js::Bool(b) => Ok(b),
            other => Err(self.malformed(method, &other)),
        }
    }

    fn row<T: Wire>(&self, method: &str, params: Obj) -> Result<Option<T>> {
        match self.call(method, params)? {
            Js::Null => Ok(None),
            answer => T::from_wire(&answer).map(Some).ok_or_else(|| self.malformed(method, &answer)),
        }
    }

    fn rows<T: Wire>(&self, method: &str, params: Obj) -> Result<Vec<T>> {
        let answer = self.call(method, params)?;
        rows(&answer).ok_or_else(|| self.malformed(method, &answer))
    }

    fn strings(&self, method: &str, params: Obj) -> Result<Vec<String>> {
        let answer = self.call(method, params)?;
        answer.as_array().and_then(|items| items.iter().map(|i| i.as_str().map(str::to_string)).collect()).ok_or_else(|| self.malformed(method, &answer))
    }
}

fn s(value: &str) -> Js {
    Js::str(value)
}

fn strings(items: &[String]) -> Js {
    Js::strings(items)
}

impl RunHostStore for ProcessStore {
    fn tenant(&self) -> &str {
        &self.tenant
    }

    fn start_run(&self, run: &RunStart<'_>) -> Result<()> {
        self.unit("runs.start", run_start_params(run))
    }
    fn start_event_run(&self, listen: &str, key: &str, run: &RunStart<'_>) -> Result<bool> {
        self.flag("events.startRun", event_run_params(listen, key, run))
    }
    fn lapsed_runs(&self, stale_ms: i64, limit: i64) -> Result<Vec<String>> {
        self.strings("runs.lapsed", obj! { "staleMs" => Js::Num(stale_ms.into()), "limit" => Js::Num(limit.into()) })
    }
    fn settle_run(&self, id: &str, status: &str, outcome: &Js, at: &str) -> Result<()> {
        self.unit("runs.settle", obj! { "runId" => s(id), "status" => s(status), "outcome" => outcome.clone(), "at" => s(at) })
    }
    fn mark_parked(&self, id: &str) -> Result<()> {
        self.unit("runs.markParked", obj! { "runId" => s(id) })
    }
    fn mark_failed(&self, id: &str, message: &str) -> Result<()> {
        self.unit("records.markFailed", obj! { "runId" => s(id), "message" => s(message) })
    }
    fn rerun_run(&self, run_id: &str, rerun: &Rerun<'_>) -> Result<Option<i64>> {
        let params = obj! { "runId" => s(run_id), "input" => s(rerun.input), "at" => s(rerun.at), "fence" => s(rerun.fence) };
        match self.call("runs.rerun", params)? {
            Js::Null => Ok(None),
            answer => answer.get("attempt").and_then(int).map(Some).ok_or_else(|| self.malformed("runs.rerun", &answer)),
        }
    }
    fn cancel_request(&self, id: &str) -> Result<Option<Option<String>>> {
        match self.call("records.cancelRequest", obj! { "runId" => s(id) })? {
            Js::Null => Ok(None),
            answer => match answer.get("reason") {
                None | Some(Js::Null) => Ok(Some(None)),
                Some(Js::Str(reason)) => Ok(Some(Some(reason.clone()))),
                Some(_) => Err(self.malformed("records.cancelRequest", &answer)),
            },
        }
    }
    fn request_cancel(&self, id: &str, reason: Option<&str>) -> Result<()> {
        self.unit("runs.requestCancel", obj! { "runId" => s(id), "reason" => opt(reason) })
    }
    fn run(&self, id: &str) -> Result<Option<RunRow>> {
        self.row("runs.get", obj! { "runId" => s(id) })
    }
    fn runs(&self, limit: i64) -> Result<Vec<RunRow>> {
        self.rows("runs.list", obj! { "limit" => Js::Num(limit.into()) })
    }
    fn append_trace(&self, run_id: &str, segment_id: &str, entries: &[Js]) -> Result<()> {
        self.unit("runs.appendTrace", obj! { "runId" => s(run_id), "segmentId" => s(segment_id), "entries" => Js::Arr(entries.to_vec()) })
    }
    fn run_spent(&self, run_id: &str) -> Result<f64> {
        match self.call("runs.spent", obj! { "runId" => s(run_id) })? {
            Js::Num(n) => n.as_f64().ok_or_else(|| self.malformed("runs.spent", &Js::Num(n))),
            other => Err(self.malformed("runs.spent", &other)),
        }
    }
    fn add_run_spend(&self, run_id: &str, microdollars: f64) -> Result<()> {
        self.unit("runs.addSpend", obj! { "runId" => s(run_id), "microdollars" => num(microdollars) })
    }
    fn reset_spend_baseline(&self, run_id: &str) -> Result<()> {
        self.unit("runs.resetSpendBaseline", obj! { "runId" => s(run_id) })
    }
    fn trace_len(&self, run_id: &str) -> Result<i64> {
        let answer = self.call("runs.traceLength", obj! { "runId" => s(run_id) })?;
        int(&answer).ok_or_else(|| self.malformed("runs.traceLength", &answer))
    }

    fn put_leaf(&self, run_id: &str, address: &str, reason: &str, wake_at: Option<&str>, state: &Js, fence: Option<&str>) -> Result<()> {
        self.unit(
            "parks.putLeaf",
            obj! { "runId" => s(run_id), "address" => s(address), "reason" => s(reason), "wakeAt" => opt(wake_at), "state" => state.clone(), "fence" => opt(fence) },
        )
    }
    fn claim_leaf(&self, run_id: &str, address: &str, reason: Option<&str>) -> Result<Option<(String, Js)>> {
        match self.call("parks.claimLeaf", obj! { "runId" => s(run_id), "address" => s(address), "reason" => opt(reason) })? {
            Js::Null => Ok(None),
            answer => match (answer.get("reason").and_then(Js::as_str), answer.get("state")) {
                (Some(reason), Some(state)) => Ok(Some((reason.to_string(), state.clone()))),
                _ => Err(self.malformed("parks.claimLeaf", &answer)),
            },
        }
    }
    fn finish_leaf(&self, run_id: &str, address: &str, fence: Option<&str>) -> Result<()> {
        self.unit("parks.finishLeaf", obj! { "runId" => s(run_id), "address" => s(address), "fence" => opt(fence) })
    }
    fn leaves(&self, run_id: &str, parked_only: bool, reason: Option<&str>, due_by: Option<&str>) -> Result<Vec<LeafRow>> {
        self.rows("parks.leaves", obj! { "runId" => s(run_id), "parkedOnly" => Js::Bool(parked_only), "reason" => opt(reason), "dueBy" => opt(due_by) })
    }
    fn delete_leaves(&self, run_id: &str, addresses: &[String]) -> Result<()> {
        self.unit("parks.deleteLeaves", obj! { "runId" => s(run_id), "addresses" => strings(addresses) })
    }
    fn commit_park(&self, park: &Park<'_>) -> Result<()> {
        self.unit("parks.commit", park_params(park))
    }
    fn commit_segment(&self, commit: &SegmentCommit<'_>) -> Result<Vec<WaitWake>> {
        const METHOD: &str = "parks.commitSegment";
        // A module written before it has no one write for a segment's parks:
        // a crash between two of them would strand the run.
        match self.client.call(METHOD, segment_commit_params(commit)) {
            Ok(answer) => rows(&answer).ok_or_else(|| self.malformed(METHOD, &answer)),
            Err(error) if error.code == METHOD_NOT_IMPLEMENTED_CODE => Err(StoreError::Backend(format!(
                "{} does not answer {}; listen-fire keeps a segment's parks in that one write",
                self.client.label,
                crate::protocol::method_with_minor(METHOD)
            ))),
            Err(error) => Err(self.refused(METHOD, error)),
        }
    }
    fn owed_races(&self, run_id: &str) -> Result<Vec<OwedRace>> {
        const METHOD: &str = "parks.owedRaces";
        // A module written before it cannot say what a run still owes: a run
        // whose owed race it lost would be settled completed.
        let answer = match self.client.call(METHOD, obj! { "runId" => s(run_id) }) {
            Ok(answer) => answer,
            Err(error) if error.code == METHOD_NOT_IMPLEMENTED_CODE => {
                return Err(StoreError::Backend(format!(
                    "{} does not answer {}; listen-fire reads what a run still owes before it settles the run",
                    self.client.label,
                    crate::protocol::method_with_minor(METHOD)
                )));
            }
            Err(error) => return Err(self.refused(METHOD, error)),
        };
        answer.as_array().and_then(|owed| owed.iter().map(OwedRace::of_payload).collect::<Option<Vec<_>>>()).ok_or_else(|| self.malformed(METHOD, &answer))
    }

    fn record_join(&self, run_id: &str, frame_address: &str, pending: i64, fence: Option<&str>) -> Result<()> {
        self.unit("joins.recordJoin", obj! { "runId" => s(run_id), "frameAddress" => s(frame_address), "pending" => Js::Num(pending.into()), "fence" => opt(fence) })
    }
    fn decrement_join(&self, run_id: &str, frame_address: &str, branch_address: &str, leaf_address: &str) -> Result<bool> {
        let params = obj! { "runId" => s(run_id), "frameAddress" => s(frame_address), "branchAddress" => s(branch_address), "leafAddress" => s(leaf_address) };
        let answer = self.call("joins.decrementJoin", params)?;
        match answer.get("closed") {
            Some(Js::Bool(closed)) => Ok(*closed),
            _ => Err(self.malformed("joins.decrementJoin", &answer)),
        }
    }
    fn persist_branch_export(&self, run_id: &str, frame_address: &str, branch_address: &str, branch_index: i64, exports: &Js) -> Result<()> {
        self.unit(
            "joins.persistBranchExport",
            obj! {
                "runId" => s(run_id),
                "frameAddress" => s(frame_address),
                "branchAddress" => s(branch_address),
                "branchIndex" => Js::Num(branch_index.into()),
                "exports" => exports.clone(),
            },
        )
    }
    fn collect_branch_exports(&self, run_id: &str, frame_address: &str) -> Result<Vec<BranchExport>> {
        self.rows("joins.collectBranchExports", obj! { "runId" => s(run_id), "frameAddress" => s(frame_address) })
    }
    fn has_pending_joins(&self, run_id: &str) -> Result<bool> {
        self.flag("joins.hasPendingJoins", obj! { "runId" => s(run_id) })
    }
    fn frames(&self, run_id: &str) -> Result<Vec<String>> {
        self.strings("joins.frames", obj! { "runId" => s(run_id) })
    }
    fn delete_frames(&self, run_id: &str, frame_addresses: &[String]) -> Result<()> {
        self.unit("joins.deleteFrames", obj! { "runId" => s(run_id), "frameAddresses" => strings(frame_addresses) })
    }

    fn arrival_mark(&self) -> Result<i64> {
        let answer = self.call("waits.mark", obj! {})?;
        int(&answer).ok_or_else(|| self.malformed("waits.mark", &answer))
    }
    fn log_arrivals(&self, log: &DeliveryArrivals<'_>) -> Result<Logged> {
        let answer = self.call("waits.log", arrivals_params(log))?;
        Logged::from_wire(&answer).ok_or_else(|| self.malformed("waits.log", &answer))
    }
    fn open_wait(&self, wait: &OpenWait<'_>) -> Result<String> {
        let answer = self.call("waits.open", open_wait_params(wait))?;
        answer.get("waitId").and_then(Js::as_str).map(str::to_string).ok_or_else(|| self.malformed("waits.open", &answer))
    }
    fn wait_arrivals(&self, wait_id: &str) -> Result<WaitArrivals> {
        let answer = self.call("waits.arrivals", obj! { "waitId" => s(wait_id) })?;
        WaitArrivals::from_wire(&answer).ok_or_else(|| self.malformed("waits.arrivals", &answer))
    }
    fn stranded_waits(&self, of: &StrandedOf<'_>) -> Result<Vec<Stranded>> {
        const METHOD: &str = "waits.stranded";
        // A module written before waits keeps none, so none is stranded.
        match self.client.call(METHOD, stranded_params(of)) {
            Ok(answer) => rows(&answer).ok_or_else(|| self.malformed(METHOD, &answer)),
            Err(error) if error.code == METHOD_NOT_IMPLEMENTED_CODE => Ok(Vec::new()),
            Err(error) => Err(self.refused(METHOD, error)),
        }
    }
    fn note_arrival(&self, noted: &Noted<'_>) -> Result<bool> {
        let mut params = obj! { "waitId" => s(noted.wait_id), "identity" => s(noted.identity), "version" => opt(noted.version), "matched" => Js::Bool(noted.matched) };
        if let Some(leaf) = noted.leaf {
            params.insert("leaf".into(), s(leaf));
        }
        if let Some(fence) = noted.fence {
            params.insert("fence".into(), s(fence));
        }
        self.flag("waits.note", params)
    }
    fn sweep_arrivals(&self, limit: i64) -> Result<i64> {
        const METHOD: &str = "waits.sweep";
        // A module written before waits logs no arrivals, so it has none to
        // forget: every drain sweeps, and such a module still drains.
        match self.client.call(METHOD, obj! { "limit" => Js::Num(limit.into()) }) {
            Ok(answer) => answer.get("swept").and_then(int).ok_or_else(|| self.malformed(METHOD, &answer)),
            Err(error) if error.code == METHOD_NOT_IMPLEMENTED_CODE => Ok(0),
            Err(error) => Err(self.refused(METHOD, error)),
        }
    }

    fn claim_lease(&self, run_id: &str, ttl_ms: i64) -> Result<Option<String>> {
        match self.call("leases.claim", obj! { "runId" => s(run_id), "ttlMs" => Js::Num(ttl_ms.into()) })? {
            Js::Null => Ok(None),
            answer => answer.get("token").and_then(Js::as_str).map(|t| Some(t.to_string())).ok_or_else(|| self.malformed("leases.claim", &answer)),
        }
    }
    fn renew_lease(&self, run_id: &str, token: &str, ttl_ms: i64) -> Result<bool> {
        self.flag("leases.renew", obj! { "runId" => s(run_id), "token" => s(token), "ttlMs" => Js::Num(ttl_ms.into()) })
    }
    fn release_lease(&self, run_id: &str, token: &str) -> Result<()> {
        self.unit("leases.release", obj! { "runId" => s(run_id), "token" => s(token) })
    }
    fn drop_run_state(&self, run_id: &str, fence: Option<&str>) -> Result<bool> {
        self.flag("leases.dropRunState", obj! { "runId" => s(run_id), "fence" => opt(fence) })
    }

    fn enqueue(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: Option<&str>) -> Result<()> {
        self.unit("work.enqueue", obj! { "kind" => s(kind), "key" => s(key), "payload" => payload.clone(), "dueAt" => opt(due_at), "teamId" => opt(team_id) })
    }
    fn enqueue_if_absent(&self, kind: &str, key: &str, payload: &Js, due_at: Option<&str>, team_id: Option<&str>) -> Result<bool> {
        const METHOD: &str = "work.enqueueIfAbsent";
        let params = obj! { "kind" => s(kind), "key" => s(key), "payload" => payload.clone(), "dueAt" => opt(due_at), "teamId" => opt(team_id) };
        // A module written before the method: armed polls need it, so the
        // refusal names it and the minor that added it.
        match self.client.call(METHOD, params) {
            Ok(Js::Bool(queued)) => Ok(queued),
            Ok(other) => Err(self.malformed(METHOD, &other)),
            Err(error) if error.code == METHOD_NOT_IMPLEMENTED_CODE => Err(StoreError::Backend(format!(
                "{} does not answer {}; arming a polled listen needs it",
                self.client.label,
                crate::protocol::method_with_minor(METHOD)
            ))),
            Err(error) => Err(self.refused(METHOD, error)),
        }
    }
    fn claim_due(&self, claim: &ClaimDue<'_>) -> Result<Vec<ClaimedWork>> {
        let mut params = obj! { "limit" => Js::Num(claim.limit.into()), "leaseMs" => Js::Num(claim.lease_ms.into()), "dueBy" => opt(claim.due_by) };
        // Absent, not null, for every kind: a module written before pools reads the same claim.
        if let Some(kinds) = claim.kinds {
            params.insert("kinds".into(), Js::strings(kinds));
        }
        self.rows("work.claimDue", params)
    }
    fn complete(&self, id: &str, claim: &str) -> Result<()> {
        self.unit("work.complete", obj! { "id" => s(id), "claim" => s(claim) })
    }
    fn release_work(&self, id: &str, claim: &str, due_at: Option<&str>, why: Release) -> Result<()> {
        self.unit("work.release", obj! { "id" => s(id), "claim" => s(claim), "dueAt" => opt(due_at), "why" => s(why.wire()) })
    }
    fn bury_work(&self, id: &str, claim: &str, reason: &str) -> Result<()> {
        self.unit("work.bury", obj! { "id" => s(id), "claim" => s(claim), "reason" => s(reason) })
    }

    fn put_source(&self, team_id: &str, hash: &str, source: &str) -> Result<()> {
        self.unit("sources.put", obj! { "teamId" => s(team_id), "hash" => s(hash), "source" => s(source) })
    }
    fn get_source(&self, team_id: &str, hash: &str) -> Result<Option<String>> {
        match self.call("sources.get", obj! { "teamId" => s(team_id), "hash" => s(hash) })? {
            Js::Null => Ok(None),
            Js::Str(source) => Ok(Some(source)),
            other => Err(self.malformed("sources.get", &other)),
        }
    }

    fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>> {
        match self.call("inbound.checkpoint", obj! { "subscriptionId" => s(subscription_id) })? {
            Js::Null => Ok(None),
            answer => answer.get("checkpoint").cloned().map(Some).ok_or_else(|| self.malformed("inbound.checkpoint", &answer)),
        }
    }
    fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<()> {
        self.unit("inbound.saveCheckpoint", obj! { "subscriptionId" => s(subscription_id), "checkpoint" => checkpoint.clone() })
    }
    fn listen_states(&self, pipelines: &[String]) -> Result<std::collections::BTreeMap<String, crate::resolve::ListenState>> {
        let answer = self.call("listens.states", obj! { "pipelines" => Js::strings(pipelines.to_vec()) })?;
        let Js::Obj(states) = &answer else { return Err(self.malformed("listens.states", &answer)) };
        states.iter().map(|(pipeline, state)| Ok((pipeline.clone(), crate::resolve::ListenState::from_js(state).ok_or_else(|| self.malformed("listens.states", &answer))?))).collect()
    }
    fn claim_listen_resolve(&self, pipeline: &str, ttl_ms: i64) -> Result<Option<String>> {
        match self.call("listens.claimResolve", obj! { "pipeline" => s(pipeline), "ttlMs" => Js::Num(ttl_ms.into()) })? {
            Js::Null => Ok(None),
            answer => answer.get("token").and_then(Js::as_str).map(|token| Some(token.to_string())).ok_or_else(|| self.malformed("listens.claimResolve", &answer)),
        }
    }
    fn save_listen_resolution(&self, pipeline: &str, token: &str, resolution: &crate::resolve::Resolution) -> Result<bool> {
        self.flag("listens.saveResolution", obj! { "pipeline" => s(pipeline), "token" => s(token), "resolution" => resolution.to_js() })
    }
    fn set_listen_paused(&self, pipeline: &str, paused: Option<&str>) -> Result<()> {
        self.unit("listens.setPaused", obj! { "pipeline" => s(pipeline), "paused" => paused.map(Js::str).unwrap_or(Js::Null) })
    }
    fn keep_delivery(
        &self,
        subscription_id: &str,
        checkpoint: Option<&Js>,
        delivery: &NewDelivery,
        work: &[NewWork],
        arrivals: Option<&DeliveryArrivals<'_>>,
        waits: &[DeliveryWait],
    ) -> Result<Option<KeptDelivery>> {
        let mut params = obj! { "subscriptionId" => s(subscription_id), "delivery" => Js::from(delivery_params(delivery)), "work" => to_rows(work) };
        if !waits.is_empty() {
            params.insert("waits".into(), to_rows(waits));
        }
        // Absent, not null: a null cursor is one to keep.
        if let Some(checkpoint) = checkpoint {
            params.insert("checkpoint".into(), checkpoint.clone());
        }
        if let Some(a) = arrivals {
            params.insert("arrivals".into(), Js::from(arrivals_params(a)));
        }
        // A module answering `null`, as one written before the receipt did,
        // is not taken to have kept it.
        let answer = self.call("inbound.keepDelivery", params)?;
        let mark = answer.get("arrivalMark").and_then(int);
        match (answer.get("kept"), arrivals) {
            (Some(Js::Bool(false)), _) => Ok(None),
            // Without arrivals the mark is the latest seq however it is read.
            (Some(Js::Bool(true)), None) => Ok(Some(KeptDelivery { wakes: Vec::new(), arrival_mark: mark.map_or_else(|| self.arrival_mark(), Ok)? })),
            // A module written before arrivals answers no `wakes`: it did not
            // log them; one written before 0.13 answers no mark before them.
            (Some(Js::Bool(true)), Some(_)) => match (answer.get("wakes").and_then(rows::<NewWork>), mark) {
                (Some(wakes), Some(arrival_mark)) => Ok(Some(KeptDelivery { wakes, arrival_mark })),
                _ => Err(StoreError::Backend(format!(
                    "{}: kept a delivery without logging its arrivals as language 0.13 does: it answers inbound.keepDelivery without `wakes` or `arrivalMark`",
                    self.client.label
                ))),
            },
            _ => Err(self.malformed("inbound.keepDelivery", &answer)),
        }
    }
    fn arrivals_unkept(&self) -> Result<Option<String>> {
        const METHOD: &str = "waits.log";
        let manifest = self.call("manifest", obj! {})?;
        let methods = manifest.get("methods").and_then(Js::as_array).ok_or_else(|| self.malformed("manifest", &manifest))?;
        Ok((!methods.iter().any(|m| m.as_str() == Some(METHOD))).then(|| {
            format!("{} does not answer {}; a delivery that reports arrivals needs it", self.client.label, crate::protocol::method_with_minor(METHOD))
        }))
    }
    fn forget_delivery_id(&self, id: &str) -> Result<()> {
        self.unit("inbound.forgetDeliveryId", obj! { "id" => s(id) })
    }
    fn deliveries(&self, query: &DeliveryQuery<'_>) -> Result<Vec<DeliveryRow>> {
        let params = obj! { "subscriptionId" => opt(query.subscription_id), "since" => opt(query.since), "limit" => Js::Num(query.limit.into()) };
        self.rows("inbound.deliveries", params)
    }
    fn delivery(&self, id: &str) -> Result<Option<DeliveryRow>> {
        self.row("inbound.delivery", obj! { "id" => s(id) })
    }
    fn sweep_deliveries(&self, before: &str, limit: i64) -> Result<i64> {
        let answer = self.call("inbound.sweepDeliveries", obj! { "before" => s(before), "limit" => Js::Num(limit.into()) })?;
        int(&answer).ok_or_else(|| self.malformed("inbound.sweepDeliveries", &answer))
    }

    fn module_processes(&self) -> Result<crate::backend::ModuleProcesses> {
        let answer = self.call("processes.list", Obj::new())?;
        let version = match answer.get("version") {
            Some(Js::Num(n)) => n.as_i64(),
            _ => None,
        };
        match (answer.get("processes"), version) {
            (Some(processes @ Js::Arr(_)), Some(version)) => Ok(crate::backend::ModuleProcesses { processes: processes.clone(), version }),
            _ => Err(self.malformed("processes.list", &answer)),
        }
    }
    fn swap_module_processes(&self, version: i64, processes: &Js) -> Result<bool> {
        self.flag("processes.swap", obj! { "version" => Js::Num(version.into()), "processes" => processes.clone() })
    }

    fn claim_event(&self, listen: &str, key: &str) -> Result<bool> {
        self.flag("events.claim", obj! { "listen" => s(listen), "key" => s(key) })
    }
}

/// `waits.log`'s params, and `inbound.keepDelivery`'s `arrivals`.
fn arrivals_params(log: &DeliveryArrivals<'_>) -> Obj {
    obj! {
        "teamId" => Js::str(log.team_id),
        "adapterType" => Js::str(log.adapter_type),
        "arrivals" => to_rows(log.arrivals),
        "at" => Js::str(log.at),
        "resendWindowMs" => Js::Num(log.resend_window_ms.into()),
    }
}

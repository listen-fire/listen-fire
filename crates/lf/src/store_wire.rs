//! The rows the store wire carries (docs/contracts/store-slot.md), each
//! written and read in one place: `listen-fire --contract-store` writes them
//! (crate::contract_store) and listen-fire reads them back from a store module
//! (crate::store_module). A row's keys are the TypeScript families' names
//! (`RunHostStore`).

use crate::json::{Js, Obj};
use crate::obj;
use crate::store::{
    BranchExport, ClaimedWork, DeliveryRow, DeliveryRun, DeliverySource, EventReceipt, LeafRow, NewDelivery, NewWork, Park, ParkKind, RunRow, RunStart, SegmentCommit,
};
use crate::waits::{DeliveryWait, Logged, LoggedArrival, NewArrival, OpenWait, PreNoted, Stranded, StrandedAfter, StrandedOf, WaitArrivals, WaitWake};

/// A row as the store wire carries it.
pub trait Wire: Sized {
    fn to_wire(&self) -> Js;
    /// None: the value is not this row.
    fn from_wire(value: &Js) -> Option<Self>;
}

pub fn opt(value: Option<&str>) -> Js {
    value.map(Js::str).unwrap_or(Js::Null)
}

fn text(value: &Js, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// An optional string: absent and `null` alike are None.
fn opt_text(value: &Js, key: &str) -> Option<Option<String>> {
    match value.get(key) {
        None | Some(Js::Null) => Some(None),
        Some(Js::Str(s)) => Some(Some(s.clone())),
        Some(_) => None,
    }
}

pub fn int(value: &Js) -> Option<i64> {
    match value {
        Js::Num(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        _ => None,
    }
}

pub fn num(value: f64) -> Js {
    serde_json::Number::from_f64(value).map(Js::Num).unwrap_or(Js::Null)
}

/// Every item of an array as a row, or None when any is not one.
pub fn rows<T: Wire>(value: &Js) -> Option<Vec<T>> {
    value.as_array()?.iter().map(T::from_wire).collect()
}

pub fn to_rows<T: Wire>(rows: &[T]) -> Js {
    Js::Arr(rows.iter().map(Wire::to_wire).collect())
}

impl Wire for RunRow {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "id" => Js::str(&self.id),
            "file" => Js::str(&self.file),
            "movement" => Js::str(&self.movement),
            "status" => Js::str(&self.status),
            "startedAt" => Js::str(&self.started_at),
            "finishedAt" => opt(self.finished_at.as_deref()),
            "input" => Js::str(&self.input),
            "outcome" => opt(self.outcome.as_deref()),
            "deliveryId" => opt(self.delivery_id.as_deref()),
            "attempt" => Js::Num(self.attempt.into()),
            "attempts" => Js::Arr(self.attempts.clone()),
        })
    }

    /// A module written before delivery receipts answers no `deliveryId`, one
    /// written before finish times no `finishedAt`: none; and one written
    /// before reruns no `attempt` or `attempts`: the run's first, alone.
    fn from_wire(v: &Js) -> Option<Self> {
        Some(RunRow {
            id: text(v, "id")?,
            file: text(v, "file")?,
            movement: text(v, "movement")?,
            status: text(v, "status")?,
            started_at: text(v, "startedAt")?,
            finished_at: opt_text(v, "finishedAt")?,
            input: text(v, "input")?,
            outcome: opt_text(v, "outcome")?,
            delivery_id: opt_text(v, "deliveryId")?,
            attempt: match v.get("attempt") {
                None | Some(Js::Null) => 1,
                Some(n) => int(n)?,
            },
            attempts: match v.get("attempts") {
                None | Some(Js::Null) => Vec::new(),
                Some(list) => list.as_array()?.to_vec(),
            },
        })
    }
}

impl Wire for LeafRow {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "address" => Js::str(&self.address),
            "reason" => Js::str(&self.reason),
            "status" => Js::str(&self.status),
            "wakeAt" => opt(self.wake_at.as_deref()),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(LeafRow { address: text(v, "address")?, reason: text(v, "reason")?, status: text(v, "status")?, wake_at: opt_text(v, "wakeAt")? })
    }
}

impl Wire for ClaimedWork {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "id" => Js::str(&self.id),
            "kind" => Js::str(&self.kind),
            "key" => Js::str(&self.key),
            "payload" => self.payload.clone(),
            "claim" => Js::str(&self.claim),
            "attempts" => Js::Num(self.attempts.into()),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(ClaimedWork {
            id: text(v, "id")?,
            kind: text(v, "kind")?,
            key: text(v, "key")?,
            payload: v.get("payload")?.clone(),
            claim: text(v, "claim")?,
            attempts: int(v.get("attempts")?)?,
        })
    }
}

impl Wire for NewWork {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "kind" => Js::str(&self.kind),
            "key" => Js::str(&self.key),
            "payload" => self.payload.clone(),
            "dueAt" => opt(self.due_at.as_deref()),
            "teamId" => opt(self.team_id.as_deref()),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(NewWork { kind: text(v, "kind")?, key: text(v, "key")?, payload: v.get("payload")?.clone(), due_at: opt_text(v, "dueAt")?, team_id: opt_text(v, "teamId")? })
    }
}

/// `parks.commit`'s params.
pub fn park_params(park: &Park<'_>) -> Obj {
    obj! {
        "runId" => Js::str(park.run_id),
        "address" => Js::str(park.address),
        "state" => park.state.clone(),
        "fence" => opt(park.fence),
        "park" => Js::from(park_kind_params(&park.kind)),
    }
}

/// `parks.commit`'s `park`.
fn park_kind_params(kind: &ParkKind<'_>) -> Obj {
    match kind {
        ParkKind::Timer { wake_at } => obj! { "kind" => Js::str("timer"), "wakeAt" => Js::str(*wake_at) },
        ParkKind::Wait { wait_id } => obj! { "kind" => Js::str("wait"), "waitId" => Js::str(*wait_id) },
        ParkKind::Limit => obj! { "kind" => Js::str("limit") },
    }
}

/// `parks.commitSegment`'s params.
pub fn segment_commit_params(commit: &SegmentCommit<'_>) -> Obj {
    let joins = commit.joins.iter().map(|join| Js::Obj(obj! { "frameAddress" => Js::str(join.frame_address), "pending" => Js::Num(join.pending.into()) }));
    let parks = commit
        .parks
        .iter()
        .map(|park| Js::Obj(obj! { "address" => Js::str(park.address), "state" => park.state.clone(), "park" => Js::from(park_kind_params(&park.kind)) }));
    obj! {
        "runId" => Js::str(commit.run_id),
        "teamId" => Js::str(commit.team_id),
        "fence" => opt(commit.fence),
        "resumed" => opt(commit.resumed),
        "joins" => Js::Arr(joins.collect()),
        "parks" => Js::Arr(parks.collect()),
        "settle" => commit.settle.as_ref().map_or(Js::Null, |settle| Js::from(obj! {
            "status" => Js::str(settle.status),
            "outcome" => settle.outcome.clone(),
            "at" => Js::str(settle.at),
        })),
        "owedRaces" => Js::Arr(commit.owed_races.iter().map(|race| Js::Obj(obj! { "frameAddress" => Js::str(race.frame_address), "state" => race.state.clone() })).collect()),
        "settledRace" => opt(commit.settled_race),
    }
}

/// `parks.commit`'s `park`, read back; None when it is not one.
pub fn park_kind(value: &Js) -> Option<ParkKind<'_>> {
    let field = |key: &str| value.get(key).and_then(Js::as_str);
    Some(match field("kind")? {
        "timer" => ParkKind::Timer { wake_at: field("wakeAt")? },
        "wait" => ParkKind::Wait { wait_id: field("waitId")? },
        "limit" => ParkKind::Limit,
        _ => return None,
    })
}

/// `runs.start`'s params.
pub fn run_start_params(run: &RunStart<'_>) -> Obj {
    let mut params = obj! {
        "id" => Js::str(run.id),
        "file" => Js::str(run.file),
        "movement" => Js::str(run.movement),
        "startedAt" => Js::str(run.started_at),
        "input" => Js::str(run.input),
        "deliveryId" => opt(run.delivery_id),
    };
    // Sent only when it names one: a store module written before the
    // member keeps every run under its own tenant.
    if let Some(team_id) = run.team_id {
        params.insert("teamId".into(), Js::str(team_id));
    }
    params
}

/// `events.claim`'s params: the listen, the key and, when it names one, the team.
pub fn receipt_params(receipt: &EventReceipt<'_>) -> Obj {
    let mut params = obj! { "listen" => Js::str(receipt.listen), "key" => Js::str(receipt.key) };
    if let Some(team_id) = receipt.team_id {
        params.insert("teamId".into(), Js::str(team_id));
    }
    params
}

/// `events.startRun`'s params: `runs.start`'s, with the receipt's.
pub fn event_run_params(receipt: &EventReceipt<'_>, run: &RunStart<'_>) -> Obj {
    let mut params = receipt_params(receipt);
    params.extend(run_start_params(run));
    params
}

/// `inbound.keepDelivery`'s `delivery`.
pub fn delivery_params(delivery: &NewDelivery) -> Obj {
    obj! {
        "id" => Js::str(&delivery.id),
        "externalId" => opt(delivery.external_id.as_deref()),
        "receivedAt" => Js::str(&delivery.received_at),
        "source" => Js::str(delivery.source.wire()),
        "inline" => Js::Bool(delivery.inline),
        "replayOf" => opt(delivery.replay_of.as_deref()),
        "events" => Js::Arr(delivery.events.clone()),
    }
}

/// `inbound.keepDelivery`'s `delivery`, read back; None when it is not one.
pub fn new_delivery(v: &Js) -> Option<NewDelivery> {
    Some(NewDelivery {
        id: text(v, "id")?,
        external_id: opt_text(v, "externalId")?,
        received_at: text(v, "receivedAt")?,
        source: DeliverySource::of_wire(v.get("source")?.as_str()?).ok()?,
        inline: match v.get("inline")? {
            Js::Bool(inline) => *inline,
            _ => return None,
        },
        replay_of: opt_text(v, "replayOf")?,
        events: v.get("events")?.as_array()?.to_vec(),
    })
}

impl Wire for DeliveryRun {
    fn to_wire(&self) -> Js {
        Js::from(obj! { "id" => Js::str(&self.id), "status" => Js::str(&self.status) })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(DeliveryRun { id: text(v, "id")?, status: text(v, "status")? })
    }
}

/// `events` only when it was read (`inbound.delivery`).
impl Wire for DeliveryRow {
    fn to_wire(&self) -> Js {
        let mut row = obj! {
            "id" => Js::str(&self.id),
            "subscriptionId" => Js::str(&self.subscription_id),
            "externalId" => opt(self.external_id.as_deref()),
            "receivedAt" => Js::str(&self.received_at),
            "source" => Js::str(self.source.wire()),
            "inline" => Js::Bool(self.inline),
            "replayOf" => opt(self.replay_of.as_deref()),
            "eventCount" => Js::Num(self.event_count.into()),
            "runs" => to_rows(&self.runs),
        };
        if let Some(events) = &self.events {
            row.insert("events".into(), Js::Arr(events.clone()));
        }
        Js::from(row)
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(DeliveryRow {
            id: text(v, "id")?,
            subscription_id: text(v, "subscriptionId")?,
            external_id: opt_text(v, "externalId")?,
            received_at: text(v, "receivedAt")?,
            source: DeliverySource::of_wire(v.get("source")?.as_str()?).ok()?,
            inline: match v.get("inline")? {
                Js::Bool(inline) => *inline,
                _ => return None,
            },
            replay_of: opt_text(v, "replayOf")?,
            event_count: int(v.get("eventCount")?)?,
            runs: rows(v.get("runs")?)?,
            events: match v.get("events") {
                None | Some(Js::Null) => None,
                Some(events) => Some(events.as_array()?.to_vec()),
            },
        })
    }
}

/// `waits.log`'s arrivals: an absent `landing` and `null` alike are none,
/// as a stored one reads back.
impl Wire for NewArrival {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "edge" => Js::str(&self.edge),
            "key" => Js::str(&self.key),
            "identity" => opt(self.identity.as_deref()),
            "version" => opt(self.version.as_deref()),
            "landing" => self.landing.clone().unwrap_or(Js::Null),
            "gone" => Js::Bool(self.gone),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(NewArrival {
            edge: text(v, "edge")?,
            key: text(v, "key")?,
            identity: opt_text(v, "identity")?,
            version: opt_text(v, "version")?,
            landing: v.get("landing").filter(|l| **l != Js::Null).cloned(),
            gone: match v.get("gone") {
                None => false,
                Some(Js::Bool(gone)) => *gone,
                Some(_) => return None,
            },
        })
    }
}

/// `inbound.keepDelivery`'s `waits`: `{ runId, edge, key, fireKey,
/// preNoted? }`, `key` null for a record already gone, `preNoted` the run's
/// trigger `{ identity, version }`.
impl Wire for DeliveryWait {
    fn to_wire(&self) -> Js {
        let mut wait = obj! {
            "runId" => Js::str(&self.run_id),
            "edge" => Js::str(&self.edge),
            "key" => opt(self.key.as_deref()),
            "fireKey" => Js::str(&self.fire_key),
        };
        if let Some(noted) = &self.pre_noted {
            wait.insert("preNoted".into(), Js::from(obj! { "identity" => Js::str(&noted.identity), "version" => opt(noted.version.as_deref()) }));
        }
        Js::from(wait)
    }

    fn from_wire(v: &Js) -> Option<Self> {
        let pre_noted = match v.get("preNoted") {
            None | Some(Js::Null) => None,
            Some(noted) => Some(PreNoted { identity: text(noted, "identity")?, version: opt_text(noted, "version")? }),
        };
        Some(DeliveryWait { run_id: text(v, "runId")?, edge: text(v, "edge")?, key: opt_text(v, "key")?, pre_noted, fire_key: text(v, "fireKey")? })
    }
}

/// `waits.open`'s params.
pub fn open_wait_params(wait: &OpenWait<'_>) -> Obj {
    obj! {
        "runId" => Js::str(wait.run_id),
        "teamId" => Js::str(wait.team_id),
        "adapterType" => Js::str(wait.adapter_type),
        "edge" => Js::str(wait.edge),
        "key" => opt(wait.key),
        "recordId" => opt(wait.record_id),
        "since" => Js::Num(wait.since.into()),
    }
}

/// `waits.stranded`'s params: `{ runId }`, or `{ after?, limit }`.
pub fn stranded_params(of: &StrandedOf<'_>) -> Obj {
    match *of {
        StrandedOf::Run(run_id) => obj! { "runId" => Js::str(run_id) },
        StrandedOf::Page { after, limit } => {
            let mut params = obj! { "limit" => Js::Num(limit.into()) };
            if let Some(StrandedAfter { at, wait_id }) = after {
                params.insert("after".into(), Js::from(obj! { "at" => Js::str(at), "waitId" => Js::str(wait_id) }));
            }
            params
        }
    }
}

impl Wire for LoggedArrival {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "seq" => Js::Num(self.seq.into()),
            "identity" => Js::str(&self.identity),
            "version" => opt(self.version.as_deref()),
            "landing" => self.landing.clone(),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(LoggedArrival {
            seq: int(v.get("seq")?)?,
            identity: text(v, "identity")?,
            version: opt_text(v, "version")?,
            landing: v.get("landing").cloned().unwrap_or(Js::Null),
        })
    }
}

impl Wire for WaitArrivals {
    fn to_wire(&self) -> Js {
        Js::from(obj! { "arrivals" => to_rows(&self.arrivals) })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(WaitArrivals { arrivals: rows(v.get("arrivals")?)? })
    }
}

impl Wire for Stranded {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "waitId" => Js::str(&self.wait_id),
            "runId" => Js::str(&self.run_id),
            "adapterType" => Js::str(&self.adapter_type),
            "edge" => Js::str(&self.edge),
            "key" => opt(self.key.as_deref()),
            "recordId" => opt(self.record_id.as_deref()),
            "at" => Js::str(&self.at),
            "parked" => Js::Bool(self.parked),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(Stranded {
            wait_id: text(v, "waitId")?,
            run_id: text(v, "runId")?,
            adapter_type: text(v, "adapterType")?,
            edge: text(v, "edge")?,
            key: opt_text(v, "key")?,
            record_id: opt_text(v, "recordId")?,
            at: text(v, "at")?,
            parked: match v.get("parked")? {
                Js::Bool(parked) => *parked,
                _ => return None,
            },
        })
    }
}

/// `waits.log`'s answer: `{ wakes, stranded }`.
impl Wire for Logged {
    fn to_wire(&self) -> Js {
        Js::from(obj! { "wakes" => to_rows(&self.wakes), "stranded" => to_rows(&self.stranded) })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(Logged { wakes: rows(v.get("wakes")?)?, stranded: rows(v.get("stranded")?)? })
    }
}

impl Wire for WaitWake {
    fn to_wire(&self) -> Js {
        Js::from(obj! { "runId" => Js::str(&self.run_id), "waitId" => Js::str(&self.wait_id), "address" => Js::str(&self.address) })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(WaitWake { run_id: text(v, "runId")?, wait_id: text(v, "waitId")?, address: text(v, "address")? })
    }
}

impl Wire for BranchExport {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "branchAddress" => Js::str(&self.branch_address),
            "branchIndex" => Js::Num(self.branch_index.into()),
            "exports" => self.exports.clone(),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(BranchExport { branch_address: text(v, "branchAddress")?, branch_index: int(v.get("branchIndex")?)?, exports: v.get("exports")?.clone() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_reads_back_as_it_was_written() {
        let run = RunRow {
            id: "r".into(),
            file: "f".into(),
            movement: "m".into(),
            status: "parked".into(),
            started_at: "2026-10-17T00:00:00.000Z".into(),
            finished_at: Some("2026-10-17T00:00:01.000Z".into()),
            input: "{}".into(),
            outcome: None,
            delivery_id: Some("d".into()),
            attempt: 2,
            attempts: vec![Js::Obj(obj! { "attempt" => Js::Num(1.into()), "status" => Js::str("failed") })],
        };
        let back = RunRow::from_wire(&run.to_wire()).unwrap();
        assert_eq!((back.id, back.status, back.outcome, back.delivery_id, back.finished_at), (run.id, run.status, None, run.delivery_id, run.finished_at));
        assert_eq!((back.attempt, back.attempts), (run.attempt, run.attempts));
        assert!(LeafRow::from_wire(&Js::str("not a row")).is_none());
    }

    #[test]
    fn a_composite_writes_rows_read_back_as_written() {
        let claimed = ClaimedWork { id: "1".into(), kind: "wake_await".into(), key: "k".into(), payload: Js::Null, claim: "t/1".into(), attempts: 3 };
        assert_eq!(ClaimedWork::from_wire(&claimed.to_wire()).map(|w| w.attempts), Some(3));
        let work = NewWork { kind: "fire_event".into(), key: "k".into(), payload: Js::Null, due_at: None, team_id: Some("t".into()) };
        assert_eq!(NewWork::from_wire(&work.to_wire()).map(|w| w.to_wire()), Some(work.to_wire()));
        let kinds = [
            ParkKind::Timer { wake_at: "2026-10-20T00:00:00.000Z" },
            ParkKind::Wait { wait_id: "w" },
            ParkKind::Limit,
        ];
        for kind in kinds {
            let reason = kind.reason();
            let params = Js::from(park_params(&Park { run_id: "r", address: "s1", state: &Js::Null, fence: None, kind }));
            assert_eq!(params.get("park").and_then(park_kind).map(|k| k.reason()), Some(reason));
        }
        assert!(park_kind(&Js::from(obj! { "kind" => Js::str("timer") })).is_none(), "a timer park names its wake");
        let delivery = NewDelivery {
            id: "d".into(),
            external_id: Some("x".into()),
            received_at: "2026-10-22T00:00:00.000Z".into(),
            source: DeliverySource::Emit,
            inline: false,
            replay_of: None,
            events: vec![Js::str("e")],
        };
        let params = Js::from(delivery_params(&delivery));
        assert_eq!(new_delivery(&params).map(|d| Js::from(delivery_params(&d))), Some(params));
    }

    #[test]
    fn a_wait_row_reads_back_as_written() {
        let landed = NewArrival { edge: "Comments".into(), key: "thread:c1".into(), identity: Some("k1".into()), version: None, landing: Some(Js::str("x")), gone: false };
        assert_eq!(NewArrival::from_wire(&landed.to_wire()), Some(landed.clone()));
        let gone = NewArrival { identity: None, landing: None, gone: true, ..landed };
        assert_eq!(NewArrival::from_wire(&gone.to_wire()), Some(gone));
        let arrivals = WaitArrivals { arrivals: vec![LoggedArrival { seq: 7, identity: "k1".into(), version: Some("2".into()), landing: Js::str("x") }] };
        assert_eq!(WaitArrivals::from_wire(&arrivals.to_wire()), Some(arrivals));
        let wake = WaitWake { run_id: "r".into(), wait_id: "w".into(), address: "s1".into() };
        assert_eq!(WaitWake::from_wire(&wake.to_wire()), Some(wake.clone()));
        let stranded = Stranded { wait_id: "w".into(), run_id: "r".into(), adapter_type: "acme".into(), edge: "Comments".into(), key: None, record_id: Some("m-1".into()), at: "2026-10-31T00:00:00.000Z".into(), parked: true };
        let logged = Logged { wakes: vec![wake], stranded: vec![stranded] };
        assert_eq!(Logged::from_wire(&logged.to_wire()), Some(logged));
        assert_eq!(park_kind(&Js::from(obj! { "kind" => Js::str("wait"), "waitId" => Js::str("w") })).map(|k| k.reason()), Some("await"));
    }
}

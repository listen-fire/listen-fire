//! The rows the store wire carries (docs/contracts/store-slot.md), each
//! written and read in one place: `listen-fire --contract-store` writes them
//! (crate::contract_store) and listen-fire reads them back from a store module
//! (crate::store_module). A row's keys are the TypeScript families' names
//! (`RunHostStore`, `CallbackStore`).

use crate::backend::{CallbackClaim, CallbackRecord};
use crate::json::{Js, Obj};
use crate::obj;
use crate::store::{
    BranchExport, ClaimedWork, CorrelatedAwait, DeliveryRow, DeliveryRun, DeliverySource, LeafRow, NewDelivery, NewWork, Park, ParkKind, RunRow, RunStart,
};

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
    let kind = match &park.kind {
        ParkKind::Timer { wake_at } => obj! { "kind" => Js::str("timer"), "wakeAt" => Js::str(*wake_at) },
        ParkKind::Await { team_id, adapter_type, correlation_key } => obj! {
            "kind" => Js::str("await"),
            "teamId" => Js::str(*team_id),
            "adapterType" => Js::str(*adapter_type),
            "correlationKey" => Js::str(*correlation_key),
        },
        ParkKind::Limit => obj! { "kind" => Js::str("limit") },
    };
    obj! {
        "runId" => Js::str(park.run_id),
        "address" => Js::str(park.address),
        "state" => park.state.clone(),
        "fence" => opt(park.fence),
        "park" => Js::from(kind),
    }
}

/// `parks.commit`'s `park`, read back; None when it is not one.
pub fn park_kind(value: &Js) -> Option<ParkKind<'_>> {
    let field = |key: &str| value.get(key).and_then(Js::as_str);
    Some(match field("kind")? {
        "timer" => ParkKind::Timer { wake_at: field("wakeAt")? },
        "await" => ParkKind::Await { team_id: field("teamId")?, adapter_type: field("adapterType")?, correlation_key: field("correlationKey")? },
        "limit" => ParkKind::Limit,
        _ => return None,
    })
}

/// `runs.start`'s params.
pub fn run_start_params(run: &RunStart<'_>) -> Obj {
    obj! {
        "id" => Js::str(run.id),
        "file" => Js::str(run.file),
        "movement" => Js::str(run.movement),
        "startedAt" => Js::str(run.started_at),
        "input" => Js::str(run.input),
        "deliveryId" => opt(run.delivery_id),
    }
}

/// `events.startRun`'s params: `runs.start`'s, with the listen and the key.
pub fn event_run_params(listen: &str, key: &str, run: &RunStart<'_>) -> Obj {
    let mut params = obj! { "listen" => Js::str(listen), "key" => Js::str(key) };
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

fn correlated_obj(c: &CorrelatedAwait) -> Obj {
    obj! { "runId" => Js::str(&c.run_id), "teamId" => Js::str(&c.team_id), "address" => Js::str(&c.address) }
}

impl Wire for CorrelatedAwait {
    fn to_wire(&self) -> Js {
        Js::from(correlated_obj(self))
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(CorrelatedAwait { run_id: text(v, "runId")?, team_id: text(v, "teamId")?, address: text(v, "address")? })
    }
}

/// A run's await correlation with its key (`correlations.ofRun`).
impl Wire for (CorrelatedAwait, String) {
    fn to_wire(&self) -> Js {
        let mut row = correlated_obj(&self.0);
        row.insert("correlationKey".into(), Js::str(&self.1));
        Js::from(row)
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some((CorrelatedAwait::from_wire(v)?, text(v, "correlationKey")?))
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

impl Wire for CallbackRecord {
    fn to_wire(&self) -> Js {
        Js::from(obj! {
            "id" => Js::str(&self.id),
            "teamId" => Js::str(&self.team_id),
            "runId" => Js::str(&self.run_id),
            "address" => Js::str(&self.address),
            "params" => self.params.clone(),
            "state" => self.state.clone(),
            "calls" => self.calls.clone(),
            "singleUse" => Js::Bool(self.single_use),
            "expiresAt" => opt(self.expires_at.as_deref()),
            "status" => Js::str(&self.status),
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        Some(CallbackRecord {
            id: text(v, "id")?,
            team_id: text(v, "teamId")?,
            run_id: text(v, "runId")?,
            address: text(v, "address")?,
            params: v.get("params")?.clone(),
            state: v.get("state")?.clone(),
            calls: v.get("calls")?.clone(),
            single_use: matches!(v.get("singleUse")?, Js::Bool(true)),
            expires_at: opt_text(v, "expiresAt")?,
            status: text(v, "status")?,
        })
    }
}

impl Wire for CallbackClaim {
    fn to_wire(&self) -> Js {
        Js::from(match self {
            CallbackClaim::Recorded { callback, call_index } => {
                obj! { "kind" => Js::str("recorded"), "callback" => callback.to_wire(), "callIndex" => Js::Num((*call_index).into()) }
            }
            CallbackClaim::NotFound => obj! { "kind" => Js::str("not_found") },
            CallbackClaim::Closed(callback) => obj! { "kind" => Js::str("closed"), "callback" => callback.to_wire() },
            CallbackClaim::Expired(callback) => obj! { "kind" => Js::str("expired"), "callback" => callback.to_wire() },
        })
    }

    fn from_wire(v: &Js) -> Option<Self> {
        let callback = || v.get("callback").and_then(CallbackRecord::from_wire);
        Some(match v.get("kind")?.as_str()? {
            "recorded" => CallbackClaim::Recorded { callback: callback()?, call_index: int(v.get("callIndex")?)? },
            "not_found" => CallbackClaim::NotFound,
            "closed" => CallbackClaim::Closed(callback()?),
            "expired" => CallbackClaim::Expired(callback()?),
            _ => return None,
        })
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
        let callback = CallbackRecord {
            id: "c".into(),
            team_id: "t".into(),
            run_id: "r".into(),
            address: "a".into(),
            params: Js::Arr(vec![]),
            state: Js::Null,
            calls: Js::Arr(vec![]),
            single_use: true,
            expires_at: Some("2026-10-18T00:00:00.000Z".into()),
            status: "live".into(),
        };
        let claim = CallbackClaim::Recorded { callback, call_index: 2 };
        assert_eq!(CallbackClaim::from_wire(&claim.to_wire()).map(|c| c.to_wire()), Some(claim.to_wire()));
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
            ParkKind::Await { team_id: "t", adapter_type: "mail", correlation_key: "k" },
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
}

//! Resolving a listen's earlier hops: a listen whose plan has a hop the host
//! resolves (`listen to f-[b:Boards WHERE b.Name == "Ops"]->-[:Notes]-> fire
//! a`) is watched on the records its earlier hops land on, its heads: the
//! last edge is polled or subscribed to once per head. listen-fire lists them
//! by reading the earlier hops, with their WHEREs, through the engine, as a
//! run's walk reads them, with no run row; and lists them again when they may
//! have changed:
//!
//! - every `relistEverySeconds` a resolved hop's module declares (the
//!   shortest), unless lf.yaml's `resolveEvery` names another for the
//!   connection: a `resolve_listen` work row;
//! - on any arrival on a resolved hop's own edge, when its module declares
//!   `parentChanges: pushed`: no row is armed for it.
//!
//! A head that drops out loses its cursor, so one that comes back is watched
//! from then, its changes in between never replayed. A listen whose hops
//! match more heads than lf.yaml's `listenScopeLimit` is suspended, watched
//! nowhere, until they match fewer; one whose read fails keeps the heads it
//! had. Either is said, named, by `listen-fire listens`, and printed when it
//! starts and whenever it changes.

use std::collections::BTreeSet;

use movement_parser::listen_plan::HopJudged;

use crate::json::{Js, Obj};
use crate::obj;
use crate::routing::Listen;
use crate::runs::{FileSet, Session};
use crate::store::iso;

/// A listen's re-resolution row in the work queue: its next resolve.
pub const RESOLVE_WORK_KIND: &str = "resolve_listen";

/// One record a listen's earlier hops land on, which its last edge is
/// watched under.
#[derive(Debug, Clone, PartialEq)]
pub struct Head {
    pub record_id: String,
    pub record_type: String,
    pub data: Js,
}

/// Why a listen's heads could not be listed.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolveFailure {
    /// `LISTEN_SCOPE_LIMIT`: its hops match more heads than lf.yaml's
    /// `listenScopeLimit`.
    OverLimit { matched: usize, limit: usize },
    /// `LISTEN_RESOLVE_FAILED`: the read did not answer.
    Read(String),
}

impl ResolveFailure {
    /// The line `listen-fire listens` shows, and listen-fire prints.
    pub fn line(&self, listen: &Listen) -> String {
        let named = format!("{}:{}", listen.file, listen.movement_name);
        let position = position_of(listen);
        match self {
            ResolveFailure::OverLimit { matched, limit } => {
                format!("LISTEN_SCOPE_LIMIT: {named} matched {matched} {position}s, over the limit of {limit}; it is suspended until its filter matches fewer")
            }
            ResolveFailure::Read(why) => format!("LISTEN_RESOLVE_FAILED: {named} could not list the {position}s it watches: {why}"),
        }
    }
}

/// What the store keeps of a listen with a hop the host resolves
/// (`listens.state`): the heads it was last resolved to, when, why its last
/// resolve failed (None: it did not), and why it is paused (None: it is
/// not).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ListenState {
    pub heads: Vec<String>,
    pub resolved_at: String,
    pub failure: Option<String>,
    pub paused: Option<String>,
}

impl ListenState {
    /// As the store wire carries it.
    pub fn to_js(&self) -> Js {
        let opt = |value: &Option<String>| value.as_deref().map(Js::str).unwrap_or(Js::Null);
        Js::Obj(obj! {
            "heads" => Js::strings(self.heads.clone()),
            "resolvedAt" => Js::str(&self.resolved_at),
            "failure" => opt(&self.failure),
            "paused" => opt(&self.paused),
        })
    }

    /// None: the value is not a listen's state.
    pub fn from_js(value: &Js) -> Option<ListenState> {
        let text = |key: &str| match value.get(key) {
            None | Some(Js::Null) => Some(None),
            Some(Js::Str(s)) => Some(Some(s.clone())),
            Some(_) => None,
        };
        let heads = value.get("heads")?.as_array()?.iter().map(|h| h.as_str().map(str::to_string)).collect::<Option<Vec<_>>>()?;
        Some(ListenState { heads, resolved_at: text("resolvedAt")??, failure: text("failure")?, paused: text("paused")? })
    }
}

/// The record type a listen's last edge hangs off: what its heads are.
pub fn position_of(listen: &Listen) -> String {
    let hops = listen.plan.as_ref().map(|plan| plan.hops.as_slice()).unwrap_or_default();
    hops.len().checked_sub(2).map(|i| hops[i].to.clone()).unwrap_or_default()
}

/// The listen's heads: its plan's earlier hops walked through the engine off
/// its connection, in its own file, as a walk in a run reads them (each
/// hop's WHERE, the part its module takes and the part the engine checks
/// alike), with no run row. More than lf.yaml's `listenScopeLimit` is a
/// failure, never a cut.
pub async fn resolve_heads(session: &Session, set: &FileSet, listen: &Listen) -> Result<Vec<Head>, ResolveFailure> {
    let plan = listen.plan.as_ref().ok_or_else(|| ResolveFailure::Read("it is not a listen on a traversal".into()))?;
    let earlier = &plan.hops[..plan.hops.len().saturating_sub(1)];
    let source = &set.file(&listen.file).source;
    let positions = session.read_positions(set, source, &plan.connection, earlier).await.map_err(ResolveFailure::Read)?;
    let mut seen = BTreeSet::new();
    let mut heads = Vec::new();
    for position in positions {
        let head = head_of(&position).ok_or_else(|| ResolveFailure::Read(format!("a record it landed on names no id: {}", position.to_json())))?;
        if seen.insert(head.record_id.clone()) {
            heads.push(head);
        }
    }
    let limit = session.project.listen_scope_limit;
    if heads.len() > limit {
        return Err(ResolveFailure::OverLimit { matched: heads.len(), limit });
    }
    Ok(heads)
}

fn head_of(position: &Js) -> Option<Head> {
    let identity = position.get("identity")?;
    let record_id = match identity.get("recordId")? {
        Js::Str(id) => id.clone(),
        Js::Num(n) => n.to_string(),
        _ => return None,
    };
    let record_type = position.get("recordType").and_then(Js::as_str).unwrap_or_default().to_string();
    Some(Head { record_id, record_type, data: identity.get("data").cloned().unwrap_or(Js::Null) })
}

/// How a set's listens are read as it opens.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Opening {
    /// A session that only runs or inspects: each is watched on the heads
    /// the store kept, and nothing is listed.
    Kept,
    /// The session that routes listens opens: those the store kept no heads
    /// for, or a failure for, are resolved now, and every failure is said.
    Routing,
    /// A routing session's set was reloaded: as `Routing`, saying only the
    /// failures that changed.
    Reloaded,
}

/// The listens of the set with a hop the host resolves, read as the set
/// opens (`opening`): each watched on the heads the store kept for it, or
/// resolved now. The failures to print.
pub async fn open(session: &Session, set: &FileSet, opening: Opening) -> Result<Vec<String>, String> {
    let mut lines = Vec::new();
    for listen in set.listens.iter().filter(|l| crate::edge_polls::resolves(l)) {
        let pipeline = listen.pipeline();
        let kept = session.store.listen_state(&pipeline).map_err(|e| e.to_string())?;
        match (opening, kept) {
            (_, Some(state)) if state.failure.is_none() => set.watch(listen, state.heads),
            (Opening::Kept, _) => {}
            (Opening::Reloaded, _) => lines.extend(resolve(session, set, listen).await?),
            (Opening::Routing, _) => {
                resolve(session, set, listen).await?;
                let now = session.store.listen_state(&pipeline).map_err(|e| e.to_string())?;
                lines.extend(now.and_then(|state| state.failure));
            }
        }
    }
    Ok(lines)
}

/// Resolve the listen again, keep what it came to, and watch its last edge
/// under its heads from now: a head that dropped out loses its cursor. The
/// line to print when its failure changed (one that cleared included).
pub async fn resolve(session: &Session, set: &FileSet, listen: &Listen) -> Result<Option<String>, String> {
    let pipeline = listen.pipeline();
    let before = session.store.listen_state(&pipeline).map_err(|e| e.to_string())?.unwrap_or_default();
    let polled = crate::edge_polls::polled_keys(set);
    let (state, watching) = match resolve_heads(session, set, listen).await {
        Ok(heads) => {
            let heads: Vec<String> = heads.into_iter().map(|h| h.record_id).collect();
            (ListenState { heads: heads.clone(), resolved_at: iso(0), failure: None, paused: before.paused.clone() }, heads)
        }
        Err(failure) => {
            // Suspended over the limit; a failed read keeps watching what it watched.
            let watching = match failure {
                ResolveFailure::OverLimit { .. } => Vec::new(),
                ResolveFailure::Read(_) => before.heads.clone(),
            };
            (ListenState { failure: Some(failure.line(listen)), resolved_at: iso(0), ..before.clone() }, watching)
        }
    };
    session.store.save_listen_state(&pipeline, &state).map_err(|e| e.to_string())?;
    set.watch(listen, watching);
    let still = crate::edge_polls::polled_keys(set);
    for key in polled.keys().filter(|key| key.scope.is_some() && !still.contains_key(*key)) {
        session.store.save_inbound_checkpoint(&crate::edge_polls::poll_subscription(key), &Js::Null).map_err(|e| e.to_string())?;
    }
    Ok(match (&before.failure, &state.failure) {
        (before, now) if before == now => None,
        (_, Some(failure)) => Some(failure.clone()),
        (Some(_), None) => Some(format!("{}:{} watches {} again", listen.file, listen.movement_name, counted(state.heads.len(), &position_of(listen)))),
        (None, None) => None,
    })
}

/// `n` of `position`, said as a person counts them.
pub fn counted(n: usize, position: &str) -> String {
    match n {
        1 => format!("1 {position}"),
        n => format!("{n} {position}s"),
    }
}

/// How often the listen is resolved again on a clock, in milliseconds: the
/// operator's `resolveEvery` for its connection (the credential it names,
/// else its module), else the shortest `relistEverySeconds` its resolved
/// hops declare. None: no hop declares one (its module reports its parents'
/// changes, `parentChanges: pushed`), and the operator names none.
pub fn every_ms(set: &FileSet, listen: &Listen, resolve_every: &std::collections::BTreeMap<String, i64>) -> Option<i64> {
    if !crate::edge_polls::resolves(listen) {
        return None;
    }
    if let Some(ms) = resolve_every.get(listen.credential.as_deref().unwrap_or(&listen.adapter)) {
        return Some(*ms);
    }
    resolved_hops(set, listen)
        .filter_map(|(_, declared)| match declared.get("relistEverySeconds") {
            Some(Js::Num(seconds)) => seconds.as_u64(),
            _ => None,
        })
        .min().map(|seconds| seconds as i64 * 1000)
}

/// The edges of the listen's resolved hops whose module reports their
/// members' changes (`parentChanges: pushed`): an arrival on one resolves
/// the listen again.
pub fn pushed_parents(set: &FileSet, listen: &Listen) -> Vec<String> {
    resolved_hops(set, listen).filter(|(_, declared)| declared.get("parentChanges").and_then(Js::as_str) == Some("pushed")).map(|(edge, _)| edge).collect()
}

fn resolved_hops<'a>(set: &'a FileSet, listen: &'a Listen) -> impl Iterator<Item = (String, Js)> + 'a {
    let hops = listen.plan.as_ref().map(|plan| plan.hops.as_slice()).unwrap_or_default();
    hops.iter().filter(|hop| hop.judged == HopJudged::Resolved).filter_map(move |hop| Some((hop.edge.clone(), crate::edge_polls::hop_schema(set, listen, hop)?)))
}

/// The work row that resolves the listen again, as it is armed.
pub fn row_payload(listen: &Listen) -> Js {
    Js::Obj(Obj::from_iter([("pipeline".to_string(), Js::Str(listen.pipeline()))]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listens_state_crosses_the_store_wire_as_it_is() {
        let state = ListenState { heads: vec!["b1".into(), "b2".into()], resolved_at: "2026-10-31T09:00:00.000Z".into(), failure: Some("LISTEN_SCOPE_LIMIT: …".into()), paused: None };
        assert_eq!(
            state.to_js().to_json(),
            r#"{"heads":["b1","b2"],"resolvedAt":"2026-10-31T09:00:00.000Z","failure":"LISTEN_SCOPE_LIMIT: …","paused":null}"#
        );
        assert_eq!(ListenState::from_js(&state.to_js()), Some(state));
        assert_eq!(ListenState::from_js(&Js::parse(br#"{"heads":[1],"resolvedAt":"x"}"#).unwrap()), None, "a head is an id");
        assert_eq!(ListenState::from_js(&Js::parse(br#"{"heads":[]}"#).unwrap()), None, "it was resolved at some time");
    }

    #[test]
    fn a_head_is_named_by_the_id_its_position_carries() {
        let position = Js::parse(br#"{"adapterType":"feed","recordType":"Board","identity":{"kind":"stable","recordId":"b1","data":{"Name":"Ops"}}}"#).unwrap();
        let head = head_of(&position).unwrap();
        assert_eq!((head.record_id.as_str(), head.record_type.as_str(), head.data.to_json()), ("b1", "Board", r#"{"Name":"Ops"}"#.to_string()));
        let numbered = Js::parse(br#"{"recordType":"Board","identity":{"kind":"stable","recordId":7}}"#).unwrap();
        assert_eq!(head_of(&numbered).unwrap().record_id, "7");
        assert_eq!(head_of(&Js::parse(br#"{"recordType":"Board","identity":{"kind":"unstable","data":{}}}"#).unwrap()), None);
    }

    #[test]
    fn a_failure_is_said_by_name() {
        let plan = r#"{"movement":"a","connection":"f","adapter":"feed","hops":[{"edge":"Boards","from":"","to":"Board","judged":"resolved"},{"edge":"Notes","from":"Board","to":"Note","judged":"arrival"}]}"#;
        let listen = Listen {
            file: "notes".into(),
            adapter: "feed".into(),
            config: Obj::new(),
            movement_name: "a".into(),
            credential: None,
            payload: None,
            args: Vec::new(),
            address: Ok(Default::default()),
            plan: Some(serde_json::from_str(plan).unwrap()),
        };
        assert_eq!(position_of(&listen), "Board");
        assert_eq!(
            ResolveFailure::OverLimit { matched: 3, limit: 2 }.line(&listen),
            "LISTEN_SCOPE_LIMIT: notes:a matched 3 Boards, over the limit of 2; it is suspended until its filter matches fewer"
        );
        assert_eq!(ResolveFailure::Read("feed: down".into()).line(&listen), "LISTEN_RESOLVE_FAILED: notes:a could not list the Boards it watches: feed: down");
        assert_eq!((counted(1, "Board"), counted(2, "Board"), counted(0, "Board")), ("1 Board".to_string(), "2 Boards".to_string(), "0 Boards".to_string()));
    }
}

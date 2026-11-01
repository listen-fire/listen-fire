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
//!   `parentChanges: pushed`: listen-fire polls or subscribes to that edge
//!   for the listen itself (crate::edge_polls), and no row is armed for it;
//! - as a routing process opens, for a listen never resolved (an edited
//!   listen among them, or one whose connection is constructed otherwise:
//!   its plan and its connection name its pipeline, its state with it), or
//!   one whose last resolve failed;
//! - once another process's hold on it is let go or lapses, when a resolve
//!   met that hold (`arm_again`).
//!
//! A listen with none of these is resolved at open only, said once as it
//! opens. The store keeps the heads, and every process routing the listen
//! watches what it keeps, whichever process listed them; one process lists
//! a listen at a time, under a hold the store keeps. A head that drops out
//! loses its cursor, so one that comes back is watched from then, its
//! changes in between never replayed. A listen whose hops match more heads
//! than lf.yaml's `listenScopeLimit` is suspended, watched nowhere, until
//! they match fewer; one whose read fails keeps the heads it had. Either is
//! said, named, by `listen-fire listens`, and printed when it starts and
//! whenever it changes.

use std::collections::{BTreeMap, BTreeSet};

use movement_parser::listen_plan::{HopJudged, PlanHop};

use crate::json::{Js, Obj};
use crate::obj;
use crate::routing::Listen;
use crate::runs::{FileSet, Session, Walk};
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
    /// `LISTEN_SCOPE_LIMIT`: a hop of it matches more records than lf.yaml's
    /// `listenScopeLimit`, `limit` (how many more is never read): its heads,
    /// or the records a hop reported per record hangs off, of the type
    /// `position`.
    OverLimit { limit: usize, position: String },
    /// `LISTEN_RESOLVE_FAILED`: the read did not answer.
    Read(String),
}

impl ResolveFailure {
    /// The line `listen-fire listens` shows, and listen-fire prints.
    pub fn line(&self, listen: &Listen) -> String {
        let named = format!("{}:{}", listen.file, listen.movement_name);
        match self {
            ResolveFailure::OverLimit { limit, position } => {
                format!("LISTEN_SCOPE_LIMIT: {named} matched more {position}s than its limit of {limit}; it is suspended until its filter matches fewer")
            }
            ResolveFailure::Read(why) => format!("LISTEN_RESOLVE_FAILED: {named} could not list the {}s it watches: {why}", position_of(listen)),
        }
    }
}

/// What a listen's last resolve came to, as the store keeps it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Resolution {
    /// The ids of the records its last edge is watched under: every process
    /// routing it watches these: none while it is suspended over its limit.
    pub heads: Vec<String>,
    /// When `heads` were listed; None: never. A failed read leaves it.
    pub resolved_at: Option<String>,
    /// Why its last resolve failed; None: it did not.
    pub failure: Option<String>,
    /// By edge, the ids of the records that edge is watched under for the
    /// listen when they are not its heads: for each resolved hop whose module
    /// reports its changes per record it hangs off (`parentChanges: pushed`
    /// with `delivery: scope`, Airtable's `Tables` per base), those records;
    /// for a last edge scoped by an earlier hop (`scopedBy`, Airtable's
    /// `Changes` by `Bases`), the records that hop landed on. Kept with the
    /// heads, listed by the same resolve.
    pub parents: BTreeMap<String, Vec<String>>,
}

/// What the store keeps of a listen with a hop the host resolves
/// (`listens.states`): what its resolves came to, which resolving writes,
/// why it is paused (None: it is not) and how many arrivals it held and did
/// not run while paused, which only a pause, a held arrival or a resume
/// writes. A resume clears the count.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ListenState {
    pub resolution: Resolution,
    pub paused: Option<String>,
    pub held: u64,
}

fn opt(value: &Option<String>) -> Js {
    value.as_deref().map(Js::str).unwrap_or(Js::Null)
}

impl Resolution {
    /// As the store wire carries it (`listens.saveResolution`).
    pub fn to_js(&self) -> Js {
        Js::Obj(self.members())
    }

    fn members(&self) -> Obj {
        let mut members = obj! {
            "heads" => Js::strings(self.heads.clone()),
            "resolvedAt" => opt(&self.resolved_at),
            "failure" => opt(&self.failure),
        };
        if !self.parents.is_empty() {
            let parents = self.parents.iter().map(|(edge, ids)| (edge.clone(), Js::strings(ids.clone())));
            members.insert("parents".into(), Js::Obj(parents.collect()));
        }
        members
    }

    /// None: the value is not a resolution.
    pub fn from_js(value: &Js) -> Option<Resolution> {
        let ids = |list: &Js| list.as_array()?.iter().map(|h| h.as_str().map(str::to_string)).collect::<Option<Vec<_>>>();
        let heads = ids(value.get("heads")?)?;
        // A store that predates them keeps none: nothing reported per record.
        let parents = match value.get("parents") {
            None | Some(Js::Null) => BTreeMap::new(),
            Some(Js::Obj(parents)) => parents.iter().map(|(edge, list)| Some((edge.clone(), ids(list)?))).collect::<Option<_>>()?,
            Some(_) => return None,
        };
        Some(Resolution { heads, resolved_at: text(value, "resolvedAt")?, failure: text(value, "failure")?, parents })
    }
}

impl ListenState {
    /// As the store wire carries it (`listens.states`).
    pub fn to_js(&self) -> Js {
        let mut members = self.resolution.members();
        members.insert("paused".into(), opt(&self.paused));
        members.insert("held".into(), Js::Num(self.held.into()));
        Js::Obj(members)
    }

    /// None: the value is not a listen's state.
    pub fn from_js(value: &Js) -> Option<ListenState> {
        // A store that predates the count answers none: no arrival held.
        let held = match value.get("held") {
            None | Some(Js::Null) => 0,
            Some(Js::Num(n)) => n.as_u64()?,
            Some(_) => return None,
        };
        Some(ListenState { resolution: Resolution::from_js(value)?, paused: text(value, "paused")?, held })
    }
}

/// A member that is a string or null; None: it is neither.
fn text(value: &Js, key: &str) -> Option<Option<String>> {
    match value.get(key) {
        None | Some(Js::Null) => Some(None),
        Some(Js::Str(s)) => Some(Some(s.clone())),
        Some(_) => None,
    }
}

/// The record type a listen's last edge hangs off: what its heads are.
pub fn position_of(listen: &Listen) -> String {
    let hops = listen.plan.hops.as_slice();
    hops.len().checked_sub(2).map(|i| hops[i].to.clone()).unwrap_or_default()
}

/// What a listen's earlier hops land on: its heads, and the records each
/// resolved hop reported per record hangs off.
pub struct Listed {
    pub heads: Vec<Head>,
    /// By the hop's edge (`Resolution.parents`).
    pub parents: BTreeMap<String, Vec<String>>,
}

/// The listen's heads, and the records each resolved hop whose module
/// reports its changes per record it hangs off (`reported_per_record`)
/// hangs off: its plan's earlier hops walked once through the engine off its
/// connection, in its own file, as a walk in a run reads them (each hop's
/// WHERE, the part its module takes and the part the engine checks alike),
/// with no run row. A hop's records are read from that walk: what the hop
/// before it landed on, whether or not a later hop went on from them. More
/// than lf.yaml's `listenScopeLimit` of either is a failure, never a cut,
/// named by the type that overflowed: the walk stops one past it at its
/// last hop, so a listen over its limit is never listed whole.
pub async fn resolve_walk(session: &Session, set: &FileSet, listen: &Listen) -> Result<Listed, ResolveFailure> {
    let plan = &listen.plan;
    let earlier = &plan.hops[..plan.hops.len().saturating_sub(1)];
    let limit = session.project.listen_scope_limit;
    let walk = Walk { source: &set.file(&listen.file).source, connection: &plan.connection, hops: earlier, limit: Some(limit) };
    let walked = session.read_positions(set, walk).await.map_err(ResolveFailure::Read)?;
    // What each earlier hop landed on: `along`, then the heads' own hop.
    let landed_by = |hop: usize| if hop + 1 == earlier.len() { Some(&walked.landed) } else { walked.along.get(hop) };
    let mut parents = BTreeMap::new();
    let mut watched_under = |edge: &str, hop: usize| -> Result<(), ResolveFailure> {
        let level = landed_by(hop).ok_or_else(|| ResolveFailure::Read(format!("the walk said nothing of what {} landed on", plan.hops[hop].edge)))?;
        let ids = distinct_heads(level)?.into_iter().map(|head| head.record_id).collect::<Vec<_>>();
        if ids.len() > limit {
            return Err(ResolveFailure::OverLimit { limit, position: plan.hops[hop].to.clone() });
        }
        parents.insert(edge.to_string(), ids);
        Ok(())
    };
    for index in reported_per_record(set, listen) {
        watched_under(&plan.hops[index].edge, index - 1)?;
    }
    if let Some(last) = plan.hops.last()
        && let Some(scoped_by) = crate::edge_polls::declared(set, listen).and_then(|declared| declared.scoped_by)
    {
        let hop = earlier.iter().rposition(|hop| hop.edge == scoped_by).ok_or_else(|| {
            ResolveFailure::Read(format!("its module subscribes to '{}' once per record its '{scoped_by}' hop lands on, and no earlier hop of the listen walks '{scoped_by}'", last.edge))
        })?;
        watched_under(&last.edge, hop)?;
    }
    let heads = distinct_heads(&walked.landed)?;
    if heads.len() > limit {
        return Err(ResolveFailure::OverLimit { limit, position: position_of(listen) });
    }
    Ok(Listed { heads, parents })
}

/// The records `positions` are, each once, in the order first landed on.
fn distinct_heads(positions: &[Js]) -> Result<Vec<Head>, ResolveFailure> {
    let mut seen = BTreeSet::new();
    let mut heads = Vec::new();
    for position in positions {
        let head = head_of(position).ok_or_else(|| ResolveFailure::Read(format!("a record it landed on names no id: {}", position.to_json())))?;
        if seen.insert(head.record_id.clone()) {
            heads.push(head);
        }
    }
    Ok(heads)
}

/// The indexes of the listen's resolved hops whose module reports their
/// changes per record they hang off (`parentChanges: pushed` with
/// `delivery: scope`): each is watched once per such record.
pub fn reported_per_record(set: &FileSet, listen: &Listen) -> Vec<usize> {
    let hops = listen.plan.hops.as_slice();
    hops.iter()
        .enumerate()
        .filter(|(index, hop)| *index > 0 && hop.judged == HopJudged::Resolved)
        .filter(|(_, hop)| {
            crate::edge_polls::hop_schema(set, listen, hop).is_some_and(|declared| {
                declared.get("parentChanges").and_then(Js::as_str) == Some("pushed") && declared.get("delivery").and_then(Js::as_str) == Some("scope")
            })
        })
        .map(|(index, _)| index)
        .collect()
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
    /// The session that routes listens opens: each is watched on the heads
    /// the store kept, and those it kept none for, or a failure for, are
    /// resolved now (an edited listen is another listen, its pipeline named
    /// by its plan and its connection, so it was never resolved); every
    /// failure is said, and a failure that cleared.
    Routing,
    /// A routing session's set was reloaded: as `Routing`, saying only the
    /// failures that changed.
    Reloaded,
}

/// The listens of the set with a hop the host resolves, read as the set
/// opens (`opening`): each watched on the heads the store kept for it, or
/// resolved now. The lines to print: failures, and each listen resolved
/// only as listen-fire opens, said once.
pub async fn open(session: &Session, set: &FileSet, opening: Opening) -> Result<Vec<String>, String> {
    let kept = watch_kept(session, set)?.states;
    let mut lines = Vec::new();
    if opening == Opening::Kept {
        return Ok(lines);
    }
    for listen in set.listens.iter().filter(|l| crate::edge_polls::resolves(l)) {
        let pipeline = listen.pipeline();
        if let Some(line) = at_open_only(session, set, listen)
            && session.says_once(&line)
        {
            lines.push(line);
        }
        let stale = kept.get(&pipeline).is_none_or(|state| state.resolution.resolved_at.is_none() || state.resolution.failure.is_some());
        if !stale {
            continue;
        }
        let changed = match resolve(session, set, listen).await? {
            Resolved::Kept(line) => line,
            Resolved::Elsewhere => {
                arm_again(session, listen)?;
                None
            }
        };
        match opening {
            Opening::Routing => {
                let failure = session.store.listen_state(&pipeline).map_err(|e| e.to_string())?.and_then(|state| state.resolution.failure);
                lines.extend(failure.or(changed));
            }
            Opening::Reloaded => lines.extend(changed),
            Opening::Kept => {}
        }
    }
    Ok(lines)
}

/// What the store keeps of a set's listens, as `watch_kept` read it.
pub struct Kept {
    pub states: BTreeMap<String, ListenState>,
    /// Some listen's heads were not those this process watched.
    pub moved: bool,
}

/// Watch each listen of the set with a hop the host resolves on the heads
/// the store keeps for it: every process routing it watches those, whichever
/// resolved it (one that kept none watches none). One read of the store.
pub fn watch_kept(session: &Session, set: &FileSet) -> Result<Kept, String> {
    let resolving: Vec<&Listen> = set.listens.iter().filter(|l| crate::edge_polls::resolves(l)).collect();
    if resolving.is_empty() {
        return Ok(Kept { states: BTreeMap::new(), moved: false });
    }
    let pipelines: Vec<String> = resolving.iter().map(|l| l.pipeline()).collect();
    let states = session.store.listen_states(&pipelines).map_err(|e| e.to_string())?;
    let mut moved = false;
    for (listen, pipeline) in resolving.into_iter().zip(&pipelines) {
        let resolution = states.get(pipeline).map(|state| state.resolution.clone()).unwrap_or_default();
        moved |= set.watch(listen, resolution.heads);
        moved |= set.watch_parents(listen, resolution.parents);
    }
    Ok(Kept { states, moved })
}

/// The line said of a listen resolved only as listen-fire opens: none of
/// its resolved hops declares a cadence (`relistEverySeconds`) or reports
/// its changes (`parentChanges: pushed`), and lf.yaml names no
/// `resolveEvery` for its connection. None for any other.
pub fn at_open_only(session: &Session, set: &FileSet, listen: &Listen) -> Option<String> {
    if !resolved_at_open_only(session, set, listen) {
        return None;
    }
    let connection = listen.credential.as_deref().unwrap_or(&listen.adapter);
    Some(format!(
        "{}:{} is resolved at open only: no hop it resolves declares relistEverySeconds or parentChanges: pushed, so the {}s it watches are listed again only when listen-fire opens; lf.yaml's `resolveEvery: {{ {connection}: <duration> }}` lists them on a clock",
        listen.file,
        listen.movement_name,
        position_of(listen)
    ))
}

/// Whether the listen is resolved only as listen-fire opens (`at_open_only`).
pub fn resolved_at_open_only(session: &Session, set: &FileSet, listen: &Listen) -> bool {
    crate::edge_polls::resolves(listen) && every_ms(set, listen, &session.project.resolve_every).is_none() && pushed_parents(set, listen).is_empty()
}

/// How long one resolve holds a listen, so two processes never list it at
/// once: past it, a resolve that has not kept what it listed is taken
/// over, and keeps nothing.
const RESOLVE_HOLD_MS: i64 = 60_000;

/// What resolving a listen came to.
pub enum Resolved {
    /// It was listed and kept: the line to print when its failure changed
    /// (one that cleared included).
    Kept(Option<String>),
    /// Another process holds it, listing it now: it is watched on what that
    /// one keeps (`watch_kept`). That listing may have begun before what
    /// asked for this one changed, or its process may be gone, so the
    /// listen is listed again once the hold is let go (`arm_again`).
    Elsewhere,
}

/// The listen's `resolve_listen` row, due now: a resolve another process
/// held is tried again by whichever worker claims it, until the hold is let
/// go or lapses (`Next::Busy` on each try it meets the hold). It is the
/// listen's one row, so a listen also resolved on a clock has its next
/// resolve brought forward, never a second row.
pub fn arm_again(session: &Session, listen: &Listen) -> Result<(), String> {
    session.store.enqueue(RESOLVE_WORK_KIND, &row_key(listen), &row_payload(listen), None, None).map_err(|e| e.to_string())?;
    crate::wake::queued(RESOLVE_WORK_KIND, None);
    Ok(())
}

/// Resolve the listen again, keep what it came to, and watch its last edge
/// under its heads from now: a head that dropped out loses its cursor. Over
/// its limit it is suspended, watched nowhere; a failed read keeps the heads
/// it had, and when they were listed. Its pause is the pause's own.
pub async fn resolve(session: &Session, set: &FileSet, listen: &Listen) -> Result<Resolved, String> {
    let pipeline = listen.pipeline();
    let Some(token) = session.store.claim_listen_resolve(&pipeline, RESOLVE_HOLD_MS).map_err(|e| e.to_string())? else {
        return Ok(Resolved::Elsewhere);
    };
    let before = session.store.listen_state(&pipeline).map_err(|e| e.to_string())?.unwrap_or_default().resolution;
    let polled = crate::edge_polls::polled_keys(set);
    let resolution = match resolve_walk(session, set, listen).await {
        Ok(Listed { heads, parents }) => Resolution { heads: heads.into_iter().map(|h| h.record_id).collect(), resolved_at: Some(iso(0)), failure: None, parents },
        Err(failure @ ResolveFailure::OverLimit { .. }) => Resolution { heads: Vec::new(), resolved_at: Some(iso(0)), failure: Some(failure.line(listen)), parents: BTreeMap::new() },
        Err(failure @ ResolveFailure::Read(_)) => Resolution { failure: Some(failure.line(listen)), ..before.clone() },
    };
    if !session.store.save_listen_resolution(&pipeline, &token, &resolution).map_err(|e| e.to_string())? {
        return Ok(Resolved::Elsewhere);
    }
    set.watch(listen, resolution.heads.clone());
    set.watch_parents(listen, resolution.parents.clone());
    let still = crate::edge_polls::polled_keys(set);
    for key in polled.keys().filter(|key| key.scope.is_some() && !still.contains_key(*key)) {
        session.store.save_inbound_checkpoint(&crate::edge_polls::poll_subscription(key), &Js::Null).map_err(|e| e.to_string())?;
    }
    Ok(Resolved::Kept(match (&before.failure, &resolution.failure) {
        (before, now) if before == now => None,
        (_, Some(failure)) => Some(failure.clone()),
        (Some(_), None) => Some(format!("{}:{} watches {} again", listen.file, listen.movement_name, counted(resolution.heads.len(), &position_of(listen)))),
        (None, None) => None,
    }))
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
        .into_iter()
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
    pushed_parent_hops(set, listen).into_iter().map(|hop| hop.edge.clone()).collect()
}

/// The listen's resolved hops whose module reports their changes.
pub fn pushed_parent_hops<'a>(set: &FileSet, listen: &'a Listen) -> Vec<&'a PlanHop> {
    resolved_hops(set, listen).into_iter().filter(|(_, declared)| declared.get("parentChanges").and_then(Js::as_str) == Some("pushed")).map(|(hop, _)| hop).collect()
}

/// The listen's resolved hops, each with what its module declares of it.
fn resolved_hops<'l>(set: &FileSet, listen: &'l Listen) -> Vec<(&'l PlanHop, Js)> {
    let hops = listen.plan.hops.as_slice();
    hops.iter().filter(|hop| hop.judged == HopJudged::Resolved).filter_map(|hop| Some((hop, crate::edge_polls::hop_schema(set, listen, hop)?))).collect()
}

/// The key of the work row that resolves the listen again: one per listen.
pub fn row_key(listen: &Listen) -> String {
    format!("{RESOLVE_WORK_KIND}:{}", listen.pipeline())
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
        let resolution = Resolution { heads: vec!["b1".into(), "b2".into()], resolved_at: Some("2026-10-31T09:00:00.000Z".into()), failure: Some("LISTEN_SCOPE_LIMIT: …".into()), parents: BTreeMap::new() };
        assert_eq!(resolution.to_js().to_json(), r#"{"heads":["b1","b2"],"resolvedAt":"2026-10-31T09:00:00.000Z","failure":"LISTEN_SCOPE_LIMIT: …"}"#);
        assert_eq!(Resolution::from_js(&resolution.to_js()), Some(resolution.clone()));
        let state = ListenState { resolution, paused: Some("LISTEN_LOOP: …".into()), held: 3 };
        assert_eq!(state.to_js().to_json(), r#"{"heads":["b1","b2"],"resolvedAt":"2026-10-31T09:00:00.000Z","failure":"LISTEN_SCOPE_LIMIT: …","paused":"LISTEN_LOOP: …","held":3}"#);
        assert_eq!(ListenState::from_js(&state.to_js()), Some(state));
        let never = ListenState::default();
        assert_eq!(never.to_js().to_json(), r#"{"heads":[],"resolvedAt":null,"failure":null,"paused":null,"held":0}"#, "never resolved");
        assert_eq!(ListenState::from_js(&never.to_js()), Some(never.clone()));
        assert_eq!(ListenState::from_js(&Js::parse(br#"{"heads":[],"resolvedAt":null,"failure":null,"paused":null}"#).unwrap()), Some(never), "a store that keeps no count holds none");
        assert_eq!(ListenState::from_js(&Js::parse(br#"{"heads":[],"held":-1}"#).unwrap()), None, "a count is a whole number");
        assert_eq!(ListenState::from_js(&Js::parse(br#"{"heads":[1],"resolvedAt":"x"}"#).unwrap()), None, "a head is an id");
        assert_eq!(ListenState::from_js(&Js::parse(br#"{"resolvedAt":"x"}"#).unwrap()), None, "its heads are said, if none");
        let per_base = Resolution { heads: vec!["tblA".into()], parents: BTreeMap::from([("Tables".to_string(), vec!["appA".to_string()])]), ..Resolution::default() };
        assert_eq!(per_base.to_js().to_json(), r#"{"heads":["tblA"],"resolvedAt":null,"failure":null,"parents":{"Tables":["appA"]}}"#, "the records a hop reported per record hangs off are kept beside the heads");
        assert_eq!(Resolution::from_js(&per_base.to_js()), Some(per_base));
        assert_eq!(Resolution::from_js(&Js::parse(br#"{"heads":[],"parents":{"Tables":[1]}}"#).unwrap()), None, "a parent is an id");
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
            movement_name: "a".into(),
            credential: None,
            payload: None,
            args: Vec::new(),
            plan: serde_json::from_str(plan).unwrap(),
            trigger_awaits: Default::default(),
        };
        assert_eq!(position_of(&listen), "Board");
        assert_eq!(
            ResolveFailure::OverLimit { limit: 2, position: position_of(&listen) }.line(&listen),
            "LISTEN_SCOPE_LIMIT: notes:a matched more Boards than its limit of 2; it is suspended until its filter matches fewer"
        );
        assert_eq!(
            ResolveFailure::OverLimit { limit: 1, position: "Base".into() }.line(&listen),
            "LISTEN_SCOPE_LIMIT: notes:a matched more Bases than its limit of 1; it is suspended until its filter matches fewer",
            "the records a hop reported per record hangs off overflowed: said by their type"
        );
        assert_eq!(ResolveFailure::Read("feed: down".into()).line(&listen), "LISTEN_RESOLVE_FAILED: notes:a could not list the Boards it watches: feed: down");
        assert_eq!((counted(1, "Board"), counted(2, "Board"), counted(0, "Board")), ("1 Board".to_string(), "2 Boards".to_string(), "0 Boards".to_string()));
    }
}

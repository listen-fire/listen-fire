//! Shared polls: the listens on traversals of one polled edge are polled
//! together. Every listen whose last edge is the same edge of the same
//! connection, with the same filter the module takes on it and the same
//! scope, shares one `PollKey`: one `poll_edge` work row, one cursor, one
//! call to the module per interval. Each arrival a poll returns is judged
//! against each listen sharing it (crate::runs `fire_arrivals`), and runs a
//! listen once per identity and version, as a pushed arrival does.
//!
//! The interval is the operator's: lf.yaml's `pollEvery` for the credential
//! the connection polls as (its module, for one that uses none), else what
//! the edge declares (`pollEverySeconds`). listen-fire has no number of its
//! own: describe refuses a polled edge that declares none.
//!
//! An edge pushed to the connection or per scope is shared the same way, by
//! one subscription per key (crate::subscriptions). A listen whose earlier
//! hops the host resolves is watched once per head on an edge polled or
//! pushed per scope, and once for all its heads on an edge pushed to the
//! connection (its arrivals name the head they are under).
//!
//! A resolved hop whose module reports its records' changes
//! (`parentChanges: pushed`) is watched for the listen too: listen-fire
//! polls or subscribes to that hop's edge itself, sharing the key of any
//! listen on it, and what arrives there fires nothing of the listen's own:
//! it lists the listen's heads again (crate::resolve).

use std::collections::BTreeMap;

use movement_parser::catalog::types::Delivery;
use movement_parser::listen_plan::HopJudged;
use sha2::{Digest, Sha256};

use crate::json::Js;
use crate::obj;
use crate::routing::Listen;
use crate::runs::FileSet;

/// A shared poll's row in the work queue: its next poll.
pub const EDGE_POLL_WORK_KIND: &str = "poll_edge";

/// What the listens sharing one poll or subscription share.
#[derive(Ord, PartialOrd, Eq, PartialEq, Clone, Debug)]
pub struct PollKey {
    pub adapter: String,
    /// The credential the connection's construction names; None for one
    /// that names none.
    pub credential: Option<String>,
    /// The canonical JSON of the connection's position (the construction's
    /// arguments the module declares as position args, as the module is
    /// handed them), "" for none: two connections that differ only there
    /// read different data.
    pub position: String,
    pub edge: String,
    /// The record the edge hangs off, by its id, for a listen whose earlier
    /// hops the host resolves; None for one over the whole connection.
    pub scope: Option<String>,
    /// The canonical JSON of the part of the last hop's filter the module
    /// takes, "" for none.
    pub taken: String,
}

impl PollKey {
    /// As a work row carries it, and as its subscription id is made from.
    pub fn to_js(&self) -> Js {
        let mut key = obj! { "adapter" => Js::str(&self.adapter), "edge" => Js::str(&self.edge), "taken" => Js::str(&self.taken) };
        if let Some(credential) = &self.credential {
            key.insert("credential".into(), Js::str(credential));
        }
        if !self.position.is_empty() {
            key.insert("position".into(), Js::str(&self.position));
        }
        if let Some(scope) = &self.scope {
            key.insert("scope".into(), Js::str(scope));
        }
        Js::Obj(key)
    }

    /// The filter the module is handed: the taken part, as the plan has it.
    pub fn filter(&self) -> Option<serde_json::Value> {
        (!self.taken.is_empty()).then(|| serde_json::from_str(&self.taken).expect("a taken part is written as JSON"))
    }

    /// The connection's position, as the module is handed it on each call
    /// for the key; None for a connection with none.
    pub fn position_settings(&self) -> Option<serde_json::Value> {
        (!self.position.is_empty()).then(|| serde_json::from_str(&self.position).expect("a position is written as JSON"))
    }

    /// Who the operator names it by in lf.yaml's `pollEvery`: the credential
    /// it polls as, else its module.
    pub fn connection<'a>(&'a self, polled_as: Option<&'a str>) -> &'a str {
        polled_as.unwrap_or(&self.adapter)
    }
}

/// The listens sharing one key: those it fires (their last edge is the
/// key's), and those whose heads an arrival on it lists again (a resolved
/// hop of theirs is on the key's edge, and its module reports that edge's
/// changes), each by its index in `set.listens`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Shared {
    /// What the module declares of the key's edge.
    pub declared: Option<Declared>,
    pub fires: Vec<usize>,
    pub resolves: Vec<usize>,
}

/// The poll keys of the set's listens on traversals, each with the listens
/// sharing it. `heads` gives a listen's scopes: `[None]` for one over the
/// whole connection.
pub fn poll_keys(set: &FileSet, heads: &dyn Fn(&Listen) -> Vec<Option<String>>) -> BTreeMap<PollKey, Shared> {
    keys_of(&set.listens, &|listen| Watched {
        position: position_of(set, listen),
        heads: heads(listen),
        declared: declared(set, listen),
        pushed_parents: crate::resolve::pushed_parent_hops(set, listen).into_iter().map(|hop| (hop.edge.clone(), declared_hop(set, listen, hop))).collect(),
    })
}

/// Where one listen's connection reads, the scopes it is watched in, what
/// its module declares of its last edge, and the edges of its resolved
/// hops that report their changes, with what is declared of each.
struct Watched {
    position: String,
    heads: Vec<Option<String>>,
    declared: Option<Declared>,
    pushed_parents: Vec<(String, Option<Declared>)>,
}

/// The canonical JSON of the position the listen's connection is in, as its
/// module is handed it (crate::externals::RunningExternal::position_settings);
/// "" for none.
fn position_of(set: &FileSet, listen: &Listen) -> String {
    let running = set.running.iter().find(|r| !r.is_plugin() && r.external.manifest.name == listen.adapter);
    running.and_then(|r| r.position_settings(&listen.args)).map(|settings| settings.to_string()).unwrap_or_default()
}

fn keys_of(listens: &[Listen], watched: &dyn Fn(&Listen) -> Watched) -> BTreeMap<PollKey, Shared> {
    let mut keys: BTreeMap<PollKey, Shared> = BTreeMap::new();
    for (index, listen) in listens.iter().enumerate() {
        let Some(last) = listen.plan.as_ref().and_then(|plan| plan.hops.last()) else { continue };
        let taken = last.taken.as_ref().map(|taken| serde_json::to_string(taken).expect("a filter is always JSON")).unwrap_or_default();
        let Watched { position, heads, declared, pushed_parents } = watched(listen);
        let key = |edge: &str, scope: Option<String>, taken: &str| PollKey { adapter: listen.adapter.clone(), credential: listen.credential.clone(), position: position.clone(), edge: edge.to_string(), scope, taken: taken.to_string() };
        // Pushed to the connection, an edge's arrivals are one stream for
        // every head: each names the head it is under.
        let scopes = match declared.as_ref().and_then(|d| d.delivery) {
            Some(Delivery::Connection) if !heads.is_empty() => vec![None],
            _ => heads,
        };
        for scope in scopes {
            let shared = keys.entry(key(&last.edge, scope, &taken)).or_default();
            shared.declared = declared.clone();
            shared.fires.push(index);
        }
        for (edge, declared) in pushed_parents {
            let shared = keys.entry(key(&edge, None, "")).or_default();
            shared.declared = shared.declared.take().or(declared);
            if !shared.resolves.contains(&index) {
                shared.resolves.push(index);
            }
        }
    }
    keys
}

/// What a shared poll's cursor and its subscription are kept under:
/// `edge-poll:` and 16 hex digits of the sha256 of its key.
pub fn poll_subscription(key: &PollKey) -> String {
    format!("edge-poll:{}", digest_of(key))
}

/// What a webhook subscription for the key's edge is kept under, beside the
/// credential's other webhooks, and its door names it by
/// (`/api/public/webhook-sync/<provider>/<credential>/<this>`): `edge-` and
/// the same 16 hex digits as its poll's.
pub fn edge_subscription(key: &PollKey) -> String {
    format!("edge-{}", digest_of(key))
}

/// 16 hex digits of the sha256 of the key's canonical JSON.
fn digest_of(key: &PollKey) -> String {
    Sha256::digest(key.to_js().to_json().as_bytes()).iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}

/// Whether the listen has a hop the host resolves (crate::resolve): it is
/// watched under the heads that hop lands on, not the whole connection.
pub fn resolves(listen: &Listen) -> bool {
    listen.plan.as_ref().is_some_and(|plan| plan.hops.iter().any(|hop| hop.judged == HopJudged::Resolved))
}

/// What a module declares of how one edge's arrivals reach the host.
#[derive(Debug, Clone, PartialEq)]
pub struct Declared {
    pub delivery: Option<Delivery>,
    /// How often it is polled when the operator says nothing.
    pub poll_every_seconds: Option<u64>,
    /// It declares `cursor: false`: a poll lists all of it, however often it is polled.
    pub cursorless: bool,
}

/// What the module declares of the listen's last edge, from the set's
/// catalog: the instance schema its credential names, else any of its
/// module's that declares the edge.
pub fn declared(set: &FileSet, listen: &Listen) -> Option<Declared> {
    declared_hop(set, listen, listen.plan.as_ref()?.hops.last()?)
}

/// What the module declares of one hop's edge of the listen's traversal.
fn declared_hop(set: &FileSet, listen: &Listen, hop: &movement_parser::listen_plan::PlanHop) -> Option<Declared> {
    let edge = hop_schema(set, listen, hop)?;
    let delivery = edge.get("delivery").and_then(Js::as_str).and_then(|d| serde_json::from_value(serde_json::Value::String(d.to_string())).ok());
    let poll_every_seconds = match edge.get("pollEverySeconds") {
        Some(Js::Num(n)) => n.as_u64(),
        _ => None,
    };
    Some(Declared { delivery, poll_every_seconds, cursorless: matches!(edge.get("cursor"), Some(Js::Bool(false))) })
}

/// What the module declares of one hop of the listen's traversal, as the
/// set's catalog has it: the instance schema its credential names, else any
/// of its module's that declares the edge.
pub fn hop_schema(set: &FileSet, listen: &Listen, hop: &movement_parser::listen_plan::PlanHop) -> Option<Js> {
    let schemas = set.catalog.get("adapters")?.get(&listen.adapter)?.get("schemas")?;
    let Js::Obj(schemas) = schemas else { return None };
    let own = listen.credential.as_deref().unwrap_or_default();
    let edge_in = |schema: &Js| match hop.from.as_str() {
        "" => schema.get("collections")?.get(&hop.edge).cloned(),
        from => schema.get("positions")?.get(from)?.get("edges")?.get(&hop.edge).cloned(),
    };
    schemas.get(own).and_then(edge_in).or_else(|| schemas.values().find_map(edge_in))
}

/// The poll keys of the listens on polled edges, each with its listens.
pub fn polled_keys(set: &FileSet) -> BTreeMap<PollKey, Shared> {
    keys_delivered(set, &[Delivery::Polled])
}

/// The keys of the listens on edges pushed to the connection or per scope,
/// each with its listens: each is one webhook subscription
/// (crate::subscriptions).
pub fn pushed_keys(set: &FileSet) -> BTreeMap<PollKey, Shared> {
    keys_delivered(set, &[Delivery::Connection, Delivery::Scope])
}

/// The key of the edge subscription `subscription` (`edge_subscription`),
/// with the listens a delivery through it is judged against; None when no
/// listen shares it any more.
pub fn sharing_subscription(set: &FileSet, subscription: &str) -> Option<(PollKey, Shared)> {
    pushed_keys(set).into_iter().find(|(key, _)| edge_subscription(key) == subscription)
}

fn keys_delivered(set: &FileSet, deliveries: &[Delivery]) -> BTreeMap<PollKey, Shared> {
    let mut keys = poll_keys(set, &|listen| set.heads(listen));
    keys.retain(|_, shared| shared.declared.as_ref().and_then(|d| d.delivery).is_some_and(|d| deliveries.contains(&d)));
    keys
}

/// How often the key's edge is polled, in milliseconds: the operator's
/// `pollEvery` for its connection (`polled_as`, the credential it polls
/// as), else the interval the edge declares.
pub fn interval_ms(poll_every: &BTreeMap<String, i64>, key: &PollKey, polled_as: Option<&str>, declared: Option<&Declared>) -> Result<i64, String> {
    if let Some(ms) = poll_every.get(key.connection(polled_as)) {
        return Ok(*ms);
    }
    match declared.and_then(|d| d.poll_every_seconds) {
        Some(seconds) => Ok(seconds as i64 * 1000),
        None => Err(format!("{}: its polled edge '{}' declares no pollEverySeconds, and lf.yaml's pollEvery names no interval for it", key.adapter, key.edge)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(taken: &str, scope: Option<&str>) -> PollKey {
        PollKey { adapter: "feed".into(), credential: None, position: String::new(), edge: "Notes".into(), scope: scope.map(str::to_string), taken: taken.into() }
    }

    /// A listen on `feed-[n:Notes WHERE …]->` firing `movement`, the taken
    /// part of its WHERE `taken` (a plan's JSON, `null` for none), off a
    /// board the host resolves when `resolved`; one in the settings form
    /// when `taken` is None.
    fn listen(movement: &str, taken: Option<&str>, resolved: bool) -> Listen {
        let from = if resolved { "Board" } else { "" };
        let taken_member = taken.filter(|t| *t != "null").map(|t| format!(r#","taken":{t}"#)).unwrap_or_default();
        let notes = format!(r#"{{"edge":"Notes","from":"{from}","to":"Note","alias":"n","judged":"arrival"{taken_member}}}"#);
        let boards = r#"{"edge":"Boards","from":"","to":"Board","judged":"resolved"}"#;
        let hops = if resolved { format!("[{boards},{notes}]") } else { format!("[{notes}]") };
        let plan = taken.map(|_| serde_json::from_str(&format!(r#"{{"movement":"{movement}","connection":"f","adapter":"feed","hops":{hops}}}"#)).unwrap());
        Listen {
            file: "notes".into(),
            adapter: "feed".into(),
            config: crate::json::Obj::new(),
            movement_name: movement.into(),
            credential: None,
            payload: None,
            args: Vec::new(),
            address: Ok(BTreeMap::new()),
            plan,
        }
    }

    /// A listen watched in `heads`, its last edge delivered as `delivery`.
    fn watched(heads: Vec<Option<String>>, delivery: Delivery) -> Watched {
        Watched { position: String::new(), heads, declared: Some(Declared { delivery: Some(delivery), poll_every_seconds: Some(60), cursorless: false }), pushed_parents: Vec::new() }
    }

    /// The listens firing on each key, as a key's indices.
    fn firing(keys: &BTreeMap<PollKey, Shared>) -> BTreeMap<PollKey, Vec<usize>> {
        keys.iter().map(|(key, shared)| (key.clone(), shared.fires.clone())).collect()
    }

    const TITLE_A: &str = r#"{"type":"compare","op":"eq","left":{"type":"property","propertyTypeId":"Title","fieldOnly":true},"right":{"type":"static","value":"a"}}"#;

    #[test]
    fn listens_on_one_edge_of_one_connection_with_one_taken_filter_and_scope_share_a_poll() {
        let listens = [listen("a", Some("null"), false), listen("b", Some("null"), false), listen("c", Some(TITLE_A), false), listen("settings", None, false)];
        let keys = firing(&keys_of(&listens, &|_| watched(vec![None], Delivery::Polled)));
        assert_eq!(keys.len(), 2, "{keys:?}");
        assert_eq!(keys[&key("", None)], vec![0, 1], "no filter taken: one poll for both");
        let (taken, sharing) = keys.iter().find(|(k, _)| !k.taken.is_empty()).unwrap();
        assert_eq!(sharing, &vec![2], "another taken filter: a poll of its own");
        assert_eq!(taken.filter(), Some(serde_json::from_str(TITLE_A).unwrap()), "the module is handed the taken part");
        assert_eq!(key("", None).filter(), None);
    }

    #[test]
    fn a_listen_is_polled_once_per_scope_its_heads_give() {
        let listens = [listen("a", Some("null"), true), listen("b", Some("null"), true), listen("c", Some("null"), false)];
        assert!(resolves(&listens[0]) && !resolves(&listens[2]));
        let heads = |l: &Listen| match l.movement_name.as_str() {
            "a" => vec![Some("board-1".to_string()), Some("board-2".to_string())],
            "b" => vec![Some("board-2".to_string())],
            _ => vec![None],
        };
        let keys = firing(&keys_of(&listens, &|l| watched(heads(l), Delivery::Polled)));
        assert_eq!(keys.get(&key("", Some("board-1"))), Some(&vec![0]));
        assert_eq!(keys.get(&key("", Some("board-2"))), Some(&vec![0, 1]), "a board both watch is polled once");
        assert_eq!(keys.get(&key("", None)), Some(&vec![2]));
        assert_eq!(keys.len(), 3);
    }

    /// An edge pushed to the connection is one subscription for all of a
    /// listen's heads, its arrivals naming the head each is under; one
    /// pushed per scope is one per head. A suspended listen, watched under
    /// no head, has neither.
    #[test]
    fn a_listen_on_an_edge_pushed_to_the_connection_is_subscribed_once_for_all_its_heads() {
        let listens = [listen("a", Some("null"), true)];
        let two = || vec![Some("board-1".to_string()), Some("board-2".to_string())];
        let connection = firing(&keys_of(&listens, &|_| watched(two(), Delivery::Connection)));
        assert_eq!(connection, BTreeMap::from([(key("", None), vec![0])]));
        let scope = firing(&keys_of(&listens, &|_| watched(two(), Delivery::Scope)));
        assert_eq!(scope.keys().cloned().collect::<Vec<_>>(), [key("", Some("board-1")), key("", Some("board-2"))]);
        assert!(keys_of(&listens, &|_| watched(Vec::new(), Delivery::Connection)).is_empty(), "suspended: watched nowhere");
    }

    /// A resolved hop whose module reports its changes is watched for the
    /// listen: on the hop's own edge, with no filter or scope, its key shared
    /// with a listen that fires on that edge, and firing none of the
    /// listen's own.
    #[test]
    fn a_resolved_hop_that_reports_its_changes_is_watched_for_its_listen() {
        let listens = [listen("a", Some("null"), true), listen("b", Some("null"), true)];
        let boards = PollKey { edge: "Boards".into(), ..key("", None) };
        let parents = |l: &Listen| Watched {
            pushed_parents: if l.movement_name == "a" { vec![("Boards".into(), Some(Declared { delivery: Some(Delivery::Polled), poll_every_seconds: Some(1), cursorless: false }))] } else { Vec::new() },
            ..watched(vec![Some("board-1".to_string())], Delivery::Polled)
        };
        let keys = keys_of(&listens, &parents);
        assert_eq!(keys[&boards], Shared { declared: Some(Declared { delivery: Some(Delivery::Polled), poll_every_seconds: Some(1), cursorless: false }), fires: Vec::new(), resolves: vec![0] });
        assert_eq!(keys[&key("", Some("board-1"))].fires, vec![0, 1], "its own last edge as before");
        assert!(keys[&key("", Some("board-1"))].resolves.is_empty());
    }

    #[test]
    fn two_connections_that_differ_only_in_position_never_share_a_poll() {
        let listens = [listen("a", Some("null"), false), listen("b", Some("null"), false), listen("c", Some("null"), false)];
        let position = |l: &Listen| match l.movement_name.as_str() {
            "a" | "b" => r#"{"base":"CRM"}"#.to_string(),
            _ => r#"{"base":"Hiring"}"#.to_string(),
        };
        let keys = firing(&keys_of(&listens, &|l| Watched { position: position(l), ..watched(vec![None], Delivery::Polled) }));
        assert_eq!(keys.len(), 2, "{keys:?}");
        let crm = PollKey { position: r#"{"base":"CRM"}"#.into(), ..key("", None) };
        let hiring = PollKey { position: r#"{"base":"Hiring"}"#.into(), ..key("", None) };
        assert_eq!(keys[&crm], vec![0, 1], "one position: one poll");
        assert_eq!(keys[&hiring], vec![2], "another position: a poll of its own");
        assert_eq!(hiring.position_settings(), Some(serde_json::json!({ "base": "Hiring" })), "each is polled in its own position");
        assert_eq!(key("", None).position_settings(), None);
        assert_ne!(poll_subscription(&crm), poll_subscription(&hiring), "each its own cursor");
        assert_ne!(edge_subscription(&crm), edge_subscription(&hiring), "and its own webhook");
        assert_ne!(poll_subscription(&crm), poll_subscription(&key("", None)));
    }

    #[test]
    fn a_poll_is_kept_under_its_key_alone() {
        let plain = poll_subscription(&key("", None));
        assert!(plain.starts_with("edge-poll:") && plain.len() == "edge-poll:".len() + 16, "{plain}");
        assert_eq!(plain, poll_subscription(&key("", None)), "the same key, the same subscription");
        assert_ne!(plain, poll_subscription(&key("{\"type\":\"static\"}", None)), "another filter");
        assert_ne!(plain, poll_subscription(&key("", Some("board-1"))), "another scope");
        assert_ne!(plain, poll_subscription(&PollKey { credential: Some("work".into()), ..key("", None) }), "another connection");
        // A key with no position hashes as before positions were in keys.
        assert_eq!(key("", None).to_js().to_json(), r#"{"adapter":"feed","edge":"Notes","taken":""}"#);
        let webhook = edge_subscription(&key("", None));
        assert!(webhook.starts_with("edge-") && webhook[5..] == plain["edge-poll:".len()..], "its webhook is kept under the same digest: {webhook}");
    }

    #[test]
    fn the_operators_interval_for_a_connection_is_over_the_edges() {
        let mut poll_every = BTreeMap::new();
        let declared = Declared { delivery: Some(Delivery::Polled), poll_every_seconds: Some(60), cursorless: false };
        assert_eq!(interval_ms(&poll_every, &key("", None), None, Some(&declared)), Ok(60_000));
        poll_every.insert("feed".into(), 1_000);
        assert_eq!(interval_ms(&poll_every, &key("", None), None, Some(&declared)), Ok(1_000), "named by its module");
        assert_eq!(interval_ms(&poll_every, &key("", None), Some("work"), Some(&declared)), Ok(60_000), "polled as another credential");
        poll_every.insert("work".into(), 5_000);
        assert_eq!(interval_ms(&poll_every, &key("", None), Some("work"), Some(&declared)), Ok(5_000));
        let undeclared = Declared { delivery: Some(Delivery::Polled), poll_every_seconds: None, cursorless: false };
        assert!(interval_ms(&poll_every, &key("", None), Some("other"), Some(&undeclared)).unwrap_err().contains("declares no pollEverySeconds"));
    }
}

//! How a host watches one `listen to <traversal> fire f`: the checker writes
//! it, and both hosts read it instead of the listen's source.
//!
//! A listen through or onto a union is one listen, with one plan: its
//! traversal is planned once per member of each union it crosses
//! (`members`), each an ordinary single-typed traversal, as TypeScript
//! distributes over a union. The members are how a host watches it;
//! everything a person or a tool sees of it (its identity, its receipts, its
//! state, its verdict on an arrival) is the one listen's.

use std::borrow::Cow;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::lowering::expression::{Expression, LogicalOp};

/// One listen, as the host watches it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenPlan {
    /// The function it fires.
    pub movement: String,
    /// `listen as "…"`: the lane's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// The connection the traversal starts from, by its name in the program.
    pub connection: String,
    /// That connection's module.
    pub adapter: String,
    /// Outermost first; the last is the listened edge. Empty for a listen
    /// through or onto a union, whose hops are each member's (`members`).
    pub hops: Vec<PlanHop>,
    /// The earlier hops' edges whose records an arrival on the last edge
    /// carries, outermost first, as its module declares them: the parents an
    /// arrival hands the judge.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub carries: Vec<String>,
    /// A listen through or onto a union: its traversal once per member of
    /// each union it crosses, in the catalog's order of members, two unions
    /// multiplying. Absent for any other listen.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub members: Vec<PlanMember>,
    /// The node the listen states its untyped landing is
    /// (`-[:Requests]-><Payment>`), by its name in the program: the host
    /// runs only what fits it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing: Option<String>,
}

/// One member's traversal of a listen through or onto a union: every hop
/// lands on one record type, and a hop whose edge lands on the union says so
/// (`PlanHop::member_of`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanMember {
    /// Outermost first; the last is the listened edge.
    pub hops: Vec<PlanHop>,
    /// As `ListenPlan::carries`, as this member's last edge declares them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub carries: Vec<String>,
}

impl ListenPlan {
    /// What makes two listens one: the plan, each hop's alias read as its
    /// place among the hops (`m` and `n` name one hop alike), and without the
    /// lane's name, which names a listen but is not what it listens to, as for
    /// the settings form. The checker refuses a second listen of one identity;
    /// a host names each listen's receipts by it. A listen over a union has
    /// one identity, of its members together.
    pub fn identity(&self) -> String {
        let hops = self.members.first().map_or(self.hops.as_slice(), |member| member.hops.as_slice());
        let places: HashMap<&str, String> = hops.iter().enumerate().filter_map(|(i, hop)| hop.alias.as_deref().map(|a| (a, format!("#{i}")))).collect();
        let mut json = serde_json::to_value(ListenPlan { alias: None, ..self.clone() }).expect("a plan is always JSON");
        read_aliases_as_places(&mut json, &places);
        json.to_string()
    }

    /// The single-typed traversals a host watches the listen by: the plan
    /// itself, or, for a listen over a union, one per member, each a plan of
    /// that member's hops alone. Each is how the listen is watched, never a
    /// listen of its own: it is named, kept and judged as the listen.
    pub fn member_plans(&self) -> Vec<Cow<'_, ListenPlan>> {
        if self.members.is_empty() {
            return vec![Cow::Borrowed(self)];
        }
        let plan = |member: &PlanMember| ListenPlan { hops: member.hops.clone(), carries: member.carries.clone(), members: Vec::new(), ..self.clone() };
        self.members.iter().map(|member| Cow::Owned(plan(member))).collect()
    }

    /// The edge the listen ends on, which each member's traversal ends on.
    pub fn last_edge(&self) -> Option<&str> {
        let hops = self.members.first().map_or(self.hops.as_slice(), |member| member.hops.as_slice());
        hops.last().map(|hop| hop.edge.as_str())
    }

    /// How many hops the listen has, as each member's traversal has.
    pub fn hop_count(&self) -> usize {
        self.members.first().map_or(self.hops.len(), |member| member.hops.len())
    }
}

/// Every hop alias in a plan's JSON, the hops' own and those their WHEREs
/// read (`aliasRoot`, an `alias_ref`'s `name`), replaced by its place.
fn read_aliases_as_places(json: &mut serde_json::Value, places: &HashMap<&str, String>) {
    match json {
        serde_json::Value::Object(members) => {
            let alias_ref = members.get("type").and_then(serde_json::Value::as_str) == Some("alias_ref");
            for (key, value) in members.iter_mut() {
                let names_alias = key == "alias" || key == "aliasRoot" || (alias_ref && key == "name");
                match value {
                    serde_json::Value::String(name) if names_alias => {
                        if let Some(place) = places.get(name.as_str()) {
                            *name = place.clone();
                        }
                    }
                    other => read_aliases_as_places(other, places),
                }
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(|item| read_aliases_as_places(item, places)),
        _ => {}
    }
}

/// One hop of a listen's traversal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanHop {
    pub edge: String,
    /// The record type the hop leaves; empty for a hop off the connection
    /// itself (one of its root collections).
    pub from: String,
    /// The record type it lands on.
    pub to: String,
    /// The union the hop's edge lands on, when the hop is one member's
    /// (`to`; `ListenPlan::members`): the host keeps a listed hop's records
    /// only when they are of that member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    /// The part of its WHERE the edge's module takes, its conjuncts joined
    /// by AND.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken: Option<Expression>,
    /// The part the host checks on what comes back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<Expression>,
    /// The fields `taken` reads that hold a scalar only the module can
    /// evaluate (an owned one): on an arrival the module did not filter, the
    /// host cannot judge them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub owned: Vec<String>,
    pub judged: HopJudged,
}

impl PlanHop {
    /// Its WHERE whole again: the part its module takes AND the part the
    /// host checks.
    pub fn filter(&self) -> Option<Expression> {
        match (self.taken.clone(), self.checked.clone()) {
            (Some(taken), Some(checked)) => Some(Expression::Logical { op: LogicalOp::And, operands: vec![taken, checked] }),
            (taken, checked) => taken.or(checked),
        }
    }
}

/// How the host honours a hop's filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HopJudged {
    /// Nothing to judge: the hop has no filter, and its members need not be
    /// listed.
    None,
    /// Judged on each arrival, against the record the arrival carries. The
    /// last hop always is.
    Arrival,
    /// The host lists the hop's members and keeps those that match, again
    /// whenever they may have changed.
    Resolved,
}

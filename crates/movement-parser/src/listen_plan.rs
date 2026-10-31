//! How a host watches one `listen to <traversal> fire f`: the checker writes
//! it, and both hosts read it instead of the listen's source.

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
    /// Outermost first; the last is the listened edge.
    pub hops: Vec<PlanHop>,
    /// The earlier hops' edges whose records an arrival on the last edge
    /// carries, outermost first, as its module declares them: the parents an
    /// arrival hands the judge.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub carries: Vec<String>,
    /// The node the listen states its untyped landing is
    /// (`-[:Requests]-><Payment>`), by its name in the program: the host
    /// runs only what fits it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub landing: Option<String>,
}

impl ListenPlan {
    /// What makes two listens one: the plan, each hop's alias read as its
    /// place among the hops (`m` and `n` name one hop alike), and without the
    /// lane's name, which names a listen but is not what it listens to, as for
    /// the settings form. The checker refuses a second listen of one identity;
    /// a host names each listen's receipts by it.
    pub fn identity(&self) -> String {
        let places: HashMap<&str, String> = self.hops.iter().enumerate().filter_map(|(i, hop)| hop.alias.as_deref().map(|a| (a, format!("#{i}")))).collect();
        let mut json = serde_json::to_value(ListenPlan { alias: None, ..self.clone() }).expect("a plan is always JSON");
        read_aliases_as_places(&mut json, &places);
        json.to_string()
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

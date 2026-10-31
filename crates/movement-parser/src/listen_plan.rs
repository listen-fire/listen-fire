//! How a host watches one `listen to <traversal> fire f`: the checker writes
//! it, and both hosts read it instead of the listen's source.

use serde::{Deserialize, Serialize};

use crate::lowering::expression::Expression;

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
    pub judged: HopJudged,
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

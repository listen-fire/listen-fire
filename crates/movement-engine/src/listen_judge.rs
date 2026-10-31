//! Whether an arrival fires a listen: one judge, which listen-fire's host
//! calls natively and the TypeScript host through the wasm (`abi.rs`
//! `judge_arrival`), held by both to the cases in
//! packages/engine-contracts/conformance/listen-arrivals.json.
//!
//! The judge reads the listen's plan (crates/movement-parser/src/
//! listen_plan.rs), never its source. Only hops judged on arrival are judged
//! here, each against the record the arrival carries for it; a hop the host
//! resolves by listing is the host's scope check. A hop's checked part is
//! always evaluated, and its taken part too unless the arrival's module says
//! it applied it: the host re-checks every conjunct the module did not
//! confirm it took.
//!
//! The hops are an AND, so a hop that fails decides the verdict even when an
//! earlier one could not be judged; only an arrival no hop fails can be
//! undecided. An undecided arrival runs nothing, and the host logs why.

use std::cell::Cell;

use movement_parser::listen_plan::{HopJudged, ListenPlan, PlanHop};
use movement_parser::lowering::expression::{Expression, FilterOperator, LogicalOp};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value as Json, json};

use crate::env::js_of_json;
use crate::eval::EvalError;
use crate::executor::ready;
use crate::filter::{AskCompare, Comparing, PredicateOptions, compare_values, evaluate_predicate_with, pure_leaf_keys, within};
use crate::js::{Js, object_property};

/// One arrival on a listen's last edge, as its host hands it to the judge.
/// Records are plain JSON on both hosts' wires.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanArrival {
    /// The edge it arrived on.
    pub edge: String,
    /// Its identity on that edge; absent on a root edge's arrival.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    /// The record that landed, its fields.
    pub landing: Json,
    /// The records it carries from earlier hops, their fields, aligned to
    /// the plan's `carries` (the k-th hop on an edge name reads the k-th
    /// carried record of it); null for one it does not carry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parents: Vec<Json>,
    /// Its module applied the plan's taken parts (a filtered poll or
    /// subscription); absent, it did not, and the judge evaluates them.
    #[serde(default)]
    pub taken_applied: bool,
}

/// Whether an arrival fires a listen. On the wire `{"fires":true}`,
/// `{"skips":n}` or `{"undecided":"…"}`.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Fires,
    /// It fails the filter of hop `hop`, outermost 0.
    Skips { hop: usize },
    /// The judge cannot tell, and says why.
    Undecided { reason: String },
}

impl Serialize for Verdict {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Verdict::Fires => json!({ "fires": true }),
            Verdict::Skips { hop } => json!({ "skips": hop }),
            Verdict::Undecided { reason } => json!({ "undecided": reason }),
        }
        .serialize(serializer)
    }
}

/// Whether `arrival` fires the listen `plan` describes, `now_ms` (epoch ms)
/// the instant `WITHIN` measures from.
pub fn judge_arrival(plan: &ListenPlan, arrival: &PlanArrival, now_ms: f64) -> Verdict {
    let Some(last) = plan.hops.len().checked_sub(1) else {
        return Verdict::Undecided { reason: format!("the listen firing '{}' has no hops to judge an arrival by", plan.movement) };
    };
    if arrival.edge != plan.hops[last].edge {
        return Verdict::Skips { hop: last };
    }
    let records: Vec<Option<Js>> = plan
        .hops
        .iter()
        .enumerate()
        .map(|(i, hop)| {
            if i == last {
                return Some(js_of_json(&arrival.landing));
            }
            // An edge crossed twice (a folder in a folder) is carried twice:
            // the k-th hop on a name reads the k-th carried record of it.
            let nth = plan.hops[..i].iter().filter(|earlier| earlier.edge == hop.edge).count();
            let at = plan.carries.iter().enumerate().filter(|(_, edge)| **edge == hop.edge).nth(nth)?.0;
            arrival.parents.get(at).filter(|parent| !parent.is_null()).map(js_of_json)
        })
        .collect();
    let judge = Judge { plan, records: &records, now_ms };
    let mut undecided = None;
    for (i, hop) in plan.hops.iter().enumerate().filter(|(_, hop)| hop.judged == HopJudged::Arrival) {
        match judge.hop(i, hop, arrival.taken_applied) {
            Judged::Holds => {}
            Judged::Fails => return Verdict::Skips { hop: i },
            Judged::Unknown(reason) => {
                undecided.get_or_insert(reason);
            }
        }
    }
    undecided.map_or(Verdict::Fires, |reason| Verdict::Undecided { reason })
}

enum Judged {
    Holds,
    Fails,
    Unknown(String),
}

struct Judge<'a> {
    plan: &'a ListenPlan,
    /// Each hop's record, where the arrival carries it.
    records: &'a [Option<Js>],
    now_ms: f64,
}

impl Judge<'_> {
    /// Every conjunct of hop `i`'s filter the host must check: its checked
    /// part, and its taken part unless the module applied it.
    fn hop(&self, i: usize, hop: &PlanHop, taken_applied: bool) -> Judged {
        let checked = hop.checked.iter().flat_map(conjuncts).map(|c| (c, false));
        let taken = hop.taken.iter().filter(|_| !taken_applied).flat_map(conjuncts).map(|c| (c, true));
        let mut unknown = None;
        for (conjunct, is_taken) in checked.chain(taken) {
            let owned = is_taken.then(|| reads_owned(conjunct, hop)).flatten();
            let judged = match owned {
                Some(field) => Judged::Unknown(format!(
                    "{module} did not apply this listen's filter on {edge} to the arrival, and only {module} can evaluate {field}",
                    module = self.plan.adapter,
                    edge = hop.edge
                )),
                None => self.conjunct(i, conjunct),
            };
            match judged {
                Judged::Holds => {}
                Judged::Fails => return Judged::Fails,
                Judged::Unknown(reason) => {
                    unknown.get_or_insert(reason);
                }
            }
        }
        unknown.map_or(Judged::Holds, Judged::Unknown)
    }

    /// One conjunct of hop `i`'s filter, its alias reads answered by the
    /// records the arrival carries.
    fn conjunct(&self, i: usize, conjunct: &Expression) -> Judged {
        let missing: Cell<Option<usize>> = Cell::new(None);
        let record = |j: usize| match &self.records[j] {
            Some(record) => Some(record),
            None => {
                missing.set(missing.get().or(Some(j)));
                None
            }
        };
        let field = |j: usize, name: &str| match record(j) {
            Some(Js::Object(fields)) => object_property(fields, name),
            _ => Js::Undefined,
        };
        let alias = |name: &str| self.plan.hops.iter().position(|hop| hop.alias.as_deref() == Some(name));
        let read_field = |name: &str| field(i, name);
        let read = |key: &str| {
            if let Some((j, name)) = key.split_once('.').and_then(|(root, name)| Some((alias(root)?, name))) {
                return field(j, name);
            }
            match alias(key) {
                Some(j) => record(j).cloned().unwrap_or(Js::Undefined),
                None => field(i, key),
            }
        };
        let now_ms = self.now_ms;
        let ask: &AskCompare = &|op: FilterOperator, left: Js, right: Js| -> Comparing {
            Box::pin(async move {
                match op {
                    FilterOperator::Within => Ok(within(&left, &right, now_ms)),
                    op => compare_values(&left, op, &right),
                }
            })
        };
        let result = ready(evaluate_predicate_with(conjunct, &read, PredicateOptions { ask: Some(ask), read_field: Some(&read_field) }));
        if let Some(j) = missing.get() {
            return Judged::Unknown(format!("the arrival carries no {} record, which this listen's filter on it reads", self.plan.hops[j].edge));
        }
        match result {
            Ok(value) if value.truthy() => Judged::Holds,
            Ok(_) => Judged::Fails,
            Err(error) => Judged::Unknown(format!("this listen's filter on {} could not be judged: {}", self.plan.hops[i].edge, described(&error))),
        }
    }
}

/// A filter's top-level conjuncts: the checker joins a hop's parts by AND.
fn conjuncts(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::Logical { op: LogicalOp::And, operands } => operands.iter().collect(),
        other => vec![other],
    }
}

/// The first field of `hop`'s owned ones `conjunct` reads.
fn reads_owned<'h>(conjunct: &Expression, hop: &'h PlanHop) -> Option<&'h str> {
    let reads = pure_leaf_keys(conjunct).unwrap_or_default();
    hop.owned.iter().find(|field| reads.contains(field)).map(String::as_str)
}

fn described(error: &EvalError) -> String {
    match error {
        EvalError::Thrown { message, .. } | EvalError::Fallback(message) => message.clone(),
        other => format!("{other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use movement_checker::CheckOptions;
    use movement_parser::catalog::types::CatalogSnapshot;

    use super::*;

    /// The cases both hosts' judges are held to, each plan the checker's
    /// answer for its listen.
    const CASES: &str = include_str!("../../../packages/engine-contracts/conformance/listen-arrivals.json");

    fn table() -> Json {
        serde_json::from_str(CASES).unwrap()
    }

    #[test]
    fn each_plan_is_what_the_checker_answers_for_its_listen() {
        let table = table();
        let catalog = CatalogSnapshot::load(&table["catalog"].to_string()).unwrap();
        let plans = table["plans"].as_object().unwrap();
        assert!(!plans.is_empty());
        for (name, entry) in plans {
            let source = entry["source"].as_str().unwrap();
            let program = movement_parser::stmt::parse_program(source, false).unwrap_or_else(|e| panic!("{name}: {}", e.message));
            let options = CheckOptions { upgrading_from: None, zones: &crate::env_services::EnvZones };
            let answer = movement_checker::answer::check_answer(&program, &catalog, options);
            let errors: Vec<_> = answer.diagnostics.iter().filter(|d| d.severity.is_none()).map(|d| format!("{} {}", d.code, d.message)).collect();
            assert_eq!(errors, Vec::<String>::new(), "{name}");
            assert_eq!(serde_json::to_value(&answer.listens).unwrap(), json!([entry["plan"]]), "{name}");
        }
    }

    #[test]
    fn judge_arrival_matches_the_shared_table_of_cases() {
        let table = table();
        let cases = table["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["case"].as_str().unwrap();
            let plan: ListenPlan = serde_json::from_value(table["plans"][case["plan"].as_str().unwrap()]["plan"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            let arrival: PlanArrival = serde_json::from_value(case["arrival"].clone()).unwrap_or_else(|e| panic!("{name}: {e}"));
            let now = crate::js_date::parse(case["now"].as_str().unwrap()).unwrap();
            assert_eq!(serde_json::to_value(judge_arrival(&plan, &arrival, now)).unwrap(), case["verdict"], "{name}");
        }
    }
}

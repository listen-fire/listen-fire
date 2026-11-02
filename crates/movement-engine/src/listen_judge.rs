//! Whether an arrival fires a listen: one judge, which listen-fire's host
//! calls natively and the TypeScript host through the wasm (`abi.rs`
//! `judge_arrival`), held by both to the cases in
//! packages/engine-contracts/conformance/listen-arrivals.json.
//!
//! The judge reads the listen's plan (crates/movement-parser/src/
//! listen_plan.rs), never its source. Hops judged on arrival are judged
//! here, each against the record the arrival carries for it; so is a hop the
//! host resolves by listing whose record the listen's last edge carries, the
//! carried record preferred to the listing, which a host that lists no
//! members (an embedded one) cannot do. Any other hop the host resolves is
//! the host's scope check. A hop's checked part is
//! always evaluated, and its taken part too unless the arrival's module says
//! it applied it: the host re-checks every conjunct the module did not
//! confirm it took.
//!
//! Each record the arrival carries, its landing and its parents, must be of
//! the record type its hop lands on: one edge name may hang off several
//! record types (every Stripe object's `Changes`), and the record type is
//! what tells their arrivals apart. A record of another type skips; one that
//! states no type cannot be told apart, so the arrival is undecided.
//!
//! A record may name the fields its module could not read (`unknown`: a
//! lookup the provider did not answer): a conjunct reading one cannot be
//! judged, never read as absent, which would skip the arrival silently.
//!
//! The hops are an AND, so a hop that fails decides the verdict even when an
//! earlier one could not be judged; only an arrival no hop fails can be
//! undecided. An undecided arrival runs nothing, and the host logs why.

use std::cell::Cell;
use std::collections::HashMap;

use movement_parser::listen_plan::{HopJudged, ListenPlan, PlanHop};
use movement_parser::lowering::expression::{Expression, FilterOperator, LogicalOp};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value as Json, json};

use crate::env::js_of_json;
use crate::eval::EvalError;
use crate::executor::ready;
use crate::filter::{AskCompare, Comparing, PredicateOptions, compare_values, evaluate_predicate_with, held_read, leaf_read_key, pure_leaf_keys, pure_leaf_reads, read_on, within};
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
    /// The record that landed.
    pub landing: ArrivedRecord,
    /// The records it carries from earlier hops, aligned to the plan's
    /// `carries` (the k-th hop on an edge name reads the k-th carried record
    /// of it); null for one it does not carry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parents: Vec<Option<ArrivedRecord>>,
    /// Its module applied the plan's taken parts (a filtered poll or
    /// subscription); absent, it did not, and the judge evaluates them.
    #[serde(default)]
    pub taken_applied: bool,
}

/// A record an arrival carries, its landing or a parent: the record type its
/// module says it is, as the catalog names it, and its fields. One edge name
/// may hang off several record types (every object's `Changes`); the record
/// type is what tells their arrivals apart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArrivedRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_type: Option<String>,
    pub fields: Json,
    /// The fields its module could not read: a filter reading one is
    /// undecided, whatever `fields` holds for it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unknown: Vec<String>,
}

/// Whether an arrival fires a listen. On the wire `{"fires":true}`,
/// `{"skips":n}` (`{"skips":n,"reason":"…"}` when a record's type, not a
/// filter, skipped it) or `{"undecided":"…"}`.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Fires,
    /// It fails the filter of hop `hop`, outermost 0; or, with a reason, the
    /// record it carries for that hop is of another record type.
    Skips { hop: usize, reason: Option<String> },
    /// The judge cannot tell, and says why.
    Undecided { reason: String },
}

impl Serialize for Verdict {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Verdict::Fires => json!({ "fires": true }),
            Verdict::Skips { hop, reason: None } => json!({ "skips": hop }),
            Verdict::Skips { hop, reason: Some(reason) } => json!({ "skips": hop, "reason": reason }),
            Verdict::Undecided { reason } => json!({ "undecided": reason }),
        }
        .serialize(serializer)
    }
}

/// A record's `fields` as a program reads them, by name: each field the
/// catalog names otherwise than its module keys it (`field_ids`, the
/// position's `fieldIds`: name → id) takes the value its id holds, as a run
/// reading it through the module does. A host hands the judge each record so
/// named (packages/engine-contracts/conformance/listen-field-names.json);
/// the rest of the record is kept as it came.
pub fn named_fields(fields: &Json, field_ids: &serde_json::Map<String, Json>) -> Json {
    let Json::Object(keyed) = fields else { return fields.clone() };
    let mut named = keyed.clone();
    for (name, id) in field_ids {
        if let Some(value) = id.as_str().and_then(|id| keyed.get(id)) {
            named.insert(name.clone(), value.clone());
        }
    }
    Json::Object(named)
}

/// Whether `arrival` fires the listen `plan` describes, `now_ms` (epoch ms)
/// the instant `WITHIN` measures from.
///
/// A listen through or onto a union is judged once, as an OR of its
/// members' traversals: it fires when one member's does, and a record of
/// another member's type is that member's to decide, never a skip of the
/// listen. Otherwise it is undecided when one member cannot tell, and skips
/// when every member does: by a filter, when one member's records were of
/// its types; else by type, naming every member's.
pub fn judge_arrival(plan: &ListenPlan, arrival: &PlanArrival, now_ms: f64) -> Verdict {
    if plan.members.is_empty() {
        return judge_traversal(plan, plan, arrival, now_ms);
    }
    let verdicts: Vec<Verdict> = plan.member_plans().iter().map(|member| judge_traversal(plan, member, arrival, now_ms)).collect();
    let by_type = |verdict: &Verdict| matches!(verdict, Verdict::Skips { reason: Some(_), .. });
    if let Some(decided) = verdicts.iter().find(|v| **v == Verdict::Fires).or_else(|| verdicts.iter().find(|v| matches!(v, Verdict::Undecided { .. }))).or_else(|| verdicts.iter().find(|v| !by_type(v))) {
        return decided.clone();
    }
    let hops: Vec<usize> = verdicts.iter().filter_map(|v| if let Verdict::Skips { hop, .. } = v { Some(*hop) } else { None }).collect();
    let Some(&hop) = hops.first() else { return Verdict::Undecided { reason: format!("the listen firing '{}' has no member to judge an arrival by", plan.movement) } };
    let reason = match (hops.iter().all(|h| *h == hop), stated_at(plan, arrival, hop)) {
        (true, Some(stated)) => another_type(plan, &arrival.edge, hop, stated),
        _ => {
            let mut reasons: Vec<String> = Vec::new();
            for verdict in verdicts {
                if let Verdict::Skips { reason: Some(reason), .. } = verdict
                    && !reasons.contains(&reason)
                {
                    reasons.push(reason);
                }
            }
            reasons.join("; ")
        }
    };
    Verdict::Skips { hop, reason: Some(reason) }
}

/// The record type the record an arrival carries for hop `i` states.
fn stated_at<'a>(plan: &ListenPlan, arrival: &'a PlanArrival, i: usize) -> Option<&'a str> {
    let member = plan.member_plans().into_iter().next()?;
    let record = if i + 1 == member.hops.len() { Some(&arrival.landing) } else { carried_record(&member, arrival, i) };
    record?.record_type.as_deref()
}

/// The record an arrival carries for earlier hop `i`: an edge crossed twice
/// (a folder in a folder) is carried twice, and the k-th hop on a name reads
/// the k-th carried record of it.
fn carried_record<'a>(plan: &ListenPlan, arrival: &'a PlanArrival, i: usize) -> Option<&'a ArrivedRecord> {
    let hop = &plan.hops[i];
    let nth = plan.hops[..i].iter().filter(|earlier| earlier.edge == hop.edge).count();
    let at = plan.carries.iter().enumerate().filter(|(_, edge)| **edge == hop.edge).nth(nth)?.0;
    arrival.parents.get(at)?.as_ref()
}

/// Whether `arrival` fires one traversal of the listen `whole`: `plan`, the
/// listen's own or one member's.
fn judge_traversal(whole: &ListenPlan, plan: &ListenPlan, arrival: &PlanArrival, now_ms: f64) -> Verdict {
    let Some(last) = plan.hops.len().checked_sub(1) else {
        return Verdict::Undecided { reason: format!("the listen firing '{}' has no hops to judge an arrival by", plan.movement) };
    };
    if arrival.edge != plan.hops[last].edge {
        return Verdict::Skips { hop: last, reason: None };
    }
    let carried: Vec<Option<&ArrivedRecord>> = (0..plan.hops.len()).map(|i| if i == last { Some(&arrival.landing) } else { carried_record(plan, arrival, i) }).collect();
    let mut undecided = None;
    // The landing first: an arrival on another record type's edge of the
    // same name is not this listen's, whatever it carries.
    for (i, record) in std::iter::once(last).chain(0..last).filter_map(|i| Some((i, carried[i]?))) {
        match &record.record_type {
            Some(stated) if *stated == plan.hops[i].to => {}
            Some(stated) => return Verdict::Skips { hop: i, reason: Some(another_type(plan, &arrival.edge, i, stated)) },
            None => {
                undecided.get_or_insert_with(|| untyped(whole, &arrival.edge, i));
            }
        }
    }
    let records: Vec<Option<Js>> = carried.iter().map(|record| record.map(|record| js_of_json(&record.fields))).collect();
    let unknown: Vec<&[String]> = carried.iter().map(|record| record.map_or(&[][..], |record| record.unknown.as_slice())).collect();
    let judge = Judge { plan, records: &records, unknown: &unknown, now_ms };
    for (i, hop) in plan.hops.iter().enumerate().filter(|(i, hop)| judged_here(plan, *i, hop)) {
        match judge.hop(i, hop, arrival.taken_applied) {
            Judged::Holds => {}
            Judged::Fails => return Verdict::Skips { hop: i, reason: None },
            Judged::Unknown(reason) => {
                undecided.get_or_insert(reason);
            }
        }
    }
    undecided.map_or(Verdict::Fires, |reason| Verdict::Undecided { reason })
}

/// Whether hop `i`'s filter is judged against the arrival: a hop judged on
/// arrival, and a hop its host lists whose record the last edge carries.
fn judged_here(plan: &ListenPlan, i: usize, hop: &PlanHop) -> bool {
    match hop.judged {
        HopJudged::Arrival => true,
        HopJudged::Resolved => carries_hop(plan, i),
        HopJudged::None => false,
    }
}

/// Whether the listen's last edge carries hop `i`'s record: the k-th hop on
/// an edge name is the k-th carried record of it.
fn carries_hop(plan: &ListenPlan, i: usize) -> bool {
    let edge = &plan.hops[i].edge;
    let nth = plan.hops[..i].iter().filter(|earlier| earlier.edge == *edge).count();
    plan.carries.iter().filter(|carried| *carried == edge).count() > nth
}

/// Why an arrival whose hop-`i` record states no record type cannot be
/// judged: it cannot be told from an arrival on another record type's edge
/// of the same name.
fn untyped(plan: &ListenPlan, edge: &str, i: usize) -> String {
    let module = &plan.adapter;
    let (hop_edge, lands) = landings_at(plan, i);
    if i + 1 == plan.hop_count() {
        format!("the arrival {module} reported on {edge} does not say its record type, so it cannot be told from another record type's {edge} (this listen's lands on {lands})")
    } else {
        format!("the arrival {module} reported on {edge} carries a {hop_edge} record that does not say its record type (this listen's {hop_edge} lands on {lands})")
    }
}

/// Why an arrival whose hop-`i` record states the record type `stated`
/// skips: it is another record type's edge of the same name, whatever its
/// fields.
fn another_type(plan: &ListenPlan, edge: &str, i: usize, stated: &str) -> String {
    let (hop_edge, lands) = landings_at(plan, i);
    if i + 1 == plan.hop_count() {
        format!("it has record type {stated}, not {lands}, which this listen's {edge} lands on")
    } else {
        format!("the {hop_edge} record it carries has record type {stated}, not {lands}, which this listen's {hop_edge} lands on")
    }
}

/// Hop `i`'s edge, and the record types it lands on, said: one, or, for a
/// listen over a union, each member's (`Person or Company`).
fn landings_at(plan: &ListenPlan, i: usize) -> (String, String) {
    let mut edge = String::new();
    let mut lands: Vec<String> = Vec::new();
    for member in plan.member_plans() {
        let Some(hop) = member.hops.get(i) else { continue };
        edge.clone_from(&hop.edge);
        if !lands.contains(&hop.to) {
            lands.push(hop.to.clone());
        }
    }
    (edge, lands.join(" or "))
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
    /// Each hop's record's fields its module could not read.
    unknown: &'a [&'a [String]],
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
            // An owned scalar the arrival carries is the module's own value
            // for it (the schedule a tick fired on, the key mail came in
            // under): it compares as the text it is.
            let owned = is_taken.then(|| reads_owned(conjunct, hop)).flatten().filter(|field| !self.carries(i, field));
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

    /// Whether the arrival carries a value for hop `i`'s record's `field`.
    fn carries(&self, i: usize, field: &str) -> bool {
        if self.unknown[i].iter().any(|name| name == field) {
            return false;
        }
        match &self.records[i] {
            Some(Js::Object(fields)) => !matches!(object_property(fields, field), Js::Undefined | Js::Null),
            _ => false,
        }
    }

    /// One conjunct of hop `i`'s filter, three-valued: an AND that one side
    /// fails fails, and an OR that one side holds holds, whichever side that
    /// is and whatever the other side could not read. Only what no side
    /// decides is undecided.
    fn conjunct(&self, i: usize, conjunct: &Expression) -> Judged {
        match conjunct {
            Expression::Logical { op, operands } => {
                let decides: fn(&Judged) -> bool = match op {
                    LogicalOp::And => |judged: &Judged| matches!(judged, Judged::Fails),
                    LogicalOp::Or => |judged: &Judged| matches!(judged, Judged::Holds),
                };
                let mut unknown = None;
                for operand in operands {
                    match self.conjunct(i, operand) {
                        judged if decides(&judged) => return judged,
                        Judged::Unknown(reason) => {
                            unknown.get_or_insert(reason);
                        }
                        _ => {}
                    }
                }
                match (unknown, *op) {
                    (Some(reason), _) => Judged::Unknown(reason),
                    (None, LogicalOp::And) => Judged::Holds,
                    (None, LogicalOp::Or) => Judged::Fails,
                }
            }
            Expression::Not { expression } => match self.conjunct(i, expression) {
                Judged::Holds => Judged::Fails,
                Judged::Fails => Judged::Holds,
                unknown => unknown,
            },
            leaf => self.leaf(i, leaf),
        }
    }

    /// A filter's part that is neither AND, OR nor NOT, its alias reads
    /// answered by the records the arrival carries.
    fn leaf(&self, i: usize, conjunct: &Expression) -> Judged {
        let missing: Cell<Option<usize>> = Cell::new(None);
        let unread: Cell<Option<(usize, &str)>> = Cell::new(None);
        let record = |j: usize| match &self.records[j] {
            Some(record) => Some(record),
            None => {
                missing.set(missing.get().or(Some(j)));
                None
            }
        };
        let field = |j: usize, name: &str| {
            if let Some(known) = self.unknown[j].iter().find(|known| *known == name) {
                unread.set(unread.get().or(Some((j, known.as_str()))));
                return Js::Undefined;
            }
            match record(j) {
                Some(Js::Object(fields)) => object_property(fields, name),
                _ => Js::Undefined,
            }
        };
        let alias = |name: &str| self.plan.hops.iter().position(|hop| hop.alias.as_deref() == Some(name));
        let read_field = |name: &str| field(i, name);
        // Each leaf is read by what it is, never by parsing its key back: a
        // hop's alias read off that hop's record, read on through a record a
        // field holds (`c.Current.Stage`); any other name off this hop's.
        // A leaf is read only when the evaluation reaches it, so the side of
        // an AND or OR its other side decides (`exists(c.Previous) AND
        // c.Previous.Stage == …` on a created row) is never read, and cannot
        // leave the conjunct undecided by what it would have read.
        let value_of = |leaf: &Expression| match leaf {
            Expression::AliasRef { name } | Expression::Property { property_type_id: name, field_only: false } | Expression::EdgeProperty { property_type_id: name, field_only: false } => match alias(name) {
                Some(j) => record(j).cloned().unwrap_or(Js::Undefined),
                None => field(i, name),
            },
            Expression::Traverse { alias_root: Some(root), expression, .. } => match (alias(root), held_read(leaf)) {
                (Some(j), Some((_, held, members))) => read_on(field(j, held), &members),
                (Some(j), None) => match expression.as_ref() {
                    Expression::Property { property_type_id: name, .. } | Expression::EdgeProperty { property_type_id: name, .. } | Expression::AliasRef { name } => field(j, name),
                    _ => Js::Undefined,
                },
                (None, _) => field(i, &leaf_read_key(leaf)),
            },
            _ => Js::Undefined,
        };
        let leaves: HashMap<String, &Expression> = pure_leaf_reads(conjunct).unwrap_or_default().into_iter().map(|leaf| (leaf_read_key(leaf), leaf)).collect();
        let read = |key: &str| leaves.get(key).map_or(Js::Undefined, |leaf| value_of(leaf));
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
        if let Some((j, name)) = unread.get() {
            return Judged::Unknown(self.unread(j, name));
        }
        match result {
            Ok(value) if value.truthy() => Judged::Holds,
            Ok(_) => Judged::Fails,
            Err(error) => Judged::Unknown(format!("this listen's filter on {} could not be judged: {}", self.plan.hops[i].edge, described(&error))),
        }
    }
}

impl Judge<'_> {
    /// Why a filter reading `name` off hop `j`'s record cannot be judged:
    /// its module could not read it.
    fn unread(&self, j: usize, name: &str) -> String {
        let (module, hop) = (&self.plan.adapter, &self.plan.hops[j]);
        if j + 1 == self.plan.hops.len() {
            format!("{module} could not read {name} of the arrival on {}, which this listen's filter reads", hop.edge)
        } else {
            format!("{module} could not read {name} of the {} record the arrival carries, which this listen's filter reads", hop.edge)
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

    /// The taken part a module may apply itself (`takenApplied`), as the
    /// judge decides it: module-kit's `holds` is held to the same table.
    #[test]
    fn a_taken_filter_is_judged_as_the_shared_table_of_comparisons_says() {
        let table: Json = serde_json::from_str(include_str!("../../../packages/engine-contracts/conformance/taken-comparisons.json")).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["case"].as_str().unwrap();
            let hop = json!({ "edge": "Records", "from": "", "to": "Record", "alias": "r", "taken": case["filter"], "judged": "arrival" });
            let plan: ListenPlan = serde_json::from_value(json!({ "movement": "m", "connection": "c", "adapter": "a", "hops": [hop] })).unwrap_or_else(|e| panic!("{name}: {e}"));
            let arrival = PlanArrival { edge: "Records".into(), key: None, landing: ArrivedRecord { record_type: Some("Record".into()), fields: case["fields"].clone(), unknown: Vec::new() }, parents: Vec::new(), taken_applied: false };
            let fires = judge_arrival(&plan, &arrival, 0.0) == Verdict::Fires;
            assert_eq!(fires, case["holds"].as_bool().unwrap(), "{name}");
        }
    }

    #[test]
    fn named_fields_matches_the_shared_table_of_cases() {
        let table: Json = serde_json::from_str(include_str!("../../../packages/engine-contracts/conformance/listen-field-names.json")).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["case"].as_str().unwrap();
            let field_ids = case["fieldIds"].as_object().unwrap();
            assert_eq!(named_fields(&case["fields"], field_ids), case["named"], "{name}");
        }
    }

    /// A listen through or onto a union is one listen, judged once: the
    /// member whose record types the arrival states decides, and a record of
    /// no member's type skips, naming every member's.
    #[test]
    fn an_arrival_is_judged_once_by_the_member_it_is_of() {
        let catalog = CatalogSnapshot::load(
            r#"{"adapters":{"crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
                "Person":{"properties":{"Name":"text"},"edges":{"Notes":{"target":"Note","listenable":true,"delivery":"connection","carries":["Subjects"]}}},
                "Company":{"properties":{"Name":"text"},"edges":{"Notes":{"target":"Note","listenable":true,"delivery":"connection","carries":["Subjects"]}}},
                "Note":{"properties":{"Text":"text"},"edges":{}}},
                "unions":{"Subject":["Person","Company"]},
                "collections":{"Subjects":{"target":"Subject"},"Things":{"target":"Subject","listenable":true,"delivery":"connection"}},
                "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#,
        )
        .unwrap();
        let plans = |source: &str| {
            let source = format!("import {{ crm as m }} from adapters; crm = connect m\nfunction f(n: <crm-[:Note]->>) {{ return n.Text }}\nfunction g(n: <crm-[:Things]->>) {{ return n.Name }}\n{source}");
            let program = movement_parser::stmt::parse_program(&source, false).unwrap();
            let answer = movement_checker::answer::check_answer(&program, &catalog, CheckOptions { upgrading_from: None, zones: &crate::env_services::EnvZones });
            assert_eq!(answer.diagnostics.iter().filter(|d| d.severity.is_none()).count(), 0, "{source}");
            answer.listens
        };
        let record = |record_type: &str, fields: Json| ArrivedRecord { record_type: Some(record_type.into()), fields, unknown: Vec::new() };
        let verdict = |plans: &[ListenPlan], arrival: &PlanArrival| {
            assert_eq!(plans.len(), 1, "one listen, one plan");
            serde_json::to_value(judge_arrival(&plans[0], arrival, 0.0)).unwrap()
        };

        // Onto a union: the landing's own type.
        let onto = plans("listen to crm-[t:Things WHERE t.Name == \"Ann\"]-> fire g\n");
        assert_eq!(onto[0].members.iter().map(|m| m.hops[0].to.as_str()).collect::<Vec<_>>(), ["Person", "Company"]);
        let thing = |record_type: &str, name: &str| PlanArrival { edge: "Things".into(), key: None, landing: record(record_type, json!({"Name": name})), parents: Vec::new(), taken_applied: false };
        assert_eq!(verdict(&onto, &thing("Person", "Ann")), json!({"fires": true}));
        assert_eq!(verdict(&onto, &thing("Company", "Ann")), json!({"fires": true}));
        assert_eq!(verdict(&onto, &thing("Company", "Bo")), json!({"skips": 0}), "the member it is of judges its filter");
        assert_eq!(verdict(&onto, &thing("Lead", "Ann")), json!({"skips": 0, "reason": "it has record type Lead, not Person or Company, which this listen's Things lands on"}));
        let untyped = PlanArrival { landing: ArrivedRecord { record_type: None, fields: json!({"Name": "Ann"}), unknown: Vec::new() }, ..thing("Person", "Ann") };
        assert_eq!(
            verdict(&onto, &untyped),
            json!({"undecided": "the arrival crm reported on Things does not say its record type, so it cannot be told from another record type's Things (this listen's lands on Person or Company)"})
        );

        // Through a union: the parent the arrival carries.
        let through = plans("listen to crm-[:Subjects]->-[:Notes]-> fire f\n");
        let note = |parent: &str| PlanArrival { edge: "Notes".into(), key: None, landing: record("Note", json!({"Text": "hi"})), parents: vec![Some(record(parent, json!({"Name": "Acme"})))], taken_applied: false };
        assert_eq!(verdict(&through, &note("Company")), json!({"fires": true}));
        assert_eq!(verdict(&through, &note("Person")), json!({"fires": true}));
        assert_eq!(
            verdict(&through, &note("Lead")),
            json!({"skips": 0, "reason": "the Subjects record it carries has record type Lead, not Person or Company, which this listen's Subjects lands on"})
        );
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

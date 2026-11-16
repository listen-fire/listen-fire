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
//!
//! A filter may call a pure function. A built-in is evaluated here, as a run
//! evaluates it. Any other call is a host function the plan names by its
//! catalog key (`@lf-platform/team/isMember`), which only the host can
//! answer: the judge reads the answers it is handed, and for a question it
//! has no answer to, it hands the question back (`Verdict::Asks`), so the
//! host asks the plugin and judges again. It asks only what it reached: a
//! hop's local terms are read before its host terms (the plan orders each
//! AND and OR so, and the taken part is read before the checked part's host
//! terms), and a term is reached only when every term before it in its AND
//! held, so a local term that decides the verdict costs no round trip. An
//! answer the host could not get leaves the arrival undecided, to be judged
//! again.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap};

use movement_parser::listen_plan::{HopJudged, ListenPlan, PlanHop};
use movement_parser::lowering::expression::{Expression, FilterOperator, LogicalOp};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Value as Json, json};

use crate::env::{js_of_json, json_of_js};
use crate::eval::EvalError;
use crate::executor::ready;
use crate::filter::{AskCall, AskCompare, Calling, Comparing, PredicateOptions, compare_values, evaluate_predicate_with, held_read, judged_leaf_reads, leaf_read_key, pure_leaf_keys, read_on, within};
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
/// filter, skipped it), `{"undecided":"…"}` (with `"unreachable":plugin`
/// when the host could not answer a host function) or `{"asks":[…]}`.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Fires,
    /// It fails the filter of hop `hop`, outermost 0; or, with a reason, the
    /// record it carries for that hop is of another record type.
    Skips { hop: usize, reason: Option<String> },
    /// The judge cannot tell, and says why.
    Undecided { reason: UndecidedReason },
    /// Its filter calls a host function the host has not answered for this
    /// arrival: the questions the judge reached, which the host asks, then
    /// judges again with their answers.
    Asks(Vec<PluginQuestion>),
}

impl Serialize for Verdict {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Verdict::Fires => json!({ "fires": true }),
            Verdict::Skips { hop, reason: None } => json!({ "skips": hop }),
            Verdict::Skips { hop, reason: Some(reason) } => json!({ "skips": hop, "reason": reason }),
            Verdict::Undecided { reason: UndecidedReason::Unjudgeable(reason) } => json!({ "undecided": reason }),
            Verdict::Undecided { reason: UndecidedReason::HostUnreachable { plugin, message } } => json!({ "undecided": message, "unreachable": plugin }),
            Verdict::Asks(questions) => json!({ "asks": questions }),
        }
        .serialize(serializer)
    }
}

/// Why the judge cannot tell whether an arrival fires a listen.
#[derive(Debug, Clone, PartialEq)]
pub enum UndecidedReason {
    /// What the arrival carries cannot be judged as it stands: a record that
    /// states no record type, a field its module could not read.
    Unjudgeable(String),
    /// The host could not answer the host function `plugin`: the arrival is
    /// kept unjudged and judged again once it can. `message` says so.
    HostUnreachable { plugin: String, message: String },
}

impl std::fmt::Display for UndecidedReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UndecidedReason::Unjudgeable(reason) | UndecidedReason::HostUnreachable { message: reason, .. } => f.write_str(reason),
        }
    }
}

/// A question the judge asks its host: what the pure plugin `plugin`, by
/// its catalog key (`@lf-platform/team/isMember`), answers for `args`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginQuestion {
    pub plugin: String,
    pub args: Vec<Json>,
}

impl PluginQuestion {
    /// What its answer is kept under: the plugin's key, then the arguments
    /// as JSON with every object's keys sorted, so one question has one key
    /// whoever asks it.
    pub fn key(&self) -> String {
        let args = String::from_utf8(movement_parser::to_sorted_json(&self.args)).expect("JSON is UTF-8");
        format!("{}{args}", self.plugin)
    }
}

/// What the host answered a question: the plugin's value, or why it could
/// not ask it.
#[derive(Debug, Clone, PartialEq)]
pub enum PluginAnswer {
    Value(Json),
    Unreachable(String),
}

/// The answers a host hands the judge, each under its question's key. On the
/// wire a list of the questions, each with its `value`, or `unreachable` and
/// why, so a host never forms a key itself.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(try_from = "Vec<AnsweredQuestion>")]
pub struct PluginAnswers(BTreeMap<String, PluginAnswer>);

impl PluginAnswers {
    pub fn insert(&mut self, question: &PluginQuestion, answer: PluginAnswer) {
        self.0.insert(question.key(), answer);
    }

    pub fn get(&self, question: &PluginQuestion) -> Option<&PluginAnswer> {
        self.0.get(&question.key())
    }
}

/// One answered question as a host writes it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AnsweredQuestion {
    plugin: String,
    args: Vec<Json>,
    /// Present, even as null, when the plugin answered.
    #[serde(default, deserialize_with = "present")]
    value: Option<Json>,
    #[serde(default)]
    unreachable: Option<String>,
}

fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Json>, D::Error> {
    Json::deserialize(deserializer).map(Some)
}

impl TryFrom<Vec<AnsweredQuestion>> for PluginAnswers {
    type Error = String;

    fn try_from(answered: Vec<AnsweredQuestion>) -> Result<Self, String> {
        let mut answers = PluginAnswers::default();
        for AnsweredQuestion { plugin, args, value, unreachable } in answered {
            let answer = match (value, unreachable) {
                (Some(value), None) => PluginAnswer::Value(value),
                (None, Some(why)) => PluginAnswer::Unreachable(why),
                _ => return Err(format!("the answer to {plugin} holds a value or says why it is unreachable, never both or neither")),
            };
            answers.insert(&PluginQuestion { plugin, args }, answer);
        }
        Ok(answers)
    }
}

/// What a judgement reads beyond the plan and the arrival.
#[derive(Clone, Copy)]
pub struct Judging<'a> {
    /// The instant (epoch ms) `WITHIN` measures from.
    pub now_ms: f64,
    /// What the host answered the questions the judge asked; none on a
    /// first judgement.
    pub answers: &'a PluginAnswers,
}

/// A verdict, and the term of the filter that decided a skip: what "why
/// didn't this fire?" names. On the wire `{verdict, firstFailed?}`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Explanation {
    pub verdict: Verdict,
    /// The first term of the hop that skipped which failed, as a filter
    /// writes it, a host function by its catalog key. Absent unless a
    /// filter skipped the arrival.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_failed: Option<String>,
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

/// Whether `arrival` fires the listen `plan` describes, as of `judging`.
///
/// A listen through or onto a union is judged once, as an OR of its
/// members' traversals: it fires when one member's does, and a record of
/// another member's type is that member's to decide, never a skip of the
/// listen. Otherwise it asks, or is undecided, as the first member that
/// cannot tell yet does, and skips when every member does: by a filter, when
/// one member's records were of its types; else by type, naming every
/// member's.
pub fn judge_arrival(plan: &ListenPlan, arrival: &PlanArrival, judging: Judging<'_>) -> Verdict {
    explain_arrival(plan, arrival, judging).verdict
}

/// `judge_arrival`'s verdict, with the term of the filter that skipped the
/// arrival, when one did.
pub fn explain_arrival(plan: &ListenPlan, arrival: &PlanArrival, judging: Judging<'_>) -> Explanation {
    if plan.members.is_empty() {
        return judge_traversal(plan, plan, arrival, judging);
    }
    let explained: Vec<Explanation> = plan.member_plans().iter().map(|member| judge_traversal(plan, member, arrival, judging)).collect();
    let by_type = |verdict: &Verdict| matches!(verdict, Verdict::Skips { reason: Some(_), .. });
    let open = |verdict: &Verdict| matches!(verdict, Verdict::Undecided { .. } | Verdict::Asks(_));
    if let Some(decided) = explained
        .iter()
        .find(|e| e.verdict == Verdict::Fires)
        .or_else(|| explained.iter().find(|e| open(&e.verdict)))
        .or_else(|| explained.iter().find(|e| !by_type(&e.verdict)))
    {
        return decided.clone();
    }
    let verdicts: Vec<Verdict> = explained.into_iter().map(|e| e.verdict).collect();
    let hops: Vec<usize> = verdicts.iter().filter_map(|v| if let Verdict::Skips { hop, .. } = v { Some(*hop) } else { None }).collect();
    let Some(&hop) = hops.first() else {
        let reason = format!("the listen firing '{}' has no member to judge an arrival by", plan.movement);
        return Explanation { verdict: Verdict::Undecided { reason: UndecidedReason::Unjudgeable(reason) }, first_failed: None };
    };
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
    Explanation { verdict: Verdict::Skips { hop, reason: Some(reason) }, first_failed: None }
}

/// The record type the record an arrival carries for hop `i` states.
fn stated_at<'a>(plan: &ListenPlan, arrival: &'a PlanArrival, i: usize) -> Option<&'a str> {
    let member = plan.member_plans().into_iter().next()?;
    let record = if i + 1 == member.hops.len() { Some(&arrival.landing) } else { carried_record(&member, arrival, i) };
    record?.record_type.as_deref()
}

/// The record an arrival carries for earlier hop `i`, when its last edge
/// carries that hop's: an edge crossed twice (a folder in a folder) is
/// carried twice, and the k-th hop on a name reads the k-th carried record
/// of it. Where the record in that place is missing or of another record
/// type, the k-th one of the hop's own record type is read instead: a module
/// that reports every arrival on an edge alike, whichever path its
/// connection walked to it, carries more than one path declares (Airtable's
/// change carries its base, which a connection positioned at the base has
/// no hop for). With none of that type, the record in its place is read,
/// and skips by its type.
fn carried_record<'a>(plan: &ListenPlan, arrival: &'a PlanArrival, i: usize) -> Option<&'a ArrivedRecord> {
    let hop = &plan.hops[i];
    let nth = plan.hops[..i].iter().filter(|earlier| earlier.edge == hop.edge).count();
    let at = plan.carries.iter().enumerate().filter(|(_, edge)| **edge == hop.edge).nth(nth)?.0;
    let placed = arrival.parents.get(at).and_then(Option::as_ref);
    if placed.is_some_and(|record| record.record_type.as_deref() == Some(hop.to.as_str())) {
        return placed;
    }
    arrival.parents.iter().flatten().filter(|record| record.record_type.as_deref() == Some(hop.to.as_str())).nth(nth).or(placed)
}

/// Whether `arrival` fires one traversal of the listen `whole`: `plan`, the
/// listen's own or one member's.
fn judge_traversal(whole: &ListenPlan, plan: &ListenPlan, arrival: &PlanArrival, judging: Judging<'_>) -> Explanation {
    let decided = |verdict: Verdict| Explanation { verdict, first_failed: None };
    let Some(last) = plan.hops.len().checked_sub(1) else {
        return decided(Verdict::Undecided { reason: UndecidedReason::Unjudgeable(format!("the listen firing '{}' has no hops to judge an arrival by", plan.movement)) });
    };
    if arrival.edge != plan.hops[last].edge {
        return decided(Verdict::Skips { hop: last, reason: None });
    }
    let carried: Vec<Option<&ArrivedRecord>> = (0..plan.hops.len()).map(|i| if i == last { Some(&arrival.landing) } else { carried_record(plan, arrival, i) }).collect();
    let mut open = None;
    // The landing first: an arrival on another record type's edge of the
    // same name is not this listen's, whatever it carries.
    for (i, record) in std::iter::once(last).chain(0..last).filter_map(|i| Some((i, carried[i]?))) {
        match &record.record_type {
            Some(stated) if *stated == plan.hops[i].to => {}
            Some(stated) => return decided(Verdict::Skips { hop: i, reason: Some(another_type(plan, &arrival.edge, i, stated)) }),
            None => {
                open.get_or_insert_with(|| Open::Unknown(UndecidedReason::Unjudgeable(untyped(whole, &arrival.edge, i))));
            }
        }
    }
    let records: Vec<Option<Js>> = carried.iter().map(|record| record.map(|record| js_of_json(&record.fields))).collect();
    let unknown: Vec<&[String]> = carried.iter().map(|record| record.map_or(&[][..], |record| record.unknown.as_slice())).collect();
    let judge = Judge { plan, records: &records, unknown: &unknown, judging };
    for (i, hop) in plan.hops.iter().enumerate().filter(|(i, hop)| judged_here(plan, *i, hop)) {
        match judge.hop(i, hop, arrival.taken_applied) {
            (Judged::Holds, _) => {}
            (Judged::Fails, failed) => {
                let first_failed = failed.map(|term| movement_checker::families::filter_split::spell(term, hop.alias.as_deref()));
                return Explanation { verdict: Verdict::Skips { hop: i, reason: None }, first_failed };
            }
            (Judged::Open(pending), _) => {
                open.get_or_insert(pending);
            }
        }
    }
    decided(match open {
        None => Verdict::Fires,
        Some(Open::Unknown(reason)) => Verdict::Undecided { reason },
        Some(Open::Asks(questions)) => Verdict::Asks(questions),
    })
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

/// A filter's part, three-valued, with the questions it waits on.
enum Judged {
    Holds,
    Fails,
    /// Not yet told: it waits on the host, or cannot be told at all.
    Open(Open),
}

enum Open {
    Unknown(UndecidedReason),
    /// The questions the judge reached, which the host's answers may decide.
    Asks(Vec<PluginQuestion>),
}

impl Judged {
    fn unknown(reason: String) -> Judged {
        Judged::Open(Open::Unknown(UndecidedReason::Unjudgeable(reason)))
    }
}

struct Judge<'a> {
    plan: &'a ListenPlan,
    /// Each hop's record, where the arrival carries it.
    records: &'a [Option<Js>],
    /// Each hop's record's fields its module could not read.
    unknown: &'a [&'a [String]],
    judging: Judging<'a>,
}

impl Judge<'_> {
    /// Every conjunct of hop `i`'s filter the host must check, as an AND:
    /// the checked part's terms that ask no host, the taken part unless the
    /// module applied it, then the checked part's host terms, so a local
    /// term that fails is read before any question is reached. With a
    /// failure, the conjunct that failed.
    fn hop<'h>(&self, i: usize, hop: &'h PlanHop, taken_applied: bool) -> (Judged, Option<&'h Expression>) {
        let (asking, local): (Vec<&Expression>, Vec<&Expression>) = hop.checked.iter().flat_map(conjuncts).partition(|c| host_call_in(c).is_some());
        let taken = hop.taken.iter().filter(|_| !taken_applied).flat_map(conjuncts);
        let terms = local.into_iter().map(|c| (c, false)).chain(taken.map(|c| (c, true))).chain(asking.into_iter().map(|c| (c, false)));
        let mut open = None;
        for (conjunct, is_taken) in terms {
            // An owned scalar the arrival carries is the module's own value
            // for it (the schedule a tick fired on, the key mail came in
            // under): it compares as the text it is.
            let owned = is_taken.then(|| reads_owned(conjunct, hop)).flatten().filter(|field| !self.carries(i, field));
            let judged = match (owned, host_call_in(conjunct)) {
                (Some(field), _) => Judged::unknown(format!(
                    "{module} did not apply this listen's filter on {edge} to the arrival, and only {module} can evaluate {field}",
                    module = self.plan.adapter,
                    edge = hop.edge
                )),
                // The checker refuses one; a host asks only of a hop it
                // judges on each arrival, never of one it lists.
                (None, Some(plugin)) if hop.judged == HopJudged::Resolved => Judged::unknown(format!(
                    "this listen's filter on {edge} calls {plugin}, and a host asks a host function only of a hop it judges on each arrival, never of {edge}, which it lists",
                    edge = hop.edge
                )),
                (None, _) => self.conjunct(i, conjunct),
            };
            match judged {
                Judged::Holds => {}
                Judged::Fails => return (Judged::Fails, Some(conjunct)),
                Judged::Open(pending) => {
                    open.get_or_insert(pending);
                }
            }
        }
        (open.map_or(Judged::Holds, Judged::Open), None)
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
    /// is and whatever the other side could not read or waits on. Otherwise
    /// the first side that could not tell decides: its questions are the
    /// ones asked, so a host is asked only once every side before it left
    /// the answer open.
    fn conjunct(&self, i: usize, conjunct: &Expression) -> Judged {
        match conjunct {
            Expression::Logical { op, operands } => {
                let decides: fn(&Judged) -> bool = match op {
                    LogicalOp::And => |judged: &Judged| matches!(judged, Judged::Fails),
                    LogicalOp::Or => |judged: &Judged| matches!(judged, Judged::Holds),
                };
                let mut open = None;
                for operand in operands {
                    match self.conjunct(i, operand) {
                        judged if decides(&judged) => return judged,
                        Judged::Open(pending) => {
                            open.get_or_insert(pending);
                        }
                        _ => {}
                    }
                }
                match (open, *op) {
                    (Some(pending), _) => Judged::Open(pending),
                    (None, LogicalOp::And) => Judged::Holds,
                    (None, LogicalOp::Or) => Judged::Fails,
                }
            }
            Expression::Not { expression } => match self.conjunct(i, expression) {
                Judged::Holds => Judged::Fails,
                Judged::Fails => Judged::Holds,
                open => open,
            },
            leaf => self.leaf(i, leaf),
        }
    }

    /// A filter's part that is neither AND, OR nor NOT, its alias reads
    /// answered by the records the arrival carries, and its host calls by
    /// the answers the judgement holds.
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
        let leaves: HashMap<String, &Expression> = judged_leaf_reads(conjunct).unwrap_or_default().into_iter().map(|leaf| (leaf_read_key(leaf), leaf)).collect();
        let read = |key: &str| leaves.get(key).map_or(Js::Undefined, |leaf| value_of(leaf));
        let now_ms = self.judging.now_ms;
        let ask: &AskCompare = &|op: FilterOperator, left: Js, right: Js| -> Comparing {
            Box::pin(async move {
                match op {
                    FilterOperator::Within => Ok(within(&left, &right, now_ms)),
                    op => compare_values(&left, op, &right),
                }
            })
        };
        // A call no answer is held for stops the evaluation where it is
        // reached: a call its arguments hold is asked first, and a question
        // is never asked with an argument still unanswered.
        let asked: RefCell<Option<PluginQuestion>> = RefCell::new(None);
        let unreachable: RefCell<Option<(String, String)>> = RefCell::new(None);
        let answers = self.judging.answers;
        let call: &AskCall = &|plugin: &str, args: Vec<Js>| -> Calling {
            let question = PluginQuestion { plugin: plugin.to_string(), args: args.iter().map(json_of_js).collect() };
            let answered = match answers.get(&question) {
                Some(PluginAnswer::Value(value)) => Ok(js_of_json(value)),
                Some(PluginAnswer::Unreachable(why)) => {
                    unreachable.borrow_mut().get_or_insert_with(|| (question.plugin.clone(), why.clone()));
                    Err(EvalError::Fallback(format!("the host could not answer {plugin}")))
                }
                None => {
                    asked.borrow_mut().get_or_insert(question);
                    Err(EvalError::Fallback(format!("{plugin} is yet to be answered")))
                }
            };
            Box::pin(std::future::ready(answered))
        };
        let result = ready(evaluate_predicate_with(conjunct, &read, PredicateOptions { ask: Some(ask), read_field: Some(&read_field), call: Some(call) }));
        if let Some(j) = missing.get() {
            return Judged::unknown(format!("the arrival carries no {} record, which this listen's filter on it reads", self.plan.hops[j].edge));
        }
        if let Some((j, name)) = unread.get() {
            return Judged::unknown(self.unread(j, name));
        }
        let edge = &self.plan.hops[i].edge;
        if let Some((plugin, why)) = unreachable.into_inner() {
            let message = format!("the host could not answer {plugin} ({why}), which this listen's filter on {edge} calls");
            return Judged::Open(Open::Unknown(UndecidedReason::HostUnreachable { plugin, message }));
        }
        if let Some(question) = asked.into_inner() {
            return Judged::Open(Open::Asks(vec![question]));
        }
        match result {
            Ok(value) if value.truthy() => Judged::Holds,
            Ok(_) => Judged::Fails,
            Err(error) => Judged::unknown(format!("this listen's filter on {edge} could not be judged: {}", described(&error))),
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

/// How many host function calls `plan`'s filters hold, over every member:
/// the judge asks one host term per judgement, so a host that answers each
/// question it is asked reaches a verdict within one judgement more than this.
pub fn host_calls(plan: &ListenPlan) -> usize {
    use movement_parser::lowering::expression::ListElement;
    fn count(expr: &Expression) -> usize {
        let all = |items: &mut dyn Iterator<Item = &Expression>| items.map(count).sum::<usize>();
        match expr {
            Expression::Function { fn_, args } => usize::from(!crate::stdlib::is_builtin(fn_)) + all(&mut args.iter()),
            Expression::Compare { left, right, .. } | Expression::Arithmetic { left, right, .. } => count(left) + count(right),
            Expression::At { expression, index } => count(expression) + count(index),
            Expression::Logical { operands, .. } => all(&mut operands.iter()),
            Expression::Concat { parts } => all(&mut parts.iter()),
            Expression::Conditional { condition, then, else_ } => count(condition) + count(then) + count(else_),
            Expression::List { elements } => all(&mut elements.iter().map(|element| match element {
                ListElement::Expression(e) => e,
                ListElement::Spread(spread) => &spread.expression,
            })),
            Expression::Not { expression } | Expression::Negate { expression } | Expression::Traverse { expression, .. } => count(expression),
            _ => 0,
        }
    }
    plan.member_plans().iter().flat_map(|member| member.hops.clone()).flat_map(|hop| [hop.taken, hop.checked]).flatten().map(|filter| count(&filter)).sum()
}

/// The first host function `expr` calls, by its catalog key: any call that
/// is no built-in's.
fn host_call_in(expr: &Expression) -> Option<&str> {
    use movement_parser::lowering::expression::ListElement;
    fn first<'e>(items: impl IntoIterator<Item = &'e Expression>) -> Option<&'e str> {
        items.into_iter().find_map(host_call_in)
    }
    match expr {
        Expression::Function { fn_, .. } if !crate::stdlib::is_builtin(fn_) => Some(fn_),
        Expression::Function { args, .. } => first(args),
        Expression::Compare { left, right, .. } | Expression::Arithmetic { left, right, .. } => first([left.as_ref(), right.as_ref()]),
        Expression::At { expression, index } => first([expression.as_ref(), index.as_ref()]),
        Expression::Logical { operands, .. } => first(operands),
        Expression::Concat { parts } => first(parts),
        Expression::Conditional { condition, then, else_ } => first([condition.as_ref(), then.as_ref(), else_.as_ref()]),
        Expression::List { elements } => first(elements.iter().map(|element| match element {
            ListElement::Expression(e) => e,
            ListElement::Spread(spread) => &spread.expression,
        })),
        Expression::Not { expression } | Expression::Negate { expression } | Expression::Traverse { expression, .. } => host_call_in(expression),
        _ => None,
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
            let options = CheckOptions { upgrading_from: None, limiting_function: None, zones: &crate::env_services::EnvZones };
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
            let fires = judge_arrival(&plan, &arrival, Judging { now_ms: 0.0, answers: &PluginAnswers::default() }) == Verdict::Fires;
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
            let answer = movement_checker::answer::check_answer(&program, &catalog, CheckOptions { upgrading_from: None, limiting_function: None, zones: &crate::env_services::EnvZones });
            assert_eq!(answer.diagnostics.iter().filter(|d| d.severity.is_none()).count(), 0, "{source}");
            answer.listens
        };
        let record = |record_type: &str, fields: Json| ArrivedRecord { record_type: Some(record_type.into()), fields, unknown: Vec::new() };
        let verdict = |plans: &[ListenPlan], arrival: &PlanArrival| {
            assert_eq!(plans.len(), 1, "one listen, one plan");
            serde_json::to_value(judge_arrival(&plans[0], arrival, Judging { now_ms: 0.0, answers: &PluginAnswers::default() })).unwrap()
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
            let answers: PluginAnswers = serde_json::from_value(case.get("answers").cloned().unwrap_or_else(|| json!([]))).unwrap_or_else(|e| panic!("{name}: {e}"));
            let now = crate::js_date::parse(case["now"].as_str().unwrap()).unwrap();
            assert_eq!(serde_json::to_value(judge_arrival(&plan, &arrival, Judging { now_ms: now, answers: &answers })).unwrap(), case["verdict"], "{name}");
        }
    }

    const MEMBER: &str = "@lf-platform/team/isMember";

    /// One of the table's plans, by its name there.
    fn plan_named(name: &str) -> ListenPlan {
        serde_json::from_value(table()["plans"][name]["plan"].clone()).unwrap()
    }

    /// A message from `name` at `email` on channel `channel`, which its
    /// module did not filter.
    fn message(channel: &str, name: &str, email: &str) -> PlanArrival {
        let fields = json!({ "Id": "m1", "Channel": channel, "Name": name, "User Email": email });
        PlanArrival { edge: "Messages".into(), key: None, landing: ArrivedRecord { record_type: Some("Message".into()), fields, unknown: Vec::new() }, parents: Vec::new(), taken_applied: false }
    }

    fn answered(email: &str, answer: PluginAnswer) -> PluginAnswers {
        let mut answers = PluginAnswers::default();
        answers.insert(&PluginQuestion { plugin: MEMBER.into(), args: vec![json!(email)] }, answer);
        answers
    }

    fn judged(plan: &str, arrival: &PlanArrival, answers: &PluginAnswers) -> Verdict {
        judge_arrival(&plan_named(plan), arrival, Judging { now_ms: 0.0, answers })
    }

    fn asks(email: &str) -> Verdict {
        Verdict::Asks(vec![PluginQuestion { plugin: MEMBER.into(), args: vec![json!(email)] }])
    }

    #[test]
    fn a_failing_local_term_asks_nothing() {
        let none = PluginAnswers::default();
        assert_eq!(judged("insiders", &message("C1", "bot", "a@acme.com"), &none), Verdict::Skips { hop: 0, reason: None }, "a checked local term");
        // The taken part is the module's, and it did not apply it: read
        // before the checked part's host term all the same.
        assert_eq!(judged("insiders", &message("C2", "ann", "a@acme.com"), &none), Verdict::Skips { hop: 0, reason: None }, "a taken term");
    }

    #[test]
    fn a_passing_local_term_asks_the_host() {
        assert_eq!(judged("insiders", &message("C1", "ann", "a@acme.com"), &PluginAnswers::default()), asks("a@acme.com"));
        let applied = PlanArrival { taken_applied: true, ..message("C2", "ann", "a@acme.com") };
        assert_eq!(judged("insiders", &applied, &PluginAnswers::default()), asks("a@acme.com"), "a taken part the module applied is not read again");
        assert_eq!(serde_json::to_value(asks("a@acme.com")).unwrap(), json!({ "asks": [{ "plugin": MEMBER, "args": ["a@acme.com"] }] }));
    }

    #[test]
    fn an_answer_completes_the_verdict() {
        let ann = message("C1", "ann", "a@acme.com");
        assert_eq!(judged("insiders", &ann, &PluginAnswers::default()), asks("a@acme.com"));
        assert_eq!(judged("insiders", &ann, &answered("a@acme.com", PluginAnswer::Value(json!(true)))), Verdict::Fires);
        assert_eq!(judged("insiders", &ann, &answered("a@acme.com", PluginAnswer::Value(json!(false)))), Verdict::Skips { hop: 0, reason: None });
        assert_eq!(judged("insiders", &ann, &answered("b@acme.com", PluginAnswer::Value(json!(true)))), asks("a@acme.com"), "an answer for another argument is no answer");
    }

    #[test]
    fn an_unreachable_host_leaves_the_arrival_undecided() {
        let verdict = judged("insiders", &message("C1", "ann", "a@acme.com"), &answered("a@acme.com", PluginAnswer::Unreachable("connection refused".into())));
        let Verdict::Undecided { reason: UndecidedReason::HostUnreachable { plugin, .. } } = &verdict else { panic!("{verdict:?}") };
        assert_eq!(plugin, MEMBER);
        assert_eq!(
            serde_json::to_value(&verdict).unwrap(),
            json!({ "undecided": format!("the host could not answer {MEMBER} (connection refused), which this listen's filter on Messages calls"), "unreachable": MEMBER })
        );
        // A local term that fails still decides, and asks nothing.
        let bot = judged("insiders", &message("C1", "bot", "a@acme.com"), &answered("a@acme.com", PluginAnswer::Unreachable("connection refused".into())));
        assert_eq!(bot, Verdict::Skips { hop: 0, reason: None });
    }

    #[test]
    fn a_plan_counts_its_host_calls_and_no_built_in() {
        assert_eq!(host_calls(&plan_named("insiders")), 1);
        assert_eq!(host_calls(&plan_named("insider_or_ann")), 1);
        assert_eq!(host_calls(&plan_named("domain")), 0, "a built-in is no host call");
    }

    #[test]
    fn an_or_with_a_true_local_branch_asks_nothing() {
        let none = PluginAnswers::default();
        assert_eq!(judged("insider_or_ann", &message("C1", "ann", "a@acme.com"), &none), Verdict::Fires);
        assert_eq!(judged("insider_or_ann", &message("C1", "bob", "a@acme.com"), &none), asks("a@acme.com"));
        assert_eq!(judged("insider_or_ann", &message("C1", "bob", "a@acme.com"), &answered("a@acme.com", PluginAnswer::Value(json!(true)))), Verdict::Fires);
    }

    #[test]
    fn a_stdlib_call_is_evaluated() {
        let none = PluginAnswers::default();
        assert_eq!(judged("domain", &message("C1", "ann", "a@acme.com"), &none), Verdict::Fires);
        assert_eq!(judged("domain", &message("C1", "ann", "a@acme.com.evil.com"), &none), Verdict::Skips { hop: 0, reason: None });
        assert_eq!(judged("domain", &message("C1", "ann", "a@other.com"), &none), Verdict::Skips { hop: 0, reason: None });
    }

    #[test]
    fn explain_names_the_first_term_that_failed() {
        let none = PluginAnswers::default();
        let explain = |arrival: &PlanArrival, answers: &PluginAnswers| explain_arrival(&plan_named("insiders"), arrival, Judging { now_ms: 0.0, answers });
        let bot = explain(&message("C1", "bot", "a@acme.com"), &none);
        assert_eq!(bot, Explanation { verdict: Verdict::Skips { hop: 0, reason: None }, first_failed: Some("m.Name != \"bot\"".into()) });
        assert_eq!(explain(&message("C2", "ann", "a@acme.com"), &none).first_failed.as_deref(), Some("m.Channel == \"C1\""), "a taken term its module did not apply");
        let stranger = explain(&message("C1", "ann", "a@acme.com"), &answered("a@acme.com", PluginAnswer::Value(json!(false))));
        assert_eq!(stranger.first_failed.as_deref(), Some(format!("{}(m.`User Email`)", MEMBER).as_str()));
        let member = explain(&message("C1", "ann", "a@acme.com"), &answered("a@acme.com", PluginAnswer::Value(json!(true))));
        assert_eq!(member, Explanation { verdict: Verdict::Fires, first_failed: None });
        assert_eq!(serde_json::to_value(&bot).unwrap(), json!({ "verdict": { "skips": 0 }, "firstFailed": "m.Name != \"bot\"" }));
    }

    /// A host call on a hop the host resolves by listing is refused by the
    /// checker; a plan that holds one anyway is never asked about.
    #[test]
    fn a_host_call_on_a_listed_hop_is_undecided_and_asks_nothing() {
        let mut plan = plan_named("insiders");
        let checked = plan.hops[0].checked.clone();
        plan.hops.insert(0, PlanHop { edge: "Channels".into(), from: String::new(), to: "Channel".into(), member_of: None, alias: Some("c".into()), taken: None, checked, owned: Vec::new(), judged: HopJudged::Resolved, asks_host: true });
        plan.carries = vec!["Channels".into()];
        let mut arrival = message("C1", "ann", "a@acme.com");
        arrival.parents = vec![Some(ArrivedRecord { record_type: Some("Channel".into()), fields: json!({ "Name": "ann", "User Email": "a@acme.com" }), unknown: Vec::new() })];
        let verdict = judge_arrival(&plan, &arrival, Judging { now_ms: 0.0, answers: &PluginAnswers::default() });
        let Verdict::Undecided { reason: UndecidedReason::Unjudgeable(reason) } = &verdict else { panic!("{verdict:?}") };
        assert!(reason.contains("Channels") && reason.contains(MEMBER), "{reason}");
    }
}

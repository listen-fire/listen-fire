//! The `walk` entry: a listen's earlier hops walked from its plan
//! (crates/movement-parser/src/listen_plan.rs), not from source text. A host
//! that watches a listen's last edge once per record its earlier hops land
//! on (listen-fire's resolution, crates/lf/src/resolve.rs) lists those
//! records here, through the program's own connections, as a run's walk
//! lists them: each hop's WHERE is its plan's `taken` AND `checked`, decided
//! on each record it lands on, and an alias names its hop's record to every
//! hop after it.
//!
//! Its `done` is `{result: {landed}}`, each record it landed on as its
//! position (`{adapterType, recordType, identity}`), on the eval wire; or
//! `{thrown: error}` / `{declined: reason}`, as a segment's.

use std::rc::Rc;

use movement_parser::ast::Statement;
use movement_parser::listen_plan::PlanHop;
use movement_parser::lowering::expression::{EdgeDirection, EdgeStep};
use serde::Deserialize;
use serde_json::{Value as Json, json};

use crate::bindings::{Binding, Landed, MovementRef, Scope};
use crate::executor::Host;
use crate::js::Js;
use crate::program::DeclaringFile;
use crate::run::{Failure, Run, SegmentInput, Stop};

/// What the `walk` entry reads beside a segment's own input: where the walk
/// starts and its hops.
#[derive(Deserialize)]
pub struct Walk {
    /// The connection it starts from, by its name in the program.
    pub connection: String,
    /// Outermost first.
    pub hops: Vec<PlanHop>,
}

/// The `walk` entry: `walk`'s hops off `walk.connection` in the program
/// `input` carries, and its `done`.
pub async fn segment(host: Host, input: SegmentInput, walk: Walk) -> Json {
    let ledger = crate::ledger::Ledger::new(&input.spend);
    let walked = match crate::run::open(&host, &input, &ledger).await {
        Ok(run) => {
            let walked = run.walk_plan(&walk).await;
            let _ = run.hand_over_trace(true).await;
            walked.map(|landed| json!({ "landed": run.wire.encode_result(&landed) }))
        }
        Err(stop) => Err(stop),
    };
    match walked {
        Ok(result) => json!({ "result": result }),
        Err(Stop::Declined(reason)) => json!({ "declined": reason }),
        Err(Stop::Thrown(failure) | Stop::Failed(failure, _)) => json!({ "thrown": failure.to_json() }),
        Err(Stop::Cancelled | Stop::Parked(_) | Stop::EndedQuietly) => unreachable!("a walk runs no statement that cancels, parks or ends quietly"),
    }
}

impl Run<'_> {
    /// The positions `walk` lands on, in order: each hop fetched off every
    /// record the hop before it kept, in a scope holding the file's names
    /// and the aliases of that record's own path.
    async fn walk_plan(&self, walk: &Walk) -> Result<Js, Stop> {
        let file = self.root_scope().await?;
        let instance = match file.resolve(&walk.connection) {
            Some(Binding::Instance(instance)) => instance,
            _ => return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("'{}' is no connection the program makes", walk.connection)))),
        };
        let read = self.instance_read(&instance).await.map_err(Stop::Thrown)?;
        let span = Js::Undefined;
        let start = Rc::new(Landed::new(crate::traverse::meta_position(&instance.adapter_slug), None, read.clone()));
        let mut paths: Vec<(Rc<Scope>, Rc<Landed>)> = vec![(file, start)];
        for hop in &walk.hops {
            let step = step_of(hop);
            let mut next = Vec::new();
            for (scope, cursor) in &paths {
                for landed in self.walk(&cursor.position(), &step, read.clone(), scope, &span).await.map_err(Stop::Thrown)? {
                    let onward = match &step.alias {
                        Some(alias) => {
                            let child = scope.child();
                            child.declare(alias.clone(), Binding::Landed(landed.clone()));
                            child
                        }
                        None => scope.clone(),
                    };
                    next.push((onward, landed));
                }
            }
            paths = next;
        }
        Ok(Js::array(paths.into_iter().map(|(_, landed)| landed.position()).collect()))
    }

    /// The program's own file bound as a run binds it before its function
    /// runs: its functions, then its other statements in source order.
    async fn root_scope(&self) -> Result<Rc<Scope>, Stop> {
        let file = Scope::of_file(DeclaringFile::Root);
        for statement in &self.checked.root.program.statements {
            if let Statement::Movement(m) = statement {
                file.declare(m.name.clone(), Binding::Movement(Rc::new(MovementRef { name: m.name.clone(), file: DeclaringFile::Root })));
            }
        }
        *self.file_scope.borrow_mut() = Some(file.clone());
        self.interpret_file(&DeclaringFile::Root, &file).await?;
        Ok(file)
    }
}

/// The hop as a walk's step: its edge, outgoing (a listen's hops are the
/// edges its records declare), its alias, and its WHERE whole again.
fn step_of(hop: &PlanHop) -> EdgeStep {
    EdgeStep {
        edge_type_id: hop.edge.clone(),
        direction: EdgeDirection::Outgoing,
        alias: hop.alias.clone(),
        cardinality: None,
        filter: None,
        expression_filter: hop.filter().map(Box::new),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use movement_parser::listen_plan::{HopJudged, PlanHop};
    use movement_parser::lowering::expression::{Expression, LogicalOp, TraversalStep};
    use serde_json::{Value as Json, json};

    use crate::env;
    use crate::executor::{PendingRequest, Step};
    use crate::js::Js;
    use crate::unique::get;

    const CATALOG: &str = r#"{"adapters":{"crm":{"constructionArgs":[],"schemas":{"":{
        "positions":{
            "Board":{"properties":{"Name":"text","Open":"boolean","Lead":"text"},"edges":{"Notes":{"target":"Note"}}},
            "Note":{"properties":{"Owner":"text"},"edges":{}}
        },
        "collections":{"Boards":{"target":"Board"}},
        "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

    fn record(record_type: &str, id: &str, fields: Vec<(&str, Js)>) -> Js {
        let identity = env::object_of(vec![("kind", Js::str("stable")), ("recordId", Js::str(id)), ("data", env::object_of(fields))]);
        env::object_of(vec![("adapterType", Js::str("crm")), ("recordType", Js::str(record_type)), ("identity", identity)])
    }

    /// The crm's boards, and each board's notes, by board id.
    fn world() -> (Vec<Js>, BTreeMap<&'static str, Vec<Js>>) {
        let board = |id: &str, name: &str, open: bool, lead: &str| record("Board", id, vec![("Name", Js::str(name)), ("Open", Js::Bool(open)), ("Lead", Js::str(lead))]);
        let note = |id: &str, owner: &str| record("Note", id, vec![("Owner", Js::str(owner))]);
        let boards = vec![board("b1", "Ops", true, "ann"), board("b2", "Ops", false, "bob"), board("b3", "Dev", true, "ann")];
        let notes = BTreeMap::from([("b1", vec![note("n1", "ann"), note("n2", "bob")]), ("b2", vec![note("n3", "bob")]), ("b3", vec![note("n4", "ann")])]);
        (boards, notes)
    }

    /// The hops of `walk` (`boards-[…]->…`) as a plan holds them: each its
    /// WHERE, all of it checked, unless `taken` says how many of its leading
    /// conjuncts its module takes.
    fn hops(walk: &str, taken: &[usize]) -> Vec<movement_parser::listen_plan::PlanHop> {
        let probe = format!("{walk}.`__probe__`");
        let tree = movement_parser::expr::parse_expression(&probe).unwrap();
        let Expression::Traverse { steps, .. } = movement_parser::lowering::lower_expression(&tree, &probe).unwrap() else { panic!("a walk") };
        let and = |mut operands: Vec<Expression>| match operands.len() {
            0 => None,
            1 => operands.pop(),
            _ => Some(Expression::Logical { op: LogicalOp::And, operands }),
        };
        steps
            .into_iter()
            .enumerate()
            .map(|(i, step)| {
                let TraversalStep::Edge(step) = step else { panic!("an edge hop") };
                let conjuncts = match step.expression_filter.map(|f| *f) {
                    Some(Expression::Logical { op: LogicalOp::And, operands }) => operands,
                    Some(filter) => vec![filter],
                    None => Vec::new(),
                };
                let split = taken.get(i).copied().unwrap_or(0).min(conjuncts.len());
                let (taken, checked) = conjuncts.split_at(split);
                PlanHop {
                    edge: step.edge_type_id,
                    from: String::new(),
                    to: String::new(),
                    alias: step.alias,
                    taken: and(taken.to_vec()),
                    checked: and(checked.to_vec()),
                    owned: Vec::new(),
                    judged: HopJudged::Resolved,
                }
            })
            .collect()
    }

    /// The walk of `hops` off `boards` in `source`, driven against the
    /// world: its `done`, and every getRelated it asked.
    fn walk(source: &str, hops: Vec<PlanHop>) -> (Json, Vec<String>) {
        let input = json!({
            "entry": "walk", "source": source, "languageVersion": movement_parser::version::LANGUAGE_VERSION, "segmentId": "g1", "serves": [],
            "now": "2026-10-31T12:00:00.000Z", "event": env::encode_plain(&env::object_of(vec![])),
            "catalog": serde_json::from_str::<Json>(CATALOG).unwrap(),
            "connection": "boards", "hops": hops,
        });
        let (boards, notes) = world();
        let positions: RefCell<BTreeMap<u64, Js>> = RefCell::default();
        let asked = RefCell::new(Vec::new());
        let serve = |request: &PendingRequest| match (request.family, request.method.as_str()) {
            ("check", "program") => json!({ "value": { "diagnostics": [], "stamps": [] } }),
            ("adapters", "resolve") => json!({ "value": { "instance": "i1", "adapterType": "crm", "methods": ["getRelated", "getFieldValue"] } }),
            ("trace", "append") => json!({}),
            ("adapters", "call") => {
                let handle = request.args["positionRef"].as_u64().unwrap();
                if let Some(position) = request.args.get("position") {
                    positions.borrow_mut().insert(handle, env::decode(position).unwrap());
                }
                let position = positions.borrow()[&handle].clone();
                let args = env::decode(&request.args["args"]).unwrap();
                let field = get(&args, "fieldId").to_js_string();
                let result = match request.args["method"].as_str().unwrap() {
                    "getRelated" => {
                        let from = crate::traverse::record_id(&position).to_js_string();
                        asked.borrow_mut().push(format!("{field} of {from}"));
                        let related = match field.as_str() {
                            "Boards" => boards.clone(),
                            _ => notes.get(from.as_str()).cloned().unwrap_or_default(),
                        };
                        Js::array(related.into_iter().map(|p| env::object_of(vec![("position", p)])).collect())
                    }
                    "getFieldValue" => get(&crate::traverse::position_data(&position), &field),
                    other => panic!("unexpected {other}"),
                };
                json!({ "value": { "result": env::encode_plain(&result) } })
            }
            other => panic!("unexpected {other:?}"),
        };
        let mut segment = crate::begin(&input.to_string()).unwrap();
        let mut step = segment.start().unwrap();
        let mut outstanding = std::collections::VecDeque::new();
        let done = loop {
            match step {
                Step::Done(done) => break done,
                Step::Pending(pending) => {
                    outstanding.extend(pending);
                    let request = outstanding.pop_front().expect("a request to answer");
                    let answer = crate::read_answer(&serve(&request).to_string()).unwrap();
                    step = segment.answer(request.id, answer).unwrap();
                }
            }
        };
        (done, asked.into_inner())
    }

    fn landed(done: &Json) -> Vec<String> {
        let landed = env::decode(&done["result"]["landed"]).unwrap_or_else(|e| panic!("{e}: {done}"));
        let Js::Array(landed) = landed else { panic!("a list: {done}") };
        landed.items().iter().map(|p| format!("{} {}", get(p, "recordType").to_js_string(), crate::traverse::record_id(p).to_js_string())).collect()
    }

    const SOURCE: &str = "import { crm } from adapters\nboards = crm()\n";

    /// Each hop keeps only what its WHERE holds for, the part its module
    /// takes and the part checked alike, and a later hop reads an earlier
    /// hop's record by its alias: only the open Ops board's note its lead
    /// owns.
    #[test]
    fn a_walk_keeps_what_each_hops_where_holds_for_reading_earlier_hops_by_alias() {
        let plan = hops("boards-[b:Boards WHERE b.Name == \"Ops\" AND b.Open == true]->-[n:Notes WHERE n.Owner == b.Lead]->", &[1, 1]);
        assert!(plan[0].taken.is_some() && plan[0].checked.is_some(), "the first hop's WHERE is split");
        let (done, asked) = walk(SOURCE, plan);
        assert_eq!(landed(&done), ["Note n1"], "{done}");
        assert_eq!(asked, ["Boards of undefined", "Notes of b1"], "only the kept board is walked on");
    }

    /// The walk ends on the hops it is given, and an empty hop list lands
    /// on nothing past the connection.
    #[test]
    fn a_walk_lands_on_its_last_hops_records() {
        let (done, _) = walk(SOURCE, hops("boards-[b:Boards WHERE b.Name == \"Ops\"]->", &[]));
        assert_eq!(landed(&done), ["Board b1", "Board b2"], "{done}");
    }

    /// The program's own names are its own: a function or node it declares
    /// under any name leaves the walk as it was.
    #[test]
    fn the_programs_own_declarations_leave_the_walk_alone() {
        let source = format!("{SOURCE}node __LfListenRead {{\n  at: <text>\n}}\nfunction __lf_listen_heads(read: <__LfListenRead>) {{\n  return 1\n}}\n");
        let (done, _) = walk(&source, hops("boards-[b:Boards WHERE b.Name == \"Dev\"]->", &[]));
        assert_eq!(landed(&done), ["Board b3"], "{done}");
    }

    /// A connection the program does not make is said by name.
    #[test]
    fn a_walk_off_no_connection_is_refused_by_name() {
        let (done, _) = walk("import { crm } from adapters\nother = crm()\n", hops("boards-[:Boards]->", &[]));
        assert_eq!(done["thrown"]["message"], json!("'boards' is no connection the program makes"), "{done}");
    }
}

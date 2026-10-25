//! The story analysis: the check's own recording, as data a projection
//! outside this crate reads (`docs/contracts/story-analysis.md`). The walk
//! that reports the diagnostics also notes, where it resolves something the
//! AST does not say, what it resolved: the instance and record type a write
//! lands on, a listen's events, where each hop of a walk lands, the
//! parameter each argument binds, the scope every construct sits in. Nothing
//! here walks the program a second time; the recorder is off unless a story
//! is asked for, as the stamps of `crate::answer` are.
//!
//! A scope becomes an id into `scopes`, holding the last binding of each name
//! (as the walk leaves it). A movement's `effects` are closed here, over the
//! recorded sites and the calls between movements; whether it may wait is the
//! checker's own inference.

use indexmap::IndexMap;
use serde_json::{Value as Json, json};

use movement_parser::ast::{ArmExpression, AwaitSource, CombinatorKind, PathHead, PathRoot, Program, RValue, Span, Statement};
use movement_parser::catalog::types::{CatalogSnapshot, DeclaredEffectRow};
use movement_parser::lowering::expression::TraversalStep;
use movement_parser::util::form::form_of_text;

use crate::checker::Checker;
use crate::families::calls::{CallPosition, CallReading};
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};
use crate::types::field::Ty;
use crate::types::position::{EXTRACT_ROOT_NAME, ExtractNode, Position};
use crate::{CheckOptions, Diagnostic};

/// The analysis's own version: a reader refuses one it does not know.
pub const STORY_ANALYSIS_VERSION: u32 = 1;

/// What the walk noted, in the order it noted it.
#[derive(Default)]
pub struct Recording {
    writes: Vec<RecordedWrite>,
    nodes: Vec<RecordedNode>,
    bodies: Vec<RecordedBody>,
    /// Where an expression calls a model, reads the clock, or reads a
    /// source outside a value path.
    sites: Vec<EffectSite>,
}

struct RecordedWrite {
    span: Span,
    scope: ScopeId,
    fields: Vec<Json>,
    has_unique_by: bool,
    binding: Option<String>,
    target: Option<(String, Option<String>)>,
    action: &'static str,
    parents: Vec<(String, Option<String>)>,
    /// The instance the write touches, where one could be placed.
    touches: Option<String>,
    /// A write onto a node this run built touches no system at all.
    local: bool,
}

struct RecordedNode {
    span: Span,
    scope: ScopeId,
    what: What,
}

/// The kinds of construct the walk notes, each with what the checker
/// resolved about it.
pub(crate) enum What {
    Instance { name: String, adapter_type: Option<String> },
    Listen {
        instance: String,
        adapter_type: Option<String>,
        fires: String,
        fires_movement: bool,
        events: Option<Vec<String>>,
        narrowing: Vec<(String, String)>,
        event_types: Vec<(String, Option<String>)>,
    },
    Link { from: String, edge: String, to: LinkTo, touches: Option<String> },
    Unlink { from: String, edge: String, to: String, touches: Option<String> },
    Await { binding: Option<String>, source: AwaitedSource },
    Combinator { combinator: CombinatorKind, binding: Option<String>, arms: Vec<(Span, Option<ScopeId>)> },
    Branch { arms: Vec<BranchArm>, otherwise: Option<(Span, ScopeId)> },
    Extract { binding: Option<String>, node: Option<Json> },
    Call { binding: Option<String>, callee: String, is_movement: bool, arg_params: Option<Vec<Option<String>>>, row: CalleeRow },
    CallReading { reading: Json },
    Traversal(Walked),
    ValuePath(Walked),
    Delete { subject: String, touches: Option<String> },
    Refresh { subject: String, touches: Option<String> },
}

pub(crate) enum LinkTo {
    Handle(String),
    Match(Span),
}

pub(crate) enum AwaitedSource {
    Traversal { root: Option<String>, edge: Option<String>, awaitable: Option<bool>, resolves_empty: Option<bool> },
    Sleep { duration: String },
    Until { every: Option<String> },
}

pub(crate) struct BranchArm {
    pub span: Span,
    pub scope: ScopeId,
    pub condition_span: Span,
}

/// What a call's callee does, as far as the check could see it.
pub(crate) enum CalleeRow {
    /// A movement of this file: its row, closed below.
    Movement(SymbolId),
    /// A function whose body is not visible, and the row it declares.
    Declared(DeclaredEffectRow),
    /// A closure bound to a name: its body is counted where it is written.
    Closure(SymbolId),
    /// Nothing the check could look inside.
    Unknown,
}

/// A walk: its root, its hops, and where each landed.
pub(crate) struct Walked {
    pub root: Option<String>,
    /// How the walk starts (`graph`, `result`); absent where the root did not type.
    pub from: Option<&'static str>,
    pub steps: Vec<TraversalStep>,
    /// Where each hop landed, positionally; `None` where it did not type.
    pub landings: Vec<Option<(String, Option<String>)>>,
    /// The instance each place on the walk is in (the start, then each
    /// landing), for what the walk reads. Empty: the walk was never typed.
    pub reads: Vec<Option<String>>,
}

struct RecordedBody {
    span: Span,
    kind: &'static str,
    terminates: bool,
}

struct EffectSite {
    span: Span,
    ai: bool,
    now: bool,
    reads: Vec<Vec<Option<String>>>,
}

/// A walk a typing made inside an expression (`recordPath`), and whether
/// the expression calls a model, reads the clock, or reads a source no
/// value path names.
#[derive(Default)]
pub struct Observed {
    pub(crate) paths: Vec<Walked>,
    pub(crate) ai: bool,
    pub(crate) now: bool,
    /// Each read site, offering every source it might be in: a walk under
    /// `exists` (its start, then each landing), or a source a built-in
    /// declares it reads (`files`).
    pub(crate) reads: Vec<Vec<Option<String>>>,
}

/// `instanceOfType`: the system a position is in, by its binding's name.
pub(crate) fn instance_of(position: &Position) -> Option<String> {
    match position {
        Position::Meta { instance } => Some(instance.name.clone()),
        Position::Position(p) => Some(p.instance.name.clone()),
        Position::Union(u) => Some(u.instance.name.clone()),
        Position::Handle(h) => Some(h.instance.name.clone()),
        Position::MaybeEmpty(of) => instance_of(of),
        Position::OneOf(members) => {
            let mut each = members.iter().map(instance_of);
            let first = each.next()??;
            each.all(|other| other.as_deref() == Some(first.as_str())).then_some(first)
        }
        Position::Extract { .. } | Position::Closure(_) | Position::Local(_) => None,
    }
}

/// `recordedLanding`: a landing's address, for the kinds a schema names.
pub(crate) fn landing_of(position: &Position) -> Option<(String, Option<String>)> {
    match position {
        Position::Position(p) => Some((p.instance.name.clone(), Some(p.position.clone()))),
        Position::Union(u) => Some((u.instance.name.clone(), Some(u.union.clone()))),
        Position::Handle(h) => Some((h.instance.name.clone(), h.position.clone())),
        Position::MaybeEmpty(of) => landing_of(of),
        _ => None,
    }
}

/// `recordedTargetOf`: where a write's handle lands.
fn target_of(handle: &Position) -> Option<(String, Option<String>)> {
    match handle {
        Position::Position(_) | Position::Union(_) | Position::Handle(_) => landing_of(handle),
        _ => None,
    }
}

/// `positionAddress`: where a binding's record is, for the kinds that have one place.
fn address_of(position: &Position) -> Option<(String, Option<String>)> {
    match position {
        Position::Meta { instance } => Some((instance.name.clone(), None)),
        Position::MaybeEmpty(of) => address_of(of),
        other => landing_of(other),
    }
}

/// `traversalFrom`: a walk off a system's records, or off what an earlier step produced.
pub(crate) fn traversal_from(position: &Position) -> Option<&'static str> {
    match position {
        Position::Meta { .. } | Position::Position(_) | Position::Union(_) | Position::Extract { .. } => Some("graph"),
        Position::Handle(_) | Position::Local(_) => Some("result"),
        Position::Closure(_) => None,
        Position::MaybeEmpty(of) => traversal_from(of),
        Position::OneOf(members) => {
            let mut each = members.iter().map(traversal_from);
            let first = each.next()?;
            each.all(|other| other == first).then_some(first)?
        }
    }
}

/// The extracted node a binding holds, where it holds one.
fn extracted_of(position: &Position) -> Option<&ExtractNode> {
    match position {
        Position::Extract { node, .. } => Some(node),
        Position::MaybeEmpty(of) => extracted_of(of),
        _ => None,
    }
}

pub(crate) fn extract_node_json(node: &ExtractNode) -> Json {
    let fields: Vec<Json> = node
        .properties
        .iter()
        .map(|(name, field)| {
            let mut entry = json!({ "name": name, "at": field.span, "fieldType": Json::Null });
            if let Some(explicit) = &field.explicit {
                entry["type"] = json!(crate::types::field::describe_field_type(explicit));
                // The catalog's own spelling of a type, so a consumer reads the borrowed field's declared type as data.
                entry["fieldType"] = serde_json::to_value(explicit.to_schema()).unwrap_or(Json::Null);
            }
            entry
        })
        .collect();
    let children: Vec<Json> = node.children.values().map(|child| extract_node_json(child)).collect();
    json!({ "name": node.name, "fields": fields, "children": children })
}

fn symbol_kind_name(kind: SymbolKind) -> &'static str {
    match kind {
        SymbolKind::Adapter => "adapter",
        SymbolKind::Credential => "credential",
        SymbolKind::Plugin => "plugin",
        SymbolKind::FileImport => "fileImport",
        SymbolKind::Binding => "binding",
        SymbolKind::Instance => "instance",
        SymbolKind::Param => "param",
        SymbolKind::Movement => "movement",
        SymbolKind::Shape => "shape",
        SymbolKind::Alias => "alias",
        SymbolKind::Type => "type",
    }
}

fn contains(outer: &Span, inner: &Span) -> bool {
    let before = |a: movement_parser::ast::Loc, b: movement_parser::ast::Loc| (a.line, a.col) <= (b.line, b.col);
    before(outer.start, inner.start) && before(inner.end, outer.end)
}

impl Checker<'_> {
    /// Whether what the walk passes now is noted: a story was asked for, and
    /// this is the program's own text walked for its diagnostics (not a
    /// library's, not a walk made only to learn a type).
    pub(crate) fn recording(&self) -> bool {
        self.story.is_some() && self.type_only == 0 && self.imports.current_path().is_none()
    }

    fn recorder(&mut self) -> Option<&mut Recording> {
        if !self.recording() {
            return None;
        }
        self.story.as_deref_mut()
    }

    /// Notes a construct; its index, to finish it where more is learned.
    pub(crate) fn record_node(&mut self, span: Span, scope: ScopeId, what: What) -> Option<usize> {
        let recording = self.recorder()?;
        recording.nodes.push(RecordedNode { span, scope, what });
        Some(recording.nodes.len() - 1)
    }

    pub(crate) fn recorded_node_mut(&mut self, index: usize) -> Option<&mut What> {
        self.story.as_deref_mut().and_then(|r| r.nodes.get_mut(index)).map(|n| &mut n.what)
    }

    /// Notes a statement list the story caps a lane by, and whether it leaves.
    pub(crate) fn record_body(&mut self, span: Span, kind: &'static str, terminates: bool) {
        if let Some(recording) = self.recorder() {
            recording.bodies.push(RecordedBody { span, kind, terminates });
        }
    }

    /// The scope the walk opened for the body at `span` (crate::query's extents).
    pub(crate) fn scope_of_body(&self, span: Span) -> Option<ScopeId> {
        self.extents.iter().rev().find(|(at, _)| *at == span).map(|(_, scope)| *scope)
    }

    /// The system `name` reaches in `scope`, where its type places one.
    pub(crate) fn instance_named(&self, name: &str, scope: ScopeId) -> Option<String> {
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return None };
        let types = &self.scopes.symbol(id).types;
        match (&types.pos, &types.field) {
            (Some(position), _) => instance_of(position),
            (None, Some(field)) => match crate::types::field::strip_absent(field) {
                Ty::Record(Some(position)) => instance_of(position),
                _ => None,
            },
            _ => None,
        }
    }

    /// A write or match, noted where its target and fields are settled.
    #[allow(clippy::too_many_arguments)] // one record's fields, named at the one call site each
    pub(crate) fn record_write(
        &mut self,
        span: Span,
        scope: ScopeId,
        fields: Vec<Json>,
        has_unique_by: bool,
        handle: Option<&Position>,
        action: &'static str,
        parents: Vec<(String, Option<String>)>,
        local: bool,
    ) {
        let target = handle.and_then(target_of);
        let touches = handle.and_then(instance_of);
        if let Some(recording) = self.recorder() {
            recording.writes.push(RecordedWrite { span, scope, fields, has_unique_by, binding: None, target, action, parents, touches, local });
        }
    }

    /// The walk a typing is about to make inside an expression is observed.
    pub(crate) fn observing(&self) -> Option<Box<Observed>> {
        self.recording().then(Box::default)
    }

    /// Notes what a typing of the slot at `span` observed.
    pub(crate) fn record_observed(&mut self, span: Span, scope: ScopeId, observed: Option<Box<Observed>>) {
        let Some(observed) = observed else { return };
        let Some(recording) = self.recorder() else { return };
        if observed.ai || observed.now || !observed.reads.is_empty() {
            recording.sites.push(EffectSite { span, ai: observed.ai, now: observed.now, reads: observed.reads });
        }
        let mut seen: Vec<String> = Vec::new();
        for walked in observed.paths {
            let key = value_path_key(walked.root.as_deref(), &walked.steps);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            recording.nodes.push(RecordedNode { span, scope, what: What::ValuePath(walked) });
        }
    }

    /// The value bound to `name` in `scope` was this construct.
    pub(crate) fn record_assigned(&mut self, name: &str, value: &RValue, scope: ScopeId) {
        let span = match value {
            RValue::Call { call } => call.span,
            RValue::Write { write } => write.span,
            RValue::Match { r#match } => r#match.span,
            RValue::Extract { extract } => {
                let position = match self.scopes.resolve(scope, name) {
                    Resolution::Found(id) => self.scopes.symbol(id).types.pos.clone(),
                    _ => None,
                };
                self.record_extracted(extract.span, position.as_ref());
                extract.span
            }
            RValue::Await { r#await } => match &r#await.source {
                AwaitSource::Combinator { combinator, .. } => combinator.span,
                _ => r#await.span,
            },
            RValue::Combinator { combinator } => combinator.span,
            RValue::ExtractCall { extract_call } => extract_call.span,
            _ => return,
        };
        self.record_binding(span, name);
    }

    /// An `await` parked on a walk: the edge it waits on, and that edge's promise.
    pub(crate) fn record_awaited_walk(&mut self, span: Span, head: &PathHead, walk: Option<&crate::families::walks::HeadWalk>, scope: ScopeId) {
        if !self.recording() {
            return;
        }
        let root = match &head.root {
            Some(PathRoot::Name { name }) => Some(name.clone()),
            _ => None,
        };
        let edge = Self::head_steps(head).and_then(|steps| {
            steps.iter().rev().find_map(|step| match step {
                TraversalStep::Edge(edge) => Some(edge.edge_type_id.clone()),
                _ => None,
            })
        });
        let schema = walk.and_then(|w| w.last_edge_schema.as_ref());
        let source = AwaitedSource::Traversal {
            root,
            edge,
            awaitable: schema.map(|s| s.awaitable == Some(true)),
            resolves_empty: schema.map(|s| s.resolves_empty == Some(true)),
        };
        self.record_node(span, scope, What::Await { binding: None, source });
    }

    /// How a call reads where it is written, noted where it is a built-in's.
    pub(crate) fn record_call_reading(&mut self, span: Span, scope: ScopeId, reading: &CallReading) {
        let reading = match reading {
            CallReading::Function => return,
            CallReading::Value(expr) => json!({ "kind": "value", "expr": expr }),
            CallReading::Collection(collection) => json!({ "kind": "collection", "collection": collection }),
            CallReading::Members(members) => json!({ "kind": "members", "members": members }),
            CallReading::Refused { code, message, span } => json!({ "kind": "refused", "refusal": { "code": code, "message": message, "span": span } }),
        };
        let Some(recording) = self.recorder() else { return };
        if recording.nodes.iter().any(|n| n.span == span && matches!(n.what, What::CallReading { .. })) {
            return;
        }
        recording.nodes.push(RecordedNode { span, scope, what: What::CallReading { reading } });
    }

    /// `read_call` for a call written as another call's argument, its reading noted.
    pub(crate) fn read_call_recorded(&mut self, call: &movement_parser::ast::CallStatement, scope: ScopeId) -> CallReading {
        let reading = self.read_call(call, scope, CallPosition::Argument);
        self.record_call_reading(call.span, scope, &reading);
        reading
    }

    /// What calling `callee` in `scope` does, as far as the check can see.
    pub(crate) fn callee_row(&self, callee: &str, scope: ScopeId) -> CalleeRow {
        let Resolution::Found(id) = self.scopes.resolve(scope, callee) else { return CalleeRow::Unknown };
        let symbol = self.scopes.symbol(id);
        match symbol.kind {
            SymbolKind::Movement => CalleeRow::Movement(id),
            SymbolKind::Plugin => self.plugin_spec_of(id, callee).and_then(|spec| spec.effects).map_or(CalleeRow::Unknown, CalleeRow::Declared),
            _ if self.calls_closure(symbol) => CalleeRow::Closure(id),
            _ => CalleeRow::Unknown,
        }
    }

    /// A combinator's written arms: each closure's own scope, and whether its
    /// body leaves (a `return` there is the arm's value, so only an `ERROR` does).
    pub(crate) fn record_arms(&mut self, at: usize, arms: &[ArmExpression]) {
        let mut written = Vec::new();
        for arm in arms {
            match arm {
                ArmExpression::Closure { closure, span } => {
                    written.push((*span, self.scope_of_body(closure.span)));
                    self.record_body(*span, "combinatorArm", crate::checker::terminates_with(&closure.body, false));
                }
                ArmExpression::Ref { span, .. } => written.push((*span, None)),
            }
        }
        if let Some(What::Combinator { arms, .. }) = self.recorded_node_mut(at) {
            *arms = written;
        }
    }

    /// `name` is what the construct at `span` was bound to.
    pub(crate) fn record_binding(&mut self, span: Span, name: &str) {
        let Some(recording) = self.recorder() else { return };
        for write in recording.writes.iter_mut().rev().filter(|w| w.span == span) {
            write.binding = Some(name.to_string());
        }
        for node in recording.nodes.iter_mut().rev().filter(|n| n.span == span) {
            let binding = match &mut node.what {
                What::Await { binding, .. } | What::Combinator { binding, .. } | What::Extract { binding, .. } | What::Call { binding, .. } => binding,
                _ => continue,
            };
            *binding = Some(name.to_string());
        }
    }

    /// The extraction bound at `span` resolved to this graph.
    pub(crate) fn record_extracted(&mut self, span: Span, position: Option<&Position>) {
        let tree = position.and_then(extracted_of).map(extract_node_json);
        let Some(recording) = self.recorder() else { return };
        for node in recording.nodes.iter_mut().rev().filter(|n| n.span == span) {
            if let What::Extract { node, .. } = &mut node.what {
                *node = tree.clone();
            }
        }
    }

    /// A head's walk is typed: where each hop landed, and what it reads.
    pub(crate) fn record_landings(&mut self, span: Span, start: &Position, landings: &[Option<Position>]) {
        let Some(recording) = self.recorder() else { return };
        let Some(walked) = recording.nodes.iter_mut().rev().find_map(|n| match &mut n.what {
            What::Traversal(walked) if n.span == span && walked.reads.is_empty() => Some(walked),
            _ => None,
        }) else {
            return;
        };
        walked.landings = landings.iter().map(|l| l.as_ref().and_then(landing_of)).collect();
        walked.reads = std::iter::once(instance_of(start)).chain(landings.iter().map(|l| l.as_ref().and_then(instance_of))).collect();
    }
}

/// `valuePathKey`: one walked path's comparable token. Its keys are sorted,
/// as every JSON this crate writes; it is only ever compared.
pub fn value_path_key(root: Option<&str>, steps: &[TraversalStep]) -> String {
    serde_json::to_value(json!([root, steps])).map(|v| v.to_string()).unwrap_or_default()
}

/// What one check of a program recorded, ready to answer as JSON.
pub struct StoryAnalysis {
    pub diagnostics: Vec<Diagnostic>,
    json: Json,
}

impl StoryAnalysis {
    /// `{storyAnalysisVersion, diagnostics, scopes, symbols, writes, nodes, bodies, shapes}`.
    pub fn to_json(&self) -> Json {
        let mut answer = self.json.clone();
        answer["diagnostics"] = json!(self.diagnostics);
        answer
    }
}

/// The analysis of a program whose pin this release does not read: the
/// version diagnostic alone, and nothing walked. `None` for a pin it reads.
pub fn refused_story_analysis(pin: &str) -> Option<Json> {
    let refusal = crate::language_version_diagnostic(pin)?;
    Some(json!({
        "storyAnalysisVersion": STORY_ANALYSIS_VERSION,
        "diagnostics": [refusal],
        "scopes": [],
        "symbols": [],
        "writes": [],
        "nodes": [],
        "bodies": [],
        "shapes": [],
    }))
}

/// Checks `program` with the recorder on, and answers what the walk recorded.
pub fn analyze_story(program: &Program, catalog: &CatalogSnapshot, options: CheckOptions) -> StoryAnalysis {
    let (diagnostics, checker) = crate::run_check_with(program, catalog, options, true);
    let json = Writer::new(&checker, program).write();
    StoryAnalysis { diagnostics, json }
}

/// The story analysis as JSON, or `{error}` for a source that does not parse
/// or a catalog that does not load (`check_json`'s inputs).
pub fn story_analysis_json(source: &str, catalog_json: &str, options: CheckOptions) -> Json {
    let catalog = match CatalogSnapshot::load(&movement_parser::util::form::read_json_text(catalog_json)) {
        Ok(catalog) => catalog,
        Err(message) => return json!({ "error": { "message": message } }),
    };
    match movement_parser::stmt::parse_program(&form_of_text(source), false) {
        Ok(program) => analyze_story(&program, &catalog, options).to_json(),
        Err(e) => json!({ "error": { "message": format!("{} at line {}, column {}", e.message, e.loc.line, e.loc.col) } }),
    }
}

/// What a movement may do (`EffectRow`), as the analysis closes it.
#[derive(Default, Clone, PartialEq)]
struct Row {
    reads: Vec<String>,
    writes: Vec<String>,
    ai: bool,
    now: bool,
    suspend: bool,
    partial: bool,
}

impl Row {
    fn read(&mut self, name: &str) {
        if !self.reads.iter().any(|r| r == name) {
            self.reads.push(name.to_string());
        }
    }

    fn write(&mut self, name: &str) {
        if !self.writes.iter().any(|w| w == name) {
            self.writes.push(name.to_string());
        }
    }

    /// One site touching whichever of `candidates` resolved; a site none of
    /// whose candidates resolved makes the row a lower bound.
    fn touch(&mut self, write: bool, candidates: &[Option<String>]) {
        let mut placed = false;
        for name in candidates.iter().flatten() {
            placed = true;
            if write { self.write(name) } else { self.read(name) }
        }
        self.partial |= !placed;
    }

    fn absorb(&mut self, other: &Row) {
        for name in &other.reads {
            self.read(name);
        }
        for name in &other.writes {
            self.write(name);
        }
        self.ai |= other.ai;
        self.now |= other.now;
        self.suspend |= other.suspend;
        self.partial |= other.partial;
    }

    fn declared(declared: &DeclaredEffectRow) -> Row {
        let mut row = Row { ai: declared.ai == Some(true), now: declared.now == Some(true), suspend: declared.suspend == Some(true), ..Row::default() };
        declared.reads.iter().flatten().for_each(|name| row.read(name));
        declared.writes.iter().flatten().for_each(|name| row.write(name));
        row
    }

    fn to_json(&self) -> Json {
        json!({ "reads": self.reads, "writes": self.writes, "ai": self.ai, "now": self.now, "suspend": self.suspend, "partial": self.partial })
    }
}

/// Writes the recording out: arena ids become dense ids into `scopes` and
/// `symbols`, the file's scope first.
struct Writer<'w, 'c> {
    checker: &'w Checker<'c>,
    program: &'w Program,
    recording: &'w Recording,
    scope_ids: IndexMap<ScopeId, usize>,
    symbol_ids: IndexMap<SymbolId, usize>,
}

impl<'w, 'c> Writer<'w, 'c> {
    fn new(checker: &'w Checker<'c>, program: &'w Program) -> Self {
        let recording = checker.story.as_deref().expect("the recorder was on");
        Writer { checker, program, recording, scope_ids: IndexMap::new(), symbol_ids: IndexMap::new() }
    }

    fn scope(&mut self, scope: ScopeId) -> usize {
        if let Some(id) = self.scope_ids.get(&scope) {
            return *id;
        }
        if let Some(parent) = self.checker.scopes.scope(scope).parent {
            self.scope(parent);
        }
        let id = self.scope_ids.len();
        self.scope_ids.insert(scope, id);
        id
    }

    fn symbol(&mut self, symbol: SymbolId) -> usize {
        let next = self.symbol_ids.len();
        *self.symbol_ids.entry(symbol).or_insert(next)
    }

    fn write(mut self) -> Json {
        self.scope(ScopeId(0));
        for (_, scope) in &self.checker.extents {
            self.scope(*scope);
        }
        let writes: Vec<Json> = self.recording.writes.iter().map(|w| self.write_json(w)).collect();
        let nodes: Vec<Json> = self.recording.nodes.iter().map(|n| self.node_json(n)).collect();
        let bodies: Vec<Json> =
            self.recording.bodies.iter().map(|b| json!({ "span": b.span, "kind": b.kind, "terminates": b.terminates })).collect();
        let shapes = self.shapes();
        let rows = self.rows();
        // Every scope the analysis names, each with its last binding per name.
        let mut scopes = Vec::new();
        let mut index = 0;
        while index < self.scope_ids.len() {
            let (arena, _) = self.scope_ids.get_index(index).map(|(a, b)| (*a, *b)).expect("in range");
            let scope = self.checker.scopes.scope(arena);
            let parent = scope.parent.map(|p| self.scope(p));
            let symbols: serde_json::Map<String, Json> = scope.symbols.iter().map(|(name, id)| (name.clone(), json!(self.symbol(*id)))).collect();
            let mut entry = json!({ "symbols": symbols });
            if let Some(parent) = parent {
                entry["parent"] = json!(parent);
            }
            if let Some((span, _)) = self.checker.extents.iter().find(|(_, s)| *s == arena) {
                entry["span"] = json!(span);
            }
            scopes.push(entry);
            index += 1;
        }
        let symbols: Vec<Json> = self.symbol_ids.keys().map(|id| self.symbol_json(*id, &rows)).collect();
        json!({
            "storyAnalysisVersion": STORY_ANALYSIS_VERSION,
            "scopes": scopes,
            "symbols": symbols,
            "writes": writes,
            "nodes": nodes,
            "bodies": bodies,
            "shapes": shapes,
        })
    }

    fn symbol_json(&self, id: SymbolId, rows: &std::collections::HashMap<SymbolId, Row>) -> Json {
        let symbol = self.checker.scopes.symbol(id);
        let mut entry = json!({ "name": symbol.name, "kind": symbol_kind_name(symbol.kind), "span": symbol.span });
        if let Some(adapter) = &symbol.adapter {
            entry["adapter"] = json!(adapter);
        }
        let position = symbol.types.pos.as_ref().or(match symbol.types.field.as_ref().map(crate::types::field::strip_absent) {
            Some(Ty::Record(Some(position))) => Some(&**position),
            _ => None,
        });
        if let Some(position) = position {
            if let Some(node) = extracted_of(position) {
                entry["extracted"] = if node.name == EXTRACT_ROOT_NAME { json!({}) } else { json!({ "entity": node.name }) };
            } else if let Some((instance, at)) = address_of(position) {
                entry["address"] = match at {
                    Some(at) => json!({ "instance": instance, "position": at }),
                    None => json!({ "instance": instance }),
                };
            }
        }
        if let Some(row) = rows.get(&id) {
            entry["effects"] = row.to_json();
        }
        entry
    }

    fn write_json(&mut self, write: &RecordedWrite) -> Json {
        let mut entry = json!({
            "span": write.span,
            "scope": self.scope(write.scope),
            "fields": write.fields,
            "hasUniqueBy": write.has_unique_by,
            "action": write.action,
            "parents": write.parents.iter().map(|(edge, type_)| match type_ {
                Some(type_) => json!({ "edge": edge, "type": type_ }),
                None => json!({ "edge": edge }),
            }).collect::<Vec<_>>(),
        });
        if let Some(binding) = &write.binding {
            entry["binding"] = json!(binding);
        }
        if let Some((instance, record_type)) = &write.target {
            entry["target"] = match record_type {
                Some(record_type) => json!({ "instance": instance, "recordType": record_type }),
                None => json!({ "instance": instance }),
            };
        }
        entry
    }

    fn node_json(&mut self, node: &RecordedNode) -> Json {
        let mut entry = match &node.what {
            What::Instance { name, adapter_type } => json!({ "kind": "instance", "name": name, "adapterType": adapter_type }),
            What::Listen { instance, adapter_type, fires, fires_movement, events, narrowing, event_types } => json!({
                "kind": "listen",
                "instance": instance,
                "adapterType": adapter_type,
                "fires": fires,
                "firesMovement": fires_movement,
                "events": events,
                "narrowing": narrowing.iter().map(|(key, value)| (key.clone(), json!(value))).collect::<serde_json::Map<String, Json>>(),
                "eventTypes": event_types.iter().map(|(key, display)| json!({ "key": key, "display": display })).collect::<Vec<_>>(),
            }),
            What::Link { from, edge, to, .. } => json!({
                "kind": "link",
                "from": from,
                "edge": edge,
                "to": match to {
                    LinkTo::Handle(name) => json!({ "kind": "handle", "name": name }),
                    LinkTo::Match(span) => json!({ "kind": "match", "span": span }),
                },
            }),
            What::Unlink { from, edge, to, .. } => json!({ "kind": "unlink", "from": from, "edge": edge, "to": { "kind": "handle", "name": to } }),
            What::Await { binding, source } => json!({
                "kind": "await",
                "binding": binding,
                "source": match source {
                    AwaitedSource::Traversal { root, edge, awaitable, resolves_empty } => {
                        json!({ "kind": "traversal", "root": root, "edge": edge, "awaitable": awaitable, "resolvesEmpty": resolves_empty })
                    }
                    AwaitedSource::Sleep { duration } => json!({ "kind": "sleep", "duration": duration }),
                    AwaitedSource::Until { every } => json!({ "kind": "until", "every": every }),
                },
            }),
            What::Combinator { combinator, binding, arms } => {
                let arms: Vec<Json> = arms
                    .iter()
                    .map(|(span, scope)| match scope {
                        Some(scope) => json!({ "span": span, "scope": self.scope(*scope) }),
                        None => json!({ "span": span }),
                    })
                    .collect();
                json!({ "kind": "combinator", "combinator": combinator.word(), "binding": binding, "arms": arms })
            }
            What::Branch { arms, otherwise } => {
                let arms: Vec<Json> = arms
                    .iter()
                    .map(|arm| json!({ "span": arm.span, "scope": self.scope(arm.scope), "conditionSpan": arm.condition_span }))
                    .collect();
                let otherwise = otherwise.map(|(span, scope)| json!({ "span": span, "scope": self.scope(scope) }));
                json!({ "kind": "branch", "arms": arms, "otherwise": otherwise })
            }
            What::Extract { binding, node } => json!({ "kind": "extract", "binding": binding, "node": node }),
            What::Call { binding, callee, is_movement, arg_params, .. } => {
                json!({ "kind": "call", "binding": binding, "callee": callee, "isMovement": is_movement, "argParams": arg_params })
            }
            What::CallReading { reading } => json!({ "kind": "callReading", "reading": reading }),
            What::Traversal(walked) | What::ValuePath(walked) => {
                let mut entry = json!({
                    "kind": if matches!(node.what, What::Traversal(_)) { "traversal" } else { "valuePath" },
                    "root": walked.root,
                    "from": walked.from,
                    "steps": walked.steps,
                    "landings": walked.landings.iter().map(|l| l.as_ref().map(|(instance, position)| match position {
                        Some(position) => json!({ "instance": instance, "position": position }),
                        None => json!({ "instance": instance }),
                    })).collect::<Vec<_>>(),
                });
                if matches!(node.what, What::ValuePath(_)) {
                    entry["key"] = json!(value_path_key(walked.root.as_deref(), &walked.steps));
                    entry.as_object_mut().expect("an object").remove("from");
                }
                entry
            }
            What::Delete { subject, .. } => json!({ "kind": "delete", "subject": subject }),
            What::Refresh { subject, .. } => json!({ "kind": "refresh", "subject": subject }),
        };
        // An absent fact is left out, never written as null — except a
        // landing a hop did not type, which holds its place.
        if let Some(object) = entry.as_object_mut() {
            object.retain(|_, value| !value.is_null());
            if let Some(Json::Object(source)) = object.get_mut("source") {
                source.retain(|_, value| !value.is_null());
            }
            if let Some(Json::Array(types)) = object.get_mut("eventTypes") {
                for each in types.iter_mut().filter_map(Json::as_object_mut) {
                    each.retain(|_, value| !value.is_null());
                }
            }
        }
        entry["span"] = json!(node.span);
        entry["scope"] = json!(self.scope(node.scope));
        entry
    }

    /// The file's node declarations, each with what it extends folded in
    /// (the declaration the checker resolved, base members first).
    fn shapes(&self) -> Vec<Json> {
        let file = self.checker.scopes.scope(ScopeId(0));
        self.program
            .statements
            .iter()
            .filter_map(|statement| {
                let Statement::Shape(shape) = statement else { return None };
                let resolved = file
                    .symbols
                    .get(&shape.name)
                    .filter(|id| self.checker.scopes.symbol(**id).span == shape.span)
                    .and_then(|id| self.checker.nodes.declared(*id))
                    .map(|declared| &declared.declaration);
                let root = &resolved.unwrap_or(shape).root;
                Some(json!({ "name": shape.name, "span": shape.span, "root": root }))
            })
            .collect()
    }

    /// Each movement of the file's row: its body's sites, closed over the
    /// movements it calls (a call cycle shares one row), with whether it may
    /// wait the checker's own inference.
    fn rows(&self) -> std::collections::HashMap<SymbolId, Row> {
        let file = self.checker.scopes.scope(ScopeId(0));
        let movements: Vec<(SymbolId, Span)> = file
            .symbols
            .values()
            .copied()
            .filter(|id| self.checker.scopes.symbol(*id).kind == SymbolKind::Movement)
            .filter_map(|id| {
                let span = self.checker.scopes.symbol(id).span;
                self.recording.bodies.iter().any(|b| b.kind == "movement" && b.span == span).then_some((id, span))
            })
            .collect();
        let mut direct: std::collections::HashMap<SymbolId, (Row, Vec<SymbolId>)> = std::collections::HashMap::new();
        for (id, span) in &movements {
            let mut row = Row { suspend: self.checker.suspends(*id), ..Row::default() };
            let mut calls = Vec::new();
            let within = |at: &Span| contains(span, at);
            for write in self.recording.writes.iter().filter(|w| within(&w.span)) {
                if !write.local {
                    row.touch(write.action != "find", std::slice::from_ref(&write.touches));
                }
            }
            for site in self.recording.sites.iter().filter(|s| within(&s.span)) {
                row.ai |= site.ai;
                row.now |= site.now;
                for read in &site.reads {
                    row.touch(false, read);
                }
            }
            for node in self.recording.nodes.iter().filter(|n| within(&n.span)) {
                match &node.what {
                    What::Link { touches, .. } | What::Unlink { touches, .. } | What::Delete { touches, .. } => {
                        row.touch(true, std::slice::from_ref(touches))
                    }
                    What::Refresh { touches, .. } => row.touch(false, std::slice::from_ref(touches)),
                    What::Traversal(walked) | What::ValuePath(walked) if !walked.reads.is_empty() && !walked.steps.is_empty() => {
                        row.touch(false, &walked.reads)
                    }
                    What::Extract { .. } => row.ai = true,
                    What::Call { row: callee, .. } => match callee {
                        CalleeRow::Movement(callee) if movements.iter().any(|(m, _)| m == callee) => calls.push(*callee),
                        CalleeRow::Declared(declared) => row.absorb(&Row::declared(declared)),
                        CalleeRow::Closure(closure) if within(&self.checker.scopes.symbol(*closure).span) => {}
                        _ => row.partial = true,
                    },
                    _ => {}
                }
            }
            direct.insert(*id, (row, calls));
        }
        let mut rows: std::collections::HashMap<SymbolId, Row> = direct.iter().map(|(id, (row, _))| (*id, row.clone())).collect();
        loop {
            let mut changed = false;
            for (id, (_, calls)) in &direct {
                let mut row = rows[id].clone();
                for callee in calls {
                    let theirs = rows[callee].clone();
                    row.absorb(&theirs);
                }
                if row != rows[id] {
                    rows.insert(*id, row);
                    changed = true;
                }
            }
            if !changed {
                return rows;
            }
        }
    }
}

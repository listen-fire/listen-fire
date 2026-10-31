//! `listen to <traversal> fire f`: a standing listen is a traversal ending on
//! an edge its module announces arrivals on, checked as a wait's is, and
//! planned for the host: which part of each hop's WHERE the module takes,
//! which the host checks, and how the host honours a filter on a hop before
//! the last (judged on each arrival, or by listing the hop's members).
//!
//! Codes: MOV_LISTEN_EDGE_NOT_LISTENABLE, MOV_LISTEN_HOP_NOT_ITERABLE,
//! MOV_LISTEN_UNWATCHABLE, MOV_LISTEN_IMPURE_WHERE, and for the path form
//! MOV_LISTEN_NOT_INSTANCE, MOV_LISTEN_PARAM_MISMATCH,
//! MOV_LISTEN_DUPLICATE, MOV_LISTEN_ALIAS_DUPLICATE.

use std::collections::HashMap;

use movement_parser::ast::{ListenDeclaration, PathHead, PathRoot};
use movement_parser::catalog::types::{CollectionSchema, Delivery, EdgeSchema, InstanceSchema, PositionSchema};
use movement_parser::listen_plan::{HopJudged, ListenPlan, PlanHop};
use movement_parser::lowering::expression::{EdgeStep, Expression, LogicalOp, TraversalStep};

use crate::checker::Checker;
use crate::codes;
use crate::families::filter_split::{EdgeView, split_hop, spell};
use crate::families::flow::spell_path_head;
use crate::families::names::spell_name;
use crate::families::walks::is_pure_predicate;
use crate::scope::{Resolution, ScopeId, SymbolKind};
use crate::types::position::{Instance, Position, positions_match};

/// A landing the schema declares no record type for (a union's name): its
/// WHERE splits as one over no known field.
static NO_LANDING: std::sync::LazyLock<PositionSchema> = std::sync::LazyLock::new(crate::types::position::empty_position_schema);

/// One hop of the traversal, as its module declares it.
struct Hop<'a> {
    step: &'a EdgeStep,
    /// The record type it leaves; `None` off the connection itself.
    from: Option<&'a str>,
    /// The record type it lands on.
    to: &'a str,
    edge: Declared<'a>,
}

enum Declared<'a> {
    Collection(&'a CollectionSchema),
    Edge(&'a EdgeSchema),
}

impl Declared<'_> {
    fn readable(&self) -> bool {
        match self {
            Declared::Collection(c) => c.readable != Some(false),
            Declared::Edge(e) => crate::families::walks::edge_is_readable(e),
        }
    }

    fn listenable(&self) -> bool {
        match self {
            Declared::Collection(c) => c.listenable == Some(true),
            Declared::Edge(e) => e.listenable == Some(true),
        }
    }

    fn delivery(&self) -> Option<Delivery> {
        match self {
            Declared::Collection(c) => c.delivery,
            Declared::Edge(e) => e.delivery,
        }
    }

    fn carries(&self) -> &[String] {
        match self {
            Declared::Collection(c) => c.carries.as_deref().unwrap_or_default(),
            Declared::Edge(e) => e.carries.as_deref().unwrap_or_default(),
        }
    }

    fn cheap_to_list(&self) -> bool {
        match self {
            Declared::Collection(c) => c.cheap_to_list == Some(true),
            Declared::Edge(e) => e.cheap_to_list == Some(true),
        }
    }

    fn view<'v>(&'v self, name: &'v str, module: &'v str) -> EdgeView<'v> {
        match self {
            Declared::Collection(c) => EdgeView::of_collection(name, module, c),
            Declared::Edge(e) => EdgeView::of_edge(name, module, e),
        }
    }
}

impl Checker<'_> {
    /// `listen to <traversal> fire f`, at file level: its root a connection,
    /// every hop but the last one its module lists, the last one it announces
    /// arrivals on, each WHERE read only off the listen's own hops and
    /// literals; then the function it fires, and the plan the host watches it
    /// by.
    pub(super) fn check_listen_traversal(&mut self, statement: &ListenDeclaration, path: &PathHead, scope: ScopeId) {
        let before = self.diagnostics.len();
        self.check_path_head(path, scope);
        let instance = match self.listen_root(statement, path, scope) {
            Some(Position::Meta { instance }) => Some(instance),
            _ => None,
        };
        let lowered = Self::head_steps(path).unwrap_or_default();
        // A walk in a WHERE is refused as the listen's (`foreign_read`), so
        // the wait's walk does not also judge it as a read or a wait.
        let without_walks: Vec<TraversalStep> = lowered.iter().cloned().map(without_walks).collect();
        let walk = instance.as_ref().and_then(|_| self.walk_head_steps(path, &without_walks, scope, true));
        // The walk is a wait's, and a listen's WHERE is refused by its own
        // code, not by the wait's.
        let walked = self.diagnostics.split_off(before.min(self.diagnostics.len()));
        self.diagnostics.extend(walked.into_iter().filter(|d| d.code != codes::AWAIT_IMPURE_WHERE));
        let steps: Vec<EdgeStep> = lowered
            .into_iter()
            .filter_map(|step| match step {
                TraversalStep::Edge(edge) => Some(edge),
                _ => None,
            })
            .collect();
        let plan = instance.as_ref().and_then(|instance| self.plan_listen(statement, path, instance, &steps, scope));
        if let Some(walk) = &walk {
            self.check_listen_fires(statement, path, &steps, walk.landed.as_ref(), scope);
        }
        let identity = match &plan {
            Some(plan) => identity_of(plan),
            None => format!("{}::{}", spell_path_head(path), statement.movement),
        };
        if !self.listens.identities.insert(format!("path::{identity}")) {
            self.report(
                codes::LISTEN_DUPLICATE,
                format!("Duplicate listener — an identical 'listen to {}' already fires '{}'", spell_path_head(path), statement.movement),
                statement.span,
            );
        }
        if let Some(alias) = &statement.alias
            && !self.listens.aliases.insert(format!("{}::{alias}", statement.movement))
        {
            self.report(
                codes::LISTEN_ALIAS_DUPLICATE,
                format!("Two lanes of '{}' are both named \"{alias}\" — give each listen a distinct alias", statement.movement),
                statement.span,
            );
        }
        if self.recording() {
            let fires_movement = self.scopes.resolve_function(scope, &statement.movement).is_some_and(|id| self.scopes.symbol(id).kind == SymbolKind::Movement);
            let what = crate::story::What::Listen {
                instance: statement.instance.clone(),
                adapter_type: instance.as_ref().and_then(|i| i.adapter.clone()),
                fires: statement.movement.clone(),
                fires_movement,
                events: None,
                narrowing: Vec::new(),
                event_types: Vec::new(),
                path: Some(spell_path_head(path)),
            };
            self.record_node(statement.span, scope, what);
        }
        // A host watches only a listen that checks clean.
        let clean = self.diagnostics[before.min(self.diagnostics.len())..].iter().all(|d| d.severity.is_some());
        if let Some(plan) = plan.filter(|_| clean) {
            self.listens.plans.push(plan);
        }
    }

    /// The connection a listen's traversal starts from, as a position.
    fn listen_root(&mut self, statement: &ListenDeclaration, path: &PathHead, scope: ScopeId) -> Option<Position> {
        let Some(PathRoot::Name { name }) = &path.root else { return None };
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return None };
        let symbol = self.scopes.symbol(id);
        match symbol.kind {
            SymbolKind::Instance => self.head_root_type(path, scope),
            // `check_path_head` refuses an adapter as a root.
            SymbolKind::Adapter => None,
            kind => {
                let message = format!(
                    "'{name}' is {} — a listen's traversal starts at a connection (e.g. 'listen to chat-[:Channels]->-[:Messages]-> fire {}')",
                    kind.describe(),
                    statement.movement
                );
                self.report(codes::LISTEN_NOT_INSTANCE, message, path.span);
                None
            }
        }
    }

    /// The hops as the connection's module declares them, each refused where
    /// a listen cannot take it, and the plan when every hop can be watched.
    fn plan_listen(&mut self, statement: &ListenDeclaration, path: &PathHead, instance: &Instance, steps: &[EdgeStep], scope: ScopeId) -> Option<ListenPlan> {
        let schema: &InstanceSchema = &instance.schema;
        let module = instance.adapter.as_deref().unwrap_or(&instance.name);
        let hops = declared_hops(schema, steps)?;
        let (last, earlier) = hops.split_last()?;
        let mut watchable = true;
        for hop in earlier {
            if !hop.edge.readable() {
                let message = format!(
                    "'-[:{}]->' on {} can't be listed, so a listen can't pass through it — only a listen's last edge may be one that is only announced",
                    hop.step.edge_type_id,
                    owner(instance, hop.from)
                );
                self.report(codes::LISTEN_HOP_NOT_ITERABLE, message, path.span);
                watchable = false;
            }
        }
        if !last.edge.listenable() {
            let such_as = first_listenable(schema, last.from).map(|e| format!(", such as '-[:{e}]->'")).unwrap_or_default();
            let message = format!(
                "'-[:{}]->' on {} announces nothing, so a listen on it would never fire — a listen ends on an edge its module announces arrivals on{such_as}",
                last.step.edge_type_id,
                owner(instance, last.from)
            );
            self.report(codes::LISTEN_EDGE_NOT_LISTENABLE, message, path.span);
            watchable = false;
        }
        let mut aliases: Vec<&str> = Vec::new();
        for hop in &hops {
            aliases.extend(hop.step.alias.as_deref());
            let Some(filter) = hop.step.expression_filter.as_deref() else { continue };
            if let Some(name) = self.foreign_read(filter, &aliases, scope) {
                self.report(codes::LISTEN_IMPURE_WHERE, format!("a listen's WHERE reads only its hops and literals — '{name}' is neither"), path.span);
                watchable = false;
            }
        }
        if !watchable {
            return None;
        }
        let scoped = last.edge.delivery() == Some(Delivery::Scope);
        let carries = last.edge.carries();
        let mut planned = Vec::new();
        let mut unwatchable = false;
        for (i, hop) in hops.iter().enumerate() {
            let edge = hop.step.edge_type_id.as_str();
            let target = schema.positions.get(hop.to).unwrap_or(&NO_LANDING);
            let split = split_hop(hop.step.expression_filter.as_deref(), hop.step.alias.as_deref(), &hop.edge.view(edge, module), target).ok()?;
            // Under a scope the host lists every head to subscribe to it, so
            // it judges their filters as it lists them, whatever listing costs.
            let judged = if i == hops.len() - 1 {
                HopJudged::Arrival
            } else if scoped {
                HopJudged::Resolved
            } else if hop.step.expression_filter.is_none() {
                HopJudged::None
            } else if carries.iter().any(|c| c == edge) {
                HopJudged::Arrival
            } else if hops[..=i].iter().all(|h| h.edge.cheap_to_list()) {
                HopJudged::Resolved
            } else {
                self.report_unwatchable(module, hop, &hops[i + 1..], instance, path);
                unwatchable = true;
                HopJudged::None
            };
            planned.push(PlanHop {
                edge: edge.to_string(),
                from: hop.from.unwrap_or_default().to_string(),
                to: hop.to.to_string(),
                alias: hop.step.alias.clone(),
                taken: joined(split.taken),
                checked: joined(split.checked),
                judged,
            });
        }
        if unwatchable {
            return None;
        }
        Some(ListenPlan {
            movement: statement.movement.clone(),
            alias: statement.alias.clone(),
            connection: instance.name.clone(),
            adapter: module.to_string(),
            hops: planned,
            carries: carries.to_vec(),
        })
    }

    /// MOV_LISTEN_UNWATCHABLE: `hop`'s filter is neither carried by what
    /// arrives on the last edge nor cheap to re-check by listing. The way
    /// out is a wait, in a run, on one record `hop` lands on.
    fn report_unwatchable(&mut self, module: &str, hop: &Hop, below: &[Hop], instance: &Instance, path: &PathHead) {
        let Some(filter) = hop.step.expression_filter.as_deref() else { return };
        let Some(last) = below.last() else { return };
        let position = crate::types::position::display_name_of(instance, hop.to);
        let alias = hop.step.alias.clone().unwrap_or_else(|| position.chars().next().map_or("x".to_string(), |c| c.to_lowercase().to_string()));
        let rest: String = below[..below.len() - 1].iter().map(|h| format!("-[:{}]->", spell_name(&h.step.edge_type_id))).collect();
        let message = format!(
            "this listen filters '-[:{}]->' with `{}`, but {module}'s arrivals on '-[:{}]->' don't carry the {position} they are under, and listing every {position} to re-check it isn't cheap — filter on what arrives, or wait on one record in a run: `await {}{rest}-[:{}]->`",
            hop.step.edge_type_id,
            spell(filter, hop.step.alias.as_deref()),
            last.step.edge_type_id,
            spell_name(&alias),
            spell_name(&last.step.edge_type_id)
        );
        self.report(codes::LISTEN_UNWATCHABLE, message, path.span);
    }

    /// A name `filter` reads that is neither one of `aliases` nor a field of
    /// the record its hop lands on, or a construct only a run can evaluate.
    fn foreign_read(&self, filter: &Expression, aliases: &[&str], scope: ScopeId) -> Option<String> {
        let is_alias = |name: &str| aliases.contains(&name);
        match filter {
            Expression::Property { property_type_id: name, field_only: false } | Expression::EdgeProperty { property_type_id: name, field_only: false } => {
                let variable = !is_alias(name) && matches!(self.scopes.resolve(scope, name), Resolution::Found(_));
                variable.then(|| name.clone())
            }
            Expression::AliasRef { name } => (!is_alias(name)).then(|| name.clone()),
            Expression::Traverse { .. } | Expression::Exists { .. } if walk_in(filter).is_some() => walk_in(filter),
            // `b.Name`: a field of another hop's record.
            Expression::Traverse { alias_root: Some(root), .. } if is_alias(root) => None,
            Expression::Traverse { alias_root: Some(root), .. } => Some(root.clone()),
            Expression::Meta { key } => Some(format!("@{key}")),
            Expression::Llm { .. } => Some("AI".to_string()),
            Expression::Exists { .. } => Some("EXISTS".to_string()),
            Expression::Function { fn_, .. } => Some(fn_.clone()),
            _ if !is_pure_predicate(filter) && crate::families::values::sub_expressions(filter).is_empty() => Some(spell(filter, None)),
            _ => crate::families::values::sub_expressions(filter).into_iter().find_map(|e| self.foreign_read(e, aliases, scope)),
        }
    }

    /// The function a listen fires takes one parameter, and what lands on
    /// the listen's last edge must be assignable to its type.
    fn check_listen_fires(&mut self, statement: &ListenDeclaration, path: &PathHead, steps: &[EdgeStep], landed: Option<&Position>, scope: ScopeId) {
        let Some(last) = steps.last().map(|s| s.edge_type_id.as_str()) else { return };
        let Some(id) = self.resolve_reference(&statement.movement, statement.span, scope) else { return };
        let kind = self.scopes.symbol(id).kind;
        if kind == SymbolKind::FileImport {
            return;
        }
        if kind != SymbolKind::Movement {
            let message = format!("'{}' is {}, not a movement — 'fire' names a movement declared in this file", statement.movement, kind.describe());
            self.report(codes::CALL_NOT_MOVEMENT, message, statement.span);
            return;
        }
        let Some(info) = self.listens.movement_info(id) else { return };
        let written: Vec<_> = info.params.clone();
        if written.len() != 1 {
            let message = format!(
                "'{}' takes {} parameters — a function a listen fires takes exactly one, what lands on '-[:{last}]->'",
                statement.movement,
                written.len()
            );
            self.report(codes::LISTEN_PARAM_MISMATCH, message, statement.span);
            return;
        }
        let Some(type_) = &written[0].type_ else { return };
        let declared = self.movement_declared_params(id).and_then(|p| p.into_iter().next());
        let param = declared.as_ref().and_then(|p| p.plane.pos.as_deref());
        let fits = match (param, landed.map(present)) {
            (None, _) => declared.as_ref().is_none_or(|p| p.plane.field.is_none()),
            (Some(param), Some(landed)) => positions_match(landed, param) != Some(false),
            (Some(_), None) => true,
        };
        if fits {
            return;
        }
        let wrote = format!("<{}>", super::spell_param_type(type_));
        let message = format!(
            "'{}' takes '{}: {wrote}', but this listen fires with what lands on '-[:{last}]->' ('<{}>') — the parameter's type must accept it",
            statement.movement,
            written[0].name,
            spell_path_head(path)
        );
        self.report(codes::LISTEN_PARAM_MISMATCH, message, statement.span);
    }
}

/// Each hop's edge as the schema declares it, from the connection down;
/// `None` when a hop names nothing the schema declares (the walk said so).
fn declared_hops<'a>(schema: &'a InstanceSchema, steps: &'a [EdgeStep]) -> Option<Vec<Hop<'a>>> {
    let mut hops = Vec::new();
    let mut from: Option<&str> = None;
    for step in steps {
        let edge = step.edge_type_id.as_str();
        let (declared, to) = match from {
            None => schema.collections.get(edge).map(|c| (Declared::Collection(c), c.target.as_str()))?,
            Some(position) => schema.positions.get(position)?.edges.get(edge).map(|e| (Declared::Edge(e), e.target.as_str()))?,
        };
        hops.push(Hop { step, from, to, edge: declared });
        from = Some(to);
    }
    (!hops.is_empty()).then_some(hops)
}

/// Where an edge is declared, as a sentence names it: the connection for a
/// root collection, else `at's Table`.
fn owner(instance: &Instance, from: Option<&str>) -> String {
    match from {
        None => instance.name.clone(),
        Some(position) => format!("{}'s {}", instance.name, crate::types::position::display_name_of(instance, position)),
    }
}

/// The first edge declared beside one a listen cannot end on that it can.
fn first_listenable(schema: &InstanceSchema, from: Option<&str>) -> Option<String> {
    match from {
        None => schema.collections.iter().find(|(_, c)| c.listenable == Some(true)).map(|(name, _)| name.clone()),
        Some(position) => {
            let edges = &schema.positions.get(position).map(|p: &PositionSchema| &p.edges)?;
            edges.iter().find(|(_, e)| e.listenable == Some(true)).map(|(name, _)| name.clone())
        }
    }
}

/// The record a landing that may be empty holds when it is not.
fn present(position: &Position) -> &Position {
    match position {
        Position::MaybeEmpty(of) => present(of),
        other => other,
    }
}

/// The first walk `expr` takes, as written (`h-[:Messages]->`): a hop off
/// a record, whatever it starts from, and EXISTS of one. Only a run can
/// take one.
fn walk_in(expr: &Expression) -> Option<String> {
    let spelled = |root: Option<&str>, steps: &[TraversalStep]| {
        Some(match steps.first()? {
            TraversalStep::Edge(step) => format!("{}-[:{}]->", root.unwrap_or_default(), step.edge_type_id),
            _ => spell(expr, None),
        })
    };
    match expr {
        Expression::Traverse { alias_root, steps, expression } => {
            spelled(alias_root.as_deref(), steps).or_else(|| match &**expression {
                // `EXISTS(h-[:E]->)` lowers as EXISTS read off `h`.
                Expression::Exists { steps, .. } => spelled(alias_root.as_deref(), steps),
                inner => walk_in(inner),
            })
        }
        Expression::Exists { steps, .. } => spelled(None, steps),
        other => crate::families::values::sub_expressions(other).into_iter().find_map(walk_in),
    }
}

/// `step` with the conjuncts of its WHERE that walk taken out.
fn without_walks(step: TraversalStep) -> TraversalStep {
    let TraversalStep::Edge(mut edge) = step else { return step };
    if let Some(filter) = edge.expression_filter.take() {
        let kept: Vec<Expression> = crate::types::event_address::conjuncts(&filter).into_iter().filter(|c| walk_in(c).is_none()).cloned().collect();
        edge.expression_filter = joined(kept).map(Box::new);
    }
    TraversalStep::Edge(edge)
}

/// What makes two listens one: the plan, each hop's alias read as its place
/// among the hops (`m` and `n` name one hop alike), and without the lane's
/// name, which names a listen but is not what it listens to, as for the
/// settings form.
fn identity_of(plan: &ListenPlan) -> String {
    let places: HashMap<&str, String> = plan.hops.iter().enumerate().filter_map(|(i, hop)| hop.alias.as_deref().map(|a| (a, format!("#{i}")))).collect();
    let mut json = serde_json::to_value(ListenPlan { alias: None, ..plan.clone() }).expect("a plan is always JSON");
    read_aliases_as_places(&mut json, &places);
    json.to_string()
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

/// Conjuncts joined back by AND; `None` for none.
fn joined(mut conjuncts: Vec<Expression>) -> Option<Expression> {
    match conjuncts.len() {
        0 => None,
        1 => conjuncts.pop(),
        _ => Some(Expression::Logical { op: LogicalOp::And, operands: conjuncts }),
    }
}

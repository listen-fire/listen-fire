//! Listens, and the callbacks 0.13 retired: what fires a movement, and with
//! what.
//!
//! Codes: MOV_LISTEN_FILE_LEVEL, MOV_LISTEN_NOT_INSTANCE,
//! MOV_LISTEN_DUPLICATE, MOV_LISTEN_ALIAS_DUPLICATE, MOV_LISTEN_PARAM_MISMATCH,
//! MOV_LISTEN_SHAPE_MISMATCH, MOV_LISTEN_MISSING, MOV_CALLBACK_RETIRED,
//! MOV_LISTEN_SETTINGS_RETIRED (settings_become.rs) (and
//! MOV_ADAPTER_NOT_CONSTRUCTED and MOV_CALL_NOT_MOVEMENT where a listen
//! raises them).
//!
//! TypeScript: check.ts `checkListen`, `reportMissingListens`, the
//! dispatchable half of `checkMovement`.

use std::collections::{HashMap, HashSet};

use movement_parser::ast::{
    CallArg, CallbackExpression, CallbackSubject, ListenDeclaration, MovementDeclaration, MovementParam, ParamTypeRef,
    Span, TypeRef, ValueType,
};
use movement_parser::catalog::helpers::parse_field_type_name;

use indexmap::IndexMap;
use movement_parser::catalog::types::EdgeSchema;

use crate::checker::Checker;
use crate::codes;
use crate::types::Ty;
use crate::types::position::{LocalEdge, LocalNode, Position};
use crate::diagnostic::{Diagnostic, Severity};
use crate::families::names::spell_name;
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};

const EVERY_KEY: &str = "every";
const POLL_INTERVAL_KEY: &str = "pollIntervalSeconds";

mod settings_become;
mod traversal;

/// `SUPPRESS_SELF_KEY`: the listen key every listener accepts.
const SUPPRESS_SELF_KEY: &str = "suppress_self";

/// The hops of a listen that fires with what a parameter typed `written`
/// takes. A parameter may name the record type it takes (`-[:Change]->`), and
/// a listen ends on an edge: then the shortest walk from the connection to a
/// listenable edge landing on that type, if the schema has one.
fn listen_hops_for(schema: Option<&movement_parser::catalog::types::InstanceSchema>, written: &str) -> Option<String> {
    let Some(schema) = schema else { return Some(written.to_string()) };
    let single = written.strip_prefix("-[:").and_then(|rest| rest.strip_suffix("]->")).map(|name| name.trim_matches('`'));
    let Some(record_type) = single.filter(|name| !schema.collections.contains_key(*name) && schema.positions.contains_key(*name)) else {
        return Some(written.to_string());
    };
    let hop = |edge: &str| format!("-[:{}]->", spell_name(edge));
    let mut frontier: Vec<(String, &str)> = Vec::new();
    for (name, collection) in schema.collections.iter() {
        if collection.listenable == Some(true) && collection.target == record_type {
            return Some(hop(name));
        }
        if collection.readable != Some(false) {
            frontier.push((hop(name), collection.target.as_str()));
        }
    }
    let mut seen: HashSet<&str> = frontier.iter().map(|(_, at)| *at).collect();
    for _ in 0..4 {
        let mut next = Vec::new();
        for (path, at) in &frontier {
            let Some(position) = schema.positions.get(*at) else { continue };
            for (name, edge) in position.edges.iter() {
                if edge.listenable == Some(true) && edge.target == record_type {
                    return Some(format!("{path}{}", hop(name)));
                }
                if crate::families::walks::edge_is_readable(edge) && seen.insert(edge.target.as_str()) {
                    next.push((format!("{path}{}", hop(name)), edge.target.as_str()));
                }
            }
        }
        frontier = next;
    }
    None
}

/// What the walk remembers across the file for its listens.
#[derive(Default)]
pub struct ListenState {
    /// Listens seen anywhere (any listen suppresses LISTEN_MISSING).
    count: usize,
    /// Each listen's instance and config, for duplicate detection.
    identities: HashSet<String>,
    /// `movement::alias`, for per-movement alias uniqueness.
    aliases: HashSet<String>,
    /// File-level single-parameter movements a listener could fire.
    dispatchables: Vec<Dispatchable>,
    /// Each movement symbol's parameters and the scope it was declared in
    /// (`ScopeSymbol.movement`).
    movements: HashMap<SymbolId, MovementInfo>,
    /// How the host watches each of the file's clean `listen to <traversal>`,
    /// and where it is written.
    plans: Vec<(Span, movement_parser::listen_plan::ListenPlan)>,
    /// Where each of the file's `listen to <traversal>` the check refuses is
    /// written: no host watches it.
    unwatched: Vec<Span>,
}

struct Dispatchable {
    movement: String,
    instance_name: String,
    /// The parameter's hops as written (`-[:Notifications]->`), when it
    /// names the edge it lands on.
    hops: Option<String>,
    span: Span,
}

pub struct MovementInfo {
    pub params: Vec<MovementParam>,
    pub decl_scope: ScopeId,
}

/// A file's own listens, set aside while an imported library is checked.
pub struct FileListens {
    count: usize,
    identities: HashSet<String>,
    aliases: HashSet<String>,
    dispatchables: Vec<Dispatchable>,
    plans: Vec<(Span, movement_parser::listen_plan::ListenPlan)>,
    unwatched: Vec<Span>,
}

impl ListenState {
    /// Starts a library's file: its listens are its own.
    pub fn enter_file(&mut self) -> FileListens {
        FileListens {
            count: std::mem::take(&mut self.count),
            identities: std::mem::take(&mut self.identities),
            aliases: std::mem::take(&mut self.aliases),
            dispatchables: std::mem::take(&mut self.dispatchables),
            plans: std::mem::take(&mut self.plans),
            unwatched: std::mem::take(&mut self.unwatched),
        }
    }

    pub fn leave_file(&mut self, outer: FileListens) {
        self.count = outer.count;
        self.identities = outer.identities;
        self.aliases = outer.aliases;
        self.dispatchables = outer.dispatchables;
        self.plans = outer.plans;
        self.unwatched = outer.unwatched;
    }

    /// The plans of the file's listens on a traversal, in source order.
    pub fn take_plans(&mut self) -> Vec<movement_parser::listen_plan::ListenPlan> {
        std::mem::take(&mut self.plans).into_iter().map(|(_, plan)| plan).collect()
    }

    /// The plans of the file's listens on a traversal, each with where it is written.
    pub fn written_plans(&self) -> &[(Span, movement_parser::listen_plan::ListenPlan)] {
        &self.plans
    }

    /// Where the file's refused listens on a traversal are written, in source order.
    pub fn take_unwatched(&mut self) -> Vec<Span> {
        std::mem::take(&mut self.unwatched)
    }

    /// A movement's parameters and the scope it was declared in.
    pub fn movement_info(&self, id: SymbolId) -> Option<&MovementInfo> {
        self.movements.get(&id)
    }

    /// An imported symbol stands for the library's: its declaration too.
    pub fn adopt(&mut self, local: SymbolId, library: SymbolId) {
        if let Some(info) = self.movements.get(&library) {
            let info = MovementInfo { params: info.params.clone(), decl_scope: info.decl_scope };
            self.movements.insert(local, info);
        }
    }
}

impl Checker<'_> {
    /// Remembers a movement's declaration on its symbol, once declared in `scope`.
    pub fn note_movement(&mut self, scope: ScopeId, movement: &MovementDeclaration) {
        if let Some(id) = self.scopes.scope(scope).symbols.get(&movement.name).copied() {
            self.listens.movements.insert(id, MovementInfo { params: movement.params.clone(), decl_scope: scope });
        }
    }

    /// The dispatchable half of `checkMovement`'s parameter loop: a file-level
    /// movement of one parameter typed against an instance is one a listener
    /// could fire. `graph` is what the parameter type's name resolved to.
    pub fn note_dispatchable(&mut self, movement: &MovementDeclaration, type_: &TypeRef, graph: Option<SymbolId>, scope: ScopeId) {
        if self.scopes.scope(scope).parent.is_some() || movement.params.len() != 1 {
            return;
        }
        let Some(symbol) = graph.map(|id| self.scopes.symbol(id)) else { return };
        if symbol.kind != SymbolKind::Instance {
            return;
        }
        let written = type_.hops_raw.clone().filter(|h| !h.trim().is_empty());
        let schema = symbol.instance.as_ref().and_then(|i| i.schema.as_ref());
        let hops = written.and_then(|written| listen_hops_for(schema, written.trim()));
        self.listens.dispatchables.push(Dispatchable {
            movement: movement.name.clone(),
            instance_name: type_.graph.clone(),
            hops,
            span: Span { start: movement.span.start, end: movement.span.start },
        });
    }

    /// `reportMissingListens`: a file that declares a dispatchable movement
    /// but no listen is told, with a listen line to paste.
    pub fn report_missing_listens(&mut self) {
        if self.listens.count > 0 {
            return;
        }
        let dispatchables = std::mem::take(&mut self.listens.dispatchables);
        for d in &dispatchables {
            let path = format!("{}{}", d.instance_name, d.hops.as_deref().map_or("-[:…]->", str::trim));
            let mut info = Diagnostic::error(
                codes::LISTEN_MISSING,
                format!(
                    "'{}' has no listener, so nothing dispatches it — add a listen statement, e.g. listen to {path} fire {}",
                    d.movement, d.movement
                ),
                d.span,
            );
            info.severity = Some(Severity::Info);
            self.push(info);
        }
    }

    /// `checkListen`: `listen to <traversal> fire <movement>`; the 0.12
    /// settings form (`listen to <instance> { … }`) is only refused.
    pub fn check_listen(&mut self, statement: &ListenDeclaration, scope: ScopeId) {
        if let Some(id) = self.scopes.resolve_function(scope, &statement.movement) {
            self.note_fired(id);
        }
        self.listens.count += 1;
        if self.scopes.scope(scope).parent.is_some() {
            self.report(
                codes::LISTEN_FILE_LEVEL,
                "'listen' is a file-level statement — it declares the file's listeners, so move it out of this block",
                statement.span,
            );
            return;
        }
        if let Some(path) = &statement.path {
            return self.check_listen_traversal(statement, path, scope);
        }
        // The settings form is retired: its refusal, carrying the upgrade's
        // rewrite to a traversal, is all the check says of it.
        self.report_settings_retired(statement, scope);
    }

    /// A listen that states the node its untyped landing is
    /// (`hooks-[:Requests]-><Payment>`) fires its function with that node:
    /// the parameter is checked against it as a parameter is against its
    /// argument, field by field.
    /// A parameter of one of several nodes (`<Payment | Refund>`) takes the
    /// node where one of them does, as TypeScript's `Payment | Refund` takes a
    /// Payment.
    pub(super) fn check_listen_payload_param(&mut self, payload: SymbolId, param: &MovementParam, type_: &ParamTypeRef, decl_scope: ScopeId, statement: &ListenDeclaration) {
        if let ParamTypeRef::Union(union) = type_ {
            let node = |checker: &Self, member: &movement_parser::ast::TypeRef| {
                member.hops_raw.is_none()
                    && matches!(checker.scopes.resolve(decl_scope, &member.graph), Resolution::Found(id) if checker.declared_node(id).is_some())
            };
            // The run holds the payload as a value: a record member could
            // never be seeded from it.
            if let Some(record) = union.members.iter().find(|member| !node(self, member)) {
                let payload = self.declared_node(payload).map(|d| d.instance.name.clone()).unwrap_or_default();
                let message = format!(
                    "'{}' takes '{}: <{}>', but this listener fires with its declared payload '{payload}', a value, and '<{}>' is a record type — every member of the union is a declared node",
                    statement.movement,
                    param.name,
                    spell_param_type(type_),
                    spell_param_type(&ParamTypeRef::Name(record.clone()))
                );
                self.report(codes::LISTEN_PARAM_MISMATCH, message, statement.span);
                return;
            }
            let fits = union.members.iter().any(|member| {
                let before = self.diagnostics.len();
                self.check_listen_payload_param(payload, param, &ParamTypeRef::Name(member.clone()), decl_scope, statement);
                let refused = self.diagnostics.split_off(before);
                refused.is_empty()
            });
            if !fits {
                let payload = self.declared_node(payload).map(|d| d.instance.name.clone()).unwrap_or_default();
                let message = format!(
                    "'{}' takes '{}: <{}>', but this listener fires with its declared payload '{payload}', and no member of the union takes it — add it as a member: '<{} | {}>'",
                    statement.movement,
                    param.name,
                    spell_param_type(type_),
                    spell_name(&payload),
                    spell_param_type(type_)
                );
                self.report(codes::LISTEN_PARAM_MISMATCH, message, statement.span);
            }
            return;
        }
        let Some(payload) = self.declared_node(payload).map(|d| d.instance.clone()) else { return };
        let declared = match type_ {
            ParamTypeRef::Name(declared) if declared.hops_raw.is_none() => match self.scopes.resolve(decl_scope, &declared.graph) {
                Resolution::Found(id) => self.declared_node(id).map(|d| d.instance.clone()),
                _ => None,
            },
            _ => None,
        };
        let Some(declared) = declared else {
            self.report(
                codes::LISTEN_PARAM_MISMATCH,
                format!(
                    "'{}' takes '{}: <{}>', but this listener fires with its declared payload '{}' — type the parameter as it: '{}: <{}>'",
                    statement.movement,
                    param.name,
                    spell_param_type(type_),
                    payload.name,
                    param.name,
                    spell_name(&payload.name)
                ),
                statement.span,
            );
            return;
        };
        if declared.name == payload.name {
            return;
        }
        let mut visited = HashSet::new();
        self.conform_shape_node(&declared.schema, &declared.name, &payload.schema, &payload.name, statement, &mut visited, "");
    }

    /// `conformShapeNode`: every field and nested node the declaration
    /// requires, present on the instance's position and assignable.
    #[allow(clippy::too_many_arguments)]
    fn conform_shape_node(
        &mut self,
        shape: &movement_parser::catalog::types::InstanceSchema,
        node_name: &str,
        schema: &movement_parser::catalog::types::InstanceSchema,
        position_name: &str,
        statement: &ListenDeclaration,
        visited: &mut HashSet<String>,
        path: &str,
    ) {
        if !visited.insert(format!("{node_name}::{position_name}")) {
            return;
        }
        let (Some(node), Some(position)) = (shape.positions.get(node_name), schema.positions.get(position_name)) else { return };
        if surface_not_enumerated(position) {
            return;
        }
        let (instance, movement) = (&statement.instance, &statement.movement);
        for (field, declared) in node.properties.iter() {
            let Some(source) = position.properties.get(field) else {
                let message = if path.is_empty() {
                    format!("'{instance}' has no field `{field}` that the declaration '{node_name}' requires — this lane can't fire '{movement}'")
                } else {
                    format!("'{instance}' {path}has no field `{field}` that the declaration '{node_name}' requires")
                };
                self.report(codes::LISTEN_SHAPE_MISMATCH, message, statement.span);
                continue;
            };
            if !crate::types::field::field_assignable(&crate::types::field::Ty::from_schema(source), &crate::types::field::Ty::from_schema(declared)) {
                let describe = |t: &movement_parser::catalog::types::FieldType| movement_parser::catalog::helpers::describe_field_type(t).unwrap_or_default();
                let message = format!(
                    "'{instance}'{}`{field}` ({}) doesn't fit declared field `{field}` ({})",
                    if path.is_empty() { ".".to_string() } else { format!(" {path}") },
                    describe(source),
                    describe(declared)
                );
                self.report(codes::LISTEN_SHAPE_MISMATCH, message, statement.span);
            }
        }
        for (child, shape_edge) in node.edges.iter() {
            let Some(edge) = position.edges.get(child) else {
                let message = if path.is_empty() {
                    format!("'{instance}' has no relationship '{child}' that the declaration '{node_name}' requires")
                } else {
                    format!("'{instance}' {path}has no relationship '{child}' that the declaration '{node_name}' requires")
                };
                self.report(codes::LISTEN_SHAPE_MISMATCH, message, statement.span);
                continue;
            };
            let child_path = format!("{path}{child} → ");
            self.conform_shape_node(shape, &shape_edge.target, schema, &edge.target, statement, visited, &child_path);
        }
    }

    /// `callback(…)` is retired at 0.13: one MOV_CALLBACK_RETIRED naming
    /// what replaces it. Its subject is still walked, so the names it uses
    /// stay used, and its fire-time parameters are handed back, so the
    /// binding keeps the type it had and nothing read off it is refused too.
    pub fn retire_callback(&mut self, callback: &CallbackExpression, scope: ScopeId) -> Vec<(String, Option<Ty>)> {
        let many_answers = callback.config.iter().any(|entry| entry.name == "once" && entry.value.raw.trim().eq_ignore_ascii_case("false"));
        let message = format!(
            "'callback(…)' is retired in 0.13. For a form a person opens, connect `@lf/forms` and write one: `form = write forms-[:Forms]-> {{ Title: …, Fields: … }}`, send `form.Url`, and `await form-[:Submissions]->`. For buttons, write them on the message (`Buttons: [{{ Text: …, Value: … }}]`) and `await msg-[:Interactions]->`.{}",
            if many_answers { " Many answers in one run (`once: false`) become a standing listen on the message's `Interactions`, one run per answer: write the message with a `Topic` beside its `Buttons`, and `listen to chat-[:Channels]->-[m:Messages WHERE m.Topic == \"…\"]->-[:Interactions]-> fire f`." } else { "" }
        );
        self.report(codes::CALLBACK_RETIRED, message, callback.span);
        match &callback.subject {
            CallbackSubject::Inline { closure, .. } => {
                self.check_closure_walked(closure, scope, None, "a callback body", 0);
                closure.params.iter().map(|param| (param.name.clone(), scalar_param_type(param.type_.as_ref()))).collect()
            }
            CallbackSubject::Named { movement, args, span, .. } => {
                self.check_callback_arguments(movement, args, *span, scope);
                self.callback_left_open(movement, args, scope)
            }
        }
    }

    /// The parameters a movement deferred by name leaves for the platform to
    /// send: those its arguments do not supply.
    fn callback_left_open(&self, movement: &str, args: &[CallArg], scope: ScopeId) -> Vec<(String, Option<Ty>)> {
        let Resolution::Found(id) = self.scopes.resolve(scope, movement) else { return Vec::new() };
        let Some(info) = self.listens.movements.get(&id) else { return Vec::new() };
        let mut supplied = HashSet::new();
        for (index, arg) in args.iter().enumerate() {
            match call_arg_name(arg) {
                Some(name) => {
                    supplied.insert(name.to_string());
                }
                None => {
                    if let Some(param) = info.params.get(index) {
                        supplied.insert(param.name.clone());
                    }
                }
            }
        }
        info.params.iter().filter(|p| !supplied.contains(&p.name)).map(|param| (param.name.clone(), scalar_param_type(param.type_.as_ref()))).collect()
    }
}

fn call_arg_name(arg: &CallArg) -> Option<&str> {
    match arg {
        CallArg::Expr { name, .. }
        | CallArg::Write { name, .. }
        | CallArg::Node { name, .. }
        | CallArg::Call { name, .. }
        | CallArg::Closure { name, .. }
        | CallArg::Type { name, .. } => name.as_deref(),
    }
}

/// `spellParamType`: a parameter's type as written, without the brackets.
pub fn spell_param_type(type_: &ParamTypeRef) -> String {
    match type_ {
        ParamTypeRef::Value(value) => spell_value_type(value),
        ParamTypeRef::Name(reference) => spell_type_ref(reference),
        ParamTypeRef::Union(union) => union.members.iter().map(spell_type_ref).collect::<Vec<_>>().join(" | "),
    }
}

/// A named type as written, without the brackets.
fn spell_type_ref(reference: &movement_parser::ast::TypeRef) -> String {
    format!("{}{}", reference.graph, reference.hops_raw.as_deref().unwrap_or(""))
}

/// `spellValueType`.
pub fn spell_value_type(type_: &ValueType) -> String {
    match type_ {
        ValueType::Name { name, .. } => name.clone(),
        ValueType::List { of, .. } => match of.as_ref() {
            ValueType::Closure { .. } => format!("<{}>[]", spell_value_type(of)),
            _ => format!("{}[]", spell_value_type(of)),
        },
        ValueType::Record { keys, .. } => {
            let keys: Vec<String> = keys
                .iter()
                .map(|k| format!("{}{}: {}", k.name, if k.optional == Some(true) { "?" } else { "" }, spell_value_type(&k.type_)))
                .collect();
            format!("{{ {} }}", keys.join(", "))
        }
        ValueType::Closure { params, returns, .. } => {
            let params: Vec<String> = params
                .iter()
                .map(|p| format!("{}: <{}>", p.name, p.type_.as_ref().map_or("?".to_string(), spell_param_type)))
                .collect();
            format!("({}) => <{}>", params.join(", "), spell_param_type(returns))
        }
    }
}

/// `surfaceNotEnumerated`: a position whose fields nobody listed.
fn surface_not_enumerated(position: &movement_parser::catalog::types::PositionSchema) -> bool {
    position.open_properties == Some(true) || position.undescribed == Some(true) || position.pending == Some(true)
}

/// A fire-time parameter's scalar type, when it declares one.
fn scalar_param_type(type_: Option<&ParamTypeRef>) -> Option<Ty> {
    match type_? {
        ParamTypeRef::Name(reference) if reference.hops_raw.is_none() => parse_field_type_name(Some(&reference.graph)).map(|scalar| Ty::from_schema(&scalar)),
        _ => None,
    }
}

/// `callbackType`: what a callback was before 0.13 retired it, kept so a
/// retired `callback(…)` raises nothing past its own refusal: a local node
/// with `.id` / `.url` reads and a listenable `Called` edge, landing on the
/// call — `At` plus one field per fire-time parameter.
pub fn callback_type(params: Vec<(String, Option<Ty>)>) -> Position {
    let mut fields = IndexMap::new();
    fields.insert("At".to_string(), Some(Ty::Datetime));
    fields.extend(params);
    let call = Position::Local(LocalNode { label: "a callback's call".to_string(), reads: fields, edges: None, run_built: None, extracted: None });
    let schema = EdgeSchema {
        target: "Called".to_string(),
        listenable: Some(true),
        sequenced: Some(movement_parser::catalog::types::EdgeSequencing::Arrival),
        ..crate::types::position::edge_schema_to("Called")
    };
    let mut edges = IndexMap::new();
    edges.insert("Called".to_string(), LocalEdge { schema, target: Some(call), structural: false, deferred: false, references: false });
    let reads = IndexMap::from([("id".to_string(), Some(Ty::Text)), ("url".to_string(), Some(Ty::Text))]);
    Position::Local(LocalNode { label: "a callback".to_string(), reads, edges: Some(edges), run_built: None, extracted: None })
}

//! `listen to x { settings }` is retired in 0.13: a listen is a traversal
//! ending on the edge its events arrive on. Each settings listen is told so,
//! with the traversal it becomes when its module declares how its settings
//! map (`listenSettingsBecome`) and every key it writes maps from a literal.
//!
//! Code: MOV_LISTEN_SETTINGS_RETIRED. A warning carrying its rewrite, so a
//! project on this release still serves its settings listens; on a check for
//! a move up from before 0.13 it is an error, so the pin holds until it is
//! rewritten.

use movement_parser::ast::{ListenDeclaration, ParamTypeRef, Span};
use movement_parser::catalog::types::{ArgKind, InstanceSchema, KeyBecomes, KeyOp, SettingsBecome};
use movement_parser::lowering::expression::{Expression, FilterOperator, ListElement, LogicalOp, StaticValue};
use movement_parser::version::{Standing, standing};
use serde_json::json;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};
use crate::families::filter_split::spell;
use crate::families::names::spell_name;
use crate::scope::{Resolution, ScopeId, SymbolKind};
use crate::slots::expression_of_slot;

use super::{EVERY_KEY, POLL_INTERVAL_KEY, SUPPRESS_SELF_KEY};

/// The release whose checks refuse the settings form on a move up.
const RETIRED_SINCE: &str = "0.13.0";

/// The settings key an omitted value of which meant the module's default
/// events (`AdapterSpec.default_events`).
const EVENTS_KEY: &str = "events";

const SUPPRESS_SELF_NOTE: &str = " (`suppress_self` is gone: a two-way sync's own echo now runs once more and finds nothing to change)";
const EVERY_NOTE: &str = " (`every` is gone: the module sets the interval; set `pollEvery` for this connection in lf.yaml)";

/// The traversal a settings listen becomes, spelled.
struct Rewrite {
    /// `gh-[n:Notifications WHERE …]->`.
    path: String,
    /// What a parameter typed as the 0.12 event position is typed as now.
    param_type: String,
}

impl Checker<'_> {
    /// MOV_LISTEN_SETTINGS_RETIRED for a settings listen at file level.
    pub(super) fn report_settings_retired(&mut self, statement: &ListenDeclaration, scope: ScopeId) {
        let instance = match self.scopes.resolve(scope, &statement.instance) {
            Resolution::Found(id) => Some(self.scopes.symbol(id)).filter(|s| s.kind == SymbolKind::Instance && statement.construct.is_none()),
            _ => None,
        };
        let spec = instance.and_then(|s| s.adapter.as_deref()).and_then(|a| self.catalog.adapter(a));
        let built = instance.and_then(|s| s.instance.clone());
        let become_ = spec.and_then(|s| s.listen_settings_become.as_ref());

        let config = |key: &str| statement.config.iter().find(|a| a.name == key);
        let suppresses_self = config(SUPPRESS_SELF_KEY).is_some_and(|a| a.is_type != Some(true) && a.value.raw.trim() == "true");
        let every = config(EVERY_KEY).or_else(|| config(POLL_INTERVAL_KEY)).is_some();
        let mut notes = String::new();
        if suppresses_self {
            notes.push_str(SUPPRESS_SELF_NOTE);
        }
        if every {
            notes.push_str(EVERY_NOTE);
        }

        let positioned = |key: &str| {
            spec.is_some_and(|s| s.construction_args.iter().any(|a| a.kind == ArgKind::Position && a.name == key))
                && built.as_ref().is_some_and(|i| i.construction_args.contains_key(key))
        };
        let schema = built.as_ref().and_then(|i| i.schema.as_ref());
        let rewrite = become_.zip(schema).and_then(|(become_, schema)| rewrite_of(statement, become_, schema, spec.and_then(|s| s.default_events.as_deref()), &positioned));
        let instance_name = spell_name(&statement.instance);
        let movement = spell_name(&statement.movement);
        let path = match (&rewrite, become_) {
            (Some(rewrite), _) => rewrite.path.clone(),
            (None, Some(become_)) => bare_path(&instance_name, become_, &positioned),
            (None, None) => format!("{instance_name}-[:…]->"),
        };
        let message = format!(
            "`listen to {instance_name} {{ … }}` is retired in 0.13: a listen is a traversal ending on the edge its events arrive on. Write `listen to {path} fire {movement}`{notes}"
        );
        let mut diagnostic = Diagnostic::error(codes::LISTEN_SETTINGS_RETIRED, message, statement.span);
        let moving_up = self.upgrading_from.is_some_and(|pin| standing(pin, RETIRED_SINCE) == Standing::OlderKey);
        if !moving_up {
            diagnostic.severity = Some(Severity::Warning);
        }
        if let Some(rewrite) = rewrite {
            let alias = statement.alias.as_ref().map(|a| format!(" as {}", serde_json::to_string(a).unwrap_or_default())).unwrap_or_default();
            let mut edits = vec![json!({ "span": statement.span, "text": format!("listen{alias} to {path} fire {movement}") })];
            if let Some(span) = become_.and_then(|b| self.param_from_span(statement, b, scope)) {
                edits.push(json!({ "span": span, "text": rewrite.param_type }));
            }
            let safe = !suppresses_self && !every;
            diagnostic.fix = Some(if safe { json!({ "edits": edits, "safe": true }) } else { json!({ "edits": edits }) });
        }
        self.push(diagnostic);
    }

    /// Where the fired function's parameter type is written, when it names
    /// the 0.12 event position the module's settings listens fired with.
    fn param_from_span(&self, statement: &ListenDeclaration, become_: &SettingsBecome, scope: ScopeId) -> Option<Span> {
        let from = become_.param_from.as_deref()?;
        let id = self.scopes.resolve_function(scope, &statement.movement)?;
        let symbol = self.scopes.symbol(id);
        if symbol.kind != SymbolKind::Movement || symbol.imported_name.is_some() {
            return None;
        }
        let info = self.listens.movement_info(id)?;
        let [param] = info.params.as_slice() else { return None };
        let Some(ParamTypeRef::Name(declared)) = &param.type_ else { return None };
        (declared.graph == statement.instance && declared.position.as_deref() == Some(from)).then_some(declared.span)
    }
}

/// The settings listen as the traversal its module maps it to: none when a
/// key has no mapping, a value is not a literal, a hop has no alias, or the
/// path is all taken by the connection's position. A `type` key (`payload: <T>`) has none either:
/// a listen's traversal does not state its landing's type. A listen that
/// writes no `events` received the module's defaults, so they are written
/// as the events' comparison, or the rewrite would widen the listen.
fn rewrite_of(
    statement: &ListenDeclaration,
    become_: &SettingsBecome,
    schema: &InstanceSchema,
    default_events: Option<&[String]>,
    positioned: &dyn Fn(&str) -> bool,
) -> Option<Rewrite> {
    let consumed = consumed_hops(become_, positioned);
    let mut conjuncts: Vec<Vec<Expression>> = vec![Vec::new(); become_.path.len()];
    for arg in &statement.config {
        if [SUPPRESS_SELF_KEY, EVERY_KEY, POLL_INTERVAL_KEY].contains(&arg.name.as_str()) {
            continue;
        }
        let key = become_.keys.get(&arg.name)?;
        if key.hop < consumed {
            continue;
        }
        if key.hop >= become_.path.len() {
            return None;
        }
        let value = |raw: &StaticValue| mapped(key, raw);
        let compare = |op, right| compare_on(key, op, right);
        match key.op {
            KeyOp::Type => return None,
            KeyOp::Eq | KeyOp::In if key.field.is_none() || arg.is_type == Some(true) => return None,
            KeyOp::Eq => {
                let Ok(Expression::Static { value: raw }) = expression_of_slot(&arg.value) else { return None };
                conjuncts[key.hop].push(compare(FilterOperator::Eq, Expression::Static { value: value(&raw)? }));
            }
            KeyOp::In => match expression_of_slot(&arg.value).ok()? {
                Expression::List { elements } => {
                    let items = elements
                        .iter()
                        .map(|e| match e {
                            ListElement::Expression(Expression::Static { value: raw }) => {
                                value(raw).map(|v| ListElement::Expression(Expression::Static { value: v }))
                            }
                            _ => None,
                        })
                        .collect::<Option<Vec<_>>>()?;
                    conjuncts[key.hop].push(compare(FilterOperator::In, Expression::List { elements: items }));
                }
                Expression::Static { value: raw } => conjuncts[key.hop].push(compare(FilterOperator::Eq, Expression::Static { value: value(&raw)? })),
                _ => return None,
            },
        }
    }
    let defaults = default_events.filter(|d| !d.is_empty());
    if let Some(defaults) = defaults.filter(|_| !statement.config.iter().any(|a| a.name == EVENTS_KEY)) {
        let key = become_.keys.get(EVENTS_KEY)?;
        if key.hop >= consumed {
            let field_less = key.field.is_none();
            let items = defaults.iter().map(|d| mapped(key, &StaticValue::String(d.clone()))).collect::<Option<Vec<_>>>()?;
            let comparison = match (key.op, items.as_slice()) {
                _ if field_less => return None,
                (KeyOp::In, _) => {
                    let elements = items.into_iter().map(|v| ListElement::Expression(Expression::Static { value: v })).collect();
                    compare_on(key, FilterOperator::In, Expression::List { elements })
                }
                (KeyOp::Eq, [only]) => compare_on(key, FilterOperator::Eq, Expression::Static { value: only.clone() }),
                (KeyOp::Eq | KeyOp::Type, _) => return None,
            };
            conjuncts.get_mut(key.hop)?.push(comparison);
        }
    }
    let kept = &become_.path[consumed.min(become_.path.len())..];
    if kept.is_empty() {
        return None;
    }
    let mut path = spell_name(&statement.instance);
    for (offset, edge) in kept.iter().enumerate() {
        let hop = consumed + offset;
        let mut where_ = std::mem::take(&mut conjuncts[hop]);
        let alias = become_.aliases.get(hop)?;
        let hop_text = match where_.len() {
            0 => format!("-[:{}]->", spell_name(edge)),
            1 => format!("-[{}:{} WHERE {}]->", spell_name(alias), spell_name(edge), spell(&where_.remove(0), Some(alias))),
            _ => format!("-[{}:{} WHERE {}]->", spell_name(alias), spell_name(edge), spell(&Expression::Logical { op: LogicalOp::And, operands: where_ }, Some(alias))),
        };
        path.push_str(&hop_text);
    }
    // One hop off the connection is the edge's own address; a longer path
    // is typed by the record it lands on (a path is not a type's address).
    let param_type = match kept {
        [edge] => format!("<{}-[:{}]->>", spell_name(&statement.instance), spell_name(edge)),
        _ => format!("<{}-[:{}]->>", spell_name(&statement.instance), spell_name(landing_of(schema, kept)?)),
    };
    Some(Rewrite { path, param_type })
}

/// A settings value as the field holds it: through the key's `values` map
/// when it has one (a value the map lacks has no spelling).
fn mapped(key: &KeyBecomes, raw: &StaticValue) -> Option<StaticValue> {
    match (raw, &key.values) {
        (StaticValue::String(s), Some(values)) => values.get(s).map(|v| StaticValue::String(v.clone())),
        (StaticValue::Null, _) => None,
        (raw, _) => Some(raw.clone()),
    }
}

fn compare_on(key: &KeyBecomes, op: FilterOperator, right: Expression) -> Expression {
    let field = Expression::Property { property_type_id: key.field.clone().unwrap_or_default(), field_only: true };
    Expression::Compare { op, left: Box::new(field), right: Box::new(right) }
}

/// The leading hops the connection's construction already stands on: each
/// one a key of the mapping names that the connection is positioned by
/// (`connect airtable … { base: "Hiring" }`), as `eventNarrowingKeys` drops
/// them.
fn consumed_hops(become_: &SettingsBecome, positioned: &dyn Fn(&str) -> bool) -> usize {
    (0..become_.path.len()).take_while(|hop| become_.keys.iter().any(|(key, b)| b.hop == *hop && positioned(key))).count()
}

/// The record type the kept path lands on, walked from the connection's root.
fn landing_of<'s>(schema: &'s InstanceSchema, kept: &[String]) -> Option<&'s str> {
    let (first, rest) = kept.split_first()?;
    let mut at = schema.collections.get(first)?.target.as_str();
    for edge in rest {
        at = schema.positions.get(at)?.edges.get(edge)?.target.as_str();
    }
    Some(at)
}

/// The mapping's path with no WHEREs: what the author narrows by hand when
/// the settings cannot be rewritten.
fn bare_path(instance: &str, become_: &SettingsBecome, positioned: &dyn Fn(&str) -> bool) -> String {
    let consumed = consumed_hops(become_, positioned);
    let hops: String = become_.path.iter().skip(consumed).map(|edge| format!("-[:{}]->", spell_name(edge))).collect();
    if hops.is_empty() { format!("{instance}-[:…]->") } else { format!("{instance}{hops}") }
}

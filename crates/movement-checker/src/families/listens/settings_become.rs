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
use movement_parser::catalog::types::{ArgKind, Composite, FieldChange, FieldType, InstanceSchema, KeyBecomes, KeyOp, PositionRef, SettingsBecome, SettingsValue};
use movement_parser::lowering::expression::{Expression, FilterOperator, ListElement, LogicalOp, StaticValue, TraversalStep};
use movement_parser::version::{Standing, standing};
use serde_json::json;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};
use crate::families::filter_split::{EdgeView, spell, split_where};
use crate::families::names::spell_name;
use crate::families::values::owned_value_error;
use crate::types::field::{OwnedScalar, Ty, strip_absent};
use crate::scope::{Resolution, ScopeId, SymbolKind};
use crate::slots::expression_of_slot;

use super::{EVERY_KEY, POLL_INTERVAL_KEY, SUPPRESS_SELF_KEY};

/// The release whose checks refuse the settings form on a move up.
const RETIRED_SINCE: &str = "0.13.0";

/// The settings key an omitted value of which meant the module's default
/// events (`AdapterSpec.default_events`), unless its mapping says what
/// omitting it meant (`absent`).
const EVENTS_KEY: &str = "events";

const SUPPRESS_SELF_NOTE: &str = " (`suppress_self` is gone: a two-way sync's own echo now runs once more and finds nothing to change)";
const EVERY_NOTE: &str = " (`every` is gone: the module sets the interval; set `pollEvery` for this connection in lf.yaml)";

fn host_judged_note(fields: &[String]) -> String {
    format!(" (the module can't take several values of {} together, so this listen compares each exactly as the field holds it, where 0.12 handed them all to the module: check they still match)", quoted(fields))
}

/// The traversal a settings listen becomes, spelled.
struct Rewrite {
    /// `gh-[n:Notifications WHERE …]->`.
    path: String,
    /// What a parameter typed as the 0.12 event position is typed as now.
    param_type: String,
    /// The 0.12 event position the mapping it came from retypes.
    param_from: Option<String>,
    /// The fields a key's several values compare by an OR the module does
    /// not take together, so the host compares each value exactly where
    /// 0.12 handed them all to the module.
    host_judged: Vec<String>,
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
        let zones = self.zones;
        let refusal = |owned: &OwnedScalar, literal: &str| owned_value_error(literal, owned, &|zone| Some(zones.is_zone(zone)));
        let rewrite = become_.zip(schema).map(|(become_, schema)| {
            let from = Narrowing { schema, default_events: spec.and_then(|s| s.default_events.as_deref()), positioned: &positioned, refusal: &refusal };
            rewrite_of(statement, become_, &from)
        });
        let instance_name = spell_name(&statement.instance);
        let movement = spell_name(&statement.movement);
        let path = match (&rewrite, become_) {
            (Some(Ok(rewrite)), _) => rewrite.path.clone(),
            (_, Some(become_)) => bare_path(&instance_name, become_, &positioned, schema),
            (_, None) => format!("{instance_name}-[:…]->"),
        };
        let why_no_fix = match &rewrite {
            Some(Err(NoRewrite::Unbounded)) => " (its settings name no value that bounds the edge, so there is no rewrite: name the one it listens for)".to_string(),
            Some(Err(NoRewrite::Refused(reason))) => format!(" (there is no rewrite: {reason})"),
            Some(Err(NoRewrite::SeveralEdges(edges))) => format!(" (there is no rewrite: its events arrive on {}, so write one listen for each)", quoted(edges)),
            Some(Err(NoRewrite::UnmappedEvents { unnamed, events })) => {
                format!(" (there is no rewrite: {instance_name} has no event {}; its events are {})", quoted(unnamed), quoted(events))
            }
            _ => String::new(),
        };
        let rewrite = rewrite.and_then(Result::ok);
        let host_judged = rewrite.as_ref().map_or(&[][..], |r| r.host_judged.as_slice());
        if !host_judged.is_empty() {
            notes.push_str(&host_judged_note(host_judged));
        }
        let message = format!(
            "`listen to {instance_name} {{ … }}` is retired in 0.13: a listen is a traversal ending on the edge its events arrive on. Write `listen to {path} fire {movement}`{notes}{why_no_fix}"
        );
        let mut diagnostic = Diagnostic::error(codes::LISTEN_SETTINGS_RETIRED, message, statement.span);
        let moving_up = self.upgrading_from.is_some_and(|pin| standing(pin, RETIRED_SINCE) == Standing::OlderKey);
        if !moving_up {
            diagnostic.severity = Some(Severity::Warning);
        }
        if let Some(rewrite) = rewrite {
            let alias = statement.alias.as_ref().map(|a| format!(" as {}", serde_json::to_string(a).unwrap_or_default())).unwrap_or_default();
            let mut edits = vec![json!({ "span": statement.span, "text": format!("listen{alias} to {path} fire {movement}") })];
            if let Some(span) = rewrite.param_from.as_deref().and_then(|from| self.param_from_span(statement, from, scope)) {
                edits.push(json!({ "span": span, "text": rewrite.param_type }));
            }
            let safe = !suppresses_self && !every && rewrite.host_judged.is_empty();
            diagnostic.fix = Some(if safe { json!({ "edits": edits, "safe": true }) } else { json!({ "edits": edits }) });
        }
        self.push(diagnostic);
    }

    /// Where the fired function's parameter type is written, when it names
    /// the 0.12 event position the module's settings listens fired with.
    fn param_from_span(&self, statement: &ListenDeclaration, from: &str, scope: ScopeId) -> Option<Span> {
        let id = self.scopes.resolve_function(scope, &statement.movement)?;
        let symbol = self.scopes.symbol(id);
        if symbol.kind != SymbolKind::Movement || symbol.imported_name.is_some() {
            return None;
        }
        let info = self.listens.movement_info(id)?;
        let [param] = info.params.as_slice() else { return None };
        let Some(ParamTypeRef::Name(declared)) = &param.type_ else { return None };
        // Named bare (`<crm-[:Organization]->>`), or as the one edge of an
        // address its WHERE narrows (Airtable's
        // ``<hiring-[:`Record Change` WHERE `table` == "tbl…"]->>``).
        let addressed = || declared.hops_raw.as_deref().and_then(crate::types::event_address::event_address_of_hops).map(|address| address.event);
        let names = declared.position.as_deref() == Some(from) || addressed().as_deref() == Some(from);
        (declared.graph == statement.instance && names).then_some(declared.span)
    }
}

/// Names in backticks, joined by "and".
fn quoted(names: &[String]) -> String {
    names.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(" and ")
}

/// What a rewrite reads besides the listen and its module's mapping.
struct Narrowing<'a> {
    schema: &'a InstanceSchema,
    /// The module's default events (`AdapterSpec.default_events`).
    default_events: Option<&'a [String]>,
    /// Whether the connection's construction is positioned by a key.
    positioned: &'a dyn Fn(&str) -> bool,
    /// Why an owned field's type refuses a literal, as the checker says it.
    refusal: &'a dyn Fn(&OwnedScalar, &str) -> Option<String>,
}

/// Why a settings listen has no rewrite.
enum NoRewrite {
    /// A key has no mapping, a value is not a literal or has no spelling, a
    /// hop has no alias, or the path is all taken by the connection's
    /// position.
    Unmapped,
    /// A kept hop would range over an unbounded edge.
    Unbounded,
    /// A value written as its field holds it is one the field's owned type
    /// refuses: the checker's reason.
    Refused(String),
    /// Its `events` name events of more than one mapping (`byEvent`): the
    /// edges they arrive on.
    SeveralEdges(Vec<String>),
    /// Its `events` name events the mapping (`byEvent`) does not, beside ones
    /// it does: those, and the events it names.
    UnmappedEvents { unnamed: Vec<String>, events: Vec<String> },
}

/// The mapping a listen takes: the one its `events` choose (`byEvent`),
/// with `events` spent choosing it unless that mapping compares them too
/// (Stripe's `invoice.paid` chooses an invoice's `Changes` and is its
/// `Kind`), else the module's own. A listen that leaves `events` out chooses
/// by the module's default events, else by what the module's own `events`
/// key says leaving them out heard (Stripe's: every event, on every edge).
fn chosen<'b>(statement: &ListenDeclaration, become_: &'b SettingsBecome, default_events: Option<&[String]>) -> Result<(&'b SettingsBecome, bool), NoRewrite> {
    let Some(by_event) = become_.by_event.as_ref().filter(|b| !b.is_empty()) else { return Ok((become_, false)) };
    let named = heard_events(statement, become_, default_events)?.unwrap_or_default();
    let ways: Vec<Option<&SettingsBecome>> = named.iter().map(|event| by_event.get(event)).collect();
    if ways.iter().all(Option::is_none) {
        return Ok((become_, false));
    }
    // An event the mapping does not name lands where a listen leaving
    // `events` out does, so it is one more edge only where that is another.
    let mut edges: Vec<String> = Vec::new();
    for way in &ways {
        let edge = edge_named(&way.unwrap_or(become_).path);
        if !edges.contains(&edge) {
            edges.push(edge);
        }
    }
    if edges.len() > 1 {
        return Err(NoRewrite::SeveralEdges(edges));
    }
    let unnamed: Vec<String> = named.iter().zip(&ways).filter(|(_, w)| w.is_none()).map(|(event, _)| event.clone()).collect();
    if !unnamed.is_empty() {
        return Err(NoRewrite::UnmappedEvents { unnamed, events: by_event.keys().cloned().collect() });
    }
    match ways.as_slice() {
        [Some(first), rest @ ..] if rest.iter().all(|w| w.is_some_and(|w| w == *first)) => Ok((*first, !first.keys.contains_key(EVENTS_KEY))),
        _ => Err(NoRewrite::Unmapped),
    }
}

/// The events a settings listen hears: those its `events` names, else the
/// module's default events, else what its mapping says leaving `events` out
/// heard. None: every event (nothing says otherwise).
fn heard_events(statement: &ListenDeclaration, become_: &SettingsBecome, default_events: Option<&[String]>) -> Result<Option<Vec<String>>, NoRewrite> {
    Ok(match statement.config.iter().find(|a| a.name == EVENTS_KEY) {
        Some(arg) => Some(match expression_of_slot(&arg.value).map_err(|_| NoRewrite::Unmapped)? {
            Expression::Static { value: StaticValue::String(event) } => vec![event],
            Expression::List { elements } => elements
                .iter()
                .map(|e| match e {
                    ListElement::Expression(Expression::Static { value: StaticValue::String(event) }) => Ok(event.clone()),
                    _ => Err(NoRewrite::Unmapped),
                })
                .collect::<Result<_, _>>()?,
            _ => return Err(NoRewrite::Unmapped),
        }),
        None => match default_events.filter(|d| !d.is_empty()) {
            Some(defaults) => Some(defaults.to_vec()),
            None => become_.keys.get(EVENTS_KEY).and_then(|k| k.absent.as_ref()).map(|heard| heard.texts().to_vec()),
        },
    })
}

/// The edge a mapping's path ends on, as a message names it: by its name
/// alone when the path is one hop (`Messages`), else by the whole path, since
/// two paths may end on edges of one name (an invoice's `Changes` and a
/// charge's: `-[:Invoices]->-[:Changes]->`).
fn edge_named(path: &[String]) -> String {
    match path {
        [edge] => edge.clone(),
        _ => path.iter().map(|edge| format!("-[:{}]->", spell_name(edge))).collect(),
    }
}

/// The settings listen as the traversal its module maps it to. A `type` key
/// (`payload: <T>`) becomes the type stated after the traversal
/// (`-[:Requests]-><T>`). A key the listen leaves out is compared with what
/// leaving it out meant (`absent`; for `events`, else the module's default
/// events), or the rewrite would widen the listen.
fn rewrite_of(statement: &ListenDeclaration, become_: &SettingsBecome, from: &Narrowing) -> Result<Rewrite, NoRewrite> {
    let (become_, events_spent) = chosen(statement, become_, from.default_events)?;
    let schema = from.schema;
    let consumed = consumed_hops(become_, from.positioned);
    let mut conjuncts: Vec<Vec<Expression>> = vec![Vec::new(); become_.path.len()];
    let mut landing = None;
    for arg in &statement.config {
        if [SUPPRESS_SELF_KEY, EVERY_KEY, POLL_INTERVAL_KEY].contains(&arg.name.as_str()) || (events_spent && arg.name == EVENTS_KEY) {
            continue;
        }
        if become_.field_change.as_ref().is_some_and(|change| [&change.field, &change.becomes].contains(&&arg.name)) {
            continue;
        }
        let key = become_.keys.get(&arg.name).ok_or(NoRewrite::Unmapped)?;
        if key.hop < consumed {
            continue;
        }
        if key.hop >= become_.path.len() {
            return Err(NoRewrite::Unmapped);
        }
        match key.op {
            // The landing's type is stated after the traversal, which ends on the hop it types.
            KeyOp::Type if arg.is_type == Some(true) && key.hop + 1 == become_.path.len() => {
                let raw = arg.value.raw.trim();
                landing = Some(format!("<{}>", raw.strip_prefix('<').and_then(|r| r.strip_suffix('>')).unwrap_or(raw)));
            }
            KeyOp::Type => return Err(NoRewrite::Unmapped),
            _ if key.field.is_none() || arg.is_type == Some(true) => return Err(NoRewrite::Unmapped),
            _ => {
                let written = written_values(key, &expression_of_slot(&arg.value).map_err(|_| NoRewrite::Unmapped)?)?;
                for (field, op) in compared(key) {
                    conjuncts[key.hop].push(comparison(key, field, op, &written).ok_or(NoRewrite::Unmapped)?);
                }
            }
        }
    }
    let written = |name: &str| (events_spent && name == EVENTS_KEY) || statement.config.iter().any(|a| a.name == name);
    let defaults = from.default_events.filter(|d| !d.is_empty() && !events_spent).map(|d| SettingsValue::Many(d.to_vec()));
    if defaults.is_some() && !written(EVENTS_KEY) && !become_.keys.contains_key(EVENTS_KEY) {
        return Err(NoRewrite::Unmapped);
    }
    for (name, key) in become_.keys.iter().filter(|(name, _)| !written(name)) {
        let meant = key.absent.clone().or_else(|| defaults.clone().filter(|_| name == EVENTS_KEY));
        let Some(meant) = meant else { continue };
        if key.hop < consumed {
            continue;
        }
        let comparison = absent_comparison(key, &meant).ok_or(NoRewrite::Unmapped)?;
        conjuncts.get_mut(key.hop).ok_or(NoRewrite::Unmapped)?.push(comparison);
    }
    let changed_field = match &become_.field_change {
        Some(change) => field_change(statement, change, become_.aliases.get(change.hop).ok_or(NoRewrite::Unmapped)?)?,
        None => None,
    };
    if let (Some(change), Some((_, comparisons))) = (&become_.field_change, &changed_field) {
        conjuncts.get_mut(change.hop).ok_or(NoRewrite::Unmapped)?.extend(comparisons.iter().cloned());
    }
    let kept = &become_.path[consumed.min(become_.path.len())..];
    if kept.is_empty() {
        return Err(NoRewrite::Unmapped);
    }
    if !unbounded_hops(schema, &become_.path, consumed, &conjuncts).is_empty() {
        return Err(NoRewrite::Unbounded);
    }
    if let Some(reason) = refused_literal(schema, &become_.path, &conjuncts, from.refusal) {
        return Err(NoRewrite::Refused(reason));
    }
    let host_judged = untaken_ors(schema, &become_.path, &conjuncts);
    let mut path = spell_name(&statement.instance);
    for (offset, edge) in kept.iter().enumerate() {
        let hop = consumed + offset;
        let mut where_ = std::mem::take(&mut conjuncts[hop]);
        let alias = become_.aliases.get(hop).ok_or(NoRewrite::Unmapped)?;
        let hop_text = match where_.len() {
            0 => format!("-[:{}]->", spell_name(edge)),
            1 => format!("-[{}:{} WHERE {}]->", spell_name(alias), spell_name(edge), spell(&where_.remove(0), Some(alias))),
            _ => format!("-[{}:{} WHERE {}]->", spell_name(alias), spell_name(edge), spell(&Expression::Logical { op: LogicalOp::And, operands: where_ }, Some(alias))),
        };
        path.push_str(&hop_text);
    }
    path.push_str(landing.as_deref().unwrap_or_default());
    // Where the host narrowed the path's hops by their WHEREs, the landing
    // is the narrowed type (one table's changes), whose rows hold the
    // compared field or the rewrite would not check.
    let narrowed = narrowed_landing(schema, &path);
    if let (Some(change), Some((field, _)), Some(landing)) = (&become_.field_change, &changed_field, narrowed.as_deref()) {
        if let Some(reason) = unheld_field(schema, landing, &change.current, field) {
            return Err(NoRewrite::Refused(reason));
        }
    }
    // One hop off the connection is the edge's own address; a longer path
    // is typed by the record it lands on (a path is not a type's address).
    let param_type = match (kept, narrowed) {
        ([edge], _) => format!("<{}-[:{}]->>", spell_name(&statement.instance), spell_name(edge)),
        (_, Some(landing)) => format!("<{}-[:{}]->>", spell_name(&statement.instance), spell_name(&landing)),
        _ => format!("<{}-[:{}]->>", spell_name(&statement.instance), spell_name(landing_of(schema, kept).ok_or(NoRewrite::Unmapped)?)),
    };
    Ok(Rewrite { path, param_type, param_from: become_.param_from.clone(), host_judged })
}

/// What a listen's `field` and `becomes` compare (`fieldChange`), on the
/// hop's alias: the field alone changed, or came to hold the value. A value
/// with no field compares nothing, as 0.12's did not. The field as written.
fn field_change(statement: &ListenDeclaration, change: &FieldChange, alias: &str) -> Result<Option<(String, Vec<Expression>)>, NoRewrite> {
    let literal = |key: &str| -> Result<Option<StaticValue>, NoRewrite> {
        let Some(arg) = statement.config.iter().find(|a| a.name == key) else { return Ok(None) };
        match expression_of_slot(&arg.value).map_err(|_| NoRewrite::Unmapped)? {
            Expression::Static { value: StaticValue::Null } => Err(NoRewrite::Unmapped),
            Expression::Static { value } if arg.is_type != Some(true) => Ok(Some(value)),
            _ => Err(NoRewrite::Unmapped),
        }
    };
    let Some(field) = literal(&change.field)? else { return Ok(None) };
    let StaticValue::String(field) = field else { return Err(NoRewrite::Unmapped) };
    let read = |row: &str| Expression::Traverse {
        alias_root: Some(alias.to_string()),
        steps: Vec::new(),
        expression: Box::new(Expression::Traverse {
            alias_root: Some(row.to_string()),
            steps: Vec::new(),
            expression: Box::new(Expression::Property { property_type_id: field.clone(), field_only: true }),
        }),
    };
    let compare = |op, left, right| Expression::Compare { op, left: Box::new(left), right: Box::new(right) };
    let comparisons = match literal(&change.becomes)? {
        None => vec![compare(FilterOperator::Neq, read(&change.current), read(&change.previous))],
        Some(value) => vec![
            compare(FilterOperator::Eq, read(&change.current), Expression::Static { value: value.clone() }),
            compare(FilterOperator::Neq, read(&change.previous), Expression::Static { value }),
        ],
    };
    Ok(Some((field, comparisons)))
}

/// The record type a rewritten traversal lands on where the host narrowed
/// its hops by their WHEREs (`refinements`): read off the traversal as it is
/// spelled, so each hop's WHERE is keyed as a check of the rewrite keys it.
/// None where no hop of it was narrowed.
fn narrowed_landing(schema: &InstanceSchema, path: &str) -> Option<String> {
    let refinements = schema.refinements.as_ref()?;
    let Expression::Traverse { steps, .. } = crate::slots::expression_of_text(&format!("{path}.`__probe__`")).ok()? else { return None };
    let mut at: Option<String> = None;
    let mut narrowed = false;
    for step in &steps {
        let TraversalStep::Edge(edge) = step else { return None };
        let target = match &at {
            None => schema.collections.get(&edge.edge_type_id)?.target.clone(),
            Some(position) => schema.positions.get(position)?.edges.get(&edge.edge_type_id)?.target.clone(),
        };
        let refined = edge.expression_filter.as_deref().and_then(|filter| {
            let key = movement_parser::catalog::helpers::refinement_key(&target, &serde_json::to_value(filter).ok()?);
            refinements.get(&key).cloned()
        });
        narrowed |= refined.is_some();
        at = Some(refined.unwrap_or(target));
    }
    at.filter(|_| narrowed)
}

/// Why a narrowed landing's row cannot hold `field`: the row its `current`
/// field holds has no such field, by the names it has.
fn unheld_field(schema: &InstanceSchema, landing: &str, current: &str, field: &str) -> Option<String> {
    let held = schema.positions.get(landing)?.properties.get(current)?;
    let row = held_position(held)?;
    let fields = &schema.positions.get(row)?.properties;
    if fields.contains_key(field) {
        return None;
    }
    let names: Vec<String> = fields.keys().map(|name| format!("`{name}`")).collect();
    Some(format!("{row} has no field `{field}` (its fields: {})", names.join(", ")))
}

/// The position a `record` field holds, through a maybe-absent one.
fn held_position(field: &FieldType) -> Option<&str> {
    match field {
        FieldType::Composite(Composite::MaybeAbsent { of }) => held_position(of),
        FieldType::Composite(Composite::Record { position: Some(PositionRef::Position { position }) }) => Some(position),
        _ => None,
    }
}

/// A key's value as written: one literal, or a list of them, each spelled
/// as its field holds it.
enum Written {
    One(StaticValue),
    Many(Vec<StaticValue>),
}

fn written_values(key: &KeyBecomes, value: &Expression) -> Result<Written, NoRewrite> {
    let spelled = |raw: &StaticValue| mapped(key, raw).ok_or(NoRewrite::Unmapped);
    match value {
        Expression::Static { value: raw } => Ok(Written::One(spelled(raw)?)),
        Expression::List { elements } => elements
            .iter()
            .map(|e| match e {
                ListElement::Expression(Expression::Static { value: raw }) => spelled(raw),
                _ => Err(NoRewrite::Unmapped),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Written::Many),
        _ => Err(NoRewrite::Unmapped),
    }
}

/// The field the key compares, and how.
fn compared(key: &KeyBecomes) -> Vec<(&str, KeyOp)> {
    key.field.as_deref().map(|field| (field, key.op)).into_iter().collect()
}

/// `field` compared with the written value by `op`: `==` and `!=` take
/// one value, `IN` a list (one value by `==`), `CONTAINS` either (several
/// an OR). None for a value the op does not compare.
fn comparison(key: &KeyBecomes, field: &str, op: KeyOp, written: &Written) -> Option<Expression> {
    let on = KeyBecomes { field: Some(field.to_string()), ..key.clone() };
    let one = |value: &StaticValue| Expression::Static { value: value.clone() };
    match (op, written) {
        (KeyOp::Eq | KeyOp::In, Written::One(value)) => Some(compare_on(&on, FilterOperator::Eq, one(value))),
        (KeyOp::Neq, Written::One(value)) => Some(compare_on(&on, FilterOperator::Neq, one(value))),
        (KeyOp::In, Written::Many(values)) => {
            let elements = values.iter().map(|v| ListElement::Expression(one(v))).collect();
            Some(compare_on(&on, FilterOperator::In, Expression::List { elements }))
        }
        (KeyOp::Contains, Written::One(value)) => any_contains(&on, vec![value.clone()]),
        (KeyOp::Contains, Written::Many(values)) => any_contains(&on, values.clone()),
        (KeyOp::Eq | KeyOp::Neq | KeyOp::Type, _) => None,
    }
}

/// The comparison what omitting `key` meant is: one value by `==`, a list
/// by `IN` (or by `==` on an `eq` key, when it holds one).
fn absent_comparison(key: &KeyBecomes, meant: &SettingsValue) -> Option<Expression> {
    let on = KeyBecomes { field: key.absent_field.clone().or_else(|| key.field.clone()), ..key.clone() };
    let key = &on;
    key.field.as_ref()?;
    let items = meant.texts().iter().map(|t| mapped(key, &StaticValue::String(t.clone()))).collect::<Option<Vec<_>>>()?;
    match (key.op, meant, items.as_slice()) {
        (KeyOp::Eq | KeyOp::In, SettingsValue::One(_), [only]) | (KeyOp::Eq, SettingsValue::Many(_), [only]) => {
            Some(compare_on(key, FilterOperator::Eq, Expression::Static { value: only.clone() }))
        }
        (KeyOp::Neq, _, [only]) => Some(compare_on(key, FilterOperator::Neq, Expression::Static { value: only.clone() })),
        (KeyOp::In, SettingsValue::Many(_), _) => {
            let elements = items.into_iter().map(|v| ListElement::Expression(Expression::Static { value: v })).collect();
            Some(compare_on(key, FilterOperator::In, Expression::List { elements }))
        }
        (KeyOp::Contains, _, _) => any_contains(key, items),
        _ => None,
    }
}

/// The record type each hop of `path` lands on, walked from the
/// connection's root; `None` from the first hop the schema lacks.
fn hop_targets<'s>(schema: &'s InstanceSchema, path: &[String]) -> Vec<Option<&'s str>> {
    let mut from: Option<&str> = None;
    path.iter()
        .map(|edge| {
            let target = match from {
                None => schema.collections.get(edge).map(|c| c.target.as_str()),
                Some(position) => schema.positions.get(position).and_then(|p| p.edges.get(edge)).map(|e| e.target.as_str()),
            };
            from = target;
            target
        })
        .collect()
}

/// The checker's refusal of the first text literal a rewritten comparison
/// gives a field whose owned type would refuse it (`"Deals"` for an
/// `InboxKey`): a rewrite never writes what then fails to check.
fn refused_literal(schema: &InstanceSchema, path: &[String], conjuncts: &[Vec<Expression>], refusal: &dyn Fn(&OwnedScalar, &str) -> Option<String>) -> Option<String> {
    let targets = hop_targets(schema, path);
    conjuncts.iter().zip(targets).find_map(|(hop, target)| {
        let position = schema.positions.get(target?)?;
        hop.iter().find_map(|comparison| {
            let Expression::Compare { left, right, .. } = comparison else { return None };
            let Expression::Property { property_type_id: field, .. } = &**left else { return None };
            let ty = Ty::from_schema(position.properties.get(field)?);
            let Ty::Owned(owned) = strip_absent(&ty) else { return None };
            let literals: Vec<&String> = match &**right {
                Expression::Static { value: StaticValue::String(literal) } => vec![literal],
                Expression::List { elements } => elements
                    .iter()
                    .filter_map(|e| match e {
                        ListElement::Expression(Expression::Static { value: StaticValue::String(literal) }) => Some(literal),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            literals.into_iter().find_map(|literal| refusal(owned, literal))
        })
    })
}

/// The fields whose rewritten OR (a key's several values) the hop's module
/// does not take, by the checker's own split.
fn untaken_ors(schema: &InstanceSchema, path: &[String], conjuncts: &[Vec<Expression>]) -> Vec<String> {
    let mut from: Option<&str> = None;
    let mut fields: Vec<String> = Vec::new();
    for (hop, edge) in path.iter().enumerate() {
        let view = match from {
            None => schema.collections.get(edge).map(|c| (EdgeView::of_collection(edge, "", c), c.target.as_str())),
            Some(position) => schema.positions.get(position).and_then(|p| p.edges.get(edge)).map(|e| (EdgeView::of_edge(edge, "", e), e.target.as_str())),
        };
        let Some((view, target)) = view else { break };
        let Some(position) = schema.positions.get(target) else { break };
        for or in conjuncts[hop].iter().filter(|c| matches!(c, Expression::Logical { op: LogicalOp::Or, .. })) {
            let taken = split_where(or, None, &view, position).is_ok_and(|split| split.checked.is_empty());
            let field = match or {
                Expression::Logical { operands, .. } => operands.first().and_then(|o| match o {
                    Expression::Compare { left, .. } => match &**left {
                        Expression::Property { property_type_id, .. } => Some(property_type_id.clone()),
                        _ => None,
                    },
                    _ => None,
                }),
                _ => None,
            };
            if let Some(field) = field.filter(|f| !taken && !fields.contains(f)) {
                fields.push(field);
            }
        }
        from = Some(target);
    }
    fields
}

/// The kept hops that would range over an edge their module declares
/// unbounded (`bounded: false`) with nothing written on a field that bounds
/// it, each with the field that would: the settings left out what the 0.13
/// listen must say (a cron listen with no schedule), so there is no rewrite
/// to offer.
fn unbounded_hops(schema: &InstanceSchema, path: &[String], consumed: usize, conjuncts: &[Vec<Expression>]) -> Vec<(usize, String)> {
    let mut from: Option<&str> = None;
    let mut unbounded = Vec::new();
    for (hop, edge) in path.iter().enumerate() {
        let declared = match from {
            None => schema.collections.get(edge).map(|c| (c.bounded, c.bounded_by.as_deref(), c.target.as_str())),
            Some(position) => schema.positions.get(position).and_then(|p| p.edges.get(edge)).map(|e| (e.bounded, e.bounded_by.as_deref(), e.target.as_str())),
        };
        let Some((bounded, bounded_by, target)) = declared else { return unbounded };
        let reads_bound = |c: &Expression| matches!(c, Expression::Compare { left, .. } if matches!(&**left, Expression::Property { property_type_id, .. } if bounded_by.unwrap_or_default().contains(property_type_id)));
        if hop >= consumed && bounded == Some(false) && !conjuncts[hop].iter().any(reads_bound) {
            unbounded.push((hop, bounded_by.and_then(<[String]>::first).cloned().unwrap_or_default()));
        }
        from = Some(target);
    }
    unbounded
}

/// A settings value as the field holds it: through the key's `values` map
/// when it has one (a value the map lacks has no spelling).
fn mapped(key: &KeyBecomes, raw: &StaticValue) -> Option<StaticValue> {
    let spelled = match (raw, &key.values) {
        (StaticValue::String(s), Some(values)) => values.get(s).map(|v| StaticValue::String(v.clone())),
        (StaticValue::Null, _) => None,
        (raw, _) => Some(raw.clone()),
    }?;
    Some(match spelled {
        StaticValue::String(s) if key.lowercase == Some(true) => StaticValue::String(s.to_lowercase()),
        other => other,
    })
}

/// `field CONTAINS value` for one value; for several, the OR of them (a
/// list field holding any of them). None for no value.
fn any_contains(key: &KeyBecomes, values: Vec<StaticValue>) -> Option<Expression> {
    let mut each: Vec<Expression> = values.into_iter().map(|value| compare_on(key, FilterOperator::Contains, Expression::Static { value })).collect();
    match each.len() {
        0 => None,
        1 => each.pop(),
        _ => Some(Expression::Logical { op: LogicalOp::Or, operands: each }),
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

/// The mapping's path with no WHEREs but the bound an unbounded hop must
/// name (`inbox-[e:Emails WHERE e.Key == "…"]->`): what the author narrows
/// by hand when the settings cannot be rewritten.
fn bare_path(instance: &str, become_: &SettingsBecome, positioned: &dyn Fn(&str) -> bool, schema: Option<&InstanceSchema>) -> String {
    let consumed = consumed_hops(become_, positioned);
    let unbounded = schema.map(|schema| unbounded_hops(schema, &become_.path, consumed, &vec![Vec::new(); become_.path.len()])).unwrap_or_default();
    let hops: String = become_
        .path
        .iter()
        .enumerate()
        .skip(consumed)
        .map(|(hop, edge)| match (unbounded.iter().find(|(h, _)| *h == hop), become_.aliases.get(hop)) {
            (Some((_, field)), Some(alias)) if !field.is_empty() => {
                format!("-[{}:{} WHERE {}.{} == \"…\"]->", spell_name(alias), spell_name(edge), spell_name(alias), spell_name(field))
            }
            _ => format!("-[:{}]->", spell_name(edge)),
        })
        .collect();
    if hops.is_empty() { format!("{instance}-[:…]->") } else { format!("{instance}{hops}") }
}

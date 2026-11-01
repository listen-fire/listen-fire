//! Event addresses (checker/event_address.ts): a parameter type's one hop
//! and the pins its WHERE states (`<at-[:`Record Change` WHERE `action` ==
//! "record.created"]->>`) name a position the host grafted under the
//! address's key. The key is opaque: built and compared, never parsed.

use movement_parser::lowering::expression::{Expression, LogicalOp, StaticValue, TraversalStep};

use crate::families::walks::is_pure_predicate;

use super::position::{InstanceRef, Position, position_ref_in};

#[derive(Debug, Clone, PartialEq)]
pub struct EventAddress {
    pub event: String,
    /// In the order the pins were written.
    pub narrowing: Vec<(String, String)>,
}

/// `eventAddressOfHops`: one hop, and the pins its WHERE states.
pub fn event_address_of_hops(hops_raw: &str) -> Option<EventAddress> {
    let probe = format!("__movement_path_root__{}.`__movement_path_probe__`", hops_raw.trim());
    let Expression::Traverse { steps, .. } = crate::slots::expression_of_text(&probe).ok()? else { return None };
    let [TraversalStep::Edge(step)] = steps.as_slice() else { return None };
    let narrowing = address_narrowing(step.expression_filter.as_deref())?;
    Some(EventAddress { event: step.edge_type_id.clone(), narrowing })
}

/// `addressNarrowing`: a conjunction of `` `key` == "literal" ``.
fn address_narrowing(filter: Option<&Expression>) -> Option<Vec<(String, String)>> {
    let Some(filter) = filter else { return Some(Vec::new()) };
    if !is_pure_predicate(filter) {
        return None;
    }
    let mut pins = Vec::new();
    collect_pins(filter, &mut pins).then_some(pins)
}

fn collect_pins(expr: &Expression, into: &mut Vec<(String, String)>) -> bool {
    conjuncts(expr).into_iter().all(|conjunct| {
        let Some((key, value)) = pin_of(conjunct) else { return false };
        match into.iter().find(|(k, _)| *k == key) {
            Some((_, existing)) => *existing == value,
            None => {
                into.push((key, value));
                true
            }
        }
    })
}

/// The `` `key` == "literal" `` conjuncts of a WHERE, in the order written,
/// beside whatever else it tests: each holds of every record the WHERE admits.
pub fn conjunct_pins(filter: &Expression) -> Vec<(String, String)> {
    conjuncts(filter).into_iter().filter_map(pin_of).collect()
}

/// A WHERE's top-level `AND`s, flattened.
pub fn conjuncts(expr: &Expression) -> Vec<&Expression> {
    match expr {
        Expression::Logical { op: LogicalOp::And, operands } => operands.iter().flat_map(conjuncts).collect(),
        other => vec![other],
    }
}

/// `` `key` == "literal" ``, either way round.
fn pin_of(expr: &Expression) -> Option<(String, String)> {
    let Expression::Compare { op: movement_parser::lowering::expression::FilterOperator::Eq, left, right } = expr else { return None };
    match (side(left), side(right)) {
        (Some(Side::Read(key)), Some(Side::Literal(value))) | (Some(Side::Literal(value)), Some(Side::Read(key))) => Some((key, value)),
        _ => None,
    }
}

enum Side {
    Read(String),
    Literal(String),
}

fn side(expr: &Expression) -> Option<Side> {
    match expr {
        Expression::Static { value: StaticValue::String(text) } => Some(Side::Literal(text.clone())),
        Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => Some(Side::Read(property_type_id.clone())),
        _ => None,
    }
}

/// `eventAddressKey`: the bare event, or `[event, pins]` with the pins sorted.
pub fn event_address_key(address: &EventAddress) -> String {
    if address.narrowing.is_empty() {
        return address.event.clone();
    }
    let mut pins = address.narrowing.clone();
    pins.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    serde_json::to_string(&(&address.event, pins)).unwrap_or_else(|_| unreachable!("strings always serialise"))
}

/// `positionFromAddress`: the position an address names, narrowed to its
/// event when it pins anything. A hop onto records that are no event lands
/// on their position whatever its WHERE says: a WHERE picks records, it does
/// not change what they are. An address that names nothing is `None`, and
/// where it is written that is an error (`address_absence`).
pub fn position_from_address(instance: &InstanceRef, hops_raw: &str) -> Option<Position> {
    if let Some(edge) = single_hop_edge(hops_raw)
        && !is_event_position(instance, &edge)
    {
        return position_ref_in(instance, &edge).or_else(|| position_ref_in(instance, &instance.schema.collections.get(&edge)?.target));
    }
    let address = event_address_of_hops(hops_raw)?;
    let resolved = position_ref_in(instance, &event_address_key(&address))?;
    let narrowed = !address.narrowing.is_empty();
    Some(match resolved {
        Position::Position(mut p) => {
            if narrowed {
                p.narrows = Some(address.event);
            }
            Position::Position(p)
        }
        Position::Union(mut u) => {
            if narrowed {
                u.narrows = Some(address.event.clone());
            }
            u.address = Some(address);
            Position::Union(u)
        }
        other => other,
    })
}

/// The edge a one-hop address walks, whatever its WHERE.
fn single_hop_edge(hops_raw: &str) -> Option<String> {
    let probe = format!("__movement_path_root__{}.`__movement_path_probe__`", hops_raw.trim());
    let Expression::Traverse { steps, .. } = crate::slots::expression_of_text(&probe).ok()? else { return None };
    let [TraversalStep::Edge(step)] = steps.as_slice() else { return None };
    Some(step.edge_type_id.clone())
}

fn is_event_position(instance: &InstanceRef, name: &str) -> bool {
    let schema = &instance.schema;
    schema.event_position.as_deref() == Some(name) || schema.event_positions.iter().flatten().any(|e| e.position == name)
}

/// Why an address names no position, in the author's words: what was looked
/// for and, where the catalog says, what there is instead.
pub fn address_absence(instance: &InstanceRef, hops_raw: &str) -> String {
    let graph = &instance.name;
    let written = format!("<{graph}{}>", hops_raw.trim());
    let schema = &instance.schema;
    if single_hop_edge(hops_raw).is_none() {
        return format!("'{written}' names no position: a type's address is one hop off the system");
    }
    let Some(address) = event_address_of_hops(hops_raw) else {
        return format!("'{written}' names no position: an event's address pins its fields to text literals with `==`, joined by AND");
    };
    let event = &address.event;
    if !schema.positions.contains_key(event) && !schema.unions.as_ref().is_some_and(|u| u.contains_key(event)) {
        let mut available: Vec<&str> = schema.unions.iter().flat_map(|u| u.keys()).map(String::as_str).collect();
        for name in schema.positions.keys() {
            if !available.contains(&name.as_str()) {
                available.push(name);
            }
        }
        let has = if available.is_empty() { String::new() } else { format!(" — it has: {}", available.join(", ")) };
        return format!("'{graph}' has no position type '{event}'{has}");
    }
    let keys: &[String] = schema.event_narrowing_keys.as_deref().unwrap_or_default();
    let narrowed_by = |keys: &[String]| {
        let mut all = vec!["action".to_string()];
        all.extend(keys.iter().cloned());
        all.join(", ")
    };
    if let Some((key, _)) = address.narrowing.iter().find(|(key, _)| key != "action" && !keys.contains(key)) {
        return format!("'{written}' names no position: '{graph}' narrows '{event}' by {}, never by '{key}'", narrowed_by(keys));
    }
    let pinned = |key: &str| address.narrowing.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    let mut prefix: Vec<(String, String)> = Vec::new();
    for key in keys {
        let Some(value) = pinned(key) else {
            if address.narrowing.iter().any(|(k, _)| k != "action") {
                return format!("'{written}' names no position: '{graph}' narrows '{event}' by {} in that order, so pin '{key}' too", keys.join(", then "));
            }
            break;
        };
        let options = schema.event_narrowing_values.as_ref().and_then(|v| v.get(&narrowing_prefix_key(&prefix))).and_then(|v| v.get(key));
        if options.is_none_or(|options| !options.contains(&value)) {
            let at = connected_at(instance, &prefix);
            let has = options.filter(|o| !o.is_empty()).map_or(String::new(), |o| format!("; it has: {}", o.iter().map(|o| format!("\"{o}\"")).collect::<Vec<_>>().join(", ")));
            return format!("'{written}' names no position: {at} has no {key} \"{value}\"{has}");
        }
        prefix.push((key.clone(), value));
    }
    format!("'{written}' names no position: '{graph}' has no '{event}' with those pins")
}

/// The connection an address walks from, as written: `'finance' (base
/// "Finance")`, then the pins already walked.
fn connected_at(instance: &InstanceRef, walked: &[(String, String)]) -> String {
    let mut at: Vec<String> = instance.address.iter().flat_map(|a| &a.args).map(|(k, v)| format!("{k} {v}")).collect();
    at.extend(walked.iter().map(|(k, v)| format!("{k} \"{v}\"")));
    match at.is_empty() {
        true => format!("'{}'", instance.name),
        false => format!("'{}' ({})", instance.name, at.join(", ")),
    }
}

/// `narrowingPrefixKey`: the pins so far as the key `eventNarrowingValues`
/// files the next hop's options under — `JSON.stringify` of the pairs, sorted.
pub fn narrowing_prefix_key(pins: &[(String, String)]) -> String {
    let mut pins = pins.to_vec();
    pins.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    serde_json::to_string(&pins).unwrap_or_default()
}

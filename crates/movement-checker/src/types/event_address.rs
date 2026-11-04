//! Event addresses (checker/event_address.ts): an `IS` test's one hop and
//! the pins its WHERE states (`IS <at-[:`Record Change` WHERE `action` ==
//! "record.created"]->>`) name a union member the host grafted under the
//! address's key. The key is opaque: built and compared, never parsed. A
//! parameter type's one hop lands on its records, whatever its WHERE.

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

/// `positionFromAddress`: the position a parameter type's one hop lands
/// on, whatever its WHERE says: a WHERE picks records, it does not change
/// what they are. An address that names nothing is `None`, and where it is
/// written that is an error (`address_absence`).
pub fn position_from_address(instance: &InstanceRef, hops_raw: &str) -> Option<Position> {
    let edge = single_hop_edge(hops_raw)?;
    position_ref_in(instance, &edge).or_else(|| position_ref_in(instance, &instance.schema.collections.get(&edge)?.target))
}

/// The edge a one-hop address walks, whatever its WHERE.
fn single_hop_edge(hops_raw: &str) -> Option<String> {
    let probe = format!("__movement_path_root__{}.`__movement_path_probe__`", hops_raw.trim());
    let Expression::Traverse { steps, .. } = crate::slots::expression_of_text(&probe).ok()? else { return None };
    let [TraversalStep::Edge(step)] = steps.as_slice() else { return None };
    Some(step.edge_type_id.clone())
}

/// Why an address names no position, in the author's words: what was looked
/// for and, where the catalog says, what there is instead; and the address
/// to write instead, where the catalog says which one it is.
///
/// - A longer walk is typed by the record it lands on (as a settings
///   listen's rewrite types its parameter): `<chat-[:File]->>` for
///   `<chat-[:Channels]->-[:Messages]->-[:Files]->>`.
/// - A hop naming no position, on a connection that has only one, names that
///   one.
///
/// Neither is offered as a safe rewrite. Before 0.13 an address naming no
/// position left its parameter untyped: typing it checks what went unchecked,
/// and a fired parameter is seeded as that record. A hop naming a position
/// the connection no longer has (one per kind of event) widens to the one it
/// has.
pub fn address_absence(instance: &InstanceRef, hops_raw: &str) -> Absence {
    let graph = &instance.name;
    let instead = |position: &str| format!("<{}-[:{}]->>", crate::families::names::spell_name(graph), crate::families::names::spell_name(position));
    let Some(edge) = single_hop_edge(hops_raw) else {
        let written = format!("'<{graph}{}>' names no position: a type's address is one hop off the system", hops_raw.trim());
        let landing = crate::families::listens::settings_become::walked_landing(&instance.schema, &format!("__movement_path_root__{}", hops_raw.trim()))
            .map(|(landing, _)| landing)
            .filter(|landing| position_ref_in(instance, landing).is_some());
        return match landing {
            Some(landing) => {
                let replacement = instead(&landing);
                Absence { message: format!("{written}; its walk lands on '{landing}', so write `{replacement}`"), replacement: Some(replacement) }
            }
            None => Absence { message: written, replacement: None },
        };
    };
    let schema = &instance.schema;
    let mut available: Vec<&str> = schema.unions.iter().flat_map(|u| u.keys()).map(String::as_str).collect();
    for name in schema.positions.keys() {
        if !available.contains(&name.as_str()) {
            available.push(name);
        }
    }
    let has = if available.is_empty() { String::new() } else { format!(" — it has: {}", available.join(", ")) };
    let written = format!("'{graph}' has no position type '{edge}'{has}");
    match available.as_slice() {
        [only] => {
            let replacement = instead(only);
            Absence { message: format!("{written}; write `{replacement}`"), replacement: Some(replacement) }
        }
        _ => Absence { message: written, replacement: None },
    }
}

/// `address_absence`'s answer.
pub struct Absence {
    pub message: String,
    /// The address to write instead, where the catalog names one.
    pub replacement: Option<String>,
}

//! The record a written receiver holds: a name the check typed, or a walk off
//! one (`c-[m:Messages]->`, an alias `m` bound by a hop), stepped edge by edge
//! with the checker's own `edge_landing`, or a field of one holding a record
//! (`c.Previous`).

use movement_checker::query::Analysis;
use movement_checker::types::Ty;
use movement_checker::types::field::{describe_field_type, strip_absent};
use movement_checker::types::position::{EdgeLanding, Position, describe_position, edge_landing, position_schema_of_ref, record_field_types};
use movement_parser::ast::Loc;

use crate::text::trailing_word;

/// The record `text` (ending where the receiver ends) holds at `at`.
pub fn receiver(analysis: &Analysis, text: &str, at: Loc) -> Option<Position> {
    receiver_within(analysis, text, at, 0)
}

fn receiver_within(analysis: &Analysis, text: &str, at: Loc, depth: usize) -> Option<Position> {
    if depth > 16 {
        return None;
    }
    let trimmed = text.trim_end();
    if let Some(head) = trimmed.strip_suffix("]->") {
        let open = hop_open(head)?;
        let edge = hop_edge(&head[open + 2..])?;
        let from = receiver_within(analysis, &head[..open], at, depth + 1)?;
        return land(&from, &edge);
    }
    // A field holding a record (`c.Previous`), read with `.` or `?.` alike.
    if let Some((head, field)) = field_of(trimmed) {
        let from = receiver_within(analysis, head, at, depth + 1)?;
        let ty = movement_checker::types::position::lookup_property_type(Some(strip(&from)), &field)?;
        let Ty::HeldRecord(held) = strip_absent(&ty) else { return None };
        return Some(held.position.clone());
    }
    let name = trailing_name(trimmed)?;
    if let Some(position) = analysis.resolve(at, &name).and_then(|id| analysis.position_of(id)) {
        return Some(position.clone());
    }
    // An alias a hop earlier in the text binds.
    let bound = text.rfind(&format!("-[{name}:"))?;
    let edge = hop_edge(&text[bound + 2..])?;
    let from = receiver_within(analysis, &text[..bound], at, depth + 1)?;
    land(&from, &edge)
}

/// Where `-[` opens the hop `head` (the text before its `]->`) closes.
fn hop_open(head: &str) -> Option<usize> {
    let mut depth = 1usize;
    for (at, c) in head.char_indices().rev() {
        match c {
            ']' => depth += 1,
            '[' => {
                depth -= 1;
                if depth == 0 {
                    return head[..at].ends_with('-').then(|| at - 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// The edge a hop's text (after its `-[`) names: `m:Messages WHERE …` → `Messages`.
pub fn hop_edge(hop: &str) -> Option<String> {
    let after = match hop.find(':') {
        Some(colon) if !hop[..colon].contains(|c: char| c.is_whitespace() || c == '`') => &hop[colon + 1..],
        _ => hop,
    };
    let after = after.trim_start();
    if let Some(rest) = after.strip_prefix('`') {
        return rest.find('`').map(|end| rest[..end].to_string());
    }
    let name: String = after.chars().take_while(|c| crate::text::is_word_char(*c) || *c == '#' || *c == '@').collect();
    (!name.is_empty()).then_some(name)
}

/// `text` read as a field off a receiver (`c.Previous`, `c?.Previous`,
/// ``c.`Previous Row` ``): the receiver's text and the field.
fn field_of(text: &str) -> Option<(&str, String)> {
    let field = trailing_name(text)?;
    let written = if text.ends_with('`') { field.len() + 2 } else { field.len() };
    let head = text[..text.len() - written].strip_suffix('.')?;
    // `...m` spreads `m`: no field read.
    if head.ends_with('.') {
        return None;
    }
    Some((head.strip_suffix('?').unwrap_or(head), field))
}

/// The name `text` ends with: an identifier, or a backticked name.
pub fn trailing_name(text: &str) -> Option<String> {
    if let Some(head) = text.strip_suffix('`') {
        return head.rfind('`').map(|open| head[open + 1..].to_string());
    }
    let word = trailing_word(text);
    (!word.is_empty()).then(|| word.to_string())
}

fn land(from: &Position, edge: &str) -> Option<Position> {
    match edge_landing(strip(from), edge) {
        EdgeLanding::Landed { landing, .. } => Some(landing),
        _ => None,
    }
}

/// The record itself, whether or not it may be missing.
pub fn strip(position: &Position) -> &Position {
    match position {
        Position::MaybeEmpty(of) => strip(of),
        other => other,
    }
}

/// The fields a record holds, each with its type as the author reads it.
pub fn fields(position: &Position) -> Vec<(String, Option<String>)> {
    record_field_types(position)
        .map(|fields| fields.into_iter().map(|(name, ty)| (name, ty.as_ref().map(describe_field_type))).collect())
        .unwrap_or_default()
}

/// The edges a walk can take next off a record, each with where it lands.
pub fn edges(position: &Position) -> Vec<(String, String)> {
    let Some(schema) = position_schema_of_ref(strip(position)) else { return Vec::new() };
    schema
        .edges
        .iter()
        .map(|(name, edge)| {
            let landing = land(position, name).map_or_else(|| edge.target.clone(), |p| describe_position(&p));
            (name.clone(), landing)
        })
        .collect()
}

/// One edge a listen may take off a record, or off a connection (its root
/// collections): whether its module lists it and announces arrivals on it.
pub struct ListenEdge {
    pub name: String,
    pub landing: String,
    pub readable: bool,
    pub listenable: bool,
}

/// The edges off `position` with what a listen needs to know of each.
pub fn listen_edges(position: &Position) -> Vec<ListenEdge> {
    let position = strip(position);
    if let Position::Meta { instance } = position {
        return instance
            .schema
            .collections
            .iter()
            .map(|(name, c)| ListenEdge {
                name: name.clone(),
                landing: land(position, name).map_or_else(|| c.target.clone(), |p| describe_position(&p)),
                readable: c.readable != Some(false),
                listenable: c.listenable == Some(true),
            })
            .collect();
    }
    edge_schemas(position)
        .into_iter()
        .map(|e| ListenEdge {
            landing: e.landing.as_ref().map_or_else(|| e.schema.target.clone(), describe_position),
            readable: e.schema.readable != Some(false),
            listenable: e.schema.listenable == Some(true),
            name: e.name,
        })
        .collect()
}

/// One edge off a record: its name, what the schema says of it, and where it lands.
pub struct Edge {
    pub name: String,
    pub schema: movement_parser::catalog::types::EdgeSchema,
    pub landing: Option<Position>,
}

/// The edges a walk can take next off a record, each with its schema and landing.
pub fn edge_schemas(position: &Position) -> Vec<Edge> {
    let Some(schema) = position_schema_of_ref(strip(position)) else { return Vec::new() };
    schema.edges.iter().map(|(name, edge)| Edge { name: name.clone(), schema: edge.clone(), landing: land(position, name) }).collect()
}

/// A field's type off a record, as the author reads it.
pub fn field_type(position: &Position, field: &str) -> Option<String> {
    let ty: Option<Ty> = movement_checker::types::position::lookup_property_type(Some(position), field);
    ty.as_ref().map(describe_field_type)
}

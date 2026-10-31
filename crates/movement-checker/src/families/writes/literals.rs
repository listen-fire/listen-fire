//! The literals a write offers at a path (`literalsFrom`): an edge off the
//! written record may declare that a field of what lands on it takes the
//! values the write wrote at, say, `Buttons[].Value`. The field is then an
//! enum of exactly those values, as TypeScript types a value by the literals
//! it was built from. Nothing here knows any field by name: the edge names
//! both ends.

use movement_parser::ast::Span;
use movement_parser::lowering::expression::{Expression, ListElement, ObjectMember, StaticValue};

use super::{Field, edges_off_handle};
use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::Severity;
use crate::slots::expression_of_slot;
use crate::types::Ty;
use crate::types::position::Position;

impl Checker<'_> {
    /// The fields of what lands on each edge off the written record that
    /// take the literals this write offered (the edge's `literalsFrom`).
    pub(super) fn apply_answer_literals(&mut self, handle: Option<Position>, fields: &[Field], description: &str) -> Option<Position> {
        let Some(Position::Handle(mut handle_position)) = handle else { return handle };
        let Some(edges) = edges_off_handle(&handle_position) else { return Some(Position::Handle(handle_position)) };
        let mut answers = indexmap::IndexMap::new();
        for (edge_name, edge_schema) in edges.iter() {
            let mut entries = Vec::new();
            for declared in edge_schema.literals_from.iter().flatten() {
                // A module's describe refuses a path that does not parse; a
                // snapshot that carries one anyway offers nothing to read.
                let (Ok(path), false) = (parse_write_path(&declared.from), declared.at.is_empty()) else { continue };
                match literals_at(fields, &path) {
                    LiteralsAt::Literals(options) if !options.is_empty() => entries.push((declared.at.clone(), Ty::Enum { options, open: None })),
                    // Only a field the write holds yields literals, so it has a span.
                    LiteralsAt::Literals(_) => {
                        let Some(span) = span_of(fields, &path) else { continue };
                        self.report_with(
                            codes::WRITE_LITERALS_EMPTY,
                            format!(
                                "this write sets no '{path}', so no answer on '-[:{edge_name}]->' from {description} can take its '{}' from it; the field keeps its declared type. Add the entries the answer may choose from, or leave '{}' out of the write",
                                declared.at.join("."),
                                path.0[0].field
                            ),
                            span,
                            Severity::Warning,
                        )
                    }
                    LiteralsAt::Absent => {}
                    LiteralsAt::NotLiteral(span) => self.report_with(
                        codes::WRITE_GENERIC_UNTYPED,
                        format!(
                            "'{path}' is not all text literals here, so the '{}' of what '-[:{edge_name}]->' delivers on {description} keeps its declared type instead of the values offered. Write each '{path}' as a text literal to have the answer checked against them",
                            declared.at.join(".")
                        ),
                        span,
                        Severity::Warning,
                    ),
                }
            }
            if !entries.is_empty() {
                answers.insert(edge_name.clone(), entries);
            }
        }
        if !answers.is_empty() {
            handle_position.answer_fields = Some(std::rc::Rc::new(answers));
        }
        Some(Position::Handle(handle_position))
    }
}

/// A path into a write's body: `Buttons[].Value` is `Buttons`, each of its
/// entries, then that entry's `Value`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WritePath(pub Vec<WriteStep>);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteStep {
    pub field: String,
    /// `[]`: the field holds a list, and the path goes on into each entry.
    pub each: bool,
}

/// `Field("[]")?("." Field("[]")?)*`, a field being any text without `.`,
/// `[` or `]` (a write's field names may hold spaces).
pub fn parse_write_path(text: &str) -> Result<WritePath, String> {
    let mut steps = Vec::new();
    for part in text.split('.') {
        let (field, each) = match part.strip_suffix("[]") {
            Some(field) => (field, true),
            None => (part, false),
        };
        if field.trim().is_empty() {
            return Err(format!("'{text}' has an empty field name: a path is fields joined by '.', each optionally followed by '[]'"));
        }
        if field.contains(['[', ']']) {
            return Err(format!("'{text}' has a stray bracket in '{part}': only '[]' may follow a field, before the next '.'"));
        }
        steps.push(WriteStep { field: field.to_string(), each });
    }
    Ok(WritePath(steps))
}

impl std::fmt::Display for WritePath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let spelled: Vec<String> = self.0.iter().map(|s| if s.each { format!("{}[]", s.field) } else { s.field.clone() }).collect();
        f.write_str(&spelled.join("."))
    }
}

/// What a write holds at a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiteralsAt {
    /// Every value there is a text literal: these, each once, in the order written.
    Literals(Vec<String>),
    /// Some value on the way is built at run time (a name, a call, an
    /// interpolation): the write field holding it is at the span.
    NotLiteral(Span),
    /// The write does not write the path at all.
    Absent,
}

/// Where the write field a path starts at is written.
fn span_of(fields: &[Field], path: &WritePath) -> Option<Span> {
    let first = &path.0.first()?.field;
    fields.iter().find(|f| f.name == *first).map(|f| f.value.span)
}

/// What `fields` hold at `path`. An entry of a list that lacks the rest of
/// the path offers nothing; one that is not written out (a spread of a list
/// held by a name) is built at run time.
pub(super) fn literals_at(fields: &[Field], path: &WritePath) -> LiteralsAt {
    let Some((first, rest)) = path.0.split_first() else { return LiteralsAt::Absent };
    let Some(field) = fields.iter().find(|f| f.name == first.field) else { return LiteralsAt::Absent };
    let span = field.value.span;
    let Ok(value) = expression_of_slot(&field.value) else { return LiteralsAt::NotLiteral(span) };
    let mut found = Vec::new();
    match collect(&value, first.each, rest, &mut found) {
        Ok(()) => LiteralsAt::Literals(found),
        Err(NotLiteral) => LiteralsAt::NotLiteral(span),
    }
}

struct NotLiteral;

/// Adds the literals `value` holds at the rest of a path, `value` being
/// a field the path reached (its entries, when `each`).
fn collect(value: &Expression, each: bool, rest: &[WriteStep], into: &mut Vec<String>) -> Result<(), NotLiteral> {
    if each {
        let Expression::List { elements } = value else { return Err(NotLiteral) };
        for element in elements {
            match element {
                ListElement::Expression(entry) => collect(entry, false, rest, into)?,
                ListElement::Spread(spread) => collect(&spread.expression, true, rest, into)?,
            }
        }
        return Ok(());
    }
    let Some((next, rest)) = rest.split_first() else {
        let Expression::Static { value: StaticValue::String(literal) } = value else { return Err(NotLiteral) };
        if !into.contains(literal) {
            into.push(literal.clone());
        }
        return Ok(());
    };
    let Expression::Object { entries } = value else { return Err(NotLiteral) };
    // The last member to set the field is what the entry holds; a spread may
    // set it, and what a spread brings is known only when it runs.
    let mut held = Ok(None);
    for member in entries {
        match member {
            ObjectMember::Entry { key, value } if *key == next.field => held = Ok(Some(value)),
            ObjectMember::Entry { .. } => {}
            ObjectMember::Spread(_) => held = Err(NotLiteral),
        }
    }
    match held? {
        Some(held) => collect(held, next.each, rest, into),
        None => Ok(()),
    }
}

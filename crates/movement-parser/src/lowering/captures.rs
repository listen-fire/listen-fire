//! What a wait's WHERE borrows from the run. A wait parks and its WHERE is
//! tested against each arrival later; the parts that do not read the arrival
//! (a run record's field, a variable) are evaluated once, when the wait is
//! reached, and kept with the parked run, as a closure keeps what it closed
//! over. One analysis serves the checker, which says on upgrade which waits
//! this changes, and the engine, which captures them.

use super::expression::{AggregationFunction, Expression, ListElement, ListSpread, ObjectMember};

/// A part of a WHERE the arrival does not read, numbered in reading order.
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureHole {
    pub index: usize,
    pub expression: Expression,
}

/// What a part of a WHERE reads, ordered so that a whole reads the most any
/// of its parts reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Reads {
    Nothing,
    Run,
    Arrival,
}

/// The maximal subexpressions of `filter` that read no field of the arrival
/// (named by `alias`). A lone literal is no hole; a bare name is a hole when
/// `bound` says it is a variable, and otherwise the arrival's field. A hole
/// written twice is one hole.
pub fn capture_holes(filter: &Expression, alias: Option<&str>, bound: &dyn Fn(&str) -> bool) -> Vec<CaptureHole> {
    let arrival = Arrival { alias, bound };
    let mut holes = Vec::new();
    arrival.collect(filter, &mut holes);
    holes
}

/// `filter` with hole i read from the reserved name `captured_name(i)`.
pub fn with_captured(filter: &Expression, holes: &[CaptureHole]) -> Expression {
    if let Some(hole) = holes.iter().find(|h| h.expression == *filter) {
        return Expression::AliasRef { name: captured_name(hole.index) };
    }
    map_parts(filter, &|part| with_captured(part, holes))
}

/// The name a captured value is read from: it starts with a NUL, which no
/// program can spell.
pub fn captured_name(index: usize) -> String {
    format!("\u{0}captured{index}")
}

struct Arrival<'a> {
    alias: Option<&'a str>,
    bound: &'a dyn Fn(&str) -> bool,
}

impl Arrival<'_> {
    /// A name read bare is the arrival's field unless a variable holds it;
    /// the alias is always the arrival.
    fn names_it(&self, name: &str) -> bool {
        self.alias == Some(name) || !(self.bound)(name)
    }

    fn reads(&self, e: &Expression) -> Reads {
        match e {
            Expression::Static { .. } => Reads::Nothing,
            Expression::Property { property_type_id: name, field_only } | Expression::EdgeProperty { property_type_id: name, field_only } => {
                if *field_only || self.names_it(name) { Reads::Arrival } else { Reads::Run }
            }
            Expression::AliasRef { name } => {
                if self.names_it(name) { Reads::Arrival } else { Reads::Run }
            }
            // A walk is read whole: off the arrival (or off no root, which is
            // the arrival) it is the arrival's, off a run record it is the run's.
            Expression::Traverse { alias_root, .. } => match alias_root {
                Some(root) if !self.names_it(root) => Reads::Run,
                _ => Reads::Arrival,
            },
            // Each is about the record the WHERE is tested against: its
            // walks, its resources, its parent, what a model makes of it.
            Expression::Exists { .. }
            | Expression::ResourceTraverse { .. }
            | Expression::ParentResult { .. }
            | Expression::Resource { .. }
            | Expression::LinkedObject { .. }
            | Expression::ExtractValue { .. }
            | Expression::Llm { .. }
            | Expression::Aggregate { fn_: AggregationFunction::Llm, .. } => Reads::Arrival,
            Expression::Meta { .. } | Expression::ActionResult { .. } => Reads::Run,
            // A knowledge-graph query reads the run's graph even with no parameters.
            Expression::KgExists { params, .. } | Expression::KgValue { params, .. } => {
                params.iter().map(|p| self.reads(p)).fold(Reads::Run, Ord::max)
            }
            composite => parts(composite).into_iter().map(|p| self.reads(p)).fold(Reads::Nothing, Ord::max),
        }
    }

    fn collect(&self, e: &Expression, holes: &mut Vec<CaptureHole>) {
        match self.reads(e) {
            Reads::Nothing => {}
            Reads::Run => {
                if !holes.iter().any(|h| h.expression == *e) {
                    holes.push(CaptureHole { index: holes.len(), expression: e.clone() });
                }
            }
            Reads::Arrival => {
                for part in parts(e) {
                    self.collect(part, holes);
                }
            }
        }
    }
}

/// The parts a whole is computed from, in reading order. A walk, an
/// `EXISTS` and a model's judgement are read whole and have none.
fn parts(e: &Expression) -> Vec<&Expression> {
    match e {
        Expression::Aggregate { fn_: AggregationFunction::Llm, .. } => Vec::new(),
        Expression::List { elements } => elements
            .iter()
            .map(|element| match element {
                ListElement::Expression(e) => e,
                ListElement::Spread(ListSpread { expression }) => expression.as_ref(),
            })
            .collect(),
        Expression::Object { entries } => entries
            .iter()
            .map(|entry| match entry {
                ObjectMember::Entry { value, .. } => value,
                ObjectMember::Spread(ListSpread { expression }) => expression.as_ref(),
            })
            .collect(),
        Expression::Arithmetic { left, right, .. } | Expression::Compare { left, right, .. } => vec![left, right],
        Expression::Logical { operands, .. } => operands.iter().collect(),
        Expression::Not { expression } | Expression::Negate { expression } => vec![expression],
        Expression::Concat { parts } => parts.iter().collect(),
        Expression::Conditional { condition, then, else_ } => vec![condition, then, else_],
        Expression::At { expression, index } => vec![expression, index],
        Expression::Aggregate { expression, order_by, .. } => std::iter::once(expression.as_ref()).chain(order_by.as_deref()).collect(),
        Expression::Function { args, .. } => args.iter().collect(),
        Expression::KgExists { params, .. } | Expression::KgValue { params, .. } => params.iter().collect(),
        Expression::Property { .. }
        | Expression::EdgeProperty { .. }
        | Expression::Static { .. }
        | Expression::Llm { .. }
        | Expression::Meta { .. }
        | Expression::ParentResult { .. }
        | Expression::ActionResult { .. }
        | Expression::Resource { .. }
        | Expression::LinkedObject { .. }
        | Expression::ExtractValue { .. }
        | Expression::AliasRef { .. }
        | Expression::Traverse { .. }
        | Expression::ResourceTraverse { .. }
        | Expression::Exists { .. } => Vec::new(),
    }
}

/// `e` with each of its `parts` replaced by `f` of it.
fn map_parts(e: &Expression, f: &dyn Fn(&Expression) -> Expression) -> Expression {
    let boxed = |e: &Expression| Box::new(f(e));
    let spread = |s: &ListSpread| ListSpread { expression: boxed(&s.expression) };
    match e {
        Expression::Aggregate { fn_: AggregationFunction::Llm, .. } => e.clone(),
        Expression::List { elements } => Expression::List {
            elements: elements
                .iter()
                .map(|element| match element {
                    ListElement::Expression(e) => ListElement::Expression(f(e)),
                    ListElement::Spread(s) => ListElement::Spread(spread(s)),
                })
                .collect(),
        },
        Expression::Object { entries } => Expression::Object {
            entries: entries
                .iter()
                .map(|entry| match entry {
                    ObjectMember::Entry { key, value } => ObjectMember::Entry { key: key.clone(), value: f(value) },
                    ObjectMember::Spread(s) => ObjectMember::Spread(spread(s)),
                })
                .collect(),
        },
        Expression::Arithmetic { op, left, right } => Expression::Arithmetic { op: *op, left: boxed(left), right: boxed(right) },
        Expression::Compare { op, left, right } => Expression::Compare { op: *op, left: boxed(left), right: boxed(right) },
        Expression::Logical { op, operands } => Expression::Logical { op: *op, operands: operands.iter().map(f).collect() },
        Expression::Not { expression } => Expression::Not { expression: boxed(expression) },
        Expression::Negate { expression } => Expression::Negate { expression: boxed(expression) },
        Expression::Concat { parts } => Expression::Concat { parts: parts.iter().map(f).collect() },
        Expression::Conditional { condition, then, else_ } => {
            Expression::Conditional { condition: boxed(condition), then: boxed(then), else_: boxed(else_) }
        }
        Expression::At { expression, index } => Expression::At { expression: boxed(expression), index: boxed(index) },
        Expression::Aggregate { fn_, expression, separator, prompt, order_by, order_direction, written } => Expression::Aggregate {
            fn_: *fn_,
            expression: boxed(expression),
            separator: separator.clone(),
            prompt: prompt.clone(),
            order_by: order_by.as_deref().map(boxed),
            order_direction: *order_direction,
            written: written.clone(),
        },
        Expression::Function { fn_, args } => Expression::Function { fn_: fn_.clone(), args: args.iter().map(f).collect() },
        Expression::KgExists { query, params } => Expression::KgExists { query: query.clone(), params: params.iter().map(f).collect() },
        Expression::KgValue { query, params } => Expression::KgValue { query: query.clone(), params: params.iter().map(f).collect() },
        Expression::Property { .. }
        | Expression::EdgeProperty { .. }
        | Expression::Static { .. }
        | Expression::Llm { .. }
        | Expression::Meta { .. }
        | Expression::ParentResult { .. }
        | Expression::ActionResult { .. }
        | Expression::Resource { .. }
        | Expression::LinkedObject { .. }
        | Expression::ExtractValue { .. }
        | Expression::AliasRef { .. }
        | Expression::Traverse { .. }
        | Expression::ResourceTraverse { .. }
        | Expression::Exists { .. } => e.clone(),
    }
}

/// The reads off a named root a hole is computed from (`founder.Email`,
/// `founder-[:Company]->.Name`), each with its root, in reading order.
pub fn rooted_reads(hole: &Expression) -> Vec<(&str, &Expression)> {
    match hole {
        Expression::Traverse { alias_root: Some(root), .. } => vec![(root.as_str(), hole)],
        other => parts(other).into_iter().flat_map(rooted_reads).collect(),
    }
}

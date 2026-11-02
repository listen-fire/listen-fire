//! What a wait's WHERE borrows from the run. A wait parks and its WHERE is
//! tested against each arrival later. A part of it that reads only what the
//! run holds (a variable, a field of a record the run read or wrote, the
//! run's meta) is evaluated once, when the wait is reached, and kept with the
//! parked run, as a closure keeps the objects it closed over. A part that
//! reads the arrival, or reaches out to a system (a walk off a connection, a
//! knowledge-graph query, a model), is evaluated at every check, as a call
//! inside a closure runs each time. One analysis serves the checker, which
//! says on upgrade which waits this changes, and the engine, which captures.

use std::collections::BTreeSet;

use super::expression::{AggregationFunction, Cardinality, EdgeStep, Expression, ListElement, ListSpread, ObjectMember, TraversalStep};

/// What a name read in a wait's WHERE is, where the wait is written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scoped {
    /// No variable has the name: read bare, it is a field of the record
    /// being tested.
    Free,
    /// A value or a record the run holds.
    Run,
    /// A connection: what is read through it is read from the system.
    Connection,
}

/// A part of a WHERE that reads only the run, numbered in reading order,
/// written as the run reads it when the wait is reached (`as_run_reads_it`).
#[derive(Debug, Clone, PartialEq)]
pub struct CaptureHole {
    pub index: usize,
    pub expression: Expression,
}

/// A WHERE's holes, and the WHERE with hole i read from `captured_name(i)`.
#[derive(Debug, Clone, PartialEq)]
pub struct Captured {
    pub holes: Vec<CaptureHole>,
    pub filter: Expression,
}

/// The largest parts of `filter` that read only what the run holds, wherever
/// they are written (inside a nested walk's or an `EXISTS`'s WHERE too), and
/// `filter` with each read from its reserved name. The arrival is named by
/// `alias`, and `scoped` says what any other name is. A lone literal is no
/// hole. A hole written twice is one hole: it reads the same run values.
pub fn capture(filter: &Expression, alias: Option<&str>, scoped: &dyn Fn(&str) -> Scoped) -> Captured {
    let mut analysis = Analysis { scoped, holes: Vec::new() };
    let arrival = Ctx { level: 0, aliases: alias.map(|a| (a.to_string(), 0)).into_iter().collect() };
    let (_, filter) = analysis.part(filter, &arrival);
    Captured { holes: analysis.holes, filter }
}

/// `capture`'s holes alone.
pub fn capture_holes(filter: &Expression, alias: Option<&str>, scoped: &dyn Fn(&str) -> Scoped) -> Vec<CaptureHole> {
    capture(filter, alias, scoped).holes
}

/// The name a captured value is read from: it starts with a NUL, which no
/// program can spell.
pub fn captured_name(index: usize) -> String {
    format!("\u{0}captured{index}")
}

/// The reads off a named root a hole is computed from (`founder.Email`,
/// `founder-[:Company]->.Name`), each with its root, in reading order. A
/// walk's own WHERE is searched too; a member read off a walk's landing is
/// not a root.
pub fn rooted_reads(hole: &Expression) -> Vec<(&str, &Expression)> {
    let mut found = Vec::new();
    collect_rooted(hole, &mut found);
    found
}

fn collect_rooted<'e>(e: &'e Expression, found: &mut Vec<(&'e str, &'e Expression)>) {
    match e {
        Expression::Traverse { alias_root, steps, .. } => {
            if let Some(root) = alias_root {
                found.push((root.as_str(), e));
            }
            for step in steps {
                step_parts(step, &mut |part| collect_rooted(part, found));
            }
        }
        Expression::Exists { steps, where_ } => {
            for step in steps {
                step_parts(step, &mut |part| collect_rooted(part, found));
            }
            if let Some(where_) = where_ {
                collect_rooted(where_, found);
            }
        }
        other => {
            for part in parts(other) {
                collect_rooted(part, found);
            }
        }
    }
}

fn step_parts<'e>(step: &'e TraversalStep, f: &mut dyn FnMut(&'e Expression)) {
    if let TraversalStep::Edge(edge) = step {
        edge.expression_filter.as_deref().into_iter().for_each(&mut *f);
        edge.cardinality.as_ref().and_then(|c| c.order_by.as_deref()).into_iter().for_each(f);
    }
}

/// What a part reads: the run, a system, and which records being tested
/// (by the level of the walk that binds them; 0 is the arrival).
#[derive(Debug, Clone, Default)]
struct Reads {
    run: bool,
    world: bool,
    records: BTreeSet<usize>,
}

impl Reads {
    fn run() -> Self {
        Reads { run: true, ..Reads::default() }
    }

    fn world() -> Self {
        Reads { world: true, ..Reads::default() }
    }

    fn record(level: usize) -> Self {
        Reads { records: BTreeSet::from([level]), ..Reads::default() }
    }

    fn with(mut self, other: Reads) -> Self {
        self.run |= other.run;
        self.world |= other.world;
        self.records.extend(other.records);
        self
    }

    /// As seen from outside the walk that binds `level`.
    fn leaving(mut self, level: usize) -> Self {
        self.records.remove(&level);
        self
    }

    fn is_hole(&self) -> bool {
        self.run && !self.world && self.records.is_empty()
    }
}

/// Where a part is written: the level of the record a bare name is a field
/// of, and the aliases in scope with the level each names.
#[derive(Clone)]
struct Ctx {
    level: usize,
    aliases: Vec<(String, usize)>,
}

impl Ctx {
    /// Inside a walk's step or landing, whose record is `level`.
    fn entering(&self, level: usize, alias: Option<&str>) -> Ctx {
        let mut aliases = self.aliases.clone();
        aliases.extend(alias.map(|a| (a.to_string(), level)));
        Ctx { level, aliases }
    }
}

struct Analysis<'a> {
    scoped: &'a dyn Fn(&str) -> Scoped,
    holes: Vec<CaptureHole>,
}

impl Analysis<'_> {
    /// A part: a hole when it reads only the run (the holes found inside it
    /// are then its own), else as `visit` rewrote it.
    fn part(&mut self, e: &Expression, ctx: &Ctx) -> (Reads, Expression) {
        let mark = self.holes.len();
        let (reads, rewritten) = self.visit(e, ctx);
        if !reads.is_hole() {
            return (reads, rewritten);
        }
        self.holes.truncate(mark);
        let expression = as_run_reads_it(e);
        let index = match self.holes.iter().find(|h| h.expression == expression) {
            Some(hole) => hole.index,
            None => {
                self.holes.push(CaptureHole { index: self.holes.len(), expression });
                self.holes.len() - 1
            }
        };
        (reads, Expression::AliasRef { name: captured_name(index) })
    }

    /// `part`, its reads added to `reads`.
    fn boxed(&mut self, e: &Expression, ctx: &Ctx, reads: &mut Reads) -> Box<Expression> {
        let (r, e) = self.part(e, ctx);
        *reads = std::mem::take(reads).with(r);
        Box::new(e)
    }

    fn each(&mut self, parts: &[Expression], ctx: &Ctx, reads: &mut Reads) -> Vec<Expression> {
        parts.iter().map(|p| *self.boxed(p, ctx, reads)).collect()
    }

    /// A name read: an alias in scope is its record; any other name is
    /// what `scoped` says.
    fn name(&self, name: &str, ctx: &Ctx) -> Reads {
        if let Some((_, level)) = ctx.aliases.iter().rev().find(|(alias, _)| alias == name) {
            return Reads::record(*level);
        }
        match (self.scoped)(name) {
            Scoped::Free => Reads::record(ctx.level),
            Scoped::Run => Reads::run(),
            Scoped::Connection => Reads::world(),
        }
    }

    /// What `e` reads, and `e` with the holes inside it read from their names.
    fn visit(&mut self, e: &Expression, ctx: &Ctx) -> (Reads, Expression) {
        let mut reads = Reads::default();
        let rewritten = match e {
            Expression::Static { .. } => e.clone(),
            Expression::Property { property_type_id: name, field_only } | Expression::EdgeProperty { property_type_id: name, field_only } => {
                reads = if *field_only { Reads::record(ctx.level) } else { self.name(name, ctx) };
                e.clone()
            }
            Expression::AliasRef { name } => {
                reads = self.name(name, ctx);
                e.clone()
            }
            Expression::Meta { .. } | Expression::ActionResult { .. } => {
                reads = Reads::run();
                e.clone()
            }
            Expression::ParentResult { .. } | Expression::Resource { .. } => {
                reads = Reads::record(ctx.level);
                e.clone()
            }
            // The record's linked object, an extraction from it, or its
            // resources: the system is asked about the record being tested.
            Expression::LinkedObject { .. } | Expression::ExtractValue { .. } | Expression::ResourceTraverse { .. } => {
                reads = Reads::record(ctx.level).with(Reads::world());
                e.clone()
            }
            Expression::Llm { prompt, prompt_expression, tier } => {
                reads = Reads::record(ctx.level).with(Reads::world());
                let prompt_expression = prompt_expression.as_deref().map(|p| self.boxed(p, ctx, &mut reads));
                Expression::Llm { prompt: prompt.clone(), prompt_expression, tier: tier.clone() }
            }
            Expression::KgExists { query, params } => {
                reads = Reads::world();
                Expression::KgExists { query: query.clone(), params: self.each(params, ctx, &mut reads) }
            }
            Expression::KgValue { query, params } => {
                reads = Reads::world();
                Expression::KgValue { query: query.clone(), params: self.each(params, ctx, &mut reads) }
            }
            Expression::Traverse { alias_root, steps, expression, optional } => {
                let root = match alias_root {
                    Some(root) => self.name(root, ctx),
                    None => Reads::record(ctx.level),
                };
                let (r, rewritten) = self.walk(root, alias_root, steps, expression, ctx);
                reads = r;
                kept_optional(rewritten, *optional)
            }
            Expression::Exists { steps, where_ } => {
                let (r, rewritten) = self.exists(Reads::record(ctx.level), steps, where_.as_deref(), ctx);
                reads = r;
                rewritten
            }
            Expression::List { elements } => Expression::List {
                elements: elements
                    .iter()
                    .map(|element| match element {
                        ListElement::Expression(e) => ListElement::Expression(*self.boxed(e, ctx, &mut reads)),
                        ListElement::Spread(s) => ListElement::Spread(ListSpread { expression: self.boxed(&s.expression, ctx, &mut reads) }),
                    })
                    .collect(),
            },
            Expression::Object { entries } => Expression::Object {
                entries: entries
                    .iter()
                    .map(|entry| match entry {
                        ObjectMember::Entry { key, value } => ObjectMember::Entry { key: key.clone(), value: *self.boxed(value, ctx, &mut reads) },
                        ObjectMember::Spread(s) => ObjectMember::Spread(ListSpread { expression: self.boxed(&s.expression, ctx, &mut reads) }),
                    })
                    .collect(),
            },
            Expression::Arithmetic { op, left, right } => {
                Expression::Arithmetic { op: *op, left: self.boxed(left, ctx, &mut reads), right: self.boxed(right, ctx, &mut reads) }
            }
            Expression::Compare { op, left, right } => {
                Expression::Compare { op: *op, left: self.boxed(left, ctx, &mut reads), right: self.boxed(right, ctx, &mut reads) }
            }
            Expression::Logical { op, operands } => Expression::Logical { op: *op, operands: self.each(operands, ctx, &mut reads) },
            Expression::Not { expression } => Expression::Not { expression: self.boxed(expression, ctx, &mut reads) },
            Expression::Negate { expression } => Expression::Negate { expression: self.boxed(expression, ctx, &mut reads) },
            Expression::Concat { parts } => Expression::Concat { parts: self.each(parts, ctx, &mut reads) },
            Expression::Conditional { condition, then, else_ } => Expression::Conditional {
                condition: self.boxed(condition, ctx, &mut reads),
                then: self.boxed(then, ctx, &mut reads),
                else_: self.boxed(else_, ctx, &mut reads),
            },
            Expression::At { expression, index } => {
                Expression::At { expression: self.boxed(expression, ctx, &mut reads), index: self.boxed(index, ctx, &mut reads) }
            }
            Expression::Aggregate { fn_, expression, separator, prompt, order_by, order_direction, written } => {
                // A model's summary is a call out, made at every check.
                if *fn_ == AggregationFunction::Llm {
                    reads = Reads::world();
                }
                Expression::Aggregate {
                    fn_: *fn_,
                    expression: self.boxed(expression, ctx, &mut reads),
                    separator: separator.clone(),
                    prompt: prompt.clone(),
                    order_by: order_by.as_deref().map(|o| self.boxed(o, ctx, &mut reads)),
                    order_direction: *order_direction,
                    written: written.clone(),
                }
            }
            Expression::Function { fn_, args } => Expression::Function { fn_: fn_.clone(), args: self.each(args, ctx, &mut reads) },
        };
        (reads, rewritten)
    }

    /// A walk from `root`: its steps, each WHERE testing that step's records,
    /// then what it reads off the records it lands on.
    fn walk(&mut self, root: Reads, alias_root: &Option<String>, steps: &[TraversalStep], terminal: &Expression, ctx: &Ctx) -> (Reads, Expression) {
        let landing = ctx.level + 1;
        let (reads, steps) = self.steps(root, steps, ctx);
        let (r, terminal) = self.terminal(terminal, &ctx.entering(landing, None));
        (reads.with(r.leaving(landing)), Expression::Traverse { alias_root: alias_root.clone(), steps, expression: Box::new(terminal), optional: false })
    }

    fn exists(&mut self, root: Reads, steps: &[TraversalStep], where_: Option<&Expression>, ctx: &Ctx) -> (Reads, Expression) {
        let landing = ctx.level + 1;
        let (mut reads, steps) = self.steps(root, steps, ctx);
        let mut tested = Reads::default();
        let where_ = where_.map(|w| self.boxed(w, &ctx.entering(landing, None), &mut tested));
        reads = reads.with(tested.leaving(landing));
        (reads, Expression::Exists { steps, where_ })
    }

    fn steps(&mut self, mut reads: Reads, steps: &[TraversalStep], ctx: &Ctx) -> (Reads, Vec<TraversalStep>) {
        let landing = ctx.level + 1;
        let mut rewritten = Vec::with_capacity(steps.len());
        for step in steps {
            rewritten.push(match step {
                TraversalStep::Edge(edge) => {
                    let inner = ctx.entering(landing, edge.alias.as_deref());
                    let mut tested = Reads::default();
                    let expression_filter = edge.expression_filter.as_deref().map(|f| self.boxed(f, &inner, &mut tested));
                    let cardinality = edge.cardinality.as_ref().map(|c| Cardinality {
                        order_by: c.order_by.as_deref().map(|o| self.boxed(o, &inner, &mut tested)),
                        ..c.clone()
                    });
                    reads = reads.with(tested.leaving(landing));
                    TraversalStep::Edge(EdgeStep { expression_filter, cardinality, ..edge.clone() })
                }
                // A plugin's transform is a call out, made at every check.
                TraversalStep::MetaEdge(_) => {
                    reads = reads.with(Reads::world());
                    step.clone()
                }
                TraversalStep::LinkBack {} | TraversalStep::Resource(_) => step.clone(),
            });
        }
        (reads, rewritten)
    }

    /// What a walk reads off the records it lands on (`ctx.level`): a name
    /// there is the landing's field or member, never a variable.
    fn terminal(&mut self, e: &Expression, ctx: &Ctx) -> (Reads, Expression) {
        match e {
            Expression::Property { .. } | Expression::EdgeProperty { .. } => (Reads::record(ctx.level), e.clone()),
            Expression::Traverse { alias_root, steps, expression, optional } => {
                let (reads, rewritten) = self.walk(Reads::record(ctx.level), alias_root, steps, expression, ctx);
                (reads, kept_optional(rewritten, *optional))
            }
            Expression::Exists { steps, where_ } => self.exists(Reads::record(ctx.level), steps, where_.as_deref(), ctx),
            other => self.visit(other, ctx),
        }
    }
}

/// A walk rebuilt from `x?.F` stays one.
fn kept_optional(mut walk: Expression, optional: bool) -> Expression {
    if let Expression::Traverse { optional: kept, .. } = &mut walk {
        *kept = optional;
    }
    walk
}

/// A hole as the run reads it, outside any hop. A hop's WHERE lowers a name
/// as the walked edge's property; in a hole that name is a variable or a
/// record's field, which the run reads as a property. So one read written at
/// the top and inside a hop is one hole. A walk's own steps lower alike
/// wherever the walk is written, so only what it reads off its landing changes.
fn as_run_reads_it(e: &Expression) -> Expression {
    match e {
        Expression::EdgeProperty { property_type_id, field_only } => {
            Expression::Property { property_type_id: property_type_id.clone(), field_only: *field_only }
        }
        Expression::Traverse { alias_root, steps, expression, optional } => Expression::Traverse {
            alias_root: alias_root.clone(),
            steps: steps.clone(),
            expression: Box::new(as_run_reads_it(expression)),
            optional: *optional,
        },
        Expression::Exists { .. } => e.clone(),
        other => map_parts(other, &as_run_reads_it),
    }
}

/// `e` with each value it is computed from replaced by `f` of it (a walk is
/// left whole).
fn map_parts(e: &Expression, f: &dyn Fn(&Expression) -> Expression) -> Expression {
    let boxed = |e: &Expression| Box::new(f(e));
    let spread = |s: &ListSpread| ListSpread { expression: boxed(&s.expression) };
    match e {
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
        Expression::Llm { prompt, prompt_expression, tier } => {
            Expression::Llm { prompt: prompt.clone(), prompt_expression: prompt_expression.as_deref().map(boxed), tier: tier.clone() }
        }
        Expression::Property { .. }
        | Expression::EdgeProperty { .. }
        | Expression::Static { .. }
        | Expression::Meta { .. }
        | Expression::ParentResult { .. }
        | Expression::ActionResult { .. }
        | Expression::Resource { .. }
        | Expression::LinkedObject { .. }
        | Expression::ExtractValue { .. }
        | Expression::AliasRef { .. }
        | Expression::Traverse { .. }
        | Expression::Exists { .. }
        | Expression::ResourceTraverse { .. } => e.clone(),
    }
}

/// The parts of a value computed from others, for `rooted_reads`.
fn parts(e: &Expression) -> Vec<&Expression> {
    match e {
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
        Expression::Llm { prompt_expression, .. } => prompt_expression.as_deref().into_iter().collect(),
        Expression::Property { .. }
        | Expression::EdgeProperty { .. }
        | Expression::Static { .. }
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

//! A hop's WHERE, split into what the edge's module takes and what the host
//! checks on what comes back. No traversal ranges over an unbounded edge: an
//! edge its module declares unbounded (every schedule, every team's mail)
//! is traversed only with a filter the module takes on one of its bounding
//! fields. A field of a scalar only the module can evaluate (an owned one)
//! is the module's to filter on, so a part of the WHERE that reads one and
//! that the module cannot take is refused rather than left to the host.
//!
//! Its codes, raised where a hop is checked (`walks`):
//!
//! - MOV_UNBOUNDED_EDGE
//! - MOV_FILTER_NOT_TAKEN

use movement_parser::catalog::types::{CollectionSchema, EdgeCapability, EdgeSchema, FieldType, PositionSchema, PushMode};
use movement_parser::lowering::expression::{Expression, FilterOperator, ListElement, LogicalOp, StaticValue};

use crate::codes;
use crate::families::names::spell_name;
use crate::families::values::with_article;
use crate::families::walks::is_pure_predicate;

/// What the split needs of an edge, whether a record's edge or a system's
/// root collection.
pub struct EdgeView<'a> {
    pub name: &'a str,
    pub module: &'a str,
    pub capability: Option<&'a EdgeCapability>,
    pub bounded: bool,
    pub bounded_by: &'a [String],
}

impl<'a> EdgeView<'a> {
    pub fn of_edge(name: &'a str, module: &'a str, schema: &'a EdgeSchema) -> Self {
        EdgeView {
            name,
            module,
            capability: schema.capability.as_ref(),
            bounded: schema.bounded != Some(false),
            bounded_by: schema.bounded_by.as_deref().unwrap_or_default(),
        }
    }

    pub fn of_collection(name: &'a str, module: &'a str, schema: &'a CollectionSchema) -> Self {
        EdgeView {
            name,
            module,
            capability: schema.capability.as_ref(),
            bounded: schema.bounded != Some(false),
            bounded_by: schema.bounded_by.as_deref().unwrap_or_default(),
        }
    }

    fn native(&self) -> bool {
        self.capability.is_some_and(|c| c.filter == Some(PushMode::Native))
    }
}

/// The WHERE's top-level conjuncts (joined by AND), in source order: those
/// the module takes, and those the host checks on what comes back.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Split {
    pub taken: Vec<Expression>,
    pub checked: Vec<Expression>,
}

/// Why a WHERE cannot be split as written. Each conjunct is spelled as the
/// program writes it.
#[derive(Debug, Clone, PartialEq)]
pub enum Untaken {
    /// An unbounded edge with no taken filter on a bounding field; `field`
    /// is the bounding field to narrow by.
    Unbounded { field: String, why: Unbounding },
    /// A conjunct that reads `field`, a scalar only the module can evaluate
    /// (`ty`), and that the module cannot take.
    OwnedField { conjunct: String, field: String, ty: String, why: OwnedUntaken },
    /// Two `==` that give one owned field two different literals.
    Contradiction { a: String, b: String, field: String, ty: String },
}

/// What a hop over an unbounded edge lacks.
#[derive(Debug, Clone, PartialEq)]
pub enum Unbounding {
    /// The hop has no WHERE.
    NoWhere,
    /// Its WHERE reads no bounding field.
    NoFilter,
    /// This conjunct reads a bounding field, by neither `==` nor `IN [ … ]`.
    Neither(String),
    /// This conjunct reads a bounding field by `==` or `IN`, compared with
    /// something other than literals.
    NotLiteral(String),
}

/// Why the module cannot take a conjunct that reads an owned field.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum OwnedUntaken {
    /// The field does not take the comparison, or the conjunct is no
    /// comparison of the field.
    Operator,
    /// The comparison is one the field takes, against a value that is not a
    /// literal.
    NotLiteral,
}

impl Untaken {
    pub fn code(&self) -> &'static str {
        match self {
            Untaken::Unbounded { .. } => codes::UNBOUNDED_EDGE,
            Untaken::OwnedField { .. } | Untaken::Contradiction { .. } => codes::FILTER_NOT_TAKEN,
        }
    }

    /// The diagnostic's message, for the hop over `edge` whose alias is `alias`.
    pub fn message(&self, edge: &EdgeView, alias: Option<&str>) -> String {
        let read = |field: &str| match alias {
            Some(alias) => format!("{}.{}", spell_name(alias), spell_name(field)),
            None => spell_name(field),
        };
        match self {
            Untaken::Unbounded { field, why } => {
                let fields = edge.bounded_by.iter().map(String::as_str).collect::<Vec<_>>().join(" or ");
                let lacks = match why {
                    Unbounding::NoWhere => "this hop has no WHERE".to_string(),
                    Unbounding::NoFilter => "this WHERE has no such filter".to_string(),
                    Unbounding::Neither(conjunct) => format!("this WHERE has no such filter: `{conjunct}` is neither"),
                    Unbounding::NotLiteral(conjunct) => format!("this WHERE has no such filter: `{conjunct}` does not compare it with a literal"),
                };
                let remedy = match (why, alias) {
                    (Unbounding::NoWhere, None) => {
                        let alias = suggested_alias(edge.name);
                        format!("`-[{alias}:{} WHERE {alias}.{} == \"…\"]->`", spell_name(edge.name), spell_name(field))
                    }
                    _ => format!("`{} == \"…\"`", read(field)),
                };
                format!("'-[:{}]->' is unbounded: {} can narrow it only by {fields} written `==` or `IN [ … ]` with literals, and {lacks}. Narrow it: {remedy}", edge.name, edge.module)
            }
            Untaken::OwnedField { conjunct, field, ty, why: OwnedUntaken::Operator } => format!(
                "`{conjunct}` reads '{field}', {} only {} can evaluate, and it can't take it here — write it as `{} == \"…\"` joined to the rest with AND",
                with_article(ty),
                edge.module,
                read(field)
            ),
            Untaken::OwnedField { conjunct, field, ty, why: OwnedUntaken::NotLiteral } => format!(
                "`{conjunct}` reads '{field}', {} only {} can evaluate, and {} takes it only compared with a literal — write the value as one: `{} == \"…\"`",
                with_article(ty),
                edge.module,
                edge.module,
                read(field)
            ),
            Untaken::Contradiction { a, b, field, ty } => format!("`{a}` and `{b}` give '{field}' two values, so nothing matches both — write one {ty}"),
        }
    }
}

/// An alias to write on a hop over `edge` that has none: the edge's first
/// letter, lower-cased.
fn suggested_alias(edge: &str) -> String {
    edge.chars().next().filter(char::is_ascii_alphabetic).map_or_else(|| "x".to_string(), |c| c.to_ascii_lowercase().to_string())
}

/// `filter`, the WHERE on a hop over `edge` landing on `target`, split.
///
/// - A conjunct is taken when it is pure and compares one field of the
///   landing with literals, by an operator that field takes, on an edge
///   whose module filters it (`native`). An `OR` of `==` on one field, or an
///   `IN`, is taken when the field takes `in`; an `OR` of `CONTAINS` on one
///   field when it takes `containsAny`. A conjunct that compares
///   with a value read off another record or a name the run holds is
///   checked on the host: what is taken is the same on every run.
/// - A conjunct reading an owned field must be taken, and two `==` giving
///   one owned field different literals are a contradiction.
/// - An unbounded edge needs a taken conjunct on a bounding field written
///   `==` or `IN [ … ]`.
pub fn split_where(filter: &Expression, alias: Option<&str>, edge: &EdgeView, target: &PositionSchema) -> Result<Split, Untaken> {
    let conjuncts = crate::types::event_address::conjuncts(filter);
    let filtered: Vec<Option<Filtered>> = conjuncts.iter().map(|c| filtered(c, edge, target)).collect();
    let is_taken = |f: &Option<Filtered>| f.as_ref().is_some_and(|f| f.literal);
    let bounding = |field: &str| edge.bounded_by.iter().any(|f| f == field);
    if !edge.bounded && !filtered.iter().flatten().any(|f| f.literal && f.narrows && bounding(&f.field)) {
        let unbounding = conjuncts.iter().zip(&filtered).find_map(|(c, f)| reads_fields(c, target).into_iter().find(|r| bounding(r)).map(|r| (*c, f, r)));
        return Err(match unbounding {
            Some((conjunct, f, field)) => {
                let conjunct = spell(conjunct, alias);
                let why = if f.as_ref().is_some_and(|f| f.narrows && f.field == field) { Unbounding::NotLiteral(conjunct) } else { Unbounding::Neither(conjunct) };
                Untaken::Unbounded { field, why }
            }
            None => Untaken::Unbounded { field: edge.bounded_by.first().cloned().unwrap_or_default(), why: Unbounding::NoFilter },
        });
    }
    for (conjunct, f) in conjuncts.iter().zip(&filtered) {
        if is_taken(f) {
            continue;
        }
        if let Some((field, ty)) = reads_fields(conjunct, target).into_iter().find_map(|f| owned_name(target, &f).map(|ty| (f, ty))) {
            let why = if f.is_some() { OwnedUntaken::NotLiteral } else { OwnedUntaken::Operator };
            return Err(Untaken::OwnedField { conjunct: spell(conjunct, alias), field, ty, why });
        }
    }
    let equalities: Vec<(&Expression, &Filtered)> =
        conjuncts.iter().zip(&filtered).filter_map(|(c, f)| f.as_ref().filter(|f| f.literal && f.equality.is_some()).map(|f| (*c, f))).collect();
    for (i, (a, first)) in equalities.iter().enumerate() {
        let Some(ty) = owned_name(target, &first.field) else { continue };
        let other = equalities[i + 1..].iter().find(|(_, second)| second.field == first.field && second.equality != first.equality);
        if let Some((b, _)) = other {
            return Err(Untaken::Contradiction { a: spell(a, alias), b: spell(b, alias), field: first.field.clone(), ty });
        }
    }
    let mut split = Split::default();
    for (conjunct, f) in conjuncts.into_iter().zip(&filtered) {
        if is_taken(f) { split.taken.push(conjunct.clone()) } else { split.checked.push(conjunct.clone()) }
    }
    Ok(split)
}

/// `split_where` for a hop that may have no WHERE: with none, nothing is
/// taken, and an unbounded edge is refused.
pub fn split_hop(filter: Option<&Expression>, alias: Option<&str>, edge: &EdgeView, target: &PositionSchema) -> Result<Split, Untaken> {
    match filter {
        Some(filter) => split_where(filter, alias, edge, target),
        None if !edge.bounded => Err(Untaken::Unbounded { field: edge.bounded_by.first().cloned().unwrap_or_default(), why: Unbounding::NoWhere }),
        None => Ok(Split::default()),
    }
}

/// A conjunct shaped as a filter the module takes: the landing's field it
/// filters, whether it narrows the field to listed values (`==`, `IN`, an
/// OR of `==`), whether every value it compares with is a literal (only
/// then is it taken), and, for a `==`, the value as written.
struct Filtered {
    field: String,
    narrows: bool,
    literal: bool,
    equality: Option<String>,
}

fn filtered(conjunct: &Expression, edge: &EdgeView, target: &PositionSchema) -> Option<Filtered> {
    if !edge.native() || !is_pure_predicate(conjunct) {
        return None;
    }
    let takes = |field: &str, op: &str| {
        target
            .property_capabilities
            .as_ref()
            .and_then(|caps| caps.get(field))
            .and_then(|c| c.filter_operators.as_ref())
            .is_some_and(|ops| ops.iter().any(|o| operator_name(*o) == op))
    };
    match conjunct {
        Expression::Logical { op: LogicalOp::Or, operands } => {
            let each: Vec<(String, FilterOperator, &Expression)> = operands.iter().map(|o| field_comparison(o, target)).collect::<Option<_>>()?;
            let (field, op, _) = each.first()?;
            // The OR is the field's comparison with any of the values: an
            // `IN` for `==`, a `containsAny` for `CONTAINS`.
            let any = match op {
                FilterOperator::Eq => "in",
                FilterOperator::Contains => "containsAny",
                _ => return None,
            };
            (each.iter().all(|(f, o, _)| f == field && o == op) && takes(field, any)).then(|| Filtered {
                field: field.clone(),
                narrows: *op == FilterOperator::Eq,
                literal: each.iter().all(|(_, _, v)| is_literal(v)),
                equality: None,
            })
        }
        Expression::Compare { op, left, right } => {
            let (field, value) = match (landing_field(left, target), landing_field(right, target)) {
                (Some(field), None) => (field, &**right),
                (None, Some(field)) if matches!(op, FilterOperator::Eq | FilterOperator::Neq) => (field, &**left),
                _ => return None,
            };
            if !reads_fields(value, target).is_empty() || !takes(field, filter_operator_name(*op)) {
                return None;
            }
            let literal = match op {
                FilterOperator::In => matches!(value, Expression::List { elements } if elements.iter().all(|e| matches!(e, ListElement::Expression(e) if is_literal(e)))),
                _ => is_literal(value),
            };
            let narrows = matches!(op, FilterOperator::Eq | FilterOperator::In);
            let equality = (*op == FilterOperator::Eq).then(|| spell(value, None));
            Some(Filtered { field: field.to_string(), narrows, literal, equality })
        }
        _ => None,
    }
}

/// `field == value` (either way round) or `field CONTAINS value`, the field
/// one of the landing's.
fn field_comparison<'e>(expr: &'e Expression, target: &PositionSchema) -> Option<(String, FilterOperator, &'e Expression)> {
    let Expression::Compare { op: op @ (FilterOperator::Eq | FilterOperator::Contains), left, right } = expr else { return None };
    let (field, value) = match (landing_field(left, target), landing_field(right, target)) {
        (Some(field), None) => (field, &**right),
        (None, Some(field)) if *op == FilterOperator::Eq => (field, &**left),
        _ => return None,
    };
    reads_fields(value, target).is_empty().then(|| (field.to_string(), *op, value))
}

/// A read of one of the landing's fields: an alias's (`t.Schedule`), or a
/// bare name the landing declares.
fn landing_field<'e>(expr: &'e Expression, target: &PositionSchema) -> Option<&'e str> {
    match expr {
        Expression::Property { property_type_id, field_only } | Expression::EdgeProperty { property_type_id, field_only }
            if *field_only || target.properties.contains_key(property_type_id) =>
        {
            Some(property_type_id)
        }
        _ => None,
    }
}

/// The landing's fields `expr` reads, in the order it reads them. A walk
/// inside it reads the records it walks to, and a read off another alias
/// (`a.Name`) reads that alias's record, not the landing.
fn reads_fields(expr: &Expression, target: &PositionSchema) -> Vec<String> {
    fn visit(expr: &Expression, target: &PositionSchema, out: &mut Vec<String>) {
        if let Some(field) = landing_field(expr, target) {
            if !out.iter().any(|f| f == field) {
                out.push(field.to_string());
            }
            return;
        }
        match expr {
            Expression::Traverse { alias_root, steps, .. } if !steps.is_empty() || alias_root.is_some() => {}
            Expression::Exists { .. } => {}
            _ => crate::families::values::sub_expressions(expr).into_iter().for_each(|e| visit(e, target, out)),
        }
    }
    let mut out = Vec::new();
    visit(expr, target, &mut out);
    out
}

/// The landing's fields `conjuncts` read that hold an owned scalar: only the
/// module can evaluate them, so a host handed a record the module did not
/// filter cannot judge them.
pub fn owned_fields(conjuncts: &[Expression], target: &PositionSchema) -> Vec<String> {
    let mut owned: Vec<String> = Vec::new();
    for field in conjuncts.iter().flat_map(|c| reads_fields(c, target)) {
        if owned_name(target, &field).is_some() && !owned.contains(&field) {
            owned.push(field);
        }
    }
    owned
}

/// The name of the owned scalar `field` holds, if it holds one.
fn owned_name(target: &PositionSchema, field: &str) -> Option<String> {
    fn of(ty: &FieldType) -> Option<&str> {
        use movement_parser::catalog::types::Composite;
        match ty {
            FieldType::Composite(Composite::Owned { name, .. }) => Some(name),
            FieldType::Composite(Composite::MaybeAbsent { of: inner } | Composite::List { of: inner, .. }) => of(inner),
            _ => None,
        }
    }
    of(target.properties.get(field)?).map(str::to_string)
}

fn is_literal(expr: &Expression) -> bool {
    matches!(expr, Expression::Static { value } if !matches!(value, StaticValue::Null))
}

fn operator_name(op: movement_parser::catalog::types::FilterOperator) -> &'static str {
    use movement_parser::catalog::types::FilterOperator as Op;
    match op {
        Op::Eq => "eq",
        Op::Neq => "neq",
        Op::Contains => "contains",
        Op::Gt => "gt",
        Op::Gte => "gte",
        Op::Lt => "lt",
        Op::Lte => "lte",
        Op::Exists => "exists",
        Op::In => "in",
        Op::Within => "within",
        Op::ContainsAny => "containsAny",
    }
}

fn filter_operator_name(op: FilterOperator) -> &'static str {
    match op {
        FilterOperator::Eq => "eq",
        FilterOperator::Neq => "neq",
        FilterOperator::Contains => "contains",
        FilterOperator::Gt => "gt",
        FilterOperator::Gte => "gte",
        FilterOperator::Lt => "lt",
        FilterOperator::Lte => "lte",
        FilterOperator::Exists => "exists",
        FilterOperator::In => "in",
        FilterOperator::Within => "within",
    }
}

/// `expr` as a WHERE writes it, a landing's field read off `alias`.
pub fn spell(expr: &Expression, alias: Option<&str>) -> String {
    let operand = |e: &Expression| match e {
        Expression::Logical { .. } => format!("({})", spell(e, alias)),
        _ => spell(e, alias),
    };
    match expr {
        Expression::Property { property_type_id, field_only } | Expression::EdgeProperty { property_type_id, field_only } => match (field_only, alias) {
            (true, Some(alias)) => format!("{}.{}", spell_name(alias), spell_name(property_type_id)),
            _ => spell_name(property_type_id),
        },
        Expression::Static { value } => match value {
            StaticValue::String(s) => serde_json::to_string(s).unwrap_or_default(),
            StaticValue::Number(n) => movement_parser::util::js::number_to_string(n.0),
            StaticValue::Bool(b) => b.to_string(),
            StaticValue::Null => "null".to_string(),
        },
        Expression::AliasRef { name } => spell_name(name),
        Expression::Traverse { alias_root: Some(root), steps, expression } if steps.is_empty() => {
            format!("{}.{}", spell_name(root), spell(expression, None))
        }
        Expression::List { elements } => {
            let items: Vec<String> = elements
                .iter()
                .map(|e| match e {
                    ListElement::Expression(e) => spell(e, alias),
                    ListElement::Spread(s) => format!("...{}", spell(&s.expression, alias)),
                })
                .collect();
            format!("[{}]", items.join(", "))
        }
        // A presence test is spelled as the program asks it: `exists(c.Previous)`.
        Expression::Compare { op: FilterOperator::Neq, left, right } if is_field_read(left) && matches!(**right, Expression::Static { value: StaticValue::Null }) => {
            format!("exists({})", spell(left, alias))
        }
        Expression::Compare { op, left, right } => {
            let word = match op {
                FilterOperator::Eq => "==",
                FilterOperator::Neq => "!=",
                FilterOperator::Contains => "CONTAINS",
                FilterOperator::Gt => ">",
                FilterOperator::Gte => ">=",
                FilterOperator::Lt => "<",
                FilterOperator::Lte => "<=",
                FilterOperator::Exists => "EXISTS",
                FilterOperator::In => "IN",
                FilterOperator::Within => "WITHIN",
            };
            format!("{} {word} {}", operand(left), operand(right))
        }
        Expression::Logical { op, operands } => {
            let word = match op {
                LogicalOp::And => " AND ",
                LogicalOp::Or => " OR ",
            };
            operands
                .iter()
                .map(|o| match o {
                    Expression::Logical { op: inner, .. } if inner != op => format!("({})", spell(o, alias)),
                    _ => spell(o, alias),
                })
                .collect::<Vec<_>>()
                .join(word)
        }
        Expression::Not { expression } => match &**expression {
            Expression::Compare { .. } if spell(expression, alias).starts_with("exists(") => format!("NOT {}", spell(expression, alias)),
            _ => format!("NOT ({})", spell(expression, alias)),
        },
        _ => "…".to_string(),
    }
}

/// A field read (`c.Previous`, `c.Current.Stage`), as `exists(…)` takes one.
fn is_field_read(expr: &Expression) -> bool {
    match expr {
        Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => {
            property_type_id != crate::types::narrowing::POSITION_SENTINEL
        }
        Expression::Traverse { alias_root: Some(_), steps, expression } if steps.is_empty() => is_field_read(expression),
        _ => false,
    }
}

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
    /// An unbounded edge with no taken filter on a bounding field. The
    /// `conjunct` is the one that reads a bounding field and is neither `==`
    /// nor `IN [ … ]` (empty when none reads one); `field` is the bounding
    /// field to narrow by.
    Unbounded { conjunct: String, field: String },
    /// A conjunct that reads `field`, a scalar only the module can evaluate
    /// (`ty`), and that the module cannot take.
    OwnedField { conjunct: String, field: String, ty: String },
    /// Two `==` that give one owned field two values.
    Contradiction { a: String, b: String, field: String, ty: String },
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
            Untaken::Unbounded { conjunct, field } => {
                let fields = edge.bounded_by.iter().map(String::as_str).collect::<Vec<_>>().join(" or ");
                let neither = if conjunct.is_empty() { String::new() } else { format!(": `{conjunct}` is neither") };
                format!(
                    "'-[:{}]->' is unbounded: {} can narrow it only by {fields} written `==` or `IN [ … ]` with literals, and this WHERE has no such filter{neither}. Narrow it: `{} == \"…\"`",
                    edge.name,
                    edge.module,
                    read(field)
                )
            }
            Untaken::OwnedField { conjunct, field, ty } => format!(
                "`{conjunct}` reads '{field}', a {ty} only {} can evaluate, and it can't take it here — write it as `{} == \"…\"` joined to the rest with AND",
                edge.module,
                read(field)
            ),
            Untaken::Contradiction { a, b, field, ty } => format!("`{a}` and `{b}` give '{field}' two values, so nothing matches both — write one {ty}"),
        }
    }
}

/// `filter`, the WHERE on a hop over `edge` landing on `target`, split.
///
/// - A conjunct is taken when it is pure and compares one field of the
///   landing, by an operator that field takes, on an edge whose module
///   filters it (`native`). An `OR` of `==` on one field, or an `IN`, is
///   taken when the field takes `in`.
/// - A conjunct reading an owned field must be taken, and two `==` on one
///   owned field are a contradiction.
/// - An unbounded edge needs a taken conjunct on a bounding field written
///   `==` or `IN [ … ]` with literals.
pub fn split_where(filter: &Expression, alias: Option<&str>, edge: &EdgeView, target: &PositionSchema) -> Result<Split, Untaken> {
    let conjuncts = crate::types::event_address::conjuncts(filter);
    let taken: Vec<Option<Taken>> = conjuncts.iter().map(|c| taken(c, edge, target)).collect();
    if !edge.bounded && !taken.iter().flatten().any(|t| t.bounds && edge.bounded_by.iter().any(|f| *f == t.field)) {
        let unbounding = conjuncts.iter().find_map(|c| reads_fields(c, target).into_iter().find(|f| edge.bounded_by.iter().any(|b| b == f)).map(|f| (*c, f)));
        let (conjunct, field) = match unbounding {
            Some((conjunct, field)) => (spell(conjunct, alias), field),
            None => (String::new(), edge.bounded_by.first().cloned().unwrap_or_default()),
        };
        return Err(Untaken::Unbounded { conjunct, field });
    }
    for (conjunct, taken) in conjuncts.iter().zip(&taken) {
        if taken.is_some() {
            continue;
        }
        if let Some((field, ty)) = reads_fields(conjunct, target).into_iter().find_map(|f| owned_name(target, &f).map(|ty| (f, ty))) {
            return Err(Untaken::OwnedField { conjunct: spell(conjunct, alias), field, ty });
        }
    }
    let equalities: Vec<(&Expression, &Taken)> = conjuncts.iter().zip(&taken).filter_map(|(c, t)| t.as_ref().filter(|t| t.equality.is_some()).map(|t| (*c, t))).collect();
    for (i, (a, first)) in equalities.iter().enumerate() {
        let Some(ty) = owned_name(target, &first.field) else { continue };
        let other = equalities[i + 1..].iter().find(|(_, second)| second.field == first.field && second.equality != first.equality);
        if let Some((b, _)) = other {
            return Err(Untaken::Contradiction { a: spell(a, alias), b: spell(b, alias), field: first.field.clone(), ty });
        }
    }
    let mut split = Split::default();
    for (conjunct, taken) in conjuncts.into_iter().zip(taken) {
        if taken.is_some() { split.taken.push(conjunct.clone()) } else { split.checked.push(conjunct.clone()) }
    }
    Ok(split)
}

/// `split_where` for a hop that may have no WHERE: with none, nothing is
/// taken, and an unbounded edge is refused.
pub fn split_hop(filter: Option<&Expression>, alias: Option<&str>, edge: &EdgeView, target: &PositionSchema) -> Result<Split, Untaken> {
    match filter {
        Some(filter) => split_where(filter, alias, edge, target),
        None if !edge.bounded => Err(Untaken::Unbounded { conjunct: String::new(), field: edge.bounded_by.first().cloned().unwrap_or_default() }),
        None => Ok(Split::default()),
    }
}

/// A conjunct the module takes: the landing's field it filters, whether it
/// bounds an unbounded edge (`==` or `IN [ … ]` with literals), and, for a
/// `==`, the value as written.
struct Taken {
    field: String,
    bounds: bool,
    equality: Option<String>,
}

fn taken(conjunct: &Expression, edge: &EdgeView, target: &PositionSchema) -> Option<Taken> {
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
            let equalities: Vec<(String, &Expression)> = operands.iter().map(|o| field_equality(o, target)).collect::<Option<_>>()?;
            let field = &equalities.first()?.0;
            (equalities.iter().all(|(f, _)| f == field) && takes(field, "in"))
                .then(|| Taken { field: field.clone(), bounds: equalities.iter().all(|(_, v)| is_literal(v)), equality: None })
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
            let bounds = match op {
                FilterOperator::Eq => is_literal(value),
                FilterOperator::In => matches!(value, Expression::List { elements } if elements.iter().all(|e| matches!(e, ListElement::Expression(e) if is_literal(e)))),
                _ => false,
            };
            let equality = (*op == FilterOperator::Eq).then(|| spell(value, None));
            Some(Taken { field: field.to_string(), bounds, equality })
        }
        _ => None,
    }
}

/// `field == value` (either way round), the field one of the landing's.
fn field_equality<'e>(expr: &'e Expression, target: &PositionSchema) -> Option<(String, &'e Expression)> {
    let Expression::Compare { op: FilterOperator::Eq, left, right } = expr else { return None };
    let (field, value) = match (landing_field(left, target), landing_field(right, target)) {
        (Some(field), None) => (field, &**right),
        (None, Some(field)) => (field, &**left),
        _ => return None,
    };
    reads_fields(value, target).is_empty().then(|| (field.to_string(), value))
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
/// inside it reads the records it walks to, not the landing.
fn reads_fields(expr: &Expression, target: &PositionSchema) -> Vec<String> {
    fn visit(expr: &Expression, target: &PositionSchema, out: &mut Vec<String>) {
        if let Some(field) = landing_field(expr, target) {
            if !out.iter().any(|f| f == field) {
                out.push(field.to_string());
            }
            return;
        }
        match expr {
            Expression::Traverse { steps, .. } if !steps.is_empty() => {}
            Expression::Exists { .. } => {}
            _ => crate::families::values::sub_expressions(expr).into_iter().for_each(|e| visit(e, target, out)),
        }
    }
    let mut out = Vec::new();
    visit(expr, target, &mut out);
    out
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
        Expression::Not { expression } => format!("NOT ({})", spell(expression, alias)),
        _ => "…".to_string(),
    }
}

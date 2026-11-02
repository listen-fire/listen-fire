//! One sample of every `Expression` variant, and of each shape nested inside
//! one, written as the JSON the checker puts on its answer. The samples are
//! committed beside the listen-arrivals cases
//! (packages/engine-contracts/conformance/expression-samples.json) and the
//! TypeScript host parses every one through its expression schema, so a shape
//! the Rust side can emit but the schema refuses fails a test instead of
//! failing a program's whole check at run time.
//!
//! A new `Expression` variant fails to compile here until `kind_of`, `Kind`
//! and `sample` name it; then re-bless the file:
//!
//!   LF_BLESS=1 cargo test -p listen-fire-parser --test expression_wire_samples

use indexmap::IndexMap;
use movement_parser::lowering::expression::{
    AggregationFunction, ArithmeticOp, Cardinality, CardinalityMode, EdgeDirection, EdgeStep, EnrichWithEntry, Expression, FilterOperator, ListElement, ListSpread, LogicalOp, MetaEdgeKind, MetaEdgeStep, MetaSetting,
    ObjectMember, OrderDirection, ResourceCardinality, ResourceFilter, ResourceStep, StaticValue, TraversalStep,
};
use movement_parser::tree::JsNumber;
use serde_json::{Value, json};

macro_rules! kinds {
    ($($kind:ident),* $(,)?) => {
        #[derive(Clone, Copy, Debug)]
        enum Kind { $($kind),* }
        const ALL: &[Kind] = &[$(Kind::$kind),*];
    };
}

kinds!(
    Property, EdgeProperty, Static, Llm, Meta, ParentResult, ActionResult, Resource, LinkedObject, ExtractValue, AliasRef, List, Object, Traverse, ResourceTraverse, Exists, Arithmetic, Compare, Logical, Not, Negate,
    Concat, Conditional, At, Aggregate, Function, KgExists, KgValue,
);

/// Exhaustive on purpose: no wildcard, so a variant added to `Expression`
/// does not compile until it has a `Kind`, and `sample` a sample for it.
fn kind_of(expression: &Expression) -> Kind {
    match expression {
        Expression::Property { .. } => Kind::Property,
        Expression::EdgeProperty { .. } => Kind::EdgeProperty,
        Expression::Static { .. } => Kind::Static,
        Expression::Llm { .. } => Kind::Llm,
        Expression::Meta { .. } => Kind::Meta,
        Expression::ParentResult { .. } => Kind::ParentResult,
        Expression::ActionResult { .. } => Kind::ActionResult,
        Expression::Resource { .. } => Kind::Resource,
        Expression::LinkedObject { .. } => Kind::LinkedObject,
        Expression::ExtractValue { .. } => Kind::ExtractValue,
        Expression::AliasRef { .. } => Kind::AliasRef,
        Expression::List { .. } => Kind::List,
        Expression::Object { .. } => Kind::Object,
        Expression::Traverse { .. } => Kind::Traverse,
        Expression::ResourceTraverse { .. } => Kind::ResourceTraverse,
        Expression::Exists { .. } => Kind::Exists,
        Expression::Arithmetic { .. } => Kind::Arithmetic,
        Expression::Compare { .. } => Kind::Compare,
        Expression::Logical { .. } => Kind::Logical,
        Expression::Not { .. } => Kind::Not,
        Expression::Negate { .. } => Kind::Negate,
        Expression::Concat { .. } => Kind::Concat,
        Expression::Conditional { .. } => Kind::Conditional,
        Expression::At { .. } => Kind::At,
        Expression::Aggregate { .. } => Kind::Aggregate,
        Expression::Function { .. } => Kind::Function,
        Expression::KgExists { .. } => Kind::KgExists,
        Expression::KgValue { .. } => Kind::KgValue,
    }
}

fn field(name: &str) -> Expression {
    Expression::EdgeProperty { property_type_id: name.into(), field_only: true }
}

fn text(value: &str) -> Expression {
    Expression::static_text(value)
}

fn boxed(expression: Expression) -> Box<Expression> {
    Box::new(expression)
}

fn edge_step() -> EdgeStep {
    EdgeStep {
        edge_type_id: "Messages".into(),
        direction: EdgeDirection::Outgoing,
        alias: Some("m".into()),
        cardinality: Some(Cardinality { mode: CardinalityMode::N, limit: Some(JsNumber(3.0)), order_by: Some(boxed(field("Posted At"))), order_direction: Some(OrderDirection::Desc) }),
        filter: None,
        expression_filter: Some(boxed(Expression::Compare { op: FilterOperator::Eq, left: boxed(field("Topic")), right: boxed(text("lunch")) })),
    }
}

fn resource_filter() -> ResourceFilter {
    ResourceFilter { resource_type: Some("URL".into()), has_document: Some(true), mime_type: Some("text/html".into()), name_pattern: Some("^a".into()) }
}

/// Every traversal step: an edge with its cardinality and filter, a link
/// back, a resource, and a meta edge with each of its settings.
fn steps() -> Vec<TraversalStep> {
    let mut config = IndexMap::new();
    config.insert("description", MetaSetting::Expression(text("what to take")));
    config.insert("data", MetaSetting::Expressions(vec![field("Name")]));
    config.insert("plugin", MetaSetting::Expression(text("p")));
    config.insert("enrichWith", MetaSetting::EnrichWith(vec![EnrichWithEntry { transform: text("t"), argument: field("Name") }]));
    config.insert("extra", MetaSetting::Extra(IndexMap::from([("k".to_string(), text("v"))])));
    vec![
        TraversalStep::Edge(edge_step()),
        TraversalStep::LinkBack {},
        TraversalStep::Resource(ResourceStep { filter: Some(resource_filter()), cardinality: Some(ResourceCardinality { mode: CardinalityMode::First, limit: Some(JsNumber(1.0)) }) }),
        TraversalStep::MetaEdge(MetaEdgeStep {
            meta_edge: MetaEdgeKind::Extract,
            alias: Some("x".into()),
            config: Some(config),
            expression_filter: Some(boxed(field("Name"))),
            filter: Some(resource_filter()),
        }),
    ]
}

/// A sample of `kind`, filling every optional member the variant has.
fn sample(kind: Kind) -> Expression {
    match kind {
        Kind::Property => Expression::Property { property_type_id: "Name".into(), field_only: true },
        Kind::EdgeProperty => field("Name"),
        Kind::Static => Expression::Static { value: StaticValue::Number(JsNumber(1.5)) },
        Kind::Llm => Expression::Llm { prompt: "summarise".into(), prompt_expression: Some(boxed(field("Body"))), tier: Some("fast".into()) },
        Kind::Meta => Expression::Meta { key: "now".into() },
        Kind::ParentResult => Expression::ParentResult { field: "created".into() },
        Kind::ActionResult => Expression::ActionResult { node_id: "n1".into(), field: "external_id".into() },
        Kind::Resource => Expression::Resource { field: "url".into() },
        Kind::LinkedObject => Expression::LinkedObject { adapter: "chat".into(), field: "Id".into() },
        Kind::ExtractValue => Expression::ExtractValue { description: "the total".into() },
        Kind::AliasRef => Expression::AliasRef { name: "m".into() },
        Kind::List => Expression::List { elements: vec![ListElement::Expression(text("a")), ListElement::Spread(ListSpread { expression: boxed(field("Tags")) })] },
        Kind::Object => Expression::Object {
            entries: vec![ObjectMember::Entry { key: "k".into(), value: text("v") }, ObjectMember::Spread(ListSpread { expression: boxed(field("Extra")) })],
        },
        Kind::Traverse => Expression::Traverse { alias_root: Some("m".into()), steps: steps(), expression: boxed(field("Topic")), optional: false },
        Kind::ResourceTraverse => Expression::ResourceTraverse { filter: Some(resource_filter()), expression_filter: Some(boxed(field("Name"))), expression: boxed(field("Name")) },
        Kind::Exists => Expression::Exists { steps: steps(), where_: Some(boxed(field("Name"))) },
        Kind::Arithmetic => Expression::Arithmetic { op: ArithmeticOp::Add, left: boxed(field("A")), right: boxed(field("B")) },
        Kind::Compare => Expression::Compare { op: FilterOperator::Within, left: boxed(field("At")), right: boxed(text("3d")) },
        Kind::Logical => Expression::Logical { op: LogicalOp::Or, operands: vec![field("A"), field("B")] },
        Kind::Not => Expression::Not { expression: boxed(field("Done")) },
        Kind::Negate => Expression::Negate { expression: boxed(field("Score")) },
        Kind::Concat => Expression::Concat { parts: vec![text("a"), field("B")] },
        Kind::Conditional => Expression::Conditional { condition: boxed(field("A")), then: boxed(text("y")), else_: boxed(text("n")) },
        Kind::At => Expression::At { expression: boxed(field("Items")), index: boxed(Expression::Static { value: StaticValue::Number(JsNumber(0.0)) }) },
        Kind::Aggregate => Expression::Aggregate {
            fn_: AggregationFunction::Join,
            expression: boxed(field("Name")),
            separator: Some(", ".into()),
            prompt: Some("p".into()),
            order_by: Some(boxed(field("Name"))),
            order_direction: Some(OrderDirection::Asc),
            written: None,
        },
        Kind::Function => Expression::Function { fn_: "lower".into(), args: vec![field("Name")] },
        Kind::KgExists => Expression::KgExists { query: "q".into(), params: vec![field("Name")] },
        Kind::KgValue => Expression::KgValue { query: "q".into(), params: vec![field("Name")] },
    }
}

/// The aggregation functions and operators the enums name, each in an
/// expression of its own: a schema that lists them must list every one.
fn variants_of_the_enums() -> Vec<(String, Expression)> {
    let aggregates = [
        AggregationFunction::First,
        AggregationFunction::Last,
        AggregationFunction::Only,
        AggregationFunction::Count,
        AggregationFunction::Sum,
        AggregationFunction::Avg,
        AggregationFunction::Min,
        AggregationFunction::Max,
        AggregationFunction::Join,
        AggregationFunction::Collect,
        AggregationFunction::Sort,
        AggregationFunction::Llm,
    ];
    let operators = [
        FilterOperator::Eq,
        FilterOperator::Neq,
        FilterOperator::Contains,
        FilterOperator::Gt,
        FilterOperator::Gte,
        FilterOperator::Lt,
        FilterOperator::Lte,
        FilterOperator::Exists,
        FilterOperator::In,
        FilterOperator::Within,
    ];
    let arithmetic = [ArithmeticOp::Add, ArithmeticOp::Sub, ArithmeticOp::Mul, ArithmeticOp::Div, ArithmeticOp::Rem];
    let mut out = Vec::new();
    for fn_ in aggregates {
        let expression = Expression::Aggregate { fn_, expression: boxed(field("Name")), separator: None, prompt: None, order_by: None, order_direction: None, written: None };
        out.push((format!("aggregate {}", fn_.id()), expression));
    }
    for op in operators {
        let name = serde_json::to_value(op).unwrap();
        out.push((format!("compare {}", name.as_str().unwrap()), Expression::Compare { op, left: boxed(field("A")), right: boxed(field("B")) }));
    }
    for op in arithmetic {
        let name = serde_json::to_value(op).unwrap();
        out.push((format!("arithmetic {}", name.as_str().unwrap()), Expression::Arithmetic { op, left: boxed(field("A")), right: boxed(field("B")) }));
    }
    for value in [StaticValue::String("s".into()), StaticValue::Number(JsNumber(-2.0)), StaticValue::Bool(false), StaticValue::Null] {
        out.push((format!("static {}", serde_json::to_string(&value).unwrap()), Expression::Static { value }));
    }
    out
}

fn samples() -> Value {
    let mut out = serde_json::Map::new();
    for &kind in ALL {
        let expression = sample(kind);
        assert_eq!(format!("{:?}", kind_of(&expression)), format!("{kind:?}"), "a sample of {kind:?} is another kind");
        out.insert(format!("{kind:?}"), serde_json::to_value(&expression).unwrap());
    }
    for (name, expression) in variants_of_the_enums() {
        out.insert(name, serde_json::to_value(&expression).unwrap());
    }
    json!({
        "about": "One sample of every Expression variant, and of each member shape nested in one, as the checker writes them (crates/movement-parser/tests/expression_wire_samples.rs, LF_BLESS=1 to rewrite). The TypeScript expression schema parses every one.",
        "samples": Value::Object(out),
    })
}

fn path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/engine-contracts/conformance/expression-samples.json")
}

#[test]
fn the_committed_samples_are_what_every_expression_variant_writes() {
    let text = serde_json::to_string_pretty(&samples()).unwrap() + "\n";
    if std::env::var_os("LF_BLESS").is_some() {
        std::fs::write(path(), &text).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(path()).expect("expression-samples.json is missing: bless it with LF_BLESS=1");
    assert_eq!(committed, text, "the samples differ from the committed file: re-bless if the change is intended");
}

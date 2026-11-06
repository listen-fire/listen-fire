//! What is at a landing, as a value: the one description every tool reads
//! (plans/graph-description-2026-11-06/DESIGN.md). Nothing here prints. Each
//! tool chooses how much to ask for and writes the value out its own way; what
//! a field's marks are, what an edge can do and what a write along it takes
//! are decided here, once.
//!
//! A landing needs no program: `connection_root` stands on a schema alone, and
//! each edge's `landing` is where to describe next.

use std::rc::Rc;

use indexmap::IndexMap;
use movement_parser::catalog::types::{EdgeSchema, InstanceSchema, PositionSchema, WritableRootSchema};
use movement_parser::catalog::written_type::WrittenType;

use crate::types::field::{Ty, written_type};
use crate::types::position::{
    EdgeLanding, HandlePosition, Instance, InstanceRef, Position, UnionPosition, describe_position, display_name_of, edge_landing_describing, lookup_property_type,
    position_schema_of_ref, record_field_types, with_write_typed, write_shape_of, write_typed_past,
};

/// How much of a landing a caller wants. The default is all of it.
#[derive(Debug, Clone, Copy, Default)]
pub struct Showing {
    /// At most this many fields per list: required first, then identifying.
    pub fields: Option<usize>,
    /// At most this many options per enum, the rest counted.
    pub enum_options: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct Description {
    /// The module's own words for what lands here.
    pub description: Option<String>,
    pub known: Known,
    /// What it may be, where it is one of several types. Its fields and edges
    /// are the ones every member has; each member is described on its own.
    pub members: Vec<String>,
    pub fields: FieldList,
    pub edges: Vec<DescribedEdge>,
}

/// Whether the fields and edges listed are all there are.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Known {
    #[default]
    Whole,
    /// Its module has fields no description names.
    Open,
    /// Nothing has looked at it: an empty list says nothing about it.
    Undescribed,
}

/// Fields in the order a first write needs them: required, then identifying,
/// then the rest, each in the schema's order.
#[derive(Debug, Clone, Default)]
pub struct FieldList {
    pub shown: Vec<DescribedField>,
    /// How many `Showing::fields` left out.
    pub cut: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DescribedField {
    pub name: String,
    /// As a program writes it (`WrittenType`).
    pub type_: String,
    pub marks: Vec<Mark>,
    /// A read's WHERE must set it with `==`.
    pub pinned: bool,
    /// On a type that can be read, a field it can only write.
    pub write_only: bool,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    /// A write must give it.
    Required,
    /// It identifies the record: a `unique by` candidate.
    Identifying,
    /// A write of the type cannot give it.
    ReadOnly,
}

impl Mark {
    pub fn glyph(self) -> char {
        match self {
            Mark::Required => '!',
            Mark::Identifying => '*',
            Mark::ReadOnly => '~',
        }
    }
}

#[derive(Debug, Clone)]
pub struct DescribedEdge {
    pub name: String,
    pub description: Option<String>,
    pub can: EdgeCan,
    /// The name of the type it lands on, as its module shows it; none where
    /// the edge's members land apart.
    pub target: Option<String>,
    /// Where it lands, to describe in turn; none where nothing describes that.
    pub landing: Option<Position>,
    /// What a write along it takes, where one can be written.
    pub write_fields: Option<FieldList>,
}

/// What a program can do along an edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeCan {
    pub read: bool,
    pub write: bool,
    pub fires: bool,
}

/// A connection's own root, from its schema alone.
pub fn connection_root(name: impl Into<String>, schema: Rc<InstanceSchema>) -> Position {
    Position::Meta { instance: Rc::new(Instance { name: name.into(), schema, declared: None, adapter: None, address: None }) }
}

/// Each record type a connection's schema holds, by the name its module shows,
/// with where to describe it. A type nothing has looked at has nothing to say.
pub fn described_record_types(connection: &Position) -> Vec<(String, Position)> {
    let Position::Meta { instance } = connection else { return Vec::new() };
    instance.schema.positions.iter().filter(|(_, schema)| schema.undescribed != Some(true)).map(|(name, _)| (display_name_of(instance, name), Position::record(instance.clone(), name))).collect()
}

/// What is at `landing`.
pub fn describe_landing(landing: &Position, showing: Showing) -> Description {
    Asked { read_as: landing, showing }.at(landing)
}

/// One description being built.
struct Asked<'a> {
    /// The landing as asked for: a landing that may be empty reads each field
    /// as maybe absent, whatever it may hold.
    read_as: &'a Position,
    showing: Showing,
}

impl Asked<'_> {
    fn at(&self, at: &Position) -> Description {
        match at {
            Position::MaybeEmpty(of) => self.at(of),
            Position::Meta { instance } => Description {
                edges: instance
                    .schema
                    .collections
                    .iter()
                    .map(|(name, collection)| {
                        let can = EdgeCan { read: collection.readable != Some(false), write: instance.schema.writable_roots.contains_key(&collection.target), fires: collection.listenable == Some(true) };
                        self.edge(at, name, EdgeFacts { can, target: &collection.target, description: collection.description.as_deref(), instance: Some(instance) })
                    })
                    .collect(),
                ..Description::default()
            },
            Position::Position(record) => self.record_type(at, &record.instance, &record.position),
            Position::Handle(HandlePosition { instance, position: Some(name), .. }) => self.record_type(at, instance, name),
            Position::Handle(handle) if !handle.written => self.write_shape(at, handle),
            Position::Handle(handle) => self.written_handle(at, handle),
            Position::Union(union) => self.union(at, union),
            Position::OneOf(members) => self.one_of(at, members),
            Position::Extract { node, .. } => Description {
                known: if node.declared { Known::Undescribed } else { Known::Whole },
                fields: self.read_fields(),
                edges: node.children.keys().map(|name| self.edge(at, name, EdgeFacts { can: EdgeCan { read: true, write: false, fires: false }, target: name, description: None, instance: None })).collect(),
                ..Description::default()
            },
            Position::Local(local) => Description {
                fields: self.read_fields(),
                edges: local
                    .edges
                    .iter()
                    .flat_map(|edges| edges.iter())
                    .map(|(name, edge)| self.edge(at, name, EdgeFacts { can: edge_can(&edge.schema), target: &edge.schema.target, description: edge.schema.description.as_deref(), instance: None }))
                    .collect(),
                ..Description::default()
            },
            Position::Closure(_) => Description::default(),
        }
    }

    /// A record type: what it declares, and what a write of it takes.
    fn record_type(&self, at: &Position, instance: &InstanceRef, type_name: &str) -> Description {
        let schema = position_schema_of_ref(at);
        let schema = schema.as_deref();
        let shape = write_shape_of_member(&instance.schema, type_name);
        let reads = self.reads();
        let mut fields: Vec<DescribedField> = reads
            .iter()
            .map(|(name, ty)| DescribedField {
                marks: marks_of(name, shape, true),
                pinned: schema.is_some_and(|s| s.pinned_properties.iter().flatten().any(|pinned| pinned == name)),
                description: doc_of(name, schema, shape),
                ..self.plain_field(name, ty.as_ref())
            })
            .collect();
        fields.extend(self.written_fields(shape).into_iter().filter(|field| !reads.contains_key(&field.name)).map(|field| DescribedField { description: doc_of(&field.name, schema, shape), write_only: true, ..field }));
        Description {
            description: schema.and_then(|s| s.description.clone()),
            known: known_of(schema),
            fields: self.list(fields),
            edges: schema
                .into_iter()
                .flat_map(|s| s.edges.iter())
                .map(|(name, edge)| self.edge(at, name, EdgeFacts { can: edge_can(edge), target: &edge.target, description: edge.description.as_deref(), instance: Some(instance) }))
                .collect(),
            ..Description::default()
        }
    }

    /// A type known only by what is written to it: its write fields, and the
    /// words its module gave it, kept on the root edge that reaches it since
    /// it has no position to keep them on.
    fn write_shape(&self, at: &Position, handle: &HandlePosition) -> Description {
        let shape = write_shape_of(&handle.instance.schema, &handle.written_type);
        let root_edge = handle.instance.schema.collections.values().find(|collection| collection.target == handle.written_type);
        Description {
            description: root_edge.and_then(|collection| collection.description.clone()),
            fields: self.list(self.written_fields(shape)),
            edges: self.handle_edges(at, handle),
            ..Description::default()
        }
    }

    /// A write's own handle on such a type: what it reads back.
    fn written_handle(&self, at: &Position, handle: &HandlePosition) -> Description {
        let shape = write_shape_of(&handle.instance.schema, &handle.written_type);
        let fields = self.reads().iter().map(|(name, ty)| DescribedField { marks: marks_of(name, shape, true), description: doc_of(name, None, shape), ..self.plain_field(name, ty.as_ref()) }).collect();
        Description { fields: self.list(fields), edges: self.handle_edges(at, handle), ..Description::default() }
    }

    fn handle_edges(&self, at: &Position, handle: &HandlePosition) -> Vec<DescribedEdge> {
        handle
            .edges
            .iter()
            .flat_map(|edges| edges.iter())
            .map(|(name, edge)| self.edge(at, name, EdgeFacts { can: edge_can(edge), target: &edge.target, description: edge.description.as_deref(), instance: Some(&handle.instance) }))
            .collect()
    }

    /// One of a type's named members: what every member has.
    fn union(&self, at: &Position, union: &UnionPosition) -> Description {
        let schemas: Vec<&PositionSchema> = union.variants.iter().filter_map(|variant| union.instance.schema.positions.get(variant)).collect();
        let members = union.variants.iter().map(|variant| display_name_of(&union.instance, variant)).collect();
        let Some((first, rest)) = schemas.split_first() else {
            return Description { members, ..Description::default() };
        };
        let fields = first
            .properties
            .keys()
            .filter_map(|name| {
                let ty = lookup_property_type(Some(at), name)?;
                let description = schemas.iter().find_map(|schema| schema.field_docs.as_ref()?.get(name).cloned());
                Some(DescribedField { description, ..self.plain_field(name, Some(&ty)) })
            })
            .collect();
        let edges = first
            .edges
            .iter()
            .filter(|(name, _)| rest.iter().all(|schema| schema.edges.contains_key(*name)))
            .map(|(name, edge)| {
                let each: Vec<&EdgeSchema> = schemas.iter().filter_map(|schema| schema.edges.get(name)).collect();
                let can = EdgeCan { read: each.iter().all(|e| e.readable != Some(false)), write: each.iter().all(|e| e.writable == Some(true)), fires: each.iter().all(|e| e.listenable == Some(true)) };
                let described = self.edge(at, name, EdgeFacts { can, target: &edge.target, description: edge.description.as_deref(), instance: Some(&union.instance) });
                DescribedEdge { target: described.target.filter(|_| each.iter().all(|e| e.target == edge.target)), ..described }
            })
            .collect();
        Description { members, fields: self.list(fields), edges, ..Description::default() }
    }

    /// One of several records of different types: what every one of them has.
    fn one_of(&self, at: &Position, members: &[Position]) -> Description {
        let each: Vec<Description> = members.iter().map(|member| describe_landing(member, self.showing)).collect();
        let edges = each.first().into_iter().flat_map(|first| first.edges.iter()).filter(|edge| each.iter().all(|d| d.edges.iter().any(|e| e.name == edge.name))).map(|edge| DescribedEdge {
            target: None,
            landing: landing_of_edge(at, &edge.name),
            ..edge.clone()
        });
        Description { members: members.iter().map(landing_name).collect(), fields: self.read_fields(), edges: edges.collect(), ..Description::default() }
    }

    fn edge(&self, from: &Position, name: &str, facts: EdgeFacts<'_>) -> DescribedEdge {
        let EdgeFacts { can, target, description, instance } = facts;
        let shape = instance.filter(|_| can.write).and_then(|instance| write_shape_of(&instance.schema, target));
        DescribedEdge {
            name: name.to_string(),
            description: description.map(str::to_string),
            can,
            target: Some(instance.map_or_else(|| target.to_string(), |instance| shown_type(instance, target))),
            landing: landing_of_edge(from, name),
            write_fields: shape.map(|shape| self.list(self.written_fields(Some(shape)))),
        }
    }

    /// A write shape's fields, as a write gives them.
    fn written_fields(&self, shape: Option<&WritableRootSchema>) -> Vec<DescribedField> {
        let Some(shape) = shape else { return Vec::new() };
        shape
            .fields
            .iter()
            .map(|(name, type_)| DescribedField {
                name: name.clone(),
                type_: WrittenType::from(type_).spell_showing(self.showing.enum_options),
                marks: marks_of(name, Some(shape), false),
                pinned: false,
                write_only: false,
                description: doc_of(name, None, Some(shape)),
            })
            .collect()
    }

    fn reads(&self) -> IndexMap<String, Option<Ty>> {
        record_field_types(self.read_as).unwrap_or_default()
    }

    fn read_fields(&self) -> FieldList {
        self.list(self.reads().iter().map(|(name, ty)| self.plain_field(name, ty.as_ref())).collect())
    }

    fn plain_field(&self, name: &str, ty: Option<&Ty>) -> DescribedField {
        let type_ = ty.map_or(WrittenType::Unknown, written_type).spell_showing(self.showing.enum_options);
        DescribedField { name: name.to_string(), type_, marks: Vec::new(), pinned: false, write_only: false, description: None }
    }

    fn list(&self, mut fields: Vec<DescribedField>) -> FieldList {
        fields.sort_by_key(|field| match (field.marks.contains(&Mark::Required), field.marks.contains(&Mark::Identifying)) {
            (true, _) => 0,
            (false, true) => 1,
            (false, false) => 2,
        });
        let shown = self.showing.fields.unwrap_or(fields.len()).min(fields.len());
        let cut = fields.len() - shown;
        fields.truncate(shown);
        FieldList { shown: fields, cut }
    }
}

/// A landing, by its type's name as its module shows it.
pub fn landing_name(landing: &Position) -> String {
    match landing {
        Position::Position(record) => display_name_of(&record.instance, &record.position),
        Position::Handle(handle) => handle.position.as_deref().map_or_else(|| handle.written_type.clone(), |name| display_name_of(&handle.instance, name)),
        Position::MaybeEmpty(of) => landing_name(of),
        Position::Meta { .. } | Position::Union(_) | Position::Extract { .. } | Position::Closure(_) | Position::Local(_) | Position::OneOf(_) => describe_position(landing),
    }
}

fn edge_can(edge: &EdgeSchema) -> EdgeCan {
    EdgeCan { read: edge.readable != Some(false), write: edge.writable == Some(true), fires: edge.listenable == Some(true) }
}

/// What an edge's own schema says, for any of the kinds of edge there are.
struct EdgeFacts<'a> {
    can: EdgeCan,
    target: &'a str,
    description: Option<&'a str>,
    /// The schema its write shape is in; none off a node a run builds.
    instance: Option<&'a InstanceRef>,
}

fn landing_of_edge(from: &Position, name: &str) -> Option<Position> {
    match edge_landing_describing(from, name) {
        EdgeLanding::Landed { landing, .. } => Some(with_write_typed(landing, write_typed_past(from, name))),
        EdgeLanding::Untyped { .. } | EdgeLanding::Unknown { .. } | EdgeLanding::SomeVariants { .. } | EdgeLanding::Unreachable | EdgeLanding::NotTraversable => None,
    }
}

/// A type's name as its module shows it: a union's key is no author's word.
fn shown_type(instance: &Instance, target: &str) -> String {
    match instance.schema.union_display_names.as_ref().and_then(|names| names.get(target)) {
        Some(shown) => shown.clone(),
        None => display_name_of(instance, target),
    }
}

/// The write shape a record type's marks come from. A member of a type told
/// apart by a field (`discriminated`) is written through that type's shape.
fn write_shape_of_member<'s>(schema: &'s InstanceSchema, type_name: &str) -> Option<&'s WritableRootSchema> {
    write_shape_of(schema, type_name).or_else(|| {
        schema
            .writable_roots
            .values()
            .chain(schema.create_shapes.iter().flat_map(|shapes| shapes.values()))
            .filter_map(|shape| shape.discriminated.as_ref())
            .flat_map(|discriminated| discriminated.variants.values())
            .find(|variant| variant.position.as_deref() == Some(type_name))
    })
}

/// A field's marks by its type's write shape, the rule the authoring tools
/// have used: required by `requiredFields`, identifying by a place in
/// `nativeUniqueness`, read only where a type with a shape has it not among the fields it writes.
fn marks_of(name: &str, shape: Option<&WritableRootSchema>, read: bool) -> Vec<Mark> {
    let Some(shape) = shape else { return Vec::new() };
    let required = shape.required_fields.iter().flatten().any(|field| field == name);
    let identifying = shape.native_uniqueness.iter().flatten().flatten().any(|field| field == name);
    let read_only = read && !shape.fields.contains_key(name);
    [(required, Mark::Required), (identifying, Mark::Identifying), (read_only, Mark::ReadOnly)].into_iter().filter(|(holds, _)| *holds).map(|(_, mark)| mark).collect()
}

fn doc_of(name: &str, schema: Option<&PositionSchema>, shape: Option<&WritableRootSchema>) -> Option<String> {
    schema.and_then(|s| s.field_docs.as_ref()?.get(name).cloned()).or_else(|| shape?.field_docs.as_ref()?.get(name).cloned())
}

fn known_of(schema: Option<&PositionSchema>) -> Known {
    match schema {
        Some(schema) if schema.undescribed == Some(true) => Known::Undescribed,
        Some(schema) if schema.open_properties == Some(true) => Known::Open,
        Some(_) => Known::Whole,
        None => Known::Undescribed,
    }
}

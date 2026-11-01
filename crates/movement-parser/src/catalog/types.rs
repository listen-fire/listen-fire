//! The catalog's data: the schema types of packages/movement-lang/checker/
//! catalog.ts and the snapshot of service/snapshot.ts, field for field, as
//! the JSON the TypeScript writes them. Absent optionals are omitted, never
//! null. A field the TypeScript does not declare is refused when read: the
//! TypeScript passes such a field through, and dropping it silently would be
//! an answer the two sides disagree on without saying so.
//!
//! Every object keyed by data is a `JsMap`, in the order a JavaScript object
//! holds its keys: schema field order is observable (a diagnostic lists a
//! position's fields in it). Sorted output is only for hashing and
//! comparison (`crate::to_sorted_json`), never the data the checker reads.

use std::ops::{Deref, DerefMut};

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::tree::JsNumber;
use crate::util::js::object_key_order;

/// How deep catalog JSON may nest. The typed read tries a field type's
/// variants one by one at every level, which costs far more stack per level
/// than a `Value`'s read: about 1,800 levels of `list of` exhausted Node's
/// stack in the WASM (measured 2026-10-07). Real catalog data is a dozen
/// levels deep.
pub const MAX_CATALOG_DEPTH: usize = 256;

/// Catalog data from its text, its nesting bounded by `MAX_CATALOG_DEPTH`.
pub fn read_catalog<'a, T: Deserialize<'a>>(json: &'a str) -> Result<T, String> {
    crate::util::json::from_json_within(json, MAX_CATALOG_DEPTH)
}

/// An object keyed by data, in JavaScript's key order: array-index keys
/// first, ascending, then the rest as written — the order `JSON.parse` gives
/// the TypeScript and every `Object.keys`/`Object.entries` over it sees.
#[derive(Debug, Clone, PartialEq)]
pub struct JsMap<V>(pub IndexMap<String, V>);

impl<V> Default for JsMap<V> {
    fn default() -> Self {
        JsMap(IndexMap::new())
    }
}

impl<V> Deref for JsMap<V> {
    type Target = IndexMap<String, V>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<V> DerefMut for JsMap<V> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl<V> FromIterator<(String, V)> for JsMap<V> {
    fn from_iter<I: IntoIterator<Item = (String, V)>>(iter: I) -> Self {
        let mut map = IndexMap::new();
        for (k, v) in iter {
            map.insert(k, v);
        }
        object_key_order(&mut map);
        JsMap(map)
    }
}

impl<V: Serialize> Serialize for JsMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for JsMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let mut map = IndexMap::<String, V>::deserialize(deserializer)?;
        object_key_order(&mut map);
        Ok(JsMap(map))
    }
}

// ── Field value types ──

/// `FieldType`: a bare name, or a tagged collection. One type serves
/// `SchemaFieldType` too — the same JSON, minus the members only the
/// checker's typing builds (a union, a record, a tuple's rest, a dict's
/// shape); `is_schema` says whether a value is one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FieldType {
    Scalar(Scalar),
    Composite(Composite),
}

pub type SchemaFieldType = FieldType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scalar {
    Text,
    Number,
    Boolean,
    Date,
    Datetime,
    File,
    Json,
    Absent,
    /// What a value that never arrives has (`fail("…")` inside an
    /// expression): TypeScript's `never`.
    Never,
}

impl Scalar {
    pub fn name(self) -> &'static str {
        match self {
            Scalar::Text => "text",
            Scalar::Number => "number",
            Scalar::Boolean => "boolean",
            Scalar::Date => "date",
            Scalar::Datetime => "datetime",
            Scalar::File => "file",
            Scalar::Json => "json",
            Scalar::Absent => "absent",
            Scalar::Never => "never",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Composite {
    List {
        of: Box<FieldType>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unordered: Option<bool>,
    },
    Tuple {
        of: Vec<Option<FieldType>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rest: Option<TupleRest>,
    },
    Dict {
        of: Box<FieldType>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shape: Option<JsMap<Option<FieldType>>>,
    },
    Enum {
        options: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        open: Option<OpenEnum>,
    },
    MaybeAbsent {
        of: Box<FieldType>,
    },
    Union {
        of: Vec<FieldType>,
    },
    /// A named scalar its owner (the module that declared it) parses: a
    /// cron schedule, a mailbox key. `allow_pattern` is the least an owner
    /// says of its values.
    Owned {
        name: String,
        owner: String,
        #[serde(rename = "allowPattern", default, skip_serializing_if = "Option::is_none")]
        allow_pattern: Option<String>,
    },
    /// A record held as the field's value, read on with `.`
    /// (`c.Current.Stage`) and never fetched: a reference to a record is an
    /// edge, not this. `position` is which record (the typing layer's
    /// `PositionTypeRef`); absent, a record nobody can name.
    Record {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        position: Option<PositionRef>,
    },
}

/// Which record a `record` field holds: the typing layer's
/// `PositionTypeRef` as a schema states it. The instance is the one whose
/// schema declares the field, so it is not spelled; a typing layer that
/// carries more of it (its instance, a display) is read for these members.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PositionRef {
    /// The instance itself, whose edges are its collections: no record a
    /// schema's field holds, carried from a typing layer.
    Meta {},
    /// One record type of the instance.
    Position { position: String },
    /// One of several (`unions`).
    Union { union: String },
}

impl PositionRef {
    /// The name the instance's schema knows it by.
    pub fn name(&self) -> Option<&str> {
        match self {
            PositionRef::Meta {} => None,
            PositionRef::Position { position } => Some(position),
            PositionRef::Union { union } => Some(union),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TupleRest {
    pub at: JsNumber,
    pub of: Option<Box<FieldType>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenEnum {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_pattern: Option<String>,
}

impl FieldType {
    /// Whether an adapter surface could declare this (`SchemaFieldType`).
    pub fn is_schema(&self) -> bool {
        match self {
            FieldType::Scalar(_) => true,
            FieldType::Composite(c) => match c {
                Composite::List { of, .. } | Composite::MaybeAbsent { of } => of.is_schema(),
                Composite::Dict { of, shape } => shape.is_none() && of.is_schema(),
                Composite::Tuple { of, rest } => rest.is_none() && of.iter().flatten().all(FieldType::is_schema),
                Composite::Enum { .. } | Composite::Owned { .. } => true,
                Composite::Record { position } => position.as_ref().and_then(PositionRef::name).is_some(),
                Composite::Union { .. } => false,
            },
        }
    }
}

// ── Capabilities (packages/movement-lang/expression/types.ts) ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushMode {
    Bounded,
    Native,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Asc,
    Desc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NaturalOrder {
    pub field: String,
    pub direction: Direction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeCapability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<PushMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<PushMode>,
    pub supports_limit: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natural_order: Option<NaturalOrder>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilterOperator {
    Eq,
    Neq,
    Contains,
    Gt,
    Gte,
    Lt,
    Lte,
    Exists,
    In,
    Within,
    /// An OR of `CONTAINS` on the field, taken together: a record that
    /// contains any of the values.
    #[serde(rename = "containsAny")]
    ContainsAny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldCapability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter_operators: Option<Vec<FilterOperator>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orderable: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeSequencing {
    Chronological,
    Document,
    Arrival,
}

// ── Per-instance schema ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OnNonLiteral {
    Error,
    Warn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenericOver {
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_non_literal: Option<OnNonLiteral>,
}

/// One field of an edge's landing typed by a write's literals: `at` is the
/// field, reached from the landing by edge names and then the field's own
/// name (`["Actions", "Value"]`); `from` is where the write holds the
/// literals (`Buttons[].Value`: each `Buttons` entry's `Value`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiteralsFrom {
    pub at: Vec<String>,
    pub from: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeSchema {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub polymorphic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<EdgeCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequenced: Option<EdgeSequencing>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ephemeral: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linkable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_live_record: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<bool>,
    /// The module announces arrivals on the edge: it can be listened to and
    /// awaited. Whether it can also be listed is `readable`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listenable: Option<bool>,
    /// Whether the module can list the arrivals since a mark it hands out;
    /// without one, an arrival announced while nobody listened is lost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<bool>,
    /// The landing's field that names an arrival, so a repeat is dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    /// The landing's field that changes when an arrival changes; without
    /// one, only a new member counts as an arrival.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Absent means bounded: the edge holds what one record has. `false`:
    /// it spans more than any listen should range over (every schedule,
    /// every team's mail), and only a filter on `bounded_by` narrows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounded: Option<bool>,
    /// The landing's fields whose `==` or `IN [literals]` make an unbounded
    /// edge bounded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounded_by: Option<Vec<String>>,
    /// How its arrivals reach the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<Delivery>,
    /// How often a polled edge is polled, by default: lf.yaml's `pollEvery`
    /// overrides it per connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_every_seconds: Option<u64>,
    /// The earlier hops' edges whose records an arrival carries, outermost
    /// first: a filter on one of them is judged on the arrival.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub carries: Option<Vec<String>>,
    /// An edge delivered per scope whose subscription is made per record an
    /// earlier hop, this edge named, landed on, not per record it hangs off
    /// (Airtable's `Changes`, one data webhook per base: `Bases`). Each
    /// arrival still names the record it is under, and a listen keeps only
    /// those under its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scoped_by: Option<String>,
    /// An arrival names the record it is about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributes: Option<bool>,
    /// Each arrival is sent to an address its sender chose (mail's
    /// plus-suffix), so one that no listen's WHERE takes is a misdirected
    /// message the host says so at its default level; on any other edge
    /// that is said only under `LF_LOG=debug`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addressed: Option<bool>,
    /// Listing it is cheap enough to re-list on a schedule (a base's
    /// tables; never every message in a workspace), so a filter on it as an
    /// earlier hop can be re-resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cheap_to_list: Option<bool>,
    /// The module reports when one of its members is created, renamed or
    /// removed, so a listen re-resolves on the report and never on a clock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_changes: Option<ParentChanges>,
    /// How often, in seconds, its members are re-listed by default when the
    /// module does not report their changes: lf.yaml's `resolveEvery`
    /// overrides it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relist_every_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generic_over: Option<GenericOver>,
    /// Fields of what lands here that take the literals the write this edge
    /// hangs off wrote at a path: each such field is an enum of exactly them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub literals_from: Option<Vec<LiteralsFrom>>,
    /// The field of the write this edge hangs off that names a node declared
    /// in the program: what lands here has that node's fields too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_shape_from: Option<String>,
    /// The system's resources edge (the describe's reserved `_resources`
    /// reference, the knowledge graph's `Resources`): walked by its name, sent
    /// to the adapter by the reserved field id (kg.ts `surfaceReadAdapter`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<bool>,
    /// What the adapter says the edge is, in its own words (a reference's
    /// `description`); the language service's hover leads with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PositionSchema {
    pub properties: JsMap<SchemaFieldType>,
    pub edges: JsMap<EdgeSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub property_capabilities: Option<JsMap<FieldCapability>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open_properties: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undescribed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_only_properties: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ambiguous_properties: Option<Vec<String>>,
    /// Fields a read of this type must pin in its WHERE with `==` (its
    /// describe's `pinned: true`): the source takes them as the read's
    /// arguments, so a read that leaves one out has nothing to ask
    /// (MOV_HOP_PIN_REQUIRED).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_properties: Option<Vec<String>>,
    /// The system removes a record of this type (its describe's
    /// `deletable: true`); the checker refuses a
    /// `delete` of a type that does not say so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletable: Option<bool>,
    /// What the adapter says a record of this type is (its describe's or
    /// entry point's `description`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// What the adapter says each field is, by name: every field it
    /// described, readable or write-only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_docs: Option<JsMap<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscriminatedWriteShape {
    pub discriminant: String,
    pub variants: JsMap<WritableRootSchema>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteUnionVariant {
    pub name: String,
    pub fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WriteUnionShape {
    pub variants: Vec<WriteUnionVariant>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RequiredEdge {
    pub edge: String,
    pub from: String,
}

/// `fuzzyResolution`: `true`, or the fields fuzzy resolution may match on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FuzzyResolution {
    All(bool),
    Fields(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WritableRootSchema {
    pub fields: JsMap<SchemaFieldType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discriminated: Option<DiscriminatedWriteShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_union: Option<WriteUnionShape>,
    pub result_shape: JsMap<SchemaFieldType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_uniqueness: Option<Vec<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_edges: Option<Vec<RequiredEdge>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edges: Option<JsMap<EdgeSchema>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_fields: Option<Vec<String>>,
    /// The writable fields' descriptions only, which the TypeScript checker
    /// reads; this checker reads the position's (`PositionSchema::field_docs`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_docs: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fuzzy_resolution: Option<FuzzyResolution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uniqueness_authorable: Option<bool>,
}

/// How a listenable edge's arrivals reach the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Delivery {
    /// Pushed to the connection: one subscription serves every listen on it.
    Connection,
    /// Pushed per scope: one subscription per watched parent (a table).
    Scope,
    /// Polled, every `poll_every_seconds` unless lf.yaml says otherwise.
    Polled,
}

/// How a listen learns that a hop's members changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParentChanges {
    /// The module reports each change.
    Pushed,
}

/// A root collection: an edge off the instance itself, declared by an entry
/// point. It says what an edge says of being listed and listened to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollectionSchema {
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability: Option<EdgeCapability>,
    /// Absent: it can be listed. `false`: it is only written to or
    /// listened to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listenable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Absent means bounded: the edge holds what one record has. `false`:
    /// it spans more than any listen should range over (every schedule,
    /// every team's mail), and only a filter on `bounded_by` narrows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounded: Option<bool>,
    /// The landing's fields whose `==` or `IN [literals]` make an unbounded
    /// edge bounded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounded_by: Option<Vec<String>>,
    /// How its arrivals reach the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<Delivery>,
    /// How often a polled edge is polled, by default: lf.yaml's `pollEvery`
    /// overrides it per connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_every_seconds: Option<u64>,
    /// The earlier hops' edges whose records an arrival carries, outermost
    /// first: a filter on one of them is judged on the arrival.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub carries: Option<Vec<String>>,
    /// An edge delivered per scope whose subscription is made per record an
    /// earlier hop, this edge named, landed on, not per record it hangs off
    /// (Airtable's `Changes`, one data webhook per base: `Bases`). Each
    /// arrival still names the record it is under, and a listen keeps only
    /// those under its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scoped_by: Option<String>,
    /// An arrival names the record it is about.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attributes: Option<bool>,
    /// Each arrival is sent to an address its sender chose (mail's
    /// plus-suffix), so one that no listen's WHERE takes is a misdirected
    /// message the host says so at its default level; on any other edge
    /// that is said only under `LF_LOG=debug`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addressed: Option<bool>,
    /// Listing it is cheap enough to re-list on a schedule (a base's
    /// tables; never every message in a workspace), so a filter on it as an
    /// earlier hop can be re-resolved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cheap_to_list: Option<bool>,
    /// The module reports when one of its members is created, renamed or
    /// removed, so a listen re-resolves on the report and never on a clock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_changes: Option<ParentChanges>,
    /// How often, in seconds, its members are re-listed by default when the
    /// module does not report their changes: lf.yaml's `resolveEvery`
    /// overrides it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relist_every_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventPosition {
    pub position: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceSchema {
    pub positions: JsMap<PositionSchema>,
    pub collections: JsMap<CollectionSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unions: Option<JsMap<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub union_display_names: Option<JsMap<String>>,
    /// Absent reads as no writable roots, as the TypeScript reads it (schemas
    /// written by hand for adapters that are only read, such as slack's).
    #[serde(default)]
    pub writable_roots: JsMap<WritableRootSchema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_shapes: Option<JsMap<WritableRootSchema>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_in_place_update: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edges_carry_properties: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refinements: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_members: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrow_by: Option<JsMap<Vec<String>>>,
    /// A hop's WHERE the host evaluated over a type's members and that
    /// selected none of them, under the same key as `refinements`: the
    /// members there are, by name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unselected: Option<JsMap<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generic_landings: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_position: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_positions: Option<Vec<EventPosition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_narrowing_keys: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_narrowing_values: Option<JsMap<JsMap<Vec<String>>>>,
}

// ── Adapters, credentials, plugins ──

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArgKind {
    Credential,
    Position,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConstructionArg {
    pub name: String,
    pub kind: ArgKind,
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options_from_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectAction {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriggerConfigFormat {
    Cron,
    Timezone,
    Fields,
    Strings,
    /// A node the program declares (`payload: <Payment>`): the listen's
    /// events are of that type.
    Type,
    /// One field of the record the listen watches, by name (`keyof T`).
    Field,
    /// A value of the field the listen's `field`-format key names (`T[K]`).
    #[serde(rename = "field-value")]
    FieldValue,
    /// A format a newer module declares and this release does not know. Its
    /// key's value is a plain, unchecked value: a module release must never
    /// break a host on an older core.
    #[serde(untagged)]
    Unknown(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Connect {
    Oauth,
    KeyEntry,
    Intrinsic,
    Handshake,
    AppOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SchemaShape {
    Static,
    Introspected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdapterSpec {
    pub construction_args: Vec<ConstructionArg>,
    /// The credentials a module declares, by name (`AdapterSpec.declaredCredentials`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_credentials: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_fire: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config_options: Option<JsMap<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_events: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config_required: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config_required_why: Option<JsMap<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_config_formats: Option<JsMap<TriggerConfigFormat>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect_actions: Option<Vec<ConnectAction>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connect: Option<Connect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger_expectation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_shape: Option<SchemaShape>,
    /// What the adapter says it is (its manifest's `description`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// How long, by default, a provider may re-send an arrival it already
    /// sent (Stripe: three days): a repeat inside it is dropped by identity.
    /// lf.yaml overrides it per connection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resend_window_seconds: Option<u64>,
    /// What a 0.12 settings listen on this module becomes as a traversal
    /// (`listenSettingsBecome`): the upgrade's rewrite of
    /// `listen to x { … }`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen_settings_become: Option<SettingsBecome>,
}

/// A module's mapping from its 0.12 listen settings to the traversal a
/// listen is in 0.13: the path from the connection to the edge its events
/// arrive on, and the hop and field each settings key narrows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsBecome {
    /// The edges from the connection's root to the listened edge.
    pub path: Vec<String>,
    /// One per hop: the alias its rewritten WHERE reads the hop's record by.
    pub aliases: Vec<String>,
    /// The 0.12 event position a fired parameter was typed as: a parameter
    /// naming it is retyped by the landing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub param_from: Option<String>,
    /// Each settings key, by name.
    pub keys: JsMap<KeyBecomes>,
    /// The mapping a listen naming one of these events in `events` becomes
    /// instead, when its module's events arrive on more than one edge (gmail's
    /// `label_added` lands on `Labelings`, not `Messages`); `events` is then
    /// spent choosing it. A listen naming events of two mappings has no
    /// rewrite: one listen per edge. One level deep: a mapping here has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_event: Option<JsMap<SettingsBecome>>,
    /// How the `field` and `becomes` keys of a module whose records hold
    /// their row before and after (`fieldChange`) compare those rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_change: Option<FieldChange>,
}

/// Two settings keys that compare a record's row before and after on one
/// hop (Airtable's `{ field: "Stage", becomes: "Interview" }`): the field
/// alone changed (`c.Current.Stage != c.Previous.Stage`); with a value, it
/// came to hold it (`c.Current.Stage == "Interview" AND c.Previous.Stage !=
/// "Interview"`). A value with no field compares nothing. The field is the
/// row's own, by name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldChange {
    /// The index into `path` of the hop whose records hold the rows.
    pub hop: usize,
    /// The settings key naming the field.
    pub field: String,
    /// The settings key naming the value the field came to hold.
    pub becomes: String,
    /// The record's field holding the row as the change left it.
    pub current: String,
    /// The record's field holding the row as it was before.
    pub previous: String,
}

/// What one settings key becomes: a comparison on a hop's field, or the
/// landing's declared type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyBecomes {
    /// The index into `path` of the hop it narrows.
    pub hop: usize,
    /// The field it compares (absent for `type`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub op: KeyOp,
    /// A settings value's spelling as a field value (`"record.created"` →
    /// `"created"`, or Slack's `"app_mention"` → `true` on a flag); absent,
    /// a value is the field's as written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub values: Option<JsMap<SpelledValue>>,
    /// What a 0.12 listen meant by leaving the key out, as a settings value
    /// (`""`: mail sent to the box itself; a list: the events it heard). The
    /// rewrite of a listen that omits the key compares it, so the traversal
    /// hears what the listen heard. Absent, omitting the key narrowed nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absent: Option<SettingsValue>,
    /// The field `absent` is compared on, when leaving the key out meant
    /// something about another field than the key's own (gmail's `labels`
    /// left out of a `label_added` listen meant its own labels:
    /// `Label Type == "user"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absent_field: Option<String>,
    /// 0.12 compared this key's values lowercased: the rewrite writes them
    /// lowercased, so `{ key: "Deals" }` still hears what it heard.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lowercase: Option<bool>,
}

/// What a settings value is spelled as on the field a key compares: a text,
/// or a flag (a boolean field).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SpelledValue {
    Text(String),
    Flag(bool),
}

/// A settings value as a 0.12 listen wrote it: one text, or a list of them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SettingsValue {
    One(String),
    Many(Vec<String>),
}

impl SettingsValue {
    /// Its texts, one or many.
    pub fn texts(&self) -> &[String] {
        match self {
            SettingsValue::One(text) => std::slice::from_ref(text),
            SettingsValue::Many(texts) => texts,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyOp {
    /// `field == value`.
    Eq,
    /// `field != value`.
    Neq,
    /// `field IN [values]`.
    In,
    /// `field CONTAINS value`, a member of a list field; several values are
    /// an OR of them (`labels: ["INBOX", "SPAM"]`).
    Contains,
    /// `payload: <T>`: the landing is typed `<T>`.
    Type,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CredentialSpec {
    pub adapters: Vec<String>,
    /// The module credential this one fills (`CredentialSpec.credential`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeclaredEffectRow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reads: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suspend: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginFedArg {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum PluginOutput {
    Value {
        #[serde(rename = "type")]
        type_: SchemaFieldType,
    },
    Record {
        fields: JsMap<SchemaFieldType>,
    },
    Records {
        fields: JsMap<SchemaFieldType>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginSpec {
    pub args: Vec<String>,
    /// Whether invoking it may cost money (`priced()`). Absent reads as
    /// unpriced, as the TypeScript reads it (specs written before plugins
    /// declared it), and stays absent when the spec is handed back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    priced: Option<bool>,
    /// What each argument takes, by name: the plugin's declared input types.
    /// The checker reads them; nothing here does yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arg_types: Option<JsMap<SchemaFieldType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub required_args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effects: Option<DeclaredEffectRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fed_by_extraction: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fed_args: Option<Vec<PluginFedArg>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<PluginOutput>,
    /// The package tag it is a member of (`@lf/web`), matched exactly
    /// (crate::catalog::packages); absent when it is in none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    /// The name a program spells it, when the catalog's key is not that: a
    /// plugin in a package is keyed by package and name (`plugin_key`), so two
    /// packages can each serve a `render`. Absent: the key is the name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// What the plugin does, in its author's words (its signature's `description`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl PluginSpec {
    /// Whether invoking it may cost money: the engine refuses to start a
    /// priced plugin once the run has spent its cost cap.
    pub fn priced(&self) -> bool {
        self.priced.unwrap_or(false)
    }
}

// ── The snapshot (service/snapshot.ts) ──

/// `AdapterSnapshot`: the spec, plus what only a snapshot carries. Read by
/// taking the snapshot's three members out and reading the rest as the spec,
/// which is how `fromCatalogSnapshot` answers `adapter(name)` — by
/// subtraction.
#[derive(Debug, Clone, PartialEq)]
pub struct AdapterSnapshot {
    pub spec: AdapterSpec,
    pub schemas: JsMap<InstanceSchema>,
    pub schema_notes: Option<JsMap<Vec<String>>>,
    pub construction_arg_options: Option<JsMap<JsMap<Vec<String>>>>,
}

impl<'de> Deserialize<'de> for AdapterSnapshot {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        use serde_json::value::RawValue;
        // Raw, so every member's maps keep the order the text has them in.
        let mut members = IndexMap::<String, Box<RawValue>>::deserialize(deserializer)?;
        fn read<T: serde::de::DeserializeOwned, E: Error>(raw: &RawValue) -> Result<T, E> {
            read_catalog(raw.get()).map_err(E::custom)
        }
        let schemas = members.shift_remove("schemas").ok_or_else(|| D::Error::missing_field("schemas"))?;
        let schema_notes = members.shift_remove("schemaNotes");
        let construction_arg_options = members.shift_remove("constructionArgOptions");
        let spec: Vec<String> = members
            .iter()
            .map(|(k, v)| format!("{}:{}", serde_json::to_string(k).expect("a key always serialises"), v.get()))
            .collect();
        Ok(AdapterSnapshot {
            schemas: read(&schemas)?,
            schema_notes: schema_notes.as_deref().map(read).transpose()?,
            construction_arg_options: construction_arg_options.as_deref().map(read).transpose()?,
            spec: read_catalog(&format!("{{{}}}", spec.join(","))).map_err(D::Error::custom)?,
        })
    }
}

/// A snapshot's credential: the multi-adapter form, or the legacy
/// single-adapter one. Each form refuses members it does not declare.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SnapshotCredential {
    Adapters(CredentialSpec),
    Adapter(LegacyCredential),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyCredential {
    pub adapter: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SnapshotFile {
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogSnapshot {
    /// The contract version the builder wrote it under
    /// (docs/contracts/catalog-snapshot.md); absent reads as 1.
    #[serde(default, rename = "contractVersion")]
    pub contract_version: Option<u32>,
    pub adapters: JsMap<AdapterSnapshot>,
    pub credentials: JsMap<SnapshotCredential>,
    pub plugins: JsMap<PluginSpec>,
    #[serde(default)]
    pub files: Option<JsMap<SnapshotFile>>,
    #[serde(default)]
    pub models: Option<Vec<String>>,
}

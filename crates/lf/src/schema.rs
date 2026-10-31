//! An adapter's introspection (`listEntryPoints()` entries plus one
//! `describe(typeId)` descriptor per entry) projected into the checker's
//! `InstanceSchema`: a port of movement-engine's
//! `translation_graph/movement/schema_projection.ts`
//! `instanceSchemaFromDescriptors`, member for member and in the TypeScript's
//! key order (the catalog reads several maps in text order). The why of each
//! rule is in the TypeScript; the comments here say only where a JavaScript
//! semantic is reproduced on purpose.

use std::collections::{HashMap, HashSet};

use indexmap::{IndexMap, IndexSet};
use movement_parser::catalog::helpers::{union_display, union_key, union_variants};

use crate::json::{Js, Obj};
use crate::obj;

/// The reserved resources reference (`RESOURCES_REFERENCE_FIELD_ID`).
const RESOURCES_REFERENCE_FIELD_ID: &str = "_resources";

pub struct ProjectionInput<'a> {
    pub adapter_type: &'a str,
    pub entries: &'a [Js],
    pub reached: &'a [Js],
    /// Descriptor per entry typeId, in the order they were set.
    pub descriptors: &'a IndexMap<String, Js>,
    pub meta_descriptor: Option<&'a Js>,
    pub supports_in_place_update: bool,
    pub edges_carry_properties: bool,
    pub all_entries: Option<&'a [Js]>,
    pub lazily_walked: bool,
}

pub struct Projection {
    pub schema: Js,
    /// What the projection left out and why. The hosted product reports
    /// these; listen-fire discards them.
    pub notes: Vec<String>,
}

/// `String(value)` for a value used as an object key.
fn key(value: Option<&Js>) -> String {
    match value {
        None => "undefined".into(),
        Some(Js::Null) => "null".into(),
        Some(Js::Bool(b)) => b.to_string(),
        Some(Js::Num(n)) => n.to_string(),
        Some(Js::Str(s)) => s.clone(),
        Some(other) => other.to_json(),
    }
}

/// JavaScript truthiness.
fn truthy(value: Option<&Js>) -> bool {
    match value {
        None | Some(Js::Null) | Some(Js::Bool(false)) => false,
        Some(Js::Num(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Js::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a ?? b`.
fn nullish_or<'a>(a: Option<&'a Js>, b: Option<&'a Js>) -> Option<&'a Js> {
    match a {
        None | Some(Js::Null) => b,
        some => some,
    }
}

fn items(value: Option<&Js>) -> &[Js] {
    value.and_then(Js::as_array).unwrap_or(&[])
}

/// `referenceTargetTypeIds`: one target, or several de-duplicated in order.
fn reference_target_type_ids(reference: &Js) -> Vec<String> {
    match reference.get("targetTypeIds") {
        None => vec![key(reference.get("targetTypeId"))],
        Some(ids) => items(Some(ids)).iter().map(|i| key(Some(i))).collect::<IndexSet<_>>().into_iter().collect(),
    }
}

fn is_artificial_edge(edge: &str) -> bool {
    edge.starts_with('@')
}

fn leave_out_artificial_edge(adapter_type: &str, edge: &str, notes: &mut Vec<String>) -> bool {
    if !is_artificial_edge(edge) {
        return false;
    }
    notes.push(format!(
        "{adapter_type}: the edge '{edge}' starts with '@', which is reserved for edges the engine makes (such as '@old') — it was left out; rename it in the source system to reach it"
    ));
    true
}

/// `fieldTypeFromDescriptor`: a field's type, or none for a reference (an
/// edge) or a kind with no projection. `owner` is the adapter, which owns
/// the scalars it names.
pub fn field_type_from_descriptor(field: &Js, owner: &str) -> Option<Js> {
    let scalar = match field.get("kind").and_then(Js::as_str) {
        Some("string") => {
            let known = items(field.get("knownValues"));
            if field.get("knownValues").is_some() && !known.is_empty() {
                let open = match field.get("knownValuePattern") {
                    Some(pattern) => obj! { "allowPattern" => pattern.clone() },
                    None => Obj::new(),
                };
                Js::from(obj! { "kind" => Js::str("enum"), "options" => Js::Arr(known.to_vec()), "open" => Js::from(open) })
            } else {
                Js::str("text")
            }
        }
        Some(kind @ ("number" | "boolean" | "date" | "file" | "json")) => Js::str(kind),
        Some("enum") => match field.get("enumValues") {
            None => Js::str("text"),
            Some(values) => Js::from(obj! { "kind" => Js::str("enum"), "options" => values.clone() }),
        },
        Some("owned") => {
            let owned = field.get("owned")?;
            let mut type_ = obj! { "kind" => Js::str("owned"), "name" => Js::str(owned.get("name").and_then(Js::as_str)?), "owner" => Js::str(owner) };
            if let Some(pattern) = owned.get("allowPattern") {
                type_.insert("allowPattern".into(), pattern.clone());
            }
            Js::from(type_)
        }
        _ => return None,
    };
    Some(if field.get("cardinality").and_then(Js::as_str) == Some("many") {
        Js::from(obj! { "kind" => Js::str("list"), "of" => scalar })
    } else {
        scalar
    })
}

fn project_native_uniqueness(
    constraints: Option<&Js>,
    surface_field_by_internal_id: &HashMap<String, String>,
    edge_surface_by_field_id: &HashMap<String, String>,
    parent_edges: Option<&IndexSet<String>>,
    label: &str,
    notes: &mut Vec<String>,
) -> Vec<Vec<String>> {
    let mut projected = Vec::new();
    for branch in items(constraints.and_then(|c| c.get("any"))) {
        let all = items(branch.get("all"));
        if all.is_empty() {
            continue;
        }
        let mut group = Vec::new();
        let mut mappable = true;
        for entry in all {
            let field = key(entry.get("field"));
            if let Some(surface) = surface_field_by_internal_id.get(&field) {
                group.push(surface.clone());
            } else if let Some(edge) = edge_surface_by_field_id.get(&field) {
                group.push(edge.clone());
            } else if parent_edges.is_some_and(|p| p.contains(&field)) {
                group.push(field);
            } else {
                mappable = false;
                break;
            }
        }
        if mappable {
            projected.push(group);
        } else {
            let named = all.iter().map(|e| key(e.get("field"))).collect::<Vec<_>>().join(", ");
            notes.push(format!(
                "{label}: a native uniqueness rule references '{named}' — not all of it maps to surface names, so the rule is omitted from the declared nativeUniqueness"
            ));
        }
    }
    projected
}

fn project_fuzzy_resolution(declared: Option<&Js>, surface_field_by_internal_id: &HashMap<String, String>, label: &str, notes: &mut Vec<String>) -> Option<Js> {
    match declared {
        None | Some(Js::Bool(false)) => None,
        Some(Js::Bool(true)) => Some(Js::Bool(true)),
        Some(list) => {
            let mut fields: Vec<String> = Vec::new();
            for field_id in items(Some(list)) {
                let field_id = key(Some(field_id));
                match surface_field_by_internal_id.get(&field_id) {
                    None => notes.push(format!("{label}: fuzzy resolution names '{field_id}', which is not one of its fields — omitted")),
                    Some(surface) if !fields.contains(surface) => fields.push(surface.clone()),
                    Some(_) => {}
                }
            }
            (!fields.is_empty()).then(|| Js::strings(fields))
        }
    }
}

fn project_write_union(declaration: &Js, write_field_name_by_id: &HashMap<String, String>, label: &str, notes: &mut Vec<String>) -> Js {
    let variants = items(declaration.get("variants"))
        .iter()
        .map(|variant| {
            let variant_name = key(variant.get("name"));
            let mut fields = Vec::new();
            for field_id in items(variant.get("fields")) {
                let field_id = key(Some(field_id));
                match write_field_name_by_id.get(&field_id) {
                    Some(name) => fields.push(name.clone()),
                    None => notes.push(format!(
                        "{label}: write variant '{variant_name}' names field '{field_id}', which did not project onto the write surface — the variant is projected without it"
                    )),
                }
            }
            let mut out = Obj::new();
            if let Some(name) = variant.get("name") {
                out.insert("name".into(), name.clone());
            }
            out.insert("fields".into(), Js::strings(fields));
            Js::from(out)
        })
        .collect();
    Js::from(obj! { "variants" => Js::Arr(variants) })
}

/// `{ ...a, ...b }` over two objects.
fn spread(a: Option<&Js>, b: Option<&Js>) -> Js {
    let mut out = Obj::new();
    for source in [a, b].into_iter().flatten() {
        if let Js::Obj(map) = source {
            for (k, v) in map {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    Js::from(out)
}

/// `mergeVariantShape`: the variant type's write shape merged onto the base's.
fn merge_variant_shape(base: &Obj, variant: Option<&Obj>) -> Obj {
    let mut rest = base.clone();
    rest.shift_remove("discriminated");
    let Some(variant) = variant else { return rest };
    let mut required: IndexSet<String> = IndexSet::new();
    for source in [base.get("requiredFields"), variant.get("requiredFields")] {
        for f in items(source) {
            required.insert(key(Some(f)));
        }
    }
    rest.insert("fields".into(), spread(base.get("fields"), variant.get("fields")));
    rest.insert("resultShape".into(), spread(base.get("resultShape"), variant.get("resultShape")));
    if !required.is_empty() {
        rest.insert("requiredFields".into(), Js::strings(required));
    }
    if base.get("edges").is_some() || variant.get("edges").is_some() {
        rest.insert("edges".into(), spread(base.get("edges"), variant.get("edges")));
    }
    if base.get("fieldDocs").is_some() || variant.get("fieldDocs").is_some() {
        rest.insert("fieldDocs".into(), spread(base.get("fieldDocs"), variant.get("fieldDocs")));
    }
    if let Some(write_union) = variant.get("writeUnion") {
        rest.insert("writeUnion".into(), write_union.clone());
    }
    rest
}

/// The flags an edge carries over from its reference: (reference member,
/// projected only when it is `true`).
const EDGE_TRUE_FLAGS: &[&str] = &["ephemeral"];

/// What a reference or a listenable entry says of its arrivals and of being
/// listed under a listen, passed through as declared, in this order.
const LISTENING: [&str; 12] =
    ["cursor", "identity", "version", "bounded", "boundedBy", "delivery", "pollEverySeconds", "carries", "attributes", "cheapToList", "parentChanges", "relistEverySeconds"];

fn pass_listening(declared: &Js, onto: &mut Obj) {
    for passed in LISTENING {
        if let Some(value) = declared.get(passed) {
            onto.insert(passed.into(), value.clone());
        }
    }
}

pub fn instance_schema_from_descriptors(input: &ProjectionInput) -> Projection {
    let mut notes = Vec::new();
    let adapter_type = input.adapter_type;
    let meta_entries = input.all_entries.unwrap_or(input.entries);
    let all_entries: Vec<&Js> = meta_entries.iter().chain(input.reached).collect();
    let meta_edge_type_ids: HashSet<String> = meta_entries.iter().map(|e| key(e.get("typeId"))).collect();
    let display_of = |type_id: &str| -> Option<String> {
        all_entries.iter().find(|e| key(e.get("typeId")) == type_id).map(|e| key(e.get("displayName")))
    };
    let target_names_of = |reference: &Js| -> Vec<String> {
        reference_target_type_ids(reference)
            .into_iter()
            .map(|type_id| display_of(&type_id).unwrap_or(type_id))
            .collect::<IndexSet<_>>()
            .into_iter()
            .collect()
    };

    let mut edge_target_names: IndexSet<String> = IndexSet::new();
    let mut incoming_edge_names: HashMap<String, IndexSet<String>> = HashMap::new();
    for descriptor in input.descriptors.values() {
        for reference in items(descriptor.get("references")) {
            for name in target_names_of(reference) {
                edge_target_names.insert(name.clone());
                incoming_edge_names.entry(name).or_default().insert(key(nullish_or(reference.get("name"), reference.get("fieldId"))));
            }
        }
    }

    let mut positions = Obj::new();
    let mut collections = Obj::new();
    let mut root_capabilities: IndexMap<String, Js> = IndexMap::new();
    for reference in items(input.meta_descriptor.and_then(|m| m.get("references"))) {
        if let Some(capability) = reference.get("capability") {
            root_capabilities.insert(key(nullish_or(reference.get("name"), reference.get("fieldId"))), capability.clone());
        }
    }
    let mut unions = Obj::new();
    let mut union_display_names = Obj::new();
    // Shapes by name; `writableRoots` and `createShapes` name them and are
    // materialised at the end, since the TypeScript's registries alias the
    // shape objects a discriminated write later extends.
    let mut shape_by_name: IndexMap<String, Obj> = IndexMap::new();
    let mut writable_roots: Vec<String> = Vec::new();
    let mut writable_targets: IndexSet<String> = IndexSet::new();
    let mut type_id_by_name: HashMap<String, String> = HashMap::new();

    for entry in input.entries.iter().chain(input.reached) {
        let name = key(entry.get("displayName"));
        let type_id = key(entry.get("typeId"));
        if let Some(claimed_by) = type_id_by_name.get(&name) {
            if *claimed_by != type_id {
                notes.push(format!(
                    "{adapter_type}: more than one type is named '{name}' — keeping the first; rename one in the source system to address the other"
                ));
            }
            continue;
        }
        type_id_by_name.insert(name.clone(), type_id.clone());

        let readable = truthy(entry.get("readable"));
        let listenable = Js::is_true(entry.get("listenable"));
        if meta_edge_type_ids.contains(&type_id) && (readable || truthy(entry.get("writable")) || listenable) {
            let collection_name = nullish_or(entry.get("collectionName"), None).map(|c| key(Some(c))).unwrap_or_else(|| name.clone());
            if !leave_out_artificial_edge(adapter_type, &collection_name, &mut notes) {
                let mut collection = obj! { "target" => Js::str(&name) };
                // The root descriptor's word on the collection, else the
                // entry's own: a host that asks no root descriptor (listen-fire)
                // reads it there.
                if let Some(capability) = root_capabilities.get(&collection_name).or(entry.get("capability")) {
                    collection.insert("capability".into(), capability.clone());
                }
                if !readable {
                    collection.insert("readable".into(), Js::Bool(false));
                }
                if listenable {
                    collection.insert("listenable".into(), Js::Bool(true));
                }
                pass_listening(entry, &mut collection);
                collections.insert(collection_name, Js::from(collection));
            }
        }

        let positioned = readable || listenable || Js::is_true(entry.get("fires")) || edge_target_names.contains(&name);
        let Some(descriptor) = input.descriptors.get(&type_id) else {
            if positioned {
                positions.insert(name, undescribed());
            }
            continue;
        };

        let mut properties = Obj::new();
        let mut property_capabilities = Obj::new();
        let mut writable_fields = Obj::new();
        let mut write_only_properties: Vec<String> = Vec::new();
        let mut ambiguous_properties: Vec<String> = Vec::new();
        let mut pinned_properties: Vec<String> = Vec::new();
        let mut required_fields: Vec<String> = Vec::new();
        let mut field_docs = Obj::new();
        let mut position_field_docs = Obj::new();
        let mut write_field_name_by_id: HashMap<String, String> = HashMap::new();
        let mut dropped_field = false;
        let fields = items(descriptor.get("fields"));
        for field in fields {
            let Some(type_) = field_type_from_descriptor(field, adapter_type) else {
                if field.get("kind").and_then(Js::as_str) != Some("reference") {
                    dropped_field = true;
                }
                continue;
            };
            let field_name = key(field.get("displayName"));
            if properties.contains_key(&field_name) || write_only_properties.contains(&field_name) {
                if !ambiguous_properties.contains(&field_name) {
                    ambiguous_properties.push(field_name.clone());
                }
                notes.push(format!("{adapter_type}: '{name}' has more than one field named '{field_name}' — reads resolve to the first"));
                continue;
            }
            let description = described(field);
            if let Some(description) = &description {
                position_field_docs.insert(field_name.clone(), Js::str(description));
            }
            if Js::is_true(field.get("pinned")) {
                pinned_properties.push(field_name.clone());
            }
            if Js::is_false(field.get("readable")) {
                write_only_properties.push(field_name.clone());
            } else {
                properties.insert(field_name.clone(), type_.clone());
                if let Some(capability) = field.get("capability") {
                    property_capabilities.insert(field_name.clone(), capability.clone());
                }
            }
            if truthy(field.get("writable")) {
                writable_fields.insert(field_name.clone(), type_);
                write_field_name_by_id.insert(key(field.get("fieldId")), field_name.clone());
                if Js::is_true(field.get("required")) {
                    required_fields.push(field_name.clone());
                }
                if let Some(description) = description {
                    field_docs.insert(field_name.clone(), Js::str(description));
                }
            }
        }

        let mut edges = Obj::new();
        let mut edge_surface_by_field_id: HashMap<String, String> = HashMap::new();
        let mut required_edges: Vec<Js> = Vec::new();
        for reference in items(descriptor.get("references")) {
            let edge = key(nullish_or(reference.get("name"), reference.get("fieldId")));
            if leave_out_artificial_edge(adapter_type, &edge, &mut notes) {
                continue;
            }
            let field_id = key(reference.get("fieldId"));
            let target_names = target_names_of(reference);
            let polymorphic = target_names.len() > 1;
            let target = if polymorphic { Some(union_key(&target_names)) } else { target_names.first().cloned() };
            if polymorphic && let Some(target) = &target {
                unions.insert(target.clone(), Js::strings(union_variants(&target_names)));
                union_display_names.insert(target.clone(), Js::str(union_display(&target_names)));
            }
            let unpublished: Vec<String> = reference_target_type_ids(reference).into_iter().filter(|t| display_of(t).is_none()).collect();
            if !unpublished.is_empty() && field_id != RESOURCES_REFERENCE_FIELD_ID && !input.lazily_walked {
                notes.push(format!(
                    "{adapter_type}: '{name}' reference '{edge}' targets {}, which listEntryPoints does not publish — the internal id will surface; publish the type or name it naturally",
                    unpublished.iter().map(|t| format!("'{t}'")).collect::<Vec<_>>().join(", ")
                ));
            }
            let replaces = match edges.get(&edge) {
                None => true,
                Some(existing) => Js::is_true(existing.get("resources")) && field_id != RESOURCES_REFERENCE_FIELD_ID,
            };
            if replaces {
                edges.insert(edge.clone(), Js::from(edge_schema(reference, target.as_deref(), polymorphic, &field_id)));
                if Js::is_true(reference.get("required")) {
                    let mut required = obj! { "edge" => Js::str(&edge) };
                    if let Some(target) = &target {
                        required.insert("from".into(), Js::str(target));
                    }
                    required_edges.push(Js::from(required));
                }
            }
            if Js::is_true(reference.get("writable")) {
                writable_targets.extend(target_names.iter().cloned());
            }
            edge_surface_by_field_id.insert(field_id, edge);
        }

        if positioned {
            let mut position = obj! { "properties" => Js::from(properties.clone()), "edges" => Js::from(edges.clone()) };
            if !property_capabilities.is_empty() {
                position.insert("propertyCapabilities".into(), Js::from(property_capabilities));
            }
            if dropped_field {
                position.insert("openProperties".into(), Js::Bool(true));
            }
            if !write_only_properties.is_empty() {
                position.insert("writeOnlyProperties".into(), Js::strings(&write_only_properties));
            }
            if !ambiguous_properties.is_empty() {
                position.insert("ambiguousProperties".into(), Js::strings(&ambiguous_properties));
            }
            if !pinned_properties.is_empty() {
                position.insert("pinnedProperties".into(), Js::strings(&pinned_properties));
            }
            if Js::is_true(descriptor.get("deletable")) {
                position.insert("deletable".into(), Js::Bool(true));
            }
            if let Some(description) = described(descriptor).or_else(|| described(entry)) {
                position.insert("description".into(), Js::str(description));
            }
            if !position_field_docs.is_empty() {
                position.insert("fieldDocs".into(), Js::from(position_field_docs));
            }
            positions.insert(name.clone(), Js::from(position));
        }

        if !writable_fields.is_empty() {
            let surface_field_by_internal_id: HashMap<String, String> = fields
                .iter()
                .filter(|f| properties.contains_key(&key(f.get("displayName"))))
                .map(|f| (key(f.get("fieldId")), key(f.get("displayName"))))
                .rev() // `new Map(pairs)`: a repeated id keeps the last pair's name
                .fold(HashMap::new(), |mut m, (k, v)| {
                    m.entry(k).or_insert(v);
                    m
                });
            let native_uniqueness = project_native_uniqueness(
                descriptor.get("uniquenessConstraints"),
                &surface_field_by_internal_id,
                &edge_surface_by_field_id,
                incoming_edge_names.get(&name),
                &name,
                &mut notes,
            );
            let mut fuzzy_names = write_field_name_by_id.clone();
            fuzzy_names.extend(surface_field_by_internal_id.iter().map(|(k, v)| (k.clone(), v.clone())));
            let fuzzy_resolution = project_fuzzy_resolution(descriptor.get("supportsFuzzyResolution"), &fuzzy_names, &name, &mut notes);
            let write_union = descriptor.get("writeUnion").map(|d| project_write_union(d, &write_field_name_by_id, &name, &mut notes));

            let mut result_shape = obj! { "externalId" => Js::str("text"), "url" => Js::str("text") };
            for (k, v) in properties.iter().chain(writable_fields.iter()) {
                result_shape.insert(k.clone(), v.clone());
            }
            let mut shape = obj! { "fields" => Js::from(writable_fields), "resultShape" => Js::from(result_shape) };
            if !native_uniqueness.is_empty() {
                shape.insert("nativeUniqueness".into(), Js::Arr(native_uniqueness.into_iter().map(Js::strings).collect()));
            }
            if !edges.is_empty() {
                shape.insert("edges".into(), Js::from(edges));
            }
            if !required_edges.is_empty() {
                shape.insert("requiredEdges".into(), Js::Arr(required_edges));
            }
            if !required_fields.is_empty() {
                shape.insert("requiredFields".into(), Js::strings(&required_fields));
            }
            if !field_docs.is_empty() {
                shape.insert("fieldDocs".into(), Js::from(field_docs));
            }
            if let Some(fuzzy) = fuzzy_resolution {
                shape.insert("fuzzyResolution".into(), fuzzy);
            }
            if Js::is_false(descriptor.get("uniquenessAuthorable")) {
                shape.insert("uniquenessAuthorable".into(), Js::Bool(false));
            }
            if let Some(write_union) = write_union {
                shape.insert("writeUnion".into(), write_union);
            }
            shape_by_name.insert(name.clone(), shape);
            if truthy(entry.get("writable")) {
                writable_roots.push(name);
            }
        }
    }

    let entry_names: HashSet<String> = all_entries.iter().map(|e| key(e.get("displayName"))).collect();
    for target in &edge_target_names {
        if positions.contains_key(target) || entry_names.contains(target) {
            continue;
        }
        positions.insert(target.clone(), undescribed());
    }

    let create_shapes: Vec<String> = writable_targets
        .iter()
        .filter(|t| !writable_roots.contains(t) && shape_by_name.contains_key(*t))
        .cloned()
        .collect();

    let described_type_names: HashSet<String> =
        all_entries.iter().filter(|e| input.descriptors.contains_key(&key(e.get("typeId")))).map(|e| key(e.get("displayName"))).collect();
    for (type_id, descriptor) in input.descriptors {
        let Some(declaration) = descriptor.get("discriminatedWrite") else { continue };
        let name = display_of(type_id).unwrap_or_else(|| type_id.clone());
        let Some(base) = shape_by_name.get(&name).cloned() else { continue };
        let mut variants = Obj::new();
        if let Some(Js::Obj(variant_types)) = declaration.get("variantTypes") {
            for (literal, variant_type) in variant_types {
                let variant_type_name = key(Some(variant_type));
                if !described_type_names.contains(&variant_type_name) {
                    notes.push(format!(
                        "{adapter_type}: {name} declares write variant \"{literal}\" as type '{variant_type_name}', which was never described — the variant is omitted rather than collapsed onto the base shape, so a body naming that variant's own fields is rejected rather than silently accepted."
                    ));
                    continue;
                }
                let mut variant = merge_variant_shape(&base, shape_by_name.get(&variant_type_name));
                if positions.contains_key(&variant_type_name) {
                    variant.insert("position".into(), Js::str(&variant_type_name));
                }
                variants.insert(literal.clone(), Js::from(variant));
            }
        }
        let mut discriminated = Obj::new();
        if let Some(discriminant) = declaration.get("discriminant") {
            discriminated.insert("discriminant".into(), discriminant.clone());
        }
        discriminated.insert("variants".into(), Js::from(variants));
        if let Some(shape) = shape_by_name.get_mut(&name) {
            shape.insert("discriminated".into(), Js::from(discriminated));
        }
    }

    let event_positions: Vec<Js> = all_entries
        .iter()
        .filter(|e| Js::is_true(e.get("fires")))
        .map(|e| {
            let mut position = obj! { "position" => Js::str(key(e.get("displayName"))) };
            if let Some(on) = e.get("firesOn") {
                position.insert("on".into(), Js::Arr(items(Some(on)).to_vec()));
            }
            Js::from(position)
        })
        .collect();
    let published_collection_names: HashSet<String> = all_entries
        .iter()
        .filter(|e| Js::is_true(e.get("readable")) || Js::is_true(e.get("writable")) || Js::is_true(e.get("listenable")))
        .map(|e| key(nullish_or(e.get("collectionName"), e.get("displayName"))))
        .collect();
    for collection_name in root_capabilities.keys() {
        if !published_collection_names.contains(collection_name) {
            notes.push(format!(
                "{adapter_type}: the root descriptor declares a capability for '{collection_name}', which listEntryPoints publishes no collection under — the declaration is dropped; give the two the same name"
            ));
        }
    }
    let readable_entries: Vec<&&Js> = all_entries.iter().filter(|e| truthy(e.get("readable"))).collect();
    let event_position = event_positions
        .first()
        .and_then(|p| p.get("position").cloned())
        .or_else(|| (readable_entries.len() == 1).then(|| Js::str(key(readable_entries[0].get("displayName")))));

    let materialise = |names: &[String]| -> Obj {
        names.iter().filter_map(|n| shape_by_name.get(n).map(|s| (n.clone(), Js::from(s.clone())))).collect()
    };
    let mut schema = obj! { "positions" => Js::from(positions), "collections" => Js::from(collections) };
    if !unions.is_empty() {
        schema.insert("unions".into(), Js::from(unions));
        schema.insert("unionDisplayNames".into(), Js::from(union_display_names));
    }
    schema.insert("writableRoots".into(), Js::from(materialise(&writable_roots)));
    if !create_shapes.is_empty() {
        schema.insert("createShapes".into(), Js::from(materialise(&create_shapes)));
    }
    if input.supports_in_place_update {
        schema.insert("supportsInPlaceUpdate".into(), Js::Bool(true));
    }
    if input.edges_carry_properties {
        schema.insert("edgesCarryProperties".into(), Js::Bool(true));
    }
    if let Some(event_position) = event_position {
        schema.insert("eventPosition".into(), event_position);
    }
    if !event_positions.is_empty() {
        schema.insert("eventPositions".into(), Js::Arr(event_positions));
    }
    Projection { schema: Js::from(schema), notes }
}

fn undescribed() -> Js {
    Js::from(obj! { "properties" => Js::from(Obj::new()), "edges" => Js::from(Obj::new()), "undescribed" => Js::Bool(true) })
}

/// One reference's edge, its members in the TypeScript's order.
fn edge_schema(reference: &Js, target: Option<&str>, polymorphic: bool, field_id: &str) -> Obj {
    let mut edge = Obj::new();
    if let Some(target) = target {
        edge.insert("target".into(), Js::str(target));
    }
    let mut flag = |name: &str, when: bool, value: Js| {
        if when {
            edge.insert(name.into(), value);
        }
    };
    flag("polymorphic", polymorphic, Js::Bool(true));
    flag("required", Js::is_true(reference.get("required")), Js::Bool(true));
    for passed in ["capability", "sequenced"] {
        if let Some(value) = reference.get(passed) {
            flag(passed, true, value.clone());
        }
    }
    for name in EDGE_TRUE_FLAGS {
        flag(name, Js::is_true(reference.get(name)), Js::Bool(true));
    }
    flag("readable", Js::is_false(reference.get("readable")), Js::Bool(false));
    flag("writable", Js::is_true(reference.get("writable")), Js::Bool(true));
    flag("linkable", Js::is_false(reference.get("linkable")), Js::Bool(false));
    for name in ["requiresLiveRecord", "subject", "listenable"] {
        flag(name, Js::is_true(reference.get(name)), Js::Bool(true));
    }
    for passed in LISTENING {
        if let Some(value) = reference.get(passed) {
            flag(passed, true, value.clone());
        }
    }
    for passed in ["genericOver", "literalsFrom", "answerShapeFrom"] {
        if let Some(value) = reference.get(passed) {
            flag(passed, true, value.clone());
        }
    }
    flag("resources", field_id == RESOURCES_REFERENCE_FIELD_ID, Js::Bool(true));
    if let Some(description) = described(reference) {
        edge.insert("description".into(), Js::str(description));
    }
    edge
}

/// The refusal of a reference that declares a key 0.13 retired, naming what
/// replaces it (engine-contracts `retiredReferenceKey` says the same).
pub fn retired_reference_key(reference: &Js) -> Option<String> {
    let retired = ["awaitable", "watchable", "resolvesEmpty"].into_iter().find(|retired| reference.get(retired).is_some())?;
    let name = key(nullish_or(reference.get("name"), reference.get("fieldId")));
    let instead = if retired == "resolvesEmpty" {
        "a deleted record leaves the wait waiting on every edge, so there is nothing to declare: drop it"
    } else {
        "declare 'listenable: true' (and, optionally, 'identity': the landing's field that names an arrival)"
    };
    Some(format!("'{name}' declares '{retired}', retired in 0.13: {instead}"))
}

/// The refusal of a field of kind `owned` that names no scalar: it would
/// project as nothing, leaving its position open (engine-contracts
/// `unreadableOwnedField` says the same).
pub fn unreadable_owned_field(field: &Js) -> Option<String> {
    if field.get("kind").and_then(Js::as_str) != Some("owned") {
        return None;
    }
    let named = field.get("owned").and_then(|owned| owned.get("name")).and_then(Js::as_str).is_some_and(|name| !name.is_empty());
    (!named).then(|| format!("'{}' is of kind 'owned' but declares no 'owned.name': name the scalar its adapter parses", key(field.get("displayName"))))
}

/// The refusal of a reference whose `identity` or `version` names a field its
/// landing does not declare (engine-contracts `undeclaredArrivalField` says
/// the same). A landing nobody described is not judged: it declares nothing
/// either way.
pub fn undeclared_arrival_field(reference: &Js, descriptors: &IndexMap<String, Js>) -> Option<String> {
    arrival_field_refusal(&reference_name(reference), reference, &reference_target_type_ids(reference), descriptors)
}

fn reference_name(reference: &Js) -> String {
    key(nullish_or(reference.get("name"), reference.get("fieldId")))
}

/// The refusal of `name`'s `identity` or `version`, read from `declared`,
/// naming a field none of its `landings` declares.
fn arrival_field_refusal(name: &str, declared: &Js, landings: &[String], descriptors: &IndexMap<String, Js>) -> Option<String> {
    ["identity", "version"].into_iter().find_map(|role| {
        let field = declared.get(role).and_then(Js::as_str)?;
        undeclared_landing_field(landings, descriptors, field, |field, landing, declared| {
            format!("'{name}' names '{field}' as its {role}, a field its landing '{landing}' does not declare (it declares: {declared})")
        })
    })
}

/// `refusal(field, landing, what it declares)` when one of `landings` that
/// somebody described has no field `field`.
fn undeclared_landing_field(
    landings: &[String],
    descriptors: &IndexMap<String, Js>,
    field: &str,
    refusal: impl Fn(&str, &str, &str) -> String,
) -> Option<String> {
    landings.iter().filter_map(|t| descriptors.get(t)).find_map(|landing| {
        let declared: Vec<&str> = items(landing.get("fields")).iter().filter_map(|f| f.get("displayName").and_then(Js::as_str)).collect();
        (!declared.contains(&field)).then(|| {
            let landing_name = landing.get("displayName").and_then(Js::as_str).unwrap_or_default();
            refusal(field, landing_name, &if declared.is_empty() { "nothing".to_string() } else { declared.join(", ") })
        })
    })
}

/// What declares how it is listened to: a reference of the type `owner`
/// (a type id), or an entry point, whose root collection hangs off the
/// instance itself.
pub enum Declarant<'a> {
    Reference { reference: &'a Js, owner: &'a str },
    Entry(&'a Js),
}

impl Declarant<'_> {
    fn declared(&self) -> &Js {
        match self {
            Declarant::Reference { reference, .. } => reference,
            Declarant::Entry(entry) => entry,
        }
    }

    /// The edge's name as a program writes it.
    fn name(&self) -> String {
        match self {
            Declarant::Reference { reference, .. } => reference_name(reference),
            Declarant::Entry(entry) => collection_name_of(entry),
        }
    }

    fn landings(&self) -> Vec<String> {
        match self {
            Declarant::Reference { reference, .. } => reference_target_type_ids(reference),
            Declarant::Entry(entry) => vec![key(entry.get("typeId"))],
        }
    }
}

fn collection_name_of(entry: &Js) -> String {
    key(nullish_or(entry.get("collectionName"), entry.get("displayName")))
}

/// Whether an entry point publishes a root collection.
fn is_collection(entry: &Js) -> bool {
    truthy(entry.get("readable")) || truthy(entry.get("writable")) || Js::is_true(entry.get("listenable"))
}

/// The refusal of what a reference or entry point declares about listening
/// to it that cannot mean what it says (engine-contracts `unreadableListening`
/// says the same): an unknown delivery, a polled edge with no interval, an
/// unbounded one with nothing to narrow it by, a field or hop named that is
/// not there, a hop cheap to list that says nothing of how its members'
/// changes are learnt. Every number declared is a default lf.yaml overrides,
/// so the module must state it. A landing nobody described is not judged.
pub fn unreadable_listening(declarant: Declarant, entries: &[Js], descriptors: &IndexMap<String, Js>) -> Option<String> {
    let declared = declarant.declared();
    let name = declarant.name();
    let has = |key: &str| declared.get(key).is_some();
    if let Declarant::Entry(_) = declarant
        && let Some(refusal) = arrival_field_refusal(&name, declared, &declarant.landings(), descriptors)
    {
        return Some(refusal);
    }
    let delivery = declared.get("delivery");
    if let Some(delivery) = delivery
        && !matches!(delivery.as_str(), Some("connection" | "scope" | "polled"))
    {
        return Some(format!("'{name}' declares delivery {}, which is none of 'connection', 'scope' or 'polled'", delivery.to_json()));
    }
    if let Declarant::Entry(_) = declarant
        && delivery.and_then(Js::as_str) == Some("scope")
    {
        return Some(format!("'{name}' declares 'delivery: scope', and '{name}' is a root collection: nothing comes before it to scope a subscription by"));
    }
    for seconds in ["pollEverySeconds", "relistEverySeconds"] {
        if let Some(value) = declared.get(seconds)
            && !matches!(value, Js::Num(n) if n.as_u64().is_some_and(|s| s > 0))
        {
            return Some(format!("'{name}' declares '{seconds}: {}': expected a positive whole number of seconds", value.to_json()));
        }
    }
    let polled = delivery.and_then(Js::as_str) == Some("polled");
    if polled && !has("pollEverySeconds") {
        return Some(format!("'{name}' declares 'delivery: polled' but no 'pollEverySeconds': state how often the module polls it"));
    }
    if !polled && has("pollEverySeconds") {
        return Some(format!("'{name}' declares 'pollEverySeconds' but not 'delivery: polled': only a polled edge is polled"));
    }
    let bounded_by = items(declared.get("boundedBy"));
    if Js::is_false(declared.get("bounded")) {
        if bounded_by.is_empty() {
            return Some(format!("'{name}' declares 'bounded: false' but no 'boundedBy': name the fields a listen narrows it by"));
        }
    } else if has("boundedBy") {
        return Some(format!("'{name}' declares 'boundedBy' but not 'bounded: false': only an unbounded edge is narrowed by it"));
    }
    for field in bounded_by {
        let field = key(Some(field));
        if let Some(refusal) = undeclared_landing_field(&declarant.landings(), descriptors, &field, |field, landing, declared| {
            format!("'{name}' names '{field}' in its boundedBy, a field its landing '{landing}' does not declare (it declares: {declared})")
        }) {
            return Some(refusal);
        }
    }
    if let Some(refusal) = unreadable_carries(&declarant, entries, descriptors) {
        return Some(refusal);
    }
    let parent_changes = declared.get("parentChanges");
    if let Some(value) = parent_changes
        && value.as_str() != Some("pushed")
    {
        return Some(format!("'{name}' declares parentChanges {}: the one value is 'pushed'", value.to_json()));
    }
    match (parent_changes.is_some(), has("relistEverySeconds"), Js::is_true(declared.get("cheapToList"))) {
        (true, true, _) => Some(format!(
            "'{name}' declares both 'parentChanges: pushed' and 'relistEverySeconds': a module that reports its members' changes is not re-listed on a clock; declare one"
        )),
        (false, false, true) => Some(format!(
            "'{name}' declares 'cheapToList: true' but neither 'parentChanges: pushed' nor 'relistEverySeconds': say how a listen learns its members changed"
        )),
        (pushed, relisted, false) if pushed || relisted => Some(format!(
            "'{name}' declares '{}' but not 'cheapToList: true': only a hop cheap to list is re-listed",
            if pushed { "parentChanges" } else { "relistEverySeconds" }
        )),
        (true, false, true) if !Js::is_true(declared.get("listenable")) => Some(format!(
            "'{name}' declares 'parentChanges: pushed' but not 'listenable: true': the module reports its members' changes as arrivals on '{name}' itself, so it must announce them"
        )),
        _ => None,
    }
}

/// `carries` names the hops before the declarant, outermost first: read
/// from the innermost, each must be an edge into the type the one after it
/// hangs off.
fn unreadable_carries(declarant: &Declarant, entries: &[Js], descriptors: &IndexMap<String, Js>) -> Option<String> {
    let carries = items(declarant.declared().get("carries"));
    if carries.is_empty() {
        return None;
    }
    let name = declarant.name();
    // Each type's edges in: (edge name, the type it hangs off, none for the instance).
    let mut into: HashMap<String, Vec<(String, Option<String>)>> = HashMap::new();
    for (owner, descriptor) in descriptors {
        for reference in items(descriptor.get("references")) {
            for target in reference_target_type_ids(reference) {
                into.entry(target).or_default().push((key(nullish_or(reference.get("name"), reference.get("fieldId"))), Some(owner.clone())));
            }
        }
    }
    for entry in entries.iter().filter(|e| is_collection(e)) {
        into.entry(key(entry.get("typeId"))).or_default().push((collection_name_of(entry), None));
    }
    let display = |type_id: &str| {
        descriptors.get(type_id).or_else(|| entries.iter().find(|e| key(e.get("typeId")) == type_id)).map_or_else(|| type_id.to_string(), |d| key(d.get("displayName")))
    };
    let (mut hangs_off, mut inner): (IndexSet<String>, String) = match declarant {
        Declarant::Reference { owner, .. } => ([owner.to_string()].into_iter().collect(), name.clone()),
        Declarant::Entry(_) => (IndexSet::new(), name.clone()),
    };
    for hop in carries.iter().rev() {
        let hop = key(Some(hop));
        if hangs_off.is_empty() {
            return Some(format!("'{name}' says its arrivals carry earlier hops, but 'carries' names '{hop}', and '{inner}' is a root collection: nothing comes before it"));
        }
        let edges_in = || hangs_off.iter().flat_map(|t| into.get(t).into_iter().flatten());
        let matched: Vec<&Option<String>> = edges_in().filter(|(edge, _)| *edge == hop).map(|(_, owner)| owner).collect();
        if matched.is_empty() {
            let types: Vec<String> = hangs_off.iter().map(|t| format!("'{}'", display(t))).collect();
            let edges: IndexSet<&str> = edges_in().map(|(edge, _)| edge.as_str()).collect();
            return Some(format!(
                "'{name}' says its arrivals carry earlier hops, but 'carries' names '{hop}', which is no edge into {} (the edges into it: {})",
                types.join(" or "),
                if edges.is_empty() { "none".to_string() } else { edges.into_iter().collect::<Vec<_>>().join(", ") }
            ));
        }
        hangs_off = matched.into_iter().flatten().cloned().collect();
        inner = hop;
    }
    None
}

/// The refusal of a reference whose `literalsFrom` cannot type what it says
/// (engine-contracts `unreadableLiteralsFrom` says the same): a `from` path
/// that does not parse, an `at` naming no field of the landing, a landing of
/// more than one type on the way, or a field that is not a single text field
/// (a write's literals are text). A landing nobody described is not judged.
pub fn unreadable_literals_from(reference: &Js, descriptors: &IndexMap<String, Js>) -> Option<String> {
    let declared = items(reference.get("literalsFrom"));
    if declared.is_empty() {
        return None;
    }
    let name = key(nullish_or(reference.get("name"), reference.get("fieldId")));
    let one_landing = |edge: &str, reference: &Js| match reference_target_type_ids(reference).as_slice() {
        [one] => Ok(one.clone()),
        many => Err(format!(
            "'{name}' declares literalsFrom, but '{edge}' lands on more than one type ({}): a field typed by a write's literals needs one landing",
            many.iter().map(|id| descriptors.get(id).map_or_else(|| id.clone(), |d| key(d.get("displayName")))).collect::<Vec<_>>().join(", ")
        )),
    };
    let first = match one_landing(&name, reference) {
        Ok(first) => first,
        Err(refusal) => return Some(refusal),
    };
    'entries: for entry in declared {
        let from = key(entry.get("from"));
        if let Err(problem) = movement_checker::families::writes::literals::parse_write_path(&from) {
            return Some(format!("'{name}' declares a literalsFrom path that cannot be read: {problem}"));
        }
        let at: Vec<String> = items(entry.get("at")).iter().map(|step| key(Some(step))).collect();
        let Some((field, hops)) = at.split_last() else {
            return Some(format!("'{name}' declares a literalsFrom with an empty 'at': name the field of its landing that the literals type"));
        };
        let spelled = at.join(".");
        let mut landing_id = first.clone();
        for hop in hops {
            let Some(landing) = descriptors.get(&landing_id) else { continue 'entries };
            let references = items(landing.get("references"));
            let Some(next) = references.iter().find(|r| key(nullish_or(r.get("name"), r.get("fieldId"))) == *hop) else {
                let has: Vec<String> = references.iter().map(|r| key(nullish_or(r.get("name"), r.get("fieldId")))).collect();
                return Some(format!(
                    "'{name}' declares literalsFrom at '{spelled}', but its landing '{}' has no reference '{hop}' (it has: {})",
                    key(landing.get("displayName")),
                    if has.is_empty() { "nothing".to_string() } else { has.join(", ") }
                ));
            };
            match one_landing(hop, next) {
                Ok(next) => landing_id = next,
                Err(refusal) => return Some(refusal),
            }
        }
        let Some(landing) = descriptors.get(&landing_id) else { continue };
        let landing_name = key(landing.get("displayName"));
        let fields = items(landing.get("fields"));
        match fields.iter().find(|f| f.get("displayName").and_then(Js::as_str) == Some(field.as_str())) {
            None => {
                let declared: Vec<&str> = fields.iter().filter_map(|f| f.get("displayName").and_then(Js::as_str)).collect();
                return Some(format!(
                    "'{name}' declares literalsFrom at '{spelled}', a field its landing '{landing_name}' does not declare (it declares: {})",
                    if declared.is_empty() { "nothing".to_string() } else { declared.join(", ") }
                ));
            }
            Some(found) if found.get("kind").and_then(Js::as_str) != Some("string") || found.get("cardinality").and_then(Js::as_str) == Some("many") => {
                return Some(format!(
                    "'{name}' declares literalsFrom at '{spelled}', but '{field}' on '{landing_name}' is not a single text field: a write's text literals type only text"
                ));
            }
            Some(_) => {}
        }
    }
    None
}

/// The refusal of a reference whose `answerShapeFrom` cannot type what it
/// says (engine-contracts `unreadableAnswerShapeFrom` says the same): it
/// names no field of the type it hangs off (`owner`), or one that is not a
/// single writable json field (the engine sends the node's fields as json),
/// or the reference lands on more than one type.
pub fn unreadable_answer_shape_from(reference: &Js, owner: &Js, descriptors: &IndexMap<String, Js>) -> Option<String> {
    let field = reference.get("answerShapeFrom").and_then(Js::as_str)?;
    let name = key(nullish_or(reference.get("name"), reference.get("fieldId")));
    let landings = reference_target_type_ids(reference);
    if landings.len() != 1 {
        let named: Vec<String> = landings.iter().map(|id| descriptors.get(id).map_or_else(|| id.clone(), |d| key(d.get("displayName")))).collect();
        return Some(format!("'{name}' takes its answer's shape from '{field}', but it lands on more than one type ({}): a shape gives one landing its fields", named.join(", ")));
    }
    let owner_name = key(owner.get("displayName"));
    let fields = items(owner.get("fields"));
    let Some(found) = fields.iter().find(|f| f.get("displayName").and_then(Js::as_str) == Some(field)) else {
        let declared: Vec<&str> = fields.iter().filter_map(|f| f.get("displayName").and_then(Js::as_str)).collect();
        return Some(format!(
            "'{name}' takes its answer's shape from '{field}', a field '{owner_name}' does not declare (it declares: {})",
            if declared.is_empty() { "nothing".to_string() } else { declared.join(", ") }
        ));
    };
    let single_json = found.get("kind").and_then(Js::as_str) == Some("json") && found.get("cardinality").and_then(Js::as_str) != Some("many");
    if !single_json || !Js::is_true(found.get("writable")) {
        return Some(format!(
            "'{name}' takes its answer's shape from '{field}', but '{field}' on '{owner_name}' is not a single writable json field: the write names a node there, and the module receives its fields as json"
        ));
    }
    None
}

/// A non-empty `description` the adapter wrote on a type, field or reference.
fn described(declared: &Js) -> Option<String> {
    declared.get("description").and_then(Js::as_str).filter(|d| !d.is_empty()).map(str::to_string)
}

/// The projection over an adapter's own introspection answers, as
/// `listen-fire check` and a session ask it of each adapter external (crate::check `describe_external`).
pub fn describe_external_schema(adapter_type: &str, entries: &[Js], descriptors: &IndexMap<String, Js>) -> Js {
    instance_schema_from_descriptors(&ProjectionInput {
        adapter_type,
        entries,
        reached: &[],
        descriptors,
        meta_descriptor: None,
        // A remote adapter always has `updateRecord` (it is not one of the
        // optional methods the client prunes), so `typeof … === 'function'`.
        supports_in_place_update: true,
        edges_carry_properties: false,
        all_entries: None,
        lazily_walked: false,
    })
    .schema
}

/// `--project-schema`: the projection over `instanceSchemaFromDescriptors`'s
/// input as JSON (`descriptors` as `[typeId, descriptor]` pairs, a `Map`'s
/// entries), answering `{ schema, notes }`.
pub fn probe(input: &Js) -> Result<Js, String> {
    let list = |key: &str| input.get(key).and_then(Js::as_array).map(<[Js]>::to_vec);
    let entries = list("entries").ok_or("entries: expected an array")?;
    let reached = list("reached").unwrap_or_default();
    let all_entries = list("allEntries");
    let mut descriptors = IndexMap::new();
    for pair in list("descriptors").ok_or("descriptors: expected [typeId, descriptor] pairs")? {
        match pair.as_array() {
            Some([Js::Str(type_id), descriptor]) => {
                descriptors.insert(type_id.clone(), descriptor.clone());
            }
            _ => return Err("descriptors: expected [typeId, descriptor] pairs".into()),
        }
    }
    let projection = instance_schema_from_descriptors(&ProjectionInput {
        adapter_type: input.get("adapterType").and_then(Js::as_str).ok_or("adapterType: expected a string")?,
        entries: &entries,
        reached: &reached,
        descriptors: &descriptors,
        meta_descriptor: input.get("metaDescriptor"),
        supports_in_place_update: Js::is_true(input.get("supportsInPlaceUpdate")),
        edges_carry_properties: Js::is_true(input.get("edgesCarryProperties")),
        all_entries: all_entries.as_deref(),
        lazily_walked: Js::is_true(input.get("lazilyWalked")),
    });
    Ok(Js::from(obj! { "schema" => projection.schema, "notes" => Js::strings(projection.notes) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn js(text: &str) -> Js {
        Js::parse(text.as_bytes()).unwrap()
    }

    /// The type's words fall back to its entry point's; every described field
    /// lands on the position, write-only ones too; a reference's on its edge.
    #[test]
    fn the_adapter_s_own_words_ride_the_projection() {
        let entries = [js(r#"{ "typeId": "co", "displayName": "Company", "writable": true, "readable": true, "description": "A company." }"#)];
        let descriptor = js(
            r#"{ "typeId": "co", "displayName": "Company",
                 "fields": [
                   { "fieldId": "n", "displayName": "Name", "kind": "string", "writable": true, "description": "Its legal name." },
                   { "fieldId": "s", "displayName": "Secret", "kind": "string", "writable": true, "readable": false, "description": "Read it on the Notes edge." },
                   { "fieldId": "t", "displayName": "Tag", "kind": "string", "writable": false, "description": "" }
                 ],
                 "references": [{ "fieldId": "notes", "name": "Notes", "targetTypeId": "co", "cardinality": "many", "direction": "outgoing", "description": "What people wrote." }] }"#,
        );
        let descriptors: IndexMap<String, Js> = [("co".to_string(), descriptor)].into_iter().collect();
        let schema = describe_external_schema("crm", &entries, &descriptors);
        let company = schema.get("positions").and_then(|p| p.get("Company")).unwrap();
        assert_eq!(company.get("description").and_then(Js::as_str), Some("A company."));
        let docs = company.get("fieldDocs").unwrap();
        assert_eq!(docs.get("Name").and_then(Js::as_str), Some("Its legal name."));
        assert_eq!(docs.get("Secret").and_then(Js::as_str), Some("Read it on the Notes edge."));
        assert!(docs.get("Tag").is_none(), "an empty description says nothing");
        assert_eq!(company.get("edges").and_then(|e| e.get("Notes")).and_then(|e| e.get("description")).and_then(Js::as_str), Some("What people wrote."));
    }

    #[test]
    fn a_listenable_reference_projects_its_capabilities() {
        let edge = edge_schema(&js(r#"{"name":"Replies","listenable":true,"cursor":false,"identity":"Timestamp","version":"Edited","sequenced":"chronological"}"#), Some("Message"), false, "replies");
        assert_eq!(Js::from(edge).to_json(), r#"{"target":"Message","sequenced":"chronological","listenable":true,"cursor":false,"identity":"Timestamp","version":"Edited"}"#);
    }

    #[test]
    fn a_reference_typed_by_a_writes_literals_projects_where_they_are() {
        let edge = edge_schema(
            &js(r#"{"name":"Interactions","readable":false,"listenable":true,"literalsFrom":[{"at":["Actions","Value"],"from":"Buttons[].Value"}]}"#),
            Some("Interaction"),
            false,
            "interactions",
        );
        assert_eq!(
            Js::from(edge).to_json(),
            r#"{"target":"Interaction","readable":false,"listenable":true,"literalsFrom":[{"at":["Actions","Value"],"from":"Buttons[].Value"}]}"#
        );
        let edge = edge_schema(&js(r#"{"name":"Responses","readable":false,"listenable":true,"answerShapeFrom":"Questions"}"#), Some("Response"), false, "responses");
        assert_eq!(Js::from(edge).to_json(), r#"{"target":"Response","readable":false,"listenable":true,"answerShapeFrom":"Questions"}"#);
    }

    #[test]
    fn an_awaitable_reference_is_refused_naming_listenable() {
        assert_eq!(
            retired_reference_key(&js(r#"{"name":"Replies","awaitable":true}"#)).unwrap(),
            "'Replies' declares 'awaitable', retired in 0.13: declare 'listenable: true' (and, optionally, 'identity': the landing's field that names an arrival)"
        );
        assert_eq!(
            retired_reference_key(&js(r#"{"fieldId":"replies","watchable":true}"#)).unwrap(),
            "'replies' declares 'watchable', retired in 0.13: declare 'listenable: true' (and, optionally, 'identity': the landing's field that names an arrival)"
        );
        assert_eq!(retired_reference_key(&js(r#"{"name":"Replies","listenable":true}"#)), None);
    }

    #[test]
    fn a_reference_declaring_resolves_empty_is_refused_by_name() {
        assert_eq!(
            retired_reference_key(&js(r#"{"name":"Interactions","listenable":true,"resolvesEmpty":true}"#)).unwrap(),
            "'Interactions' declares 'resolvesEmpty', retired in 0.13: a deleted record leaves the wait waiting on every edge, so there is nothing to declare: drop it"
        );
    }

    #[test]
    fn an_identity_or_version_must_name_a_field_the_landing_declares() {
        let message = js(r#"{ "typeId": "m", "displayName": "Message", "fields": [{ "fieldId": "ts", "displayName": "Timestamp", "kind": "date" }], "references": [] }"#);
        let descriptors: IndexMap<String, Js> = [("m".to_string(), message)].into_iter().collect();
        let replies = |extra: &str| js(&format!(r#"{{ "fieldId": "replies", "name": "Replies", "targetTypeId": "m", "listenable": true{extra} }}"#));
        assert_eq!(undeclared_arrival_field(&replies(r#", "identity": "Timestamp""#), &descriptors), None);
        assert_eq!(
            undeclared_arrival_field(&replies(r#", "identity": "ts""#), &descriptors).unwrap(),
            "'Replies' names 'ts' as its identity, a field its landing 'Message' does not declare (it declares: Timestamp)"
        );
        assert_eq!(
            undeclared_arrival_field(&replies(r#", "identity": "Timestamp", "version": "Edited""#), &descriptors).unwrap(),
            "'Replies' names 'Edited' as its version, a field its landing 'Message' does not declare (it declares: Timestamp)"
        );
        assert_eq!(undeclared_arrival_field(&replies(r#", "identity": "Anything""#), &IndexMap::new()), None, "an undescribed landing is not judged");
    }

    #[test]
    fn an_answer_shape_from_must_name_one_writable_json_field_of_its_owner() {
        let survey = js(r#"{ "typeId": "f", "displayName": "Survey", "fields": [
            { "fieldId": "title", "displayName": "Name", "kind": "string", "writable": true },
            { "fieldId": "fields", "displayName": "Questions", "kind": "json", "writable": true },
            { "fieldId": "url", "displayName": "Url", "kind": "string", "writable": false },
            { "fieldId": "seen", "displayName": "Seen", "kind": "json", "writable": false }
        ], "references": [] }"#);
        let descriptors: IndexMap<String, Js> =
            [("f".to_string(), survey.clone()), ("s".to_string(), js(r#"{ "typeId": "s", "displayName": "Response", "fields": [], "references": [] }"#))].into_iter().collect();
        let responses = |field: &str, landings: &str| {
            js(&format!(r#"{{ "fieldId": "responses", "name": "Responses", "targetTypeId": "s", {landings} "listenable": true, "answerShapeFrom": "{field}" }}"#))
        };
        let refusal = |field: &str| unreadable_answer_shape_from(&responses(field, ""), &survey, &descriptors);
        assert_eq!(refusal("Questions"), None);
        assert_eq!(
            refusal("Topics").unwrap(),
            "'Responses' takes its answer's shape from 'Topics', a field 'Survey' does not declare (it declares: Name, Questions, Url, Seen)"
        );
        for field in ["Name", "Seen"] {
            assert_eq!(
                refusal(field).unwrap(),
                format!("'Responses' takes its answer's shape from '{field}', but '{field}' on 'Survey' is not a single writable json field: the write names a node there, and the module receives its fields as json")
            );
        }
        assert_eq!(
            unreadable_answer_shape_from(&responses("Questions", r#""targetTypeIds": ["s", "f"],"#), &survey, &descriptors).unwrap(),
            "'Responses' takes its answer's shape from 'Questions', but it lands on more than one type (Response, Survey): a shape gives one landing its fields"
        );
        assert_eq!(unreadable_answer_shape_from(&js(r#"{ "fieldId": "x", "targetTypeId": "s" }"#), &survey, &descriptors), None);
    }

    #[test]
    fn a_literals_from_must_type_one_text_field_of_its_landing() {
        let descriptors: IndexMap<String, Js> = [
            ("i", r#"{ "typeId": "i", "displayName": "Interaction", "fields": [{ "fieldId": "id", "displayName": "Id", "kind": "string" }],
                "references": [{ "fieldId": "actions", "name": "Actions", "targetTypeId": "a" }, { "fieldId": "on", "name": "On", "targetTypeId": "a", "targetTypeIds": ["a", "i"] }] }"#),
            ("a", r#"{ "typeId": "a", "displayName": "Action", "fields": [{ "fieldId": "v", "displayName": "Value", "kind": "string" },
                { "fieldId": "n", "displayName": "Count", "kind": "number" }, { "fieldId": "t", "displayName": "Tags", "kind": "string", "cardinality": "many" }], "references": [] }"#),
        ]
        .into_iter()
        .map(|(id, d)| (id.to_string(), js(d)))
        .collect();
        let interactions = |at: &str, from: &str| {
            js(&format!(r#"{{ "fieldId": "interactions", "name": "Interactions", "targetTypeId": "i", "listenable": true, "literalsFrom": [{{ "at": {at}, "from": "{from}" }}] }}"#))
        };
        let refusal = |at: &str, from: &str| unreadable_literals_from(&interactions(at, from), &descriptors);
        assert_eq!(refusal(r#"["Actions", "Value"]"#, "Buttons[].Value"), None);
        assert_eq!(refusal(r#"["Id"]"#, "Buttons[].Value"), None);
        assert_eq!(
            refusal(r#"["Actions", "Value"]"#, "Buttons[.Value").unwrap(),
            "'Interactions' declares a literalsFrom path that cannot be read: 'Buttons[.Value' has a stray bracket in 'Buttons[': only '[]' may follow a field, before the next '.'"
        );
        assert_eq!(
            refusal(r#"["Actions", "Valu"]"#, "Buttons[].Value").unwrap(),
            "'Interactions' declares literalsFrom at 'Actions.Valu', a field its landing 'Action' does not declare (it declares: Value, Count, Tags)"
        );
        assert_eq!(
            refusal(r#"["Action", "Value"]"#, "Buttons[].Value").unwrap(),
            "'Interactions' declares literalsFrom at 'Action.Value', but its landing 'Interaction' has no reference 'Action' (it has: Actions, On)"
        );
        assert_eq!(
            refusal(r#"["On", "Value"]"#, "Buttons[].Value").unwrap(),
            "'Interactions' declares literalsFrom, but 'On' lands on more than one type (Action, Interaction): a field typed by a write's literals needs one landing"
        );
        for field in ["Count", "Tags"] {
            assert_eq!(
                refusal(&format!(r#"["Actions", "{field}"]"#), "Buttons[].Value").unwrap(),
                format!("'Interactions' declares literalsFrom at 'Actions.{field}', but '{field}' on 'Action' is not a single text field: a write's text literals type only text")
            );
        }
        let polymorphic = js(r#"{ "fieldId": "x", "name": "Answers", "targetTypeId": "a", "targetTypeIds": ["a", "i"], "literalsFrom": [{ "at": ["Value"], "from": "Options[].Key" }] }"#);
        assert_eq!(
            unreadable_literals_from(&polymorphic, &descriptors).unwrap(),
            "'Answers' declares literalsFrom, but 'Answers' lands on more than one type (Action, Interaction): a field typed by a write's literals needs one landing"
        );
        assert_eq!(unreadable_literals_from(&interactions(r#"["Anything"]"#, "Buttons[].Value"), &IndexMap::new()), None, "an undescribed landing is not judged");
    }

    fn tick_schema(entry: &str) -> Js {
        let tick = js(r#"{ "typeId": "tick", "displayName": "Tick", "fields": [{ "fieldId": "schedule", "displayName": "Schedule", "kind": "owned", "owned": { "name": "Cron" }, "writable": false, "required": true }], "references": [] }"#);
        let descriptors: IndexMap<String, Js> = [("tick".to_string(), tick)].into_iter().collect();
        describe_external_schema("cron", &[js(entry)], &descriptors)
    }

    #[test]
    fn a_listenable_root_projects_its_capabilities() {
        let schema = tick_schema(
            r#"{"typeId":"tick","displayName":"Tick","writable":false,"listenable":true,"readable":false,"bounded":false,"boundedBy":["Schedule"],"delivery":"polled","pollEverySeconds":60}"#,
        );
        let collection = schema.get("collections").and_then(|c| c.get("Tick")).unwrap();
        assert_eq!(
            collection.to_json(),
            r#"{"target":"Tick","readable":false,"listenable":true,"bounded":false,"boundedBy":["Schedule"],"delivery":"polled","pollEverySeconds":60}"#
        );
        assert!(schema.get("positions").and_then(|p| p.get("Tick")).is_some(), "what a root listen lands on is a position");
    }

    #[test]
    fn a_reference_projects_how_it_is_listened_to() {
        let edge = edge_schema(
            &js(r#"{"name":"Changes","listenable":true,"identity":"Id","delivery":"scope","carries":["Bases","Tables"],"attributes":true,"bounded":true}"#),
            Some("Change"),
            false,
            "changes",
        );
        assert_eq!(
            Js::from(edge).to_json(),
            r#"{"target":"Change","listenable":true,"identity":"Id","bounded":true,"delivery":"scope","carries":["Bases","Tables"],"attributes":true}"#
        );
        let tables = edge_schema(&js(r#"{"name":"Tables","cheapToList":true,"parentChanges":"pushed"}"#), Some("Table"), false, "tables");
        assert_eq!(Js::from(tables).to_json(), r#"{"target":"Table","cheapToList":true,"parentChanges":"pushed"}"#);
    }

    #[test]
    fn an_owned_field_projects_as_owned() {
        let field = js(r#"{"fieldId":"schedule","displayName":"Schedule","kind":"owned","owned":{"name":"Cron"},"writable":false,"required":true}"#);
        assert_eq!(field_type_from_descriptor(&field, "cron").unwrap().to_json(), r#"{"kind":"owned","name":"Cron","owner":"cron"}"#);
        let keyed = js(r#"{"fieldId":"key","displayName":"Key","kind":"owned","owned":{"name":"Key","allowPattern":"^[a-z0-9]+$"},"cardinality":"many","writable":false,"required":true}"#);
        assert_eq!(
            field_type_from_descriptor(&keyed, "email").unwrap().to_json(),
            r#"{"kind":"list","of":{"kind":"owned","name":"Key","owner":"email","allowPattern":"^[a-z0-9]+$"}}"#
        );
        let schema = tick_schema(r#"{"typeId":"tick","displayName":"Tick","writable":false,"readable":true}"#);
        let read: movement_parser::catalog::types::InstanceSchema = movement_parser::catalog::types::read_catalog(&schema.to_json()).unwrap();
        assert_eq!(
            read.positions["Tick"].properties["Schedule"],
            movement_parser::catalog::types::FieldType::Composite(movement_parser::catalog::types::Composite::Owned {
                name: "Cron".into(),
                owner: "cron".into(),
                allow_pattern: None
            })
        );
    }

    /// The entry point `Ticks`, its descriptor and the refusal of what it declares.
    fn ticks_refusal(declares: &str) -> Option<String> {
        let entry = js(&format!(r#"{{"typeId":"tick","displayName":"Tick","collectionName":"Ticks","writable":false,"readable":false,"listenable":true{declares}}}"#));
        let tick = js(r#"{ "typeId": "tick", "displayName": "Tick", "fields": [{ "fieldId": "schedule", "displayName": "Schedule", "kind": "string", "writable": false, "required": true }], "references": [] }"#);
        let descriptors: IndexMap<String, Js> = [("tick".to_string(), tick)].into_iter().collect();
        unreadable_listening(Declarant::Entry(&entry), std::slice::from_ref(&entry), &descriptors)
    }

    #[test]
    fn bounded_false_without_bounded_by_is_refused_naming_it() {
        assert_eq!(ticks_refusal(r#","bounded":false"#).unwrap(), "'Ticks' declares 'bounded: false' but no 'boundedBy': name the fields a listen narrows it by");
        assert_eq!(ticks_refusal(r#","bounded":false,"boundedBy":[]"#).unwrap(), "'Ticks' declares 'bounded: false' but no 'boundedBy': name the fields a listen narrows it by");
        assert_eq!(ticks_refusal(r#","bounded":false,"boundedBy":["Schedule"]"#), None);
        assert_eq!(
            ticks_refusal(r#","boundedBy":["Schedule"]"#).unwrap(),
            "'Ticks' declares 'boundedBy' but not 'bounded: false': only an unbounded edge is narrowed by it"
        );
    }

    #[test]
    fn bounded_by_must_name_a_field_the_landing_declares() {
        assert_eq!(
            ticks_refusal(r#","bounded":false,"boundedBy":["Cron"]"#).unwrap(),
            "'Ticks' names 'Cron' in its boundedBy, a field its landing 'Tick' does not declare (it declares: Schedule)"
        );
        assert_eq!(
            ticks_refusal(r#","identity":"Id""#).unwrap(),
            "'Ticks' names 'Id' as its identity, a field its landing 'Tick' does not declare (it declares: Schedule)",
            "a root collection's identity is held to its landing as an edge's is"
        );
    }

    #[test]
    fn a_polled_edge_states_its_interval() {
        assert_eq!(
            ticks_refusal(r#","delivery":"polled""#).unwrap(),
            "'Ticks' declares 'delivery: polled' but no 'pollEverySeconds': state how often the module polls it"
        );
        assert_eq!(ticks_refusal(r#","delivery":"polled","pollEverySeconds":60"#), None);
        assert_eq!(
            ticks_refusal(r#","delivery":"polled","pollEverySeconds":0"#).unwrap(),
            "'Ticks' declares 'pollEverySeconds: 0': expected a positive whole number of seconds"
        );
        assert_eq!(
            ticks_refusal(r#","delivery":"connection","pollEverySeconds":60"#).unwrap(),
            "'Ticks' declares 'pollEverySeconds' but not 'delivery: polled': only a polled edge is polled"
        );
        assert_eq!(
            ticks_refusal(r#","delivery":"pushed""#).unwrap(),
            r#"'Ticks' declares delivery "pushed", which is none of 'connection', 'scope' or 'polled'"#
        );
    }

    #[test]
    fn a_root_collection_cannot_deliver_by_scope() {
        assert_eq!(
            ticks_refusal(r#","delivery":"scope""#).unwrap(),
            "'Ticks' declares 'delivery: scope', and 'Ticks' is a root collection: nothing comes before it to scope a subscription by"
        );
        assert_eq!(ticks_refusal(r#","delivery":"connection""#), None);
    }

    #[test]
    fn a_hop_cheap_to_list_says_how_its_members_changes_are_learnt() {
        assert_eq!(
            ticks_refusal(r#","cheapToList":true"#).unwrap(),
            "'Ticks' declares 'cheapToList: true' but neither 'parentChanges: pushed' nor 'relistEverySeconds': say how a listen learns its members changed"
        );
        assert_eq!(ticks_refusal(r#","cheapToList":true,"relistEverySeconds":300"#), None);
        assert_eq!(ticks_refusal(r#","cheapToList":true,"parentChanges":"pushed""#), None);
        assert_eq!(
            ticks_refusal(r#","cheapToList":true,"parentChanges":"pushed","relistEverySeconds":300"#).unwrap(),
            "'Ticks' declares both 'parentChanges: pushed' and 'relistEverySeconds': a module that reports its members' changes is not re-listed on a clock; declare one"
        );
        assert_eq!(
            ticks_refusal(r#","relistEverySeconds":300"#).unwrap(),
            "'Ticks' declares 'relistEverySeconds' but not 'cheapToList: true': only a hop cheap to list is re-listed"
        );
        assert_eq!(ticks_refusal(r#","cheapToList":true,"parentChanges":"polled""#).unwrap(), r#"'Ticks' declares parentChanges "polled": the one value is 'pushed'"#);
    }

    #[test]
    fn a_number_of_seconds_is_a_positive_whole_number() {
        for (declared, shown) in [("0", "0"), ("-5", "-5"), ("1.5", "1.5"), (r#""300""#, r#""300""#)] {
            assert_eq!(
                ticks_refusal(&format!(r#","cheapToList":true,"relistEverySeconds":{declared}"#)).unwrap(),
                format!("'Ticks' declares 'relistEverySeconds: {shown}': expected a positive whole number of seconds")
            );
        }
    }

    #[test]
    fn a_hop_whose_changes_are_pushed_announces_them() {
        let entry = js(r#"{"typeId":"board","displayName":"Board","collectionName":"Boards","writable":false,"cheapToList":true,"parentChanges":"pushed"}"#);
        let board = js(r#"{ "typeId": "board", "displayName": "Board", "fields": [], "references": [] }"#);
        let descriptors: IndexMap<String, Js> = [("board".to_string(), board)].into_iter().collect();
        assert_eq!(
            unreadable_listening(Declarant::Entry(&entry), std::slice::from_ref(&entry), &descriptors).unwrap(),
            "'Boards' declares 'parentChanges: pushed' but not 'listenable: true': the module reports its members' changes as arrivals on 'Boards' itself, so it must announce them"
        );
        assert_eq!(ticks_refusal(r#","cheapToList":true,"parentChanges":"pushed""#), None, "a listenable root may");
    }

    #[test]
    fn a_hop_that_is_pushed_is_still_cheap_to_list() {
        assert_eq!(
            ticks_refusal(r#","parentChanges":"pushed""#).unwrap(),
            "'Ticks' declares 'parentChanges' but not 'cheapToList: true': only a hop cheap to list is re-listed"
        );
    }

    #[test]
    fn a_root_collection_carries_no_earlier_hop() {
        assert_eq!(
            ticks_refusal(r#","carries":["Bases"]"#).unwrap(),
            "'Ticks' says its arrivals carry earlier hops, but 'carries' names 'Bases', and 'Ticks' is a root collection: nothing comes before it"
        );
    }

    #[test]
    fn an_owned_field_without_its_name_is_refused_by_name() {
        let refusal = |field: &str| unreadable_owned_field(&js(field));
        assert_eq!(refusal(r#"{"fieldId":"schedule","displayName":"Schedule","kind":"owned","owned":{"name":"Cron"}}"#), None);
        assert_eq!(refusal(r#"{"fieldId":"schedule","displayName":"Schedule","kind":"string"}"#), None);
        let expected = "'Schedule' is of kind 'owned' but declares no 'owned.name': name the scalar its adapter parses";
        assert_eq!(refusal(r#"{"fieldId":"schedule","displayName":"Schedule","kind":"owned"}"#).unwrap(), expected);
        assert_eq!(refusal(r#"{"fieldId":"schedule","displayName":"Schedule","kind":"owned","owned":{}}"#).unwrap(), expected);
        assert_eq!(refusal(r#"{"fieldId":"schedule","displayName":"Schedule","kind":"owned","owned":{"name":""}}"#).unwrap(), expected);
    }

    #[test]
    fn carries_names_the_hops_before_the_edge_outermost_first() {
        let entries = [js(r#"{"typeId":"base","displayName":"Base","collectionName":"Bases","writable":false,"readable":true}"#)];
        let base = js(r#"{ "typeId": "base", "displayName": "Base", "fields": [], "references": [{ "fieldId": "tables", "name": "Tables", "targetTypeId": "table", "cardinality": "many", "direction": "outgoing" }] }"#);
        let table = js(r#"{ "typeId": "table", "displayName": "Table", "fields": [], "references": [] }"#);
        let descriptors: IndexMap<String, Js> = [("base".to_string(), base), ("table".to_string(), table)].into_iter().collect();
        let changes = |carries: &str| {
            let reference = js(&format!(r#"{{"fieldId":"changes","name":"Changes","targetTypeId":"table","listenable":true,"carries":{carries}}}"#));
            unreadable_listening(Declarant::Reference { reference: &reference, owner: "table" }, &entries, &descriptors)
        };
        assert_eq!(changes(r#"["Bases","Tables"]"#), None);
        assert_eq!(changes(r#"["Tables"]"#), None);
        assert_eq!(
            changes(r#"["Nope"]"#).unwrap(),
            "'Changes' says its arrivals carry earlier hops, but 'carries' names 'Nope', which is no edge into 'Table' (the edges into it: Tables)"
        );
        assert_eq!(
            changes(r#"["Tables","Bases"]"#).unwrap(),
            "'Changes' says its arrivals carry earlier hops, but 'carries' names 'Bases', which is no edge into 'Table' (the edges into it: Tables)",
            "outermost first: the innermost hop is last"
        );
        assert_eq!(
            changes(r#"["Nope","Bases","Tables"]"#).unwrap(),
            "'Changes' says its arrivals carry earlier hops, but 'carries' names 'Nope', and 'Bases' is a root collection: nothing comes before it"
        );
    }
}

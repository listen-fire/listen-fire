//! What a catalog holds, as the description value (movement_checker::
//! description) in JSON: the describing query a host without `listen-fire`
//! asks the engine artifact (`describe_query`). Every name, type, hop and
//! mark arrives spelled as `listen-fire catalog` spells it; how much is shown
//! is the caller's (`Showing`), how it is laid out the caller's too.
//!
//! A request is `{address?, showing?, landings?}`, each showing
//! `{fields?, enumOptions?}`:
//! - no address: `{legend, connections: [{adapter, key, place}]}`, every
//!   connection the snapshot describes, each at its root;
//! - an address (`'@lf/slack:team_workspace-[:Channels]->'`, as
//!   `listen-fire catalog '<address>'` takes one): `{legend, diagnostics,
//!   place}`, `place` null where a diagnostic is an error or nothing
//!   describes where it lands. With no walk it is the connection's root, and
//!   `records` each record type it holds, `{name, place}`, by the name a
//!   program's type writes (`<c-[:Message]->>`).
//!
//! `showing` is how much of the place is shown, `landings` how much of where
//! each of its edges lands (one level deep: a landing's own edges carry no
//! landing). A place is `{name, description?, known, members, fields, edges}`;
//! `fields` is `{shown: [field], cut}`; a field is `{name, written,
//! markedName, type, required, identifying, readOnly, writeOnly, pinned,
//! description?}`, `written` the whole of it as the catalog writes it; an
//! edge is `{name, step, hop, target, read, write, fires, description?,
//! writes?, lands?}`, `step` the hop alone (`-[:Messages]->`), `hop` with
//! where it lands and what it can do, `writes` what a write along it takes.

use std::rc::Rc;

use movement_checker::address::Address;
use movement_checker::description::{
    DescribedEdge, DescribedField, Description, FieldList, Known, LEGEND, Mark, Showing, connection_root, describe_landing, described_record_types, landing_name,
};
use movement_checker::host::ZoneLookup;
use movement_checker::types::position::Position;
use movement_checker::{Diagnostic, Severity};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::{Value, json};

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Asked {
    #[serde(default)]
    address: Option<String>,
    #[serde(default)]
    showing: AskedShowing,
    #[serde(default)]
    landings: AskedShowing,
}

#[derive(serde::Deserialize, Default, Clone, Copy)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AskedShowing {
    #[serde(default)]
    fields: Option<usize>,
    #[serde(default)]
    enum_options: Option<usize>,
}

impl From<AskedShowing> for Showing {
    fn from(asked: AskedShowing) -> Showing {
        Showing { fields: asked.fields, enum_options: asked.enum_options }
    }
}

/// How much of each level is shown.
#[derive(Clone, Copy)]
struct Levels {
    place: Showing,
    landings: Showing,
}

/// `describe_query`'s answer: the snapshot loaded as the checker loads it,
/// then the request answered; `{error}` for a snapshot or a request that
/// does not read.
pub fn describe_query_json(catalog_json: &str, request_json: &str, zones: &dyn ZoneLookup) -> Value {
    let catalog = match CatalogSnapshot::load(&movement_parser::util::form::read_json_text(catalog_json)) {
        Ok(catalog) => catalog,
        Err(message) => return json!({ "error": { "message": message } }),
    };
    let asked: Asked = match serde_json::from_str(request_json) {
        Ok(asked) => asked,
        Err(e) => return json!({ "error": { "message": format!("the describing request does not read: {e}") } }),
    };
    let levels = Levels { place: asked.showing.into(), landings: asked.landings.into() };
    match &asked.address {
        None => json!({ "legend": LEGEND, "connections": connections_json(&catalog, levels) }),
        Some(address) => match address_json(address, &catalog, levels, zones) {
            Ok(answer) => answer,
            Err(message) => json!({ "error": { "message": message } }),
        },
    }
}

/// Every connection the snapshot describes, at its root, from its schema alone.
fn connections_json(catalog: &CatalogSnapshot, levels: Levels) -> Vec<Value> {
    catalog
        .adapters
        .0
        .iter()
        .flat_map(|(adapter, spec)| {
            spec.schemas.0.iter().map(move |(key, schema)| {
                let root = connection_root(if key.is_empty() { adapter.as_str() } else { key.as_str() }, Rc::new(schema.clone()));
                json!({ "adapter": adapter, "key": key, "place": place_json(&root, levels, true) })
            })
        })
        .collect()
}

fn address_json(address: &str, catalog: &CatalogSnapshot, levels: Levels, zones: &dyn ZoneLookup) -> Result<Value, String> {
    let (read, program) = match Address::read(address) {
        Ok(read) => read,
        Err(refused) => return Ok(json!({ "legend": LEGEND, "diagnostics": [diagnostic_json(&refused)], "place": null })),
    };
    let landed = read.land(&program, catalog, zones)?;
    let diagnostics: Vec<Value> = landed.diagnostics.iter().map(diagnostic_json).collect();
    let place = landed.landing.as_ref().map_or(Value::Null, |landing| place_json(landing, levels, true));
    let mut answer = json!({ "legend": LEGEND, "diagnostics": diagnostics, "place": place });
    if read.walk.is_none()
        && let Some(connection) = &landed.landing
    {
        let records: Vec<Value> = described_record_types(connection).iter().map(|(name, landing)| json!({ "name": name, "place": place_json(landing, levels, true) })).collect();
        answer["records"] = json!(records);
    }
    Ok(answer)
}

fn diagnostic_json(diagnostic: &Diagnostic) -> Value {
    let severity = match diagnostic.severity {
        None => "error",
        Some(Severity::Warning) => "warning",
        Some(Severity::Info) => "info",
    };
    json!({ "code": diagnostic.code, "message": diagnostic.message, "severity": severity })
}

/// What is at `landing`; with `deep`, each edge with where it lands.
fn place_json(landing: &Position, levels: Levels, deep: bool) -> Value {
    let showing = if deep { levels.place } else { levels.landings };
    let described = describe_landing(landing, showing);
    let Description { description, known, members, fields, edges } = &described;
    let mut place = json!({
        "name": landing_name(landing),
        "known": known_name(*known),
        "members": members,
        "fields": fields_json(fields),
        "edges": edges.iter().map(|edge| edge_json(edge, levels, deep)).collect::<Vec<_>>(),
    });
    if let Some(description) = description {
        place["description"] = json!(description);
    }
    place
}

fn known_name(known: Known) -> &'static str {
    match known {
        Known::Whole => "whole",
        Known::Open => "open",
        Known::Undescribed => "undescribed",
    }
}

fn fields_json(fields: &FieldList) -> Value {
    json!({ "shown": fields.shown.iter().map(field_json).collect::<Vec<_>>(), "cut": fields.cut })
}

fn field_json(field: &DescribedField) -> Value {
    let mut value = json!({
        "name": field.name,
        "written": field.written_noted(),
        "markedName": field.marked_name(),
        "type": field.type_,
        "required": field.marks.contains(&Mark::Required),
        "identifying": field.marks.contains(&Mark::Identifying),
        "readOnly": field.marks.contains(&Mark::ReadOnly),
        "writeOnly": field.write_only,
        "pinned": field.pinned,
    });
    if let Some(description) = &field.description {
        value["description"] = json!(description);
    }
    value
}

fn edge_json(edge: &DescribedEdge, levels: Levels, deep: bool) -> Value {
    let mut value = json!({
        "name": edge.name,
        "step": edge.step(),
        "hop": edge.hop(),
        "target": edge.target,
        "read": edge.can.read,
        "write": edge.can.write,
        "fires": edge.can.fires,
    });
    if let Some(description) = &edge.description {
        value["description"] = json!(description);
    }
    if let Some(writes) = &edge.write_fields {
        value["writes"] = fields_json(writes);
    }
    if deep && let Some(landing) = &edge.landing {
        value["lands"] = place_json(landing, levels, false);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use movement_checker::host::native::NativeZones;

    const CATALOG: &str = r#"{"adapters":{"crm":{"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"declaredCredentials":["crm"],"schemaShape":"introspected",
        "schemas":{"workspace":{"positions":{
            "Company":{"properties":{"Name":"text","Stage":{"kind":"enum","options":["Lead","Customer","Lost","Won","Churned","Paused"]},"Id":"text"},"edges":{"People":{"target":"Person","writable":true}}},
            "Person":{"properties":{"Email":"text"},"edges":{}}},
          "collections":{"Company":{"target":"Company","listenable":true}},
          "writableRoots":{"Company":{"fields":{"Name":"text","Stage":{"kind":"enum","options":["Lead","Customer","Lost","Won","Churned","Paused"]}},"resultShape":{},"requiredFields":["Name"],"nativeUniqueness":[["Id"]]}},
          "createShapes":{"Person":{"fields":{"Email":"text"},"resultShape":{},"requiredFields":["Email"]}}}}}},
      "credentials":{"workspace":{"adapters":["crm"],"credential":"crm"}},"plugins":{}}"#;

    fn ask(request: Value) -> Value {
        describe_query_json(CATALOG, &request.to_string(), &NativeZones)
    }

    #[test]
    fn with_no_address_every_connection_is_described_at_its_root_each_edge_with_where_it_lands() {
        let answer = ask(json!({ "landings": { "fields": 2, "enumOptions": 2 } }));
        assert_eq!(answer["legend"], LEGEND);
        let connection = &answer["connections"][0];
        assert_eq!((connection["adapter"].as_str(), connection["key"].as_str()), (Some("crm"), Some("workspace")));
        let edge = &connection["place"]["edges"][0];
        assert_eq!(edge["hop"], "-[:Company]-> Company [r w fires]");
        assert_eq!(edge["step"], "-[:Company]->");
        let lands = &edge["lands"];
        assert_eq!(lands["name"], "Company");
        let written: Vec<&str> = lands["fields"]["shown"].as_array().unwrap().iter().map(|f| f["written"].as_str().unwrap()).collect();
        assert_eq!(written, [r#"Name! text"#, r#"Id*~ text"#]);
        assert_eq!(lands["fields"]["cut"], 1);
        assert!(lands["edges"][0].get("lands").is_none(), "one level deep");
    }

    #[test]
    fn an_address_lands_through_the_checker_and_an_enum_is_cut_the_shared_way() {
        let answer = ask(json!({ "address": "#crm:workspace-[:Company]->", "showing": { "enumOptions": 2 } }));
        assert_eq!(answer["diagnostics"], json!([]));
        let place = &answer["place"];
        assert_eq!(place["name"], "Company");
        let stage = place["fields"]["shown"].as_array().unwrap().iter().find(|f| f["name"] == "Stage").unwrap();
        assert_eq!(stage["written"], r#"Stage "Lead" | "Customer" | …+4"#);
        let people = &place["edges"][0];
        assert_eq!(people["hop"], "-[:People]-> Person [r w]");
        assert_eq!(people["writes"]["shown"][0]["markedName"], "Email!");
        assert_eq!(people["lands"]["fields"]["shown"][0]["written"], "Email! text");
    }

    #[test]
    fn an_address_error_is_the_checkers_diagnostic() {
        let answer = ask(json!({ "address": "#crm:workspace-[:Nowhere]->" }));
        assert_eq!(answer["place"], Value::Null);
        assert_eq!(answer["diagnostics"][0]["code"], "MOV_TRAVERSE_UNKNOWN_EDGE");
        assert!(answer["diagnostics"][0]["message"].as_str().unwrap().contains("Company"), "{answer}");
        let unread = ask(json!({ "address": "#crm:workspace-[:Company" }));
        assert_eq!(unread["diagnostics"][0]["code"], "MOV_PARSE");
        assert!(ask(json!({ "nope": 1 }))["error"]["message"].as_str().unwrap().contains("does not read"));
    }

    #[test]
    fn an_address_with_no_walk_is_the_connection_at_its_root() {
        let answer = ask(json!({ "address": "#crm:workspace" }));
        assert_eq!(answer["diagnostics"], json!([]));
        assert_eq!(answer["place"]["edges"][0]["hop"], "-[:Company]-> Company [r w fires]");
        let records: Vec<&str> = answer["records"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
        assert_eq!(records, ["Company", "Person"]);
        assert!(ask(json!({ "address": "#crm:workspace-[:Company]->" })).get("records").is_none());
    }
}


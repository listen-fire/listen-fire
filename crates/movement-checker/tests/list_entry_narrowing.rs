//! A hop that lands on a type whose members a discriminant tells apart (an
//! Affinity record's `List Entries`, one member per list, told apart by
//! `listName`) lands on the member its WHERE pins with a literal — the same
//! `` `key` == "literal" `` pins an event address states. The member's fields
//! are then readable in the hop's body and in the WHERE's other conjuncts.
//! The member a literal picks is the one the catalog already publishes for
//! writes (`createShapes[…].discriminated`): one member set, both directions.
//! A host's own narrowing (`refinements`) answers first. A pin that picks no
//! member adds no diagnostic of its own: a literal the lists do not include
//! is the discriminant's enum refusal, as it is today.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::{Value, json};

const DEALS: &str = "List Entry — Master Deals List";
const PORTFOLIO: &str = "List Entry — Portfolio";

fn variant(position: &str, fields: Value) -> Value {
    json!({ "fields": fields, "resultShape": { "externalId": "text" }, "position": position })
}

fn catalog(refinements: Option<Value>) -> Value {
    let lists = json!({ "kind": "enum", "options": ["Master Deals List", "Portfolio"] });
    let mut schema = json!({
        "positions": {
            "Organization": {
                "properties": { "Name": "text" },
                "edges": { "List Entries": { "target": "Organization List Entry", "writable": true, "linkable": false } }
            },
            "Organization List Entry": { "properties": { "listName": lists }, "edges": {} },
            DEALS: {
                "properties": {
                    "listName": { "kind": "enum", "options": ["Master Deals List"] },
                    "Deal Created": "date",
                    "Status": "text"
                },
                "edges": {}
            },
            PORTFOLIO: {
                "properties": {
                    "listName": { "kind": "enum", "options": ["Portfolio"] },
                    "Ownership %": "number",
                    "Added On": "date"
                },
                "edges": {}
            },
            "Refined Deals": { "properties": { "listName": "text", "Only Refined": "text" }, "edges": {} }
        },
        "collections": { "Organization": { "target": "Organization" } },
        "writableRoots": {},
        "createShapes": {
            "Organization List Entry": {
                "fields": { "listName": lists },
                "resultShape": { "externalId": "text" },
                "discriminated": {
                    "discriminant": "listName",
                    "variants": {
                        "Master Deals List": variant(DEALS, json!({ "listName": "text", "Deal Created": "date", "Status": "text" })),
                        "Portfolio": variant(PORTFOLIO, json!({ "listName": "text", "Ownership %": "number", "Added On": "date" }))
                    }
                }
            }
        }
    });
    if let Some(refinements) = refinements {
        schema["refinements"] = refinements;
    }
    json!({
        "adapters": { "affinity": {
            "canFire": true,
            "constructionArgs": [{ "name": "credentials", "kind": "credential", "required": true }],
            "schemas": { "Affinity": schema }
        } },
        "credentials": { "Affinity": { "adapters": ["affinity"] } },
        "plugins": {}
    })
}

fn source(hop_where: &str, body: &str) -> String {
    format!(
        "import {{ affinity }} from adapters\nimport {{ Affinity }} from credentials\n\ncrm = connect affinity using Affinity\n\nfunction `Min` (name: <text>, since: <date>) {{\n  return crm-[o:`Organization` WHERE o.`Name` == name]->-[le:`List Entries` WHERE {hop_where}]-> {{\n    return {body}\n  }}\n}}\n"
    )
}

fn errors_under(catalog: &Value, source: &str) -> Vec<String> {
    let catalog = CatalogSnapshot::load(&catalog.to_string()).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .filter(|d| d.severity.is_none())
        .map(|d| format!("{} {}", d.code, d.message))
        .collect()
}

fn errors(hop_where: &str, body: &str) -> Vec<String> {
    errors_under(&catalog(None), &source(hop_where, body))
}

#[test]
fn a_hop_pinned_to_one_list_reads_that_lists_fields() {
    assert_eq!(errors("le.`listName` == \"Master Deals List\"", "le.`Deal Created`"), Vec::<String>::new());
}

#[test]
fn the_pin_may_be_written_literal_first() {
    assert_eq!(errors("\"Master Deals List\" == le.`listName`", "le.`Deal Created`"), Vec::<String>::new());
}

#[test]
fn the_wheres_other_conjuncts_read_the_pinned_lists_fields_in_either_order() {
    for hop_where in [
        "le.`Added On` >= since AND le.`listName` == \"Portfolio\"",
        "le.`listName` == \"Portfolio\" AND le.`Added On` >= since",
    ] {
        assert_eq!(errors(hop_where, "le.`Ownership %`"), Vec::<String>::new(), "{hop_where}");
    }
}

#[test]
fn a_field_of_another_list_is_still_refused() {
    let found = errors("le.`listName` == \"Portfolio\"", "le.`Deal Created`");
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].starts_with("MOV_UNKNOWN_PROPERTY") && found[0].contains("Portfolio") && found[0].contains("'Deal Created'"), "{found:?}");
}

#[test]
fn a_literal_no_list_has_is_refused_naming_the_lists() {
    let found = errors("le.`listName` == \"Pipeline\"", "le.`listName`");
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].contains("\"Pipeline\"") && found[0].contains("Master Deals List") && found[0].contains("Portfolio"), "{found:?}");
}

/// TypeScript's `never`: refused where a field is read off it, as today.
#[test]
fn two_lists_at_once_narrows_nothing() {
    let both = "le.`listName` == \"Portfolio\" AND le.`listName` == \"Master Deals List\"";
    assert_eq!(errors(both, "le.`listName`"), Vec::<String>::new());
    assert_eq!(errors(both, "le.`Deal Created`"), vec![UNNARROWED.to_string()]);
}

/// A list the field admits whose entry type nobody described is not "no
/// list": the hop stays on what every list has, as today.
#[test]
fn a_value_whose_member_nobody_described_narrows_nothing() {
    let mut admitting = catalog(None);
    let lists = json!({ "kind": "enum", "options": ["Master Deals List", "Portfolio", "Pipeline"] });
    admitting["adapters"]["affinity"]["schemas"]["Affinity"]["positions"]["Organization List Entry"]["properties"]["listName"] = lists;
    assert_eq!(errors_under(&admitting, &source("le.`listName` == \"Pipeline\"", "le.`listName`")), Vec::<String>::new());
}

const UNNARROWED: &str = "MOV_UNKNOWN_PROPERTY crm.Organization List Entry has no field 'Deal Created' — it has: listName";

#[test]
fn without_a_pin_the_hop_reads_only_what_every_list_has() {
    assert_eq!(
        errors("le.`listName` != \"Portfolio\"", "le.`Deal Created`"),
        vec![UNNARROWED.to_string()]
    );
    assert_eq!(errors("le.`listName` != \"Portfolio\"", "le.`listName`"), Vec::<String>::new());
}

#[test]
fn a_pin_only_one_side_of_an_or_states_narrows_nothing() {
    let found = errors("le.`listName` == \"Portfolio\" OR le.`listName` == \"Master Deals List\"", "le.`Deal Created`");
    assert_eq!(found, vec![UNNARROWED.to_string()]);
}

/// The key a host registers its narrowing of this WHERE under.
fn refinement_key_of(hop_where: &str) -> String {
    let probe = format!("__movement_path_root__-[le:`List Entries` WHERE {hop_where}]->.`__movement_path_probe__`");
    let movement_parser::lowering::expression::Expression::Traverse { steps, .. } = movement_checker::slots::expression_of_text(&probe).unwrap() else { panic!() };
    let movement_parser::lowering::expression::TraversalStep::Edge(step) = &steps[0] else { panic!() };
    let filter = serde_json::to_value(step.expression_filter.as_deref().unwrap()).unwrap();
    movement_parser::catalog::helpers::refinement_key("Organization List Entry", &filter)
}

#[test]
fn a_hosts_refinement_answers_before_the_literal() {
    let hop_where = "le.`listName` == \"Master Deals List\"";
    let refined = catalog(Some(json!({ refinement_key_of(hop_where): "Refined Deals" })));
    assert_eq!(errors_under(&refined, &source(hop_where, "le.`Only Refined`")), Vec::<String>::new());
    let found = errors_under(&refined, &source(hop_where, "le.`Deal Created`"));
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].contains("Refined Deals has no field 'Deal Created'"), "{found:?}");
}

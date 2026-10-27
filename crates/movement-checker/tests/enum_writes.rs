//! An enum holds every literal written or compared against it: each element
//! of a list literal written into a list of enum, and a WHERE written inside
//! a parameter's type as well as one in a body.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

/// A system `crm`: `Company` records with a single choice (`Stage`) and a
/// multiple choice (`Tags`), both writable.
const CRM: &str = r#"{"adapters":{"crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{"Company":{"properties":{"Name":"text","Stage":{"kind":"enum","options":["Lead","Won"]},"Tags":{"kind":"list","of":{"kind":"enum","options":["Hot","Warm"]}}},"edges":{}}},"collections":{"Companies":{"target":"Company"}},"writableRoots":{"Company":{"fields":{"Name":"text","Stage":{"kind":"enum","options":["Lead","Won"]},"Tags":{"kind":"list","of":{"kind":"enum","options":["Hot","Warm"]}}},"requiredFields":[],"resultShape":{"externalId":"text"}}}}}}},"credentials":{},"plugins":{}}"#;

const HEAD: &str = "import { crm } from adapters\nc = connect crm\n";

fn codes(body: &str) -> Vec<String> {
    let source = format!("{HEAD}{body}");
    let catalog = CatalogSnapshot::load(CRM).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options)
        .unwrap()
        .into_iter()
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

fn unknown_values(found: &[String]) -> Vec<&String> {
    found.iter().filter(|d| d.starts_with("MOV_ENUM_UNKNOWN_VALUE")).collect()
}

#[test]
fn a_text_literal_written_into_an_enum_is_one_of_its_options() {
    let found = codes("function m() {\n  write c-[:Companies]-> { Name: \"A\", Stage: \"Lost\" }\n}\n");
    assert_eq!(unknown_values(&found).len(), 1, "{found:#?}");
}

#[test]
fn each_literal_of_a_list_written_into_a_list_of_enum_is_one_of_its_options() {
    let found = codes("function m() {\n  write c-[:Companies]-> { Name: \"A\", Tags: [\"Hot\", \"Cold\"] }\n}\n");
    let unknown = unknown_values(&found);
    assert_eq!(unknown.len(), 1, "{found:#?}");
    assert!(unknown[0].contains("Cold"), "{unknown:#?}");
}

#[test]
fn a_list_of_known_options_and_unknown_values_passes() {
    let found = codes("function m(t: <text>) {\n  write c-[:Companies]-> { Name: \"A\", Tags: [\"Hot\", \"Warm\"] }\n  write c-[:Companies]-> { Name: \"B\", Tags: [\"Hot\", t] }\n}\n");
    assert!(unknown_values(&found).is_empty(), "{found:#?}");
}

#[test]
fn every_unknown_literal_of_a_list_is_named() {
    let found = codes("function m(t: <text>) {\n  write c-[:Companies]-> { Name: \"A\", Tags: [\"Cold\", t, \"Frozen\"] }\n}\n");
    let unknown = unknown_values(&found);
    assert_eq!(unknown.len(), 2, "{found:#?}");
    assert!(unknown[0].contains("Cold") && unknown[1].contains("Frozen"), "{unknown:#?}");
}

#[test]
fn a_where_in_a_body_is_held_against_the_enum() {
    let found = codes("function m() {\n  return c-[x:Companies WHERE x.Stage == \"Lost\"]->\n}\n");
    assert_eq!(unknown_values(&found).len(), 1, "{found:#?}");
}

#[test]
fn a_where_in_a_parameter_type_is_held_against_the_enum() {
    let found = codes("function m(co: <c-[x:Companies WHERE x.Stage == \"Lost\"]->>) {\n  return co.Name\n}\n");
    assert_eq!(unknown_values(&found).len(), 1, "{found:#?}");
}

#[test]
fn a_known_option_in_a_parameter_type_where_passes() {
    let found = codes("function m(co: <c-[x:Companies WHERE x.Stage == \"Won\"]->>) {\n  return co.Name\n}\n");
    assert!(unknown_values(&found).is_empty(), "{found:#?}");
}

//! A listen's `field` (format `field`: one field of the record the listen
//! watches) and `becomes` (format `field-value`: a value of the field the
//! listen's `field` key names), held against the listened table as the
//! platform narrows it: the event's subject edge lands on the table the
//! listen's address names.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"sheet":{"canFire":true,"constructionArgs":[],"triggerConfig":["table","field","becomes"],"triggerConfigRequired":["table"],"triggerConfigFormats":{"field":"field","becomes":"field-value"},"schemas":{"":{"positions":{"Table":{"properties":{},"edges":{},"undescribed":true},"Candidates":{"properties":{"Name":"text","Stage":{"kind":"enum","options":["Applied","Interview","Rejected"]},"Score":"number","Hired":"boolean","Tags":{"kind":"list","of":{"kind":"enum","options":["Remote","Senior"]}}},"edges":{}},"Change":{"properties":{},"edges":{"Record":{"target":"Table","subject":true}}},"[\"Change\",[[\"table\",\"tblC\"]]]":{"properties":{},"edges":{"Record":{"target":"Candidates","subject":true}}}},"collections":{},"writableRoots":{},"eventPosition":"Change","eventPositions":[{"position":"Change"}],"eventNarrowingKeys":["table"]}}}},"credentials":{},"plugins":{}}"#;

fn check(config: &str) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let source = format!(
        "import {{ sheet }} from adapters\ns = connect sheet\nfunction moved(change: <s-[:Change]->>) {{}}\nlisten to s {{ table: \"tblC\", {config} }} fire moved\n"
    );
    check_source(&source, &catalog, options).unwrap()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

#[test]
fn a_field_of_the_table_and_one_of_its_choices_are_accepted() {
    assert_eq!(codes(&check("field: \"Stage\", becomes: \"Interview\"")), Vec::<&str>::new());
    assert_eq!(codes(&check("field: \"Name\"")), Vec::<&str>::new());
}

#[test]
fn a_field_the_table_does_not_have_is_refused_naming_its_fields() {
    let found = check("field: \"Stge\"");
    assert_eq!(codes(&found), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(found[0].message.contains("'Stge' is not a field of what this listener watches"), "{}", found[0].message);
    assert!(found[0].message.contains("Hired, Name, Score, Stage, Tags"), "{}", found[0].message);
    assert!(found[0].message.contains("did you mean 'Stage'"), "{}", found[0].message);
}

#[test]
fn a_field_is_one_quoted_name() {
    let found = check("field: [\"Stage\"]");
    assert_eq!(codes(&found), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(found[0].message.contains("one quoted field name"), "{}", found[0].message);
}

#[test]
fn an_unknown_choice_of_an_enum_field_is_refused() {
    let found = check("field: \"Stage\", becomes: \"Interveiw\"");
    assert_eq!(codes(&found), ["MOV_ENUM_UNKNOWN_VALUE"]);
    assert!(found[0].message.contains("Did you mean \"Interview\"?"), "{}", found[0].message);
}

#[test]
fn a_value_is_held_to_its_fields_type() {
    assert_eq!(codes(&check("field: \"Score\", becomes: 3")), Vec::<&str>::new());
    assert_eq!(codes(&check("field: \"Hired\", becomes: true")), Vec::<&str>::new());
    let found = check("field: \"Score\", becomes: \"high\"");
    assert_eq!(codes(&found), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(found[0].message.contains("'becomes' is text, but 'Score' holds number"), "{}", found[0].message);
    let found = check("field: \"Name\", becomes: 3");
    assert_eq!(codes(&found), ["MOV_LISTEN_BAD_CONFIG"]);
}

#[test]
fn a_list_fields_value_is_a_list_of_its_choices() {
    assert_eq!(codes(&check("field: \"Tags\", becomes: [\"Remote\", \"Senior\"]")), Vec::<&str>::new());
    assert_eq!(codes(&check("field: \"Tags\", becomes: [\"Remot\"]")), ["MOV_ENUM_UNKNOWN_VALUE"]);
    assert_eq!(codes(&check("field: \"Tags\", becomes: \"Remote\"")), ["MOV_LISTEN_BAD_CONFIG"]);
}

#[test]
fn a_value_without_its_field_is_refused() {
    let found = check("becomes: \"Interview\"");
    assert_eq!(codes(&found), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(found[0].message.contains("add field: \"…\""), "{}", found[0].message);
}

#[test]
fn a_value_is_a_literal() {
    let found = check("field: \"Stage\", becomes: Stage");
    assert_eq!(codes(&found), ["MOV_LISTEN_BAD_CONFIG"]);
    assert!(found[0].message.contains("takes a literal value"), "{}", found[0].message);
}

#[test]
fn an_unnarrowed_table_holds_nothing_against_the_field() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let source = "import { sheet } from adapters\ns = connect sheet\nfunction moved(change: <s-[:Change]->>) {}\nlisten to s { table: \"tblOther\", field: \"Anything\", becomes: 3 } fire moved\n";
    let found = check_source(source, &catalog, options).unwrap();
    assert_eq!(codes(&found), Vec::<&str>::new());
}


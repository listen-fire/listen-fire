//! `connect` names the adapter and the credential itself, so neither needs an
//! import: each of its two positions holds only one kind of name, as a type
//! position does in TypeScript. The import form keeps working within 0.13.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const SNAPSHOT: &str = r#"{"adapters":{
  "attio":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text"},"edges":{}}},"collections":{"companies":{"target":"company"}},"writableRoots":{}}}},
  "hubspot":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{}},
  "email":{"canFire":true,"constructionArgs":[],"schemas":{}}
},"credentials":{"crm_cred":{"adapters":["attio"]},"alice_hubspot":{"adapters":["hubspot"]}},"plugins":{}}"#;

fn check(source: &str) -> Vec<movement_checker::Diagnostic> {
    let catalog = CatalogSnapshot::load(SNAPSHOT).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn found(source: &str) -> Vec<(String, String)> {
    check(source).into_iter().map(|d| (d.code, d.message)).collect()
}

const READS_A_FIELD: &str = "\nfunction m() {\n  names = crm-[c:companies]-> { return c.name }\n  return names\n}\n";

#[test]
fn a_connection_names_its_adapter_and_credential_with_no_import() {
    assert_eq!(found(&format!("crm = connect attio using crm_cred{READS_A_FIELD}")), []);
}

#[test]
fn the_package_tag_names_the_same_adapter() {
    assert_eq!(found(&format!("crm = connect `@lf/attio` using crm_cred{READS_A_FIELD}")), []);
}

#[test]
fn the_connection_is_typed_by_the_schema_its_adapter_and_credential_pick() {
    let source = "crm = connect attio using crm_cred\nfunction m() {\n  names = crm-[c:companies]-> { return c.nope }\n  return names\n}\n";
    let diagnostics = found(source);
    assert!(diagnostics.iter().any(|(_, m)| m.contains("nope")), "{diagnostics:?}");
}

#[test]
fn the_import_form_still_checks_clean() {
    let source = format!("import {{ attio as kind }} from adapters\nimport {{ crm_cred as cred }} from credentials\ncrm = connect kind using cred{READS_A_FIELD}");
    assert_eq!(found(&source), []);
}

#[test]
fn a_connection_s_positions_are_not_hidden_by_a_binding_of_the_same_name() {
    let source = "attio = connect attio using crm_cred\nfunction m() {\n  names = attio-[c:companies]-> { return c.name }\n  return names\n}\n";
    assert_eq!(found(source), []);
}

#[test]
fn a_connection_with_no_credential_is_unchanged() {
    assert_eq!(found("mail = connect email\n"), []);
}

#[test]
fn another_adapter_s_credential_is_refused() {
    let diagnostics = found("hs = connect hubspot using crm_cred\n");
    assert_eq!(diagnostics, [("MOV_CRED_WRONG_ADAPTER".to_string(), "'crm_cred' is a attio credential — 'hubspot' needs a hubspot credential".to_string())]);
}

#[test]
fn an_unknown_credential_names_the_adapter_s_credentials() {
    let diagnostics = found("hs = connect hubspot using alice_hubspt\n");
    assert_eq!(
        diagnostics,
        [("MOV_NAME_UNRESOLVED".to_string(), "'alice_hubspt' is no credential here — did you mean 'alice_hubspot'? (the hubspot credentials: alice_hubspot)".to_string())]
    );
}

#[test]
fn an_unknown_adapter_names_the_adapters() {
    let diagnostics = found("hs = connect hubspt using alice_hubspot\n");
    assert_eq!(
        diagnostics,
        [("MOV_NAME_UNRESOLVED".to_string(), "'hubspt' is no adapter here — did you mean 'hubspot'? (the adapters: attio, hubspot, email)".to_string())]
    );
}

#[test]
fn a_missing_credential_says_how_to_connect() {
    let diagnostics = found("hs = connect hubspot\n");
    assert_eq!(diagnostics, [("MOV_CONSTRUCT_MISSING_CRED".to_string(), "'hubspot' needs a credential to connect with: 'connect hubspot using <credential>'".to_string())]);
}

#[test]
fn the_older_construction_is_refused_with_the_connect_it_is_written_as() {
    let diagnostics = check("crm = attio(credentials: crm_cred)\n");
    let [diagnostic] = diagnostics.as_slice() else { panic!("{diagnostics:?}") };
    assert_eq!(diagnostic.code, "MOV_NAME_UNRESOLVED");
    assert_eq!(diagnostic.message, "an adapter is set up with `connect attio using crm_cred`");
    let fix = diagnostic.fix.as_ref().expect("a fix");
    assert_eq!(fix["edits"][0]["text"], "connect attio using crm_cred");
}

#[test]
fn a_credential_read_as_a_value_says_where_it_belongs() {
    let diagnostics = found("function m() {\n  return crm_cred\n}\n");
    assert_eq!(
        diagnostics,
        [(
            "MOV_NAME_UNRESOLVED".to_string(),
            "'crm_cred' is a credential, which is never a value in a program — it is only named after 'using' where an adapter is connected ('connect … using crm_cred')".to_string()
        )]
    );
}

#[test]
fn an_adapter_read_as_a_value_says_to_connect_it() {
    let diagnostics = found("function m() {\n  return attio-[c:companies]-> { return c.name }\n}\n");
    assert!(
        diagnostics.iter().any(|(c, m)| c == "MOV_NAME_UNRESOLVED" && m.starts_with("'attio' is an adapter, not a connection — connect it and name the connection first: '<name> = connect attio using …' — with the one attio connection here: '<name> = connect attio using crm_cred'")),
        "{diagnostics:?}"
    );
}

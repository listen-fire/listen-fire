//! `connect` names the adapter and the credential itself, so neither needs an
//! import: each of its two positions holds only one kind of name, as a type
//! position does in TypeScript. A module installed from a package is named by
//! its package name, compared whole; a module of the project's own by its key.
//! The import form keeps working within 0.13.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const SNAPSHOT: &str = r#"{"adapters":{
  "attio":{"package":"@lf/attio","canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{"crm_cred":{"positions":{"company":{"properties":{"name":"text"},"edges":{}}},"collections":{"companies":{"target":"company"}},"writableRoots":{}}}},
  "hubspot":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"schemas":{}},
  "email":{"package":"@lf/email","canFire":true,"constructionArgs":[],"schemas":{}}
},"credentials":{"crm_cred":{"adapters":["attio"]},"alice_hubspot":{"adapters":["hubspot"]}},"plugins":{}}"#;

fn check(source: &str) -> Vec<movement_checker::Diagnostic> {
    let catalog = CatalogSnapshot::load(SNAPSHOT).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn found(source: &str) -> Vec<(String, String)> {
    check(source).into_iter().map(|d| (d.code, d.message)).collect()
}

fn one(code: &str, message: &str) -> Vec<(String, String)> {
    vec![(code.to_string(), message.to_string())]
}

const READS_A_FIELD: &str = "\nfunction m() {\n  names = crm-[c:companies]-> { return c.name }\n  return names\n}\n";

#[test]
fn a_package_module_is_connected_by_its_package_name_with_no_import() {
    assert_eq!(found(&format!("crm = connect `@lf/attio` using crm_cred{READS_A_FIELD}")), []);
}

#[test]
fn a_module_of_the_project_s_own_is_connected_by_hash_and_its_key() {
    assert_eq!(found("hs = connect #hubspot using alice_hubspot\n"), []);
}

#[test]
fn a_module_of_the_project_s_own_without_its_hash_is_refused_with_it_as_the_fix() {
    let diagnostics = check("hs = connect hubspot using alice_hubspot\n");
    let [diagnostic] = diagnostics.as_slice() else { panic!("{diagnostics:?}") };
    assert_eq!(diagnostic.code, "MOV_NAME_UNRESOLVED");
    assert_eq!(diagnostic.message, "'hubspot' is a module of this project's own, connected by '#' and its name: `connect #hubspot using alice_hubspot`");
    assert_eq!(diagnostic.fix.as_ref().expect("a fix")["edits"][0]["text"], "connect #hubspot using alice_hubspot");
}

#[test]
fn a_package_module_named_with_a_hash_is_refused_with_its_package_name_as_the_fix() {
    let diagnostics = check(&format!("crm = connect #attio using crm_cred{READS_A_FIELD}"));
    let [diagnostic] = diagnostics.as_slice() else { panic!("{diagnostics:?}") };
    assert_eq!(
        diagnostic.message,
        "'#attio' is installed from the package @lf/attio, and a package module is connected by its package name: `connect `@lf/attio` using crm_cred`"
    );
}

#[test]
fn an_imported_alias_still_names_a_module_of_the_project_s_own() {
    assert_eq!(found("import { hubspot as hs_kind } from adapters\nhs = connect hs_kind using alice_hubspot\n"), []);
}

#[test]
fn the_connection_is_typed_by_the_schema_its_adapter_and_credential_pick() {
    let source = "crm = connect `@lf/attio` using crm_cred\nfunction m() {\n  names = crm-[c:companies]-> { return c.nope }\n  return names\n}\n";
    let diagnostics = found(source);
    assert!(diagnostics.iter().any(|(_, m)| m.contains("nope")), "{diagnostics:?}");
}

#[test]
fn a_package_module_s_key_is_refused_with_its_package_name_as_the_fix() {
    let diagnostics = check(&format!("crm = connect attio using crm_cred{READS_A_FIELD}"));
    let [diagnostic] = diagnostics.as_slice() else { panic!("{diagnostics:?}") };
    assert_eq!(diagnostic.code, "MOV_NAME_UNRESOLVED");
    assert_eq!(
        diagnostic.message,
        "'attio' is installed from the package @lf/attio, and a package module is connected by its package name: `connect `@lf/attio` using crm_cred`"
    );
    assert_eq!(diagnostic.fix.as_ref().expect("a fix")["edits"][0]["text"], "connect `@lf/attio` using crm_cred");
}

#[test]
fn a_package_name_is_compared_whole_never_cut() {
    let hint = "(the adapters: `@lf/attio`, #hubspot, `@lf/email`)";
    assert_eq!(found("hs = connect `@lf/hubspot` using alice_hubspot\n"), one("MOV_NAME_UNRESOLVED", &format!("'@lf/hubspot' is no adapter here — did you mean #hubspot? {hint}")));
    assert_eq!(found("crm = connect `@acme/attio` using crm_cred\n"), one("MOV_NAME_UNRESOLVED", &format!("'@acme/attio' is no adapter here {hint}")));
}

#[test]
fn the_import_form_still_checks_clean() {
    let source = format!("import {{ `@lf/attio` as kind }} from adapters\nimport {{ crm_cred as cred }} from credentials\ncrm = connect kind using cred{READS_A_FIELD}");
    assert_eq!(found(&source), []);
}

#[test]
fn a_connection_s_positions_are_not_hidden_by_a_binding_of_the_same_name() {
    let source = "attio = connect `@lf/attio` using crm_cred\nfunction m() {\n  names = attio-[c:companies]-> { return c.name }\n  return names\n}\n";
    assert_eq!(found(source), []);
}

#[test]
fn a_connection_with_no_credential_is_unchanged() {
    assert_eq!(found("mail = connect `@lf/email`\n"), []);
}

#[test]
fn another_adapter_s_credential_is_refused() {
    assert_eq!(
        found("hs = connect #hubspot using crm_cred\n"),
        one("MOV_CRED_WRONG_ADAPTER", "'crm_cred' is a attio credential — 'hubspot' needs a hubspot credential")
    );
}

#[test]
fn an_unknown_credential_names_the_adapter_s_credentials() {
    assert_eq!(
        found("hs = connect #hubspot using alice_hubspt\n"),
        one("MOV_NAME_UNRESOLVED", "'alice_hubspt' is no credential here — did you mean 'alice_hubspot'? (the hubspot credentials: alice_hubspot)")
    );
}

#[test]
fn an_unknown_adapter_names_the_adapters_as_connect_names_them() {
    assert_eq!(
        found("hs = connect hubspt using alice_hubspot\n"),
        one("MOV_NAME_UNRESOLVED", "'hubspt' is no adapter here — did you mean #hubspot? (the adapters: `@lf/attio`, #hubspot, `@lf/email`)")
    );
}

#[test]
fn a_missing_credential_says_how_to_connect() {
    assert_eq!(found("hs = connect #hubspot\n"), one("MOV_CONSTRUCT_MISSING_CRED", "'hubspot' needs a credential to connect with: 'connect #hubspot using <credential>'"));
}

#[test]
fn the_older_construction_is_refused_with_the_connect_it_is_written_as() {
    let diagnostics = check("crm = attio(credentials: crm_cred)\n");
    let [diagnostic] = diagnostics.as_slice() else { panic!("{diagnostics:?}") };
    assert_eq!(diagnostic.code, "MOV_NAME_UNRESOLVED");
    assert_eq!(diagnostic.message, "an adapter is set up with `connect `@lf/attio` using crm_cred`");
    assert_eq!(diagnostic.fix.as_ref().expect("a fix")["edits"][0]["text"], "connect `@lf/attio` using crm_cred");
}

#[test]
fn a_credential_read_as_a_value_says_where_it_belongs() {
    assert_eq!(
        found("function m() {\n  return crm_cred\n}\n"),
        one(
            "MOV_NAME_UNRESOLVED",
            "'crm_cred' is a credential, which is never a value in a program — it is only named after 'using' where an adapter is connected ('connect … using crm_cred')"
        )
    );
}

#[test]
fn an_adapter_read_as_a_value_says_to_connect_it_by_its_package_name() {
    let diagnostics = found("function m() {\n  return attio-[c:companies]-> { return c.name }\n}\n");
    assert!(
        diagnostics.iter().any(|(c, m)| c == "MOV_NAME_UNRESOLVED"
            && m.starts_with("'attio' is an adapter, not a connection — connect it and name the connection first: '<name> = connect `@lf/attio` using …' — with the one attio connection here: '<name> = connect `@lf/attio` using crm_cred'")),
        "{diagnostics:?}"
    );
}

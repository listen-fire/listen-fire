//! A listen config format this release does not know (a newer module's) loads
//! and checks: its value is a plain value, unchecked, said once as an Info. A
//! module release then never breaks a host on an older core.

use movement_checker::{CheckOptions, Diagnostic, Severity, check_source};
use movement_parser::catalog::types::{CatalogSnapshot, TriggerConfigFormat};

const CATALOG: &str = r#"{"adapters":{"sheet":{"canFire":true,"constructionArgs":[],"triggerConfig":["table","within"],"triggerConfigFormats":{"within":"duration-window"},"schemas":{"":{"positions":{"Change":{"properties":{},"edges":{}}},"collections":{},"writableRoots":{},"eventPosition":"Change","eventPositions":[{"position":"Change"}]}}}},"credentials":{},"plugins":{}}"#;

fn check(config: &str) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let source = format!(
        "import {{ sheet }} from adapters\ns = connect sheet\nfunction moved(change: <s-[:Change]->>) {{}}\nlisten to s {{ table: \"tblC\", {config} }} fire moved\n"
    );
    check_source(&source, &catalog, options).unwrap()
}

#[test]
fn an_unknown_format_loads_as_itself() {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let formats = catalog.adapters.0.get("sheet").unwrap().spec.trigger_config_formats.clone().unwrap();
    assert_eq!(formats.0.get("within"), Some(&TriggerConfigFormat::Unknown("duration-window".into())));
}

#[test]
fn a_key_of_an_unknown_format_checks_as_a_plain_value_with_an_info_naming_the_format() {
    let found = check("within: \"P2D\"");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].code, "MOV_LISTEN_BAD_CONFIG");
    assert_eq!(found[0].severity, Some(Severity::Info));
    assert!(found[0].message.contains("does not know the format 'duration-window'"), "{}", found[0].message);
    assert!(found[0].message.contains("not checked"), "{}", found[0].message);
}

#[test]
fn a_listen_without_the_key_says_nothing() {
    assert_eq!(check("").len(), 0);
}

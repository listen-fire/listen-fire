//! A pin is the host's to hold to the rule: the checker reads its own
//! release's language and says what a pin it does not read is, by name.

use movement_checker::{CheckOptions, check_program, language_version_diagnostic};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::version::LANGUAGE_VERSION;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

/// A program with an error of its own, which a walk reports.
const SOURCE: &str = "function m(n: <number>) {\n  a = nowhere\n}\n";

#[test]
fn a_pin_of_an_older_key_is_refused_with_the_remedy() {
    let refused = language_version_diagnostic("0.11.0").expect("0.11.0 is not this release's key");
    assert_eq!(refused.code, "MOV_LANGUAGE_VERSION_UNSUPPORTED");
    assert_eq!(
        refused.message,
        format!("this automation pins language 0.11.0, which this release ({LANGUAGE_VERSION}) does not read; validate it under {LANGUAGE_VERSION} and upgrade it")
    );
}

#[test]
fn a_newer_pin_is_refused_saying_to_upgrade_the_engine() {
    let refused = language_version_diagnostic("0.13.0").expect("0.13.0 is newer than this release");
    assert_eq!(refused.code, "MOV_LANGUAGE_VERSION_UNSUPPORTED");
    assert_eq!(refused.message, format!("this automation pins language 0.13.0, newer than this release ({LANGUAGE_VERSION}); upgrade the engine"));
}

#[test]
fn this_releases_own_version_says_nothing_and_the_program_is_walked() {
    assert!(language_version_diagnostic(LANGUAGE_VERSION).is_none());
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let program = movement_parser::stmt::parse_program(SOURCE, false).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let codes: Vec<String> = check_program(&program, &catalog, options).into_iter().map(|d| d.code).collect();
    assert_eq!(codes, ["MOV_NAME_UNRESOLVED"]);
}

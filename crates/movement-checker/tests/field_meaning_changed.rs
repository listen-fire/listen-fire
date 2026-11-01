//! A module may say a release of its changed what a field holds
//! (`changedFields`: gmail's `Labels`, label ids before 0.13 and names
//! since). A check for an upgrade from before that release warns where a
//! program reads the field, MOV_FIELD_MEANING_CHANGED, with nothing to
//! rewrite; a check on the release itself says nothing.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{
  "mail":{"canFire":true,"constructionArgs":[],
    "schemas":{"":{"positions":{
      "Message":{"properties":{"Subject":"text","Labels":{"kind":"list","of":"text"}},"edges":{},
        "changedFields":{"Labels":{"release":"0.13.0","note":"it holds label names where it held label ids"}}}},
      "collections":{"Messages":{"target":"Message","listenable":true,"identity":"Id","delivery":"polled","pollEverySeconds":60}},
      "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

const PROGRAM: &str = "import { mail as mail_module } from adapters\nmail = connect mail_module\nfunction triage(m: <mail-[:Messages]->>) {\n  return m.Labels\n}\nlisten to mail-[m:Messages WHERE m.Labels CONTAINS \"Label_12\"]-> fire triage\n";

fn checked(pin: Option<&str>) -> Vec<Diagnostic> {
    let options = CheckOptions { upgrading_from: pin, zones: &movement_checker::host::native::NativeZones };
    check_source(PROGRAM, &CatalogSnapshot::load(CATALOG).unwrap(), options).unwrap()
}

#[test]
fn a_read_of_a_field_whose_meaning_changed_is_a_warning_on_an_upgrade_from_before() {
    let found = checked(Some("0.12.13"));
    let told: Vec<&Diagnostic> = found.iter().filter(|d| d.code == "MOV_FIELD_MEANING_CHANGED").collect();
    // Once where the function reads it, once in the listen's WHERE.
    assert_eq!(told.len(), 2, "{found:?}");
    assert!(told.iter().all(|d| !d.is_error() && d.upgrade == Some(true)), "{found:?}");
    assert_eq!(
        told[0].message,
        "'Labels' changed meaning in 0.13.0: it holds label names where it held label ids. Under 0.12.13 it held what it held then: check this read before moving the pin"
    );
    assert!(found.iter().all(|d| !d.is_error()), "{found:?}");
}

#[test]
fn a_check_on_the_release_that_changed_it_says_nothing() {
    for pin in [None, Some("0.13.0")] {
        let found = checked(pin);
        assert!(found.iter().all(|d| d.code != "MOV_FIELD_MEANING_CHANGED"), "{pin:?}: {found:?}");
    }
}

//! What `List.groupBy` and `List.keyBy` file each member under. A run refuses
//! a member whose key answers nothing, so a key that may be absent is
//! warned of where it is written (a warning under this release's
//! compatibility key, which accepts what it did).

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_checker::Severity;
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"manual":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"Invocation":{"properties":{"Text":"text"},"edges":{}}},"collections":{"Invocations":{"target":"Invocation","readable":false,"listenable":true,"delivery":"connection"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn check(body: &str) -> Vec<Diagnostic> {
    let source = format!("function go(i: <manual-[:Invocations]->>) {{\n{body}\n}}\nlisten to manual-[:Invocations]-> fire go\n");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &CatalogSnapshot::load(CATALOG).unwrap(), options).unwrap()
}

fn codes(found: &[Diagnostic]) -> Vec<(&str, Option<Severity>)> {
    found.iter().map(|d| (d.code.as_str(), d.severity)).collect()
}

#[test]
fn a_key_that_may_answer_nothing_is_warned_of() {
    for op in ["List.groupBy", "List.keyBy"] {
        let found = check(&format!("  by = {op}([\"a\", \"b\"], (s) => s == \"a\" ? null : s)\n  return count(by)"));
        assert_eq!(codes(&found), [("MOV_DICT_KEY_MAY_BE_ABSENT", Some(Severity::Warning))], "{op}: {found:?}");
        assert!(found[0].message.contains("coalesce("), "{}", found[0].message);
    }
}

#[test]
fn a_key_with_a_fallback_is_not() {
    let found = check("  by = List.groupBy([\"a\", \"b\"], (s) => coalesce(s == \"a\" ? null : s, \"none\"))\n  return count(by)");
    assert_eq!(codes(&found), []);
    let found = check("  by = List.groupBy([\"a\", \"b\"], (s) => s)\n  return count(by)");
    assert_eq!(codes(&found), []);
}

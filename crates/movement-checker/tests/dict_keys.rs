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

// ── Listing a dict: Dict.keys, Dict.values, Dict.entries; List.distinct ──

const BY: &str = "  by = List.groupBy([{ who: \"Tom\", n: 1 }, { who: \"Ann\", n: 2 }], (r) => r.who)\n";

#[test]
fn a_dict_lists_its_keys_values_and_entries_typed_by_the_dict() {
    let found = check(&format!(
        "{BY}  keys = Text.join(sort(Dict.keys(by)), \", \")\n  sizes = List.sum(map(Dict.values(by), (g) => count(g)))\n  lines = map(sort(Dict.entries(by), (e) => e.key), (e) => \"${{e.key}}: ${{List.sum(map(e.value, (r) => r.n))}}\")\n  return \"${{keys}} ${{sizes}} ${{Text.join(lines, \", \")}}\""
    ));
    assert_eq!(codes(&found), []);
}

#[test]
fn a_dict_s_keys_come_in_no_order() {
    for fold in ["first(Dict.keys(by))", "Text.join(Dict.keys(by), \", \")", "reduce(Dict.keys(by), (s, k) => \"${s}${k}\", \"\")", "Dict.keys(by)[0]", "first(Dict.values(by))", "first(Dict.entries(by))?.key"] {
        let found = check(&format!("{BY}  x = {fold}\n  return x"));
        assert_eq!(codes(&found), [("MOV_FOLD_NEEDS_ORDER", None)], "{fold}: {found:?}");
    }
    let found = check(&format!("{BY}  ks = Dict.keys(by)\n  return Text.join(map(ks, (k) => k), \", \")"));
    assert_eq!(codes(&found), [("MOV_FOLD_NEEDS_ORDER", None)], "{found:?}");
}

#[test]
fn only_a_dict_has_keys() {
    for arg in ["[\"a\"]", "\"a\""] {
        let found = check(&format!("  x = Dict.keys({arg})\n  return count(x)"));
        assert_eq!(codes(&found), [("MOV_BUILTIN_ARG_TYPE", None)], "{arg}: {found:?}");
    }
    assert_eq!(codes(&check("  return Text.join(sort(Dict.keys({ a: 1, b: 2 })), \",\")")), []);
}

#[test]
fn distinct_keeps_the_order_its_list_has() {
    assert_eq!(codes(&check("  return first(List.distinct([\"b\", \"a\", \"b\"]))")), []);
    let found = check(&format!("{BY}  return first(List.distinct(Dict.keys(by)))"));
    assert_eq!(codes(&found), [("MOV_FOLD_NEEDS_ORDER", None)], "{found:?}");
}

#[test]
fn a_dict_namespace_is_a_word_no_name_takes() {
    let found = check("  Dict = 1\n  return Dict");
    assert!(found.iter().any(|d| d.code == "MOV_V5_HIDES_BUILTIN"), "{found:?}");
}

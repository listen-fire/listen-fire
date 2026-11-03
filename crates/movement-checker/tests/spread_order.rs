//! A list literal holds its members in the order written, and a spread keeps
//! the order of what it splices in: spreading a collection in no order gives
//! a list in no order. An order-dependent operation over it (`first`, `[0]`,
//! `Text.join`, `reduce`) is refused (`MOV_FOLD_NEEDS_ORDER`) as it is over
//! the collection itself; 0.14 read every list literal as ordered.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"crm":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"Person":{"properties":{"Name":"text","Age":"number"},"edges":{"Friends":{"target":"Person"}}}},"collections":{"People":{"target":"Person"}},"writableRoots":{}}}},"manual":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"Invocation":{"properties":{"Text":"text"},"edges":{}}},"collections":{"Invocations":{"target":"Invocation","readable":false,"listenable":true,"delivery":"connection"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn check(body: &str) -> Vec<Diagnostic> {
    let source = format!("c = connect #crm\nfunction go(i: <manual-[:Invocations]->>) {{\n{body}\n}}\nlisten to manual-[:Invocations]-> fire go\n");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &CatalogSnapshot::load(CATALOG).unwrap(), options).unwrap()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

const UNORDERED: &str = "  ns = c-[p:People]-> { return p.Name }\n";
const ORDERED: &str = "  ns = c-[p:People ORDER BY p.Name]-> { return p.Name }\n";

#[test]
fn a_spread_of_a_collection_in_no_order_gives_a_list_in_no_order() {
    for read in [
        "return Text.join([...ns], \",\")",
        "return first([...ns])",
        "return [...ns][0]",
        "return reduce([...ns], (s, n) => \"${s}${n}\", \"\")",
        "return Text.join([\"a\", ...ns], \",\")",
        "xs = [...ns]\n  return Text.join(xs, \",\")",
        "xs = [...ns, \"z\"]\n  return first(xs)",
        "xs = [...ns]\n  return reduce(xs, (s, n) => \"${s}${n}\", \"\")",
        "return Text.join([...[...ns]], \",\")",
        "return Text.join([...Dict.keys(List.groupBy(ns, (n) => n))], \",\")",
    ] {
        let found = check(&format!("{UNORDERED}  {read}"));
        assert_eq!(codes(&found), ["MOV_FOLD_NEEDS_ORDER"], "{read}: {found:?}");
    }
}

#[test]
fn a_spread_of_a_walk_in_no_order_gives_a_list_in_no_order() {
    let found = check("  return Text.join([...c-[p:People]->.Name], \",\")");
    assert_eq!(codes(&found), ["MOV_FOLD_NEEDS_ORDER"], "{found:?}");
}

#[test]
fn a_spread_of_an_ordered_collection_stays_ordered() {
    for body in [
        format!("{ORDERED}  return Text.join([...ns], \",\")"),
        format!("{ORDERED}  xs = [\"a\", ...ns]\n  return first(xs)"),
        format!("{UNORDERED}  return Text.join([...sort(ns)], \",\")"),
        format!("{UNORDERED}  xs = [...sort(ns)]\n  return reduce(xs, (s, n) => \"${{s}}${{n}}\", \"\")"),
        format!("{UNORDERED}  return Text.join([\"a\", \"b\"], \",\")"),
        format!("{UNORDERED}  return count([...ns])"),
    ] {
        let found = check(&body);
        assert_eq!(codes(&found), Vec::<&str>::new(), "{body}: {found:?}");
    }
}

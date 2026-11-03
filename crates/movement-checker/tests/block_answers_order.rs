//! A block over a walk answers what each record it walked returned, in the
//! walk's order: with no `ORDER BY`, none. An order-dependent operation over
//! those answers (`first`, `[0]`, `Text.join`, `reduce`) is refused as it is
//! over the walk itself (`MOV_FOLD_NEEDS_ORDER`). 0.14 said nothing where the
//! block answered the records themselves.

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

#[test]
fn the_records_a_block_answers_come_in_no_order() {
    for (block, read) in [
        ("c-[p:People]-> { return p }", "first(ns)?.Name"),
        ("c-[p:People]-> { return p }", "ns[0]?.Name"),
        ("c-[p:People]->-[f:Friends]-> { return f }", "first(ns)?.Name"),
        ("c-[p:People]-> { return p }", "Text.join(map(ns, (x) => x.Name), \", \")"),
    ] {
        let found = check(&format!("  ns = {block}\n  return {read}"));
        assert_eq!(codes(&found), ["MOV_FOLD_NEEDS_ORDER"], "{block} / {read}: {found:?}");
    }
}

#[test]
fn the_values_a_block_answers_come_in_no_order() {
    for read in ["Text.join(ns, \", \")", "first(ns)", "ns[0]", "reduce(ns, (s, n) => \"${s}${n}\", \"\")"] {
        let found = check(&format!("  ns = c-[p:People]-> {{ return p.Name }}\n  return {read}"));
        assert_eq!(codes(&found), ["MOV_FOLD_NEEDS_ORDER"], "{read}: {found:?}");
    }
}

#[test]
fn an_ordered_walk_or_a_sort_gives_them_an_order() {
    for body in [
        "  ns = c-[p:People ORDER BY p.Name]-> { return p }\n  return first(ns)?.Name",
        "  ns = c-[p:People ORDER BY p.Name]-> { return p.Name }\n  return Text.join(ns, \", \")",
        "  ns = c-[p:People]-> { return p.Name }\n  return Text.join(sort(ns), \", \")",
        "  ns = c-[p:People]-> { return p }\n  return count(ns)",
    ] {
        let found = check(body);
        assert_eq!(codes(&found), Vec::<&str>::new(), "{body}: {found:?}");
    }
}

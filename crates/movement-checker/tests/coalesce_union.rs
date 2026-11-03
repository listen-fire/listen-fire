//! `coalesce` typed as TypeScript types `a ?? b ?? c`: the union of what each
//! argument it reaches holds, absent only where every one of them may be. In
//! 0.14 arguments of different kinds answered "unknown", and every later check
//! on the value said nothing.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"manual":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"Invocation":{"properties":{"Text":{"kind":"maybeAbsent","of":"text"},"Count":{"kind":"maybeAbsent","of":"number"},"Tags":{"kind":"maybeAbsent","of":{"kind":"list","of":"text"}},"Stage":{"kind":"maybeAbsent","of":{"kind":"enum","options":["Open","Done"]}}},"edges":{}}},"collections":{"Invocations":{"target":"Invocation","readable":false,"listenable":true,"delivery":"connection"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn check(body: &str) -> Vec<Diagnostic> {
    let source = format!("function go(i: <manual-[:Invocations]->>) {{\n{body}\n}}\nlisten to manual-[:Invocations]-> fire go\n");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &CatalogSnapshot::load(CATALOG).unwrap(), options).unwrap()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

#[test]
fn a_text_or_an_empty_list_is_no_collection() {
    // The held-out run's program: it checked clean, then failed whenever
    // `Text` was there.
    let found = check("  held = coalesce(i.Text, [])\n  return map(held, (n) => n)");
    assert_eq!(codes(&found), ["MOV_COLLECTION_OP_NOT_A_COLLECTION"], "{found:?}");
    assert!(found[0].message.contains("[] | text"), "{}", found[0].message);
}

#[test]
fn a_number_or_a_text_is_no_number() {
    let found = check("  x = coalesce(i.Count, \"n/a\")\n  return x + 1");
    assert_eq!(codes(&found), ["MOV_ARITH_NON_NUMERIC"], "{found:?}");
    assert!(found[0].message.contains("number | text"), "{}", found[0].message);
    let found = check("  x = coalesce(i.Text, i.Count)\n  return Text.upper(x)");
    assert_eq!(codes(&found), ["MOV_BUILTIN_ARG_TYPE"], "{found:?}");
}

#[test]
fn arguments_of_one_kind_check_as_before() {
    for body in [
        "  x = coalesce(i.Count, 0)\n  return x + 1",
        "  x = coalesce(i.Tags, [])\n  return Text.join(sort(map(x, (t) => Text.upper(t))), \", \")",
        "  x = coalesce(i.Tags, [\"none\"])\n  return count(x)",
        "  x = coalesce(i.Stage, \"none\")\n  return Text.upper(x)",
        "  x = coalesce(i.Text, \"\")\n  return Text.upper(x)",
        "  x = coalesce(i.Count, \"none\")\n  return \"${x}\"",
    ] {
        let found = check(body);
        assert_eq!(codes(&found), Vec::<&str>::new(), "{body}: {found:?}");
    }
}

#[test]
fn an_argument_that_is_always_there_is_the_last_one_reached() {
    // `coalesce(n, "x")` where `n` is always there is `n`, as `n ?? "x"` is in
    // TypeScript: the fallback is never reached, so it does not widen the type.
    let found = check("  n = coalesce(i.Count, 0)\n  x = coalesce(n, \"n/a\")\n  return x + 1");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:?}");
}

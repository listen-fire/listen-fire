//! 0.14 retires `lazy` for a closure: `tables = () => s-[t:Tables]->`, read
//! as `tables()`. Each `lazy` is refused where it is written
//! (MOV_LAZY_RETIRED), with a rewrite where the closure means what `lazy`
//! meant: safe for a binding read only where a call's answer reads the same,
//! and for a returned walk; not applied without `--all` for a binding bound
//! whole to another name or a node's entry; none for a binding passed to a
//! function. Each rewrite checks clean.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const STORE: &str = r#"{"adapters":{
  "store":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Table":{"properties":{"Name":"text"},"edges":{"History":{"target":"Change"}}},
    "Change":{"properties":{"Id":"text","Kind":"text"},"edges":{}}},
    "collections":{"Tables":{"target":"Table"}},"writableRoots":{}}}}
},"credentials":{},"plugins":{}}"#;

const HEAD: &str = "import { store } from adapters\n\ns = connect store\n\n";

fn check(body: &str) -> Vec<Diagnostic> {
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let source = format!("{HEAD}{body}");
    check_source(&source, &CatalogSnapshot::load(STORE).unwrap(), options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().filter(|d| d.severity != Some(movement_checker::Severity::Info)).map(|d| d.code.as_str()).collect()
}

/// `body` with every edit of every MOV_LAZY_RETIRED fix applied, as
/// `listen-fire upgrade --all` applies them (columns in UTF-16 units).
fn rewritten(body: &str) -> String {
    let source = format!("{HEAD}{body}");
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    let lines: Vec<usize> = std::iter::once(0).chain(source.encode_utf16().enumerate().filter(|(_, u)| *u == u16::from(b'\n')).map(|(i, _)| i + 1)).collect();
    let offset = |loc: &serde_json::Value| lines[loc["line"].as_u64().unwrap() as usize - 1] + loc["col"].as_u64().unwrap() as usize - 1;
    for d in check(body).into_iter().filter(|d| d.code == "MOV_LAZY_RETIRED") {
        for e in d.fix.expect("a fix")["edits"].as_array().unwrap() {
            edits.push((offset(&e["span"]["start"]), offset(&e["span"]["end"]), e["text"].as_str().unwrap().to_string()));
        }
    }
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut units: Vec<u16> = source.encode_utf16().collect();
    for (from, to, text) in edits {
        units.splice(from..to, text.encode_utf16());
    }
    String::from_utf16(&units).unwrap()[HEAD.len()..].to_string()
}

fn safe(d: &Diagnostic) -> bool {
    d.fix.as_ref().is_some_and(|f| f["safe"] == serde_json::Value::Bool(true))
}

const BINDING: &str = "function lz() {
  tables = lazy s-[t:Tables]->
  n = count(tables)
  names = tables.Name
  past = tables-[c:History WHERE c.Id == \"A\"]-> {
    return c.Kind
  }
  shown = \"${tables.Name}\"
  return { n: n, names: names, past: past, shown: shown, later: count(tables-[:History]->) }
}
";

#[test]
fn a_lazy_binding_is_refused_and_rewritten_safely_to_a_closure_and_its_calls() {
    let found = check(BINDING);
    assert_eq!(codes(&found), ["MOV_LAZY_RETIRED"], "{found:?}");
    let d = &found[0];
    assert_eq!((d.span.start.line, d.span.start.col), (6, 12), "{d:?}");
    assert!(d.severity.is_none(), "an error: {d:?}");
    assert_eq!(
        d.message,
        "`lazy` is retired in 0.14: a closure keeps a walk to run where it is read. Write `tables = () => s-[t:Tables]->` and read it as `tables()`; `listen-fire upgrade` rewrites it"
    );
    assert!(safe(d), "{d:?}");
    let closure = rewritten(BINDING);
    assert_eq!(
        closure,
        BINDING
            .replace("lazy s-", "() => s-")
            .replace("count(tables)", "count(tables())")
            .replace("tables.Name", "tables().Name")
            .replace("tables-[", "tables()-[")
    );
    assert_eq!(codes(&check(&closure)), Vec::<&str>::new(), "{closure}");
}

#[test]
fn a_mapped_lazy_binding_becomes_a_closure_returning_the_walks_block() {
    let body = "function lz() {\n  labelled = lazy s-[t:Tables]-> node { label: t.Name }\n  return labelled.label\n}\n";
    let found = check(body);
    assert_eq!(codes(&found), ["MOV_LAZY_RETIRED"], "{found:?}");
    assert!(safe(&found[0]));
    assert!(found[0].message.contains("Write `labelled = () => { return s-[t:Tables]-> { return node { … } } }`"), "{}", found[0].message);
    let closure = rewritten(body);
    assert_eq!(
        closure,
        "function lz() {\n  labelled = () => {\n    return s-[t:Tables]-> {\n      return node { label: t.Name }\n    }\n  }\n  return labelled().label\n}\n"
    );
    assert_eq!(codes(&check(&closure)), Vec::<&str>::new(), "{closure}");
}

#[test]
fn a_returned_lazy_walk_drops_lazy() {
    let body = "function kept() {\n  return lazy s-[t:Tables]->\n}\n\nfunction lz() {\n  return kept().Name\n}\n";
    let found = check(body);
    assert_eq!(codes(&found), ["MOV_LAZY_RETIRED"], "{found:?}");
    assert!(safe(&found[0]));
    let plain = rewritten(body);
    assert_eq!(plain, body.replace("lazy ", ""));
    assert_eq!(codes(&check(&plain)), Vec::<&str>::new(), "{plain}");
}

#[test]
fn a_lazy_node_entry_is_refused_and_dropping_lazy_is_not_safe() {
    let body = "function lz() {\n  g = node { tabs: lazy s-[t:Tables]->, label: \"x\" }\n  return count(g-[:tabs]->)\n}\n";
    let found = check(body);
    assert_eq!(codes(&found), ["MOV_LAZY_RETIRED"], "{found:?}");
    let d = &found[0];
    assert_eq!((d.span.start.line, d.span.start.col), (6, 14), "{d:?}");
    assert!(d.fix.is_some() && !safe(d), "{d:?}");
    assert!(d.message.contains("bind a closure beside the node (`tabs = () => s-[t:Tables]->`) and read it as `tabs()`"), "{}", d.message);
    assert!(d.message.contains("the walk then runs once, when the node is built, where `lazy` ran it at every read of 'tabs'"), "{}", d.message);
    let eager = rewritten(body);
    assert_eq!(eager, body.replace("lazy ", ""));
    assert_eq!(codes(&check(&eager)), Vec::<&str>::new(), "{eager}");
}

#[test]
fn a_lazy_binding_bound_whole_to_another_name_is_rewritten_only_under_all() {
    let body = "function lz() {\n  tables = lazy s-[t:Tables]->\n  held = tables\n  return held.Name\n}\n";
    let found = check(body);
    assert_eq!(codes(&found), ["MOV_LAZY_RETIRED"], "{found:?}");
    let d = &found[0];
    assert!(d.fix.is_some() && !safe(d), "{d:?}");
    assert!(d.message.contains("'held' then holds what the walk landed on when it was bound, where 'tables' bound whole kept the walk, and each read walked again"), "{}", d.message);
    let closure = rewritten(body);
    assert_eq!(closure, body.replace("lazy s-", "() => s-").replace("held = tables", "held = tables()"));
    assert_eq!(codes(&check(&closure)), Vec::<&str>::new(), "{closure}");
}

#[test]
fn a_lazy_binding_passed_to_a_function_has_no_rewrite() {
    let body = "function named(t: <s-[:Tables]->>) {\n  return t.Name\n}\n\nfunction lz() {\n  tables = lazy s-[t:Tables]->\n  return named(tables)\n}\n";
    let found = check(body);
    assert_eq!(codes(&found), ["MOV_LAZY_RETIRED"], "{found:?}");
    assert!(found[0].fix.is_none(), "{:?}", found[0]);
    assert!(found[0].message.contains("there is no rewrite: 'tables' is passed to 'named'"), "{}", found[0].message);
}

#[test]
fn a_read_inside_a_closures_block_in_an_expression_is_rewritten() {
    let body = "function lz() {
  tables = lazy s-[t:Tables]->
  names = map([1], (i) => {
    return count(tables)
  })
  return names
}
";
    let found = check(body);
    assert_eq!(codes(&found), ["MOV_LAZY_RETIRED"], "{found:?}");
    assert!(safe(&found[0]), "{:?}", found[0]);
    let closure = rewritten(body);
    assert_eq!(closure, body.replace("lazy s-", "() => s-").replace("count(tables)", "count(tables())"));
    assert_eq!(codes(&check(&closure)), Vec::<&str>::new(), "{closure}");
}

#[test]
fn a_naming_the_rewrite_cannot_account_for_withholds_it() {
    let body = "function lz() {
  tables = lazy s-[t:Tables]->
  delete tables
}
";
    let told: Vec<Diagnostic> = check(body).into_iter().filter(|d| d.code == "MOV_LAZY_RETIRED").collect();
    assert_eq!(told.len(), 1, "{told:?}");
    assert!(told[0].fix.is_none(), "{:?}", told[0]);
    assert!(told[0].message.ends_with("(there is no rewrite: 'tables' is named somewhere a call can't stand, so rewrite it by hand)"), "{}", told[0].message);
}

#[test]
fn the_closure_forms_check_clean() {
    let body = "function lz() {
  tables = () => s-[t:Tables]->
  labelled = () => {
    return s-[t:Tables]-> {
      return node { label: t.Name }
    }
  }
  g = node { tabs: s-[t:Tables]-> }
  return { n: count(tables()), labels: labelled().label, tabs: count(g-[:tabs]->), past: count(tables()-[:History]->) }
}
";
    assert_eq!(codes(&check(body)), Vec::<&str>::new());
}

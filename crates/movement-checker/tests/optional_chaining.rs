//! A field read through a value that may be missing is refused
//! (MOV_ABSENT_REQUIRED), whatever the value is: a graph record a walk may
//! not find, a nested call's or an index's result, a held record. `x?.F`
//! reads it, absent when `x` is; narrowing (`exists(x)`, `x != null`,
//! `x?.F != null`) proves it there. The refusal's fix is `?.`, safe: the two
//! read alike.

use movement_checker::CheckOptions;
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::Value;

const CATALOG: &str = r#"{"adapters":{"at":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
  "Table":{"properties":{"Name":"text","Topic":"text"},"edges":{}}},
  "collections":{"Tables":{"target":"Table"}},
  "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn diagnostics(body: &str) -> (String, Vec<movement_checker::Diagnostic>) {
    let source = format!("import {{ at as m }} from adapters\nat = connect m\nfunction go() {{\n{body}\n}}\n");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let found = movement_checker::check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    (source, found.into_iter().filter(|d| d.severity.is_none()).collect())
}

fn check(body: &str) -> Vec<String> {
    diagnostics(body).1.into_iter().map(|d| format!("{} {}", d.code, d.message)).collect()
}

/// The source with every refusal's fix applied, each a one-line insertion.
fn fixed(body: &str) -> String {
    let (source, found) = diagnostics(body);
    let mut lines: Vec<String> = source.lines().map(String::from).collect();
    let mut edits: Vec<(usize, usize, String)> = found
        .iter()
        .map(|d| {
            let fix = d.fix.as_ref().unwrap_or_else(|| panic!("no fix: {}", d.message));
            assert_eq!(fix["safe"], Value::Bool(true), "{}", d.message);
            let edit = &fix["edits"][0];
            let (start, end) = (&edit["span"]["start"], &edit["span"]["end"]);
            assert_eq!(start, end, "an insertion");
            (start["line"].as_u64().unwrap() as usize, start["col"].as_u64().unwrap() as usize, edit["text"].as_str().unwrap().to_string())
        })
        .collect();
    edits.sort();
    for (line, col, text) in edits.into_iter().rev() {
        lines[line - 1].insert_str(col - 1, &text);
    }
    lines.join("\n")
}

const T: &str = "  t = only(at-[:Tables]->)\n";

#[test]
fn a_field_is_never_read_off_a_record_a_walk_may_not_find() {
    assert_eq!(
        check(&format!("{T}  return t.Name")),
        ["MOV_ABSENT_REQUIRED 't' may be absent, and 't.Name' reads through it. Read it with `t?.Name` (absent when 't' is), or test it first: `exists(t) && t.Name …`, or read it inside `if (exists(t)) { … }`. (see handbook: front#maybe-absent)"]
    );
    // The presence test the handbook used to recommend reads through it too.
    assert_eq!(check(&format!("{T}  if (t.Topic != null) {{\n    return t.Topic\n  }}\n  return \"none\"")).len(), 1);
}

#[test]
fn optional_chaining_reads_it_and_narrowing_proves_it_there() {
    for clean in [
        format!("{T}  return t?.Name"),
        format!("{T}  if (t?.Topic != null) {{\n    return t.Topic\n  }}\n  return \"none\""),
        format!("{T}  if (exists(t)) {{\n    return t.Name\n  }}\n  return \"none\""),
        format!("{T}  if (t != null) {{\n    return t.Name\n  }}\n  return \"none\""),
        format!("{T}  return exists(t) && t.Name == \"a\""),
        format!("{T}  return t?.Name == \"a\" && t.Topic == \"b\""),
        // A value that is never missing may be read either way, as TypeScript allows.
        format!("{T}  if (t != null) {{\n    return t?.Name\n  }}\n  return \"none\""),
    ] {
        assert_eq!(check(&clean), Vec::<String>::new(), "{clean}");
    }
}

#[test]
fn a_nested_call_or_an_index_is_a_value_that_may_be_missing() {
    for (refused, read) in [
        ("  return only(at-[:Tables]->).Name", "  return only(at-[:Tables]->)?.Name"),
        ("  l = [only(at-[:Tables]->), only(at-[:Tables]->)]\n  return l[1].Name", "  l = [only(at-[:Tables]->), only(at-[:Tables]->)]\n  return l[1]?.Name"),
    ] {
        assert_eq!(
            check(refused),
            ["MOV_ABSENT_REQUIRED this value may be absent, and '.Name' reads through it. Read it with `?.Name` (absent when the value is), or test the value with `exists(…)` first. (see handbook: front#maybe-absent)"],
            "{refused}"
        );
        assert_eq!(check(read), Vec::<String>::new(), "{read}");
    }
}

#[test]
fn the_fix_is_optional_chaining_and_checks_clean() {
    let body = format!("{T}  u = only(at-[:Tables]->)\n  return [t.Name, u.Name, t.Topic, only(at-[:Tables]->).Name]");
    let after = fixed(&body);
    assert!(after.contains("return [t?.Name, u?.Name, t?.Topic, only(at-[:Tables]->)?.Name]"), "{after}");
    let body = after.split("function go() {\n").nth(1).unwrap().trim_end_matches("\n}");
    assert_eq!(check(body), Vec::<String>::new());
}

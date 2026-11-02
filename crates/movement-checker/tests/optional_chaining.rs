//! A field read through a value that may be missing is refused
//! (MOV_ABSENT_REQUIRED), whatever the value is: a graph record a walk may
//! not find, a nested call's or an index's result, a held record. `x?.F`
//! reads it, absent when `x` is; narrowing (`exists(x)`, `x != null`,
//! `x?.F != null`) proves it there, and a test of `l[1]` (`l[1] != null`,
//! `exists(l[1])`) proves every later `l[1]` (a name at a literal index),
//! never a call's result. A map's member is one entry, `d.a` or `d["a"]`.
//! The refusal's fix is `?.`, safe: the two read alike.

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

const L: &str = "  l = [only(at-[:Tables]->), only(at-[:Tables]->)]\n";
const D: &str = "  d = {a: only(at-[:Tables]->)}\n";

#[test]
fn a_nested_call_or_an_index_is_a_value_that_may_be_missing() {
    let call = "  return only(at-[:Tables]->).Name";
    assert_eq!(
        check(call),
        ["MOV_ABSENT_REQUIRED this value may be absent, and '.Name' reads through it. Read it with `?.Name` (absent when the value is), or name the value and test the name first: `x = …`, then `exists(x)`. (see handbook: front#maybe-absent)"]
    );
    assert_eq!(check("  return only(at-[:Tables]->)?.Name"), Vec::<String>::new());
    assert_eq!(
        check(&format!("{L}  return l[1].Name")),
        ["MOV_ABSENT_REQUIRED 'l[1]' may be absent, and 'l[1].Name' reads through it. Read it with `l[1]?.Name` (absent when 'l[1]' is), or test it first: `l[1] != null && l[1].Name …`. (see handbook: front#maybe-absent)"]
    );
    assert_eq!(check(&format!("{L}  return l[1]?.Name")), Vec::<String>::new());
}

#[test]
fn an_index_read_is_narrowed_by_what_it_reads() {
    for clean in [
        format!("{L}  if (l[1] != null) {{\n    return l[1].Name\n  }}\n  return \"none\""),
        format!("{L}  return l[1] != null && l[1].Name == \"a\""),
        format!("{L}  return l[1] == null || l[1].Name == \"a\""),
        format!("{L}  return l[1] != null ? l[1].Name : \"none\""),
        format!("{L}  if (l[1] == null) {{ fail(\"none\") }}\n  return l[1].Name"),
        format!("{L}  return l[1]?.Name != null && l[1].Topic == \"a\""),
        format!("{D}  return d[\"a\"] != null && d[\"a\"].Name == \"a\""),
        format!("{D}  if (d[\"a\"] != null) {{\n    return d[\"a\"].Name\n  }}\n  return \"none\""),
    ] {
        assert_eq!(check(&clean), Vec::<String>::new(), "{clean}");
    }
}

#[test]
fn an_index_read_is_not_narrowed_by_another_value() {
    for refused in [
        // Read before the test.
        format!("{L}  return l[1].Name == \"a\" && l[1] != null"),
        // Another index.
        format!("{L}  return l[0] != null && l[1].Name == \"a\""),
        // The name rebound (refused itself, MOV_REBOUND_NAME): another list,
        // as an assignment ends TypeScript's narrowing.
        format!("{L}  if (l[1] == null) {{ fail(\"none\") }}\n{L}  return l[1].Name"),
        // A call's result: each call answers anew.
        "  return only(at-[:Tables]->) != null && only(at-[:Tables]->).Name == \"a\"".to_string(),
    ] {
        let found = check(&refused);
        let absent = found.iter().filter(|d| d.starts_with("MOV_ABSENT_REQUIRED")).count();
        let rebound = found.iter().filter(|d| d.starts_with("MOV_REBOUND_NAME")).count();
        assert!(absent == 1 && absent + rebound == found.len(), "{refused}: {found:?}");
    }
}

#[test]
fn the_fix_is_optional_chaining_and_checks_clean() {
    let body = format!("{T}{L}  u = only(at-[:Tables]->)\n  return [t.Name, u.Name, t.Topic, only(at-[:Tables]->).Name, l[1].Name]");
    let after = fixed(&body);
    assert!(after.contains("return [t?.Name, u?.Name, t?.Topic, only(at-[:Tables]->)?.Name, l[1]?.Name]"), "{after}");
    let body = after.split("function go() {\n").nth(1).unwrap().trim_end_matches("\n}");
    assert_eq!(check(body), Vec::<String>::new());
}

#[test]
fn exists_of_an_index_read_narrows_it() {
    for clean in [
        format!("{L}  if (exists(l[1])) {{\n    return l[1].Name\n  }}\n  return \"none\""),
        format!("{L}  return exists(l[1]) && l[1].Name == \"a\""),
        format!("{L}  return !exists(l[1]) || l[1].Name == \"a\""),
        format!("{L}  if (!exists(l[1])) {{ fail(\"none\") }}\n  return l[1].Name"),
        format!("{D}  return exists(d[\"a\"]) && d[\"a\"].Name == \"a\""),
        format!("{D}  if (exists(d[\"a\"])) {{\n    return d[\"a\"].Name\n  }}\n  return \"none\""),
    ] {
        assert_eq!(check(&clean), Vec::<String>::new(), "{clean}");
    }
    for refused in [
        format!("{L}  return exists(l[0]) && l[1].Name == \"a\""),
        format!("{L}  return exists(l[1]) || l[1].Name == \"a\""),
        format!("{L}  if (exists(l[1])) {{ fail(\"none\") }}\n  return l[1].Name"),
    ] {
        let found = check(&refused);
        assert!(found.len() == 1 && found[0].starts_with("MOV_ABSENT_REQUIRED"), "{refused}: {found:?}");
    }
}

/// `d.a` and `d["a"]` read one member, as TypeScript narrows both spellings
/// of one property alike.
#[test]
fn a_map_member_is_one_entry_however_it_is_spelled() {
    for clean in [
        format!("{D}  if (d[\"a\"] != null) {{\n    return d.a.Name\n  }}\n  return \"none\""),
        format!("{D}  if (exists(d.a)) {{\n    return d[\"a\"].Name\n  }}\n  return \"none\""),
        format!("{D}  return d.a != null && d[\"a\"].Name == \"a\""),
        format!("{D}  return exists(d[\"a\"]) && d.a.Name == \"a\""),
        format!("{D}  return d[\"a\"] == null || d.a.Name == \"a\""),
        format!("{D}  if (d.a == null) {{ fail(\"none\") }}\n  return d[\"a\"].Name"),
        format!("{D}  if (d[\"a\"] == null) {{ fail(\"none\") }}\n  return d.a.Name"),
    ] {
        assert_eq!(check(&clean), Vec::<String>::new(), "{clean}");
    }
    const D2: &str = "  d = {a: only(at-[:Tables]->), b: only(at-[:Tables]->)}\n";
    for refused in [
        format!("{D2}  if (d[\"b\"] != null) {{\n    return d.a.Name\n  }}\n  return \"none\""),
        format!("{D2}  if (exists(d.b)) {{\n    return d[\"a\"].Name\n  }}\n  return \"none\""),
        format!("{D2}  return d.b != null && d[\"a\"].Name == \"a\""),
        format!("{D2}  return d[\"b\"] != null && d.a.Name == \"a\""),
    ] {
        let found = check(&refused);
        assert!(found.len() == 1 && found[0].starts_with("MOV_ABSENT_REQUIRED"), "{refused}: {found:?}");
    }
}

/// A presence test of a read refused for reading through a value that may be
/// missing is not also called constant: the field is always set on a found
/// record, but the read is absent whenever the record is. The refusal alone
/// is said, and once the read is `?.` nothing is said.
#[test]
fn a_refused_read_is_never_called_an_always_present_test() {
    let every_code = |body: &str| -> Vec<String> {
        let source = format!("import {{ at as m }} from adapters\nat = connect m\nfunction go() {{\n{body}\n}}\n");
        let catalog = CatalogSnapshot::load(CATALOG).unwrap();
        let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
        let found = movement_checker::check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
        found.into_iter().map(|d| d.code).collect()
    };
    for body in [
        "  t = only(at-[:Tables]->)\n  if (t.Name != null) { return 1 }",
        "  if (only(at-[:Tables]->).Name != null) { return 1 }",
        "  if (only(at-[:Tables]->).Name == null) { return 1 }",
    ] {
        assert_eq!(every_code(body), ["MOV_ABSENT_REQUIRED"], "{body}");
    }
    for body in ["  t = only(at-[:Tables]->)\n  if (t?.Name != null) { return 1 }", "  if (only(at-[:Tables]->)?.Name != null) { return 1 }"] {
        assert_eq!(every_code(body), Vec::<String>::new(), "{body}");
    }
}

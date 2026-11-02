//! A field that holds a record (`{ kind: "record", position: { kind:
//! "position", position: "Row" } }`) is a value: a dot read goes on through
//! it as the record it is
//! (`c.Current.Stage`), typed by its position, and a name it does not have is
//! refused there. Read-through stays refused past every other field — a
//! reference is an edge, walked, never read past, since reading through it
//! would hide a fetch.
//!
//! The changes of a table: `Change` holds its row before and after as
//! `Previous` and `Current` (each maybe absent), typed by the generic `Row`.
//! A field is never read through a row that may be absent: `exists(row)`
//! proves it present, as TypeScript's strict null checks have it;
//! narrowed to the Candidates table by a WHERE the host decided (its
//! `refinements`), the table's `Changes` land on `Candidates Change`, whose
//! rows are `Candidates`. `Record` is the live row, an edge.

use movement_checker::slots::expression_of_text;
use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::helpers::refinement_key;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::lowering::expression::{Expression, TraversalStep};
use serde_json::{Value, json};

const NARROWED: &str = "-[t:Tables WHERE t.Name == \"Candidates\"]->";

fn held(of: &str) -> Value {
    json!({ "kind": "maybeAbsent", "of": { "kind": "record", "position": { "kind": "position", "position": of } } })
}

fn change(row: &str) -> Value {
    json!({
        "properties": { "Id": "text", "Kind": { "kind": "enum", "options": ["created", "updated", "deleted"] }, "Current": held(row), "Previous": held(row), "Meta": "json" },
        "edges": { "Record": { "target": row } }
    })
}

fn key_of(hop: &str) -> String {
    let Ok(Expression::Traverse { steps, .. }) = expression_of_text(&format!("__movement_path_root__{hop}.`__probe__`")) else { panic!("{hop}") };
    let [TraversalStep::Edge(edge)] = steps.as_slice() else { panic!("{hop}") };
    refinement_key("Table", &serde_json::to_value(edge.expression_filter.as_deref().unwrap()).unwrap())
}

fn catalog() -> CatalogSnapshot {
    let changes = |target: &str| json!({ "target": target, "readable": false, "listenable": true, "identity": "Id", "delivery": "connection" });
    let schema = json!({
        "positions": {
            "Table": { "properties": { "Name": "text", "Id": "text" }, "edges": { "Changes": changes("Change") } },
            "Table \"Candidates\"": { "properties": { "Name": "text", "Id": "text", "Stage": "text" }, "edges": { "Changes": changes("Candidates Change") } },
            "Change": change("Row"),
            "Candidates Change": change("Candidates"),
            "Row": { "properties": { "Id": "text" }, "edges": {} },
            "Candidates": {
                "properties": { "Id": "text", "Name": "text", "Score": "number", "Stage": { "kind": "enum", "options": ["Applied", "Interview", "Rejected"] } },
                "edges": { "Role": { "target": "Row" } }
            }
        },
        "collections": { "Tables": { "target": "Table", "membersChange": { "relistEverySeconds": 300 } } },
        "writableRoots": { "Candidates": { "fields": { "Name": "text" }, "resultShape": { "Id": "text" } } },
        "supportsInPlaceUpdate": true,
        "refinements": { key_of(NARROWED): "Table \"Candidates\"" },
        "selectedMembers": { key_of(NARROWED): "Candidates" }
    });
    let catalog = json!({ "adapters": { "at": { "canFire": false, "constructionArgs": [], "schemas": { "": schema } } }, "credentials": {}, "plugins": {} });
    CatalogSnapshot::load(&catalog.to_string()).unwrap()
}

/// Each error's code and message, the source after a line connecting `at`.
fn errors_of(source: &str) -> Vec<(String, String)> {
    let source = format!("import {{ at as at_module }} from adapters\nat = connect at_module\n{source}");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog(), options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .filter(|d| d.severity.is_none())
        .map(|d| (d.code, d.message))
        .collect()
}

/// A function over the Candidates table's changes (typed, as any landing
/// is, by the record type it lands on) reading `body`.
fn candidates(body: &str) -> Vec<(String, String)> {
    errors_of(&format!("function f(c: <at-[:`Candidates Change`]->>) {{\n  {body}\n}}\n"))
}

fn codes(found: &[(String, String)]) -> Vec<&str> {
    found.iter().map(|(code, _)| code.as_str()).collect()
}

/// `body` where `c.Current` (or another row) is proved present.
fn present(row: &str, body: &str) -> Vec<(String, String)> {
    candidates(&format!("if (exists({row})) {{\n    {body}\n  }}"))
}

#[test]
fn a_read_through_a_row_held_inline_is_typed_by_the_rows_type() {
    assert_eq!(present("c.Current", "x = c.Current.Stage"), Vec::<(String, String)>::new());
    assert_eq!(present("c.Previous", "x = c.Previous.Name"), Vec::<(String, String)>::new());
    // The row's own type: its enum refuses a value it does not hold.
    assert_eq!(codes(&present("c.Current", "x = c.Current.Stage == \"Intervew\"")), ["MOV_ENUM_UNKNOWN_VALUE"]);
}

#[test]
fn a_name_the_row_does_not_have_is_refused_naming_its_fields() {
    let found = present("c.Current", "x = c.Current.Stge");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:#?}");
    assert!(found[0].1.contains("Stge") && found[0].1.contains("Stage"), "{found:#?}");
}

#[test]
fn unnarrowed_the_row_is_the_generic_row() {
    let found = errors_of("function f(c: <at-[:Change]->>) {\n  if (exists(c.Current)) {\n    x = c.Current.Stage\n  }\n}\n");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:#?}");
    assert_eq!(errors_of("function f(c: <at-[:Change]->>) {\n  if (exists(c.Current)) {\n    x = c.Current.Id\n  }\n}\n"), Vec::<(String, String)>::new());
}

/// `Previous` is absent on a created row, `Current` on a deleted one: a
/// field read through either is refused where it is written, once, with
/// the tests that prove the row present.
#[test]
fn a_field_is_never_read_through_a_row_that_may_be_absent() {
    let found = candidates("x = c.Previous.Stage");
    assert_eq!(codes(&found), ["MOV_ABSENT_REQUIRED"], "{found:#?}");
    for told in ["`exists(c.Previous) && c.Previous.Stage …`", "`!exists(c.Previous) || c.Previous.Stage …`", "`if (exists(c.Previous)) { … }`"] {
        assert!(found[0].1.contains(told), "{told}: {found:#?}");
    }
    // Read on as present once refused: the arithmetic says nothing more.
    assert_eq!(codes(&candidates("x = c.Previous.Score + 1")), ["MOV_ABSENT_REQUIRED"]);
    // No fallback reads through it either: the row is tested first.
    assert_eq!(codes(&candidates("x = coalesce(c.Previous.Score, 0) + 1")), ["MOV_ABSENT_REQUIRED"]);
    assert_eq!(codes(&candidates("x = c.Previous.Score != null")), ["MOV_ABSENT_REQUIRED"]);
    // The row itself is read as the value it is, absent or not.
    assert_eq!(candidates("x = c.Previous == null"), Vec::<(String, String)>::new());
}

/// `exists(x)` narrows `x` present in the right side of `&&`; `!exists(x)`
/// in the right side of `||`; either in the arm of an `if` it decides, as
/// `x != null` always has. The narrowing goes through parentheses, and no
/// further than the operand it guards.
#[test]
fn exists_narrows_a_row_present_where_it_holds() {
    let clean = Vec::<(String, String)>::new();
    for body in [
        "x = exists(c.Previous) && c.Previous.Stage == \"Applied\"",
        "x = !exists(c.Previous) || c.Previous.Stage != \"Interview\"",
        "x = exists(c.Current) && (exists(c.Previous) && c.Previous.Stage != c.Current.Stage)",
        "x = exists(c.Current) && c.Current.Stage == \"Interview\" && (!exists(c.Previous) || c.Previous.Stage != \"Interview\")",
        "x = exists(c.Previous) ? c.Previous.Score + 1 : 0",
        "x = c.Previous != null && c.Previous.Score > 1",
        "if (exists(c.Previous)) {\n    x = c.Previous.Score + 1\n  }",
        "if (!exists(c.Previous)) {\n    return 0\n  }\n  x = c.Previous.Score + 1",
        "if (c.Previous != null) {\n    x = c.Previous.Score + 1\n  }",
        "r = c.Previous\n  if (exists(r)) {\n    x = r.Score + 1\n  }",
        "r = c.Previous\n  x = exists(r) && r.Stage == \"Applied\"",
    ] {
        assert_eq!(candidates(body), clean, "{body}");
    }
    for body in [
        // The wrong connective proves nothing on the right.
        "x = exists(c.Previous) || c.Previous.Stage == \"Applied\"",
        "x = !exists(c.Previous) && c.Previous.Stage == \"Applied\"",
        // The left side is read before any test.
        "x = c.Previous.Stage == \"Applied\" && exists(c.Previous)",
        // One row proved is not the other.
        "x = exists(c.Current) && c.Previous.Stage == \"Applied\"",
        // An arm's narrowing ends with the arm.
        "if (exists(c.Previous)) {\n    y = 1\n  }\n  x = c.Previous.Stage",
        "x = exists(c.Previous) ? 0 : c.Previous.Score",
    ] {
        assert_eq!(codes(&candidates(body)), ["MOV_ABSENT_REQUIRED"], "{body}");
    }
}

#[test]
fn read_through_stays_refused_past_any_other_field() {
    // A reference is an edge: reading it as a field says so, with its walk.
    let found = candidates("x = c.Record.Stage");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:#?}");
    assert!(found[0].1.contains("-[:Record]->"), "{found:#?}");
    assert_eq!(codes(&candidates("x = c.Meta.crm_id")), ["MOV_READ_THROUGH_FIELD"]);
    // An edge of the held row is not walked off the value: the live record is `Record`.
    assert_eq!(codes(&present("c.Current", "x = c.Current.Role.Id")), ["MOV_UNKNOWN_PROPERTY"]);
    // And a field of the held row is read whole, as any record's is.
    assert_eq!(codes(&present("c.Current", "x = c.Current.Name.first")), ["MOV_TEXT_HAS_NO_FIELDS"]);
}

#[test]
fn the_live_record_is_walked_in_the_function() {
    assert_eq!(candidates("x = only(c-[:Record]->).Stage"), Vec::<(String, String)>::new());
}

/// The source's MOV_ABSENT_REQUIRED refusals, and the source with each
/// one's fix applied (a safe `?` inserted before the `.`).
fn absent_fixed(source: &str) -> (usize, String) {
    let source = format!("import {{ at as at_module }} from adapters\nat = connect at_module\n{source}");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let found: Vec<_> = check_source(&source, &catalog(), options).unwrap().into_iter().filter(|d| d.code == "MOV_ABSENT_REQUIRED").collect();
    let mut lines: Vec<String> = source.lines().map(String::from).collect();
    let mut edits: Vec<(usize, usize)> = found
        .iter()
        .map(|d| {
            let fix = d.fix.as_ref().unwrap_or_else(|| panic!("no fix: {}", d.message));
            assert_eq!(fix["safe"], true, "{}", d.message);
            let edit = &fix["edits"][0];
            assert_eq!(edit["text"], "?");
            let at = &edit["span"]["start"];
            (at["line"].as_u64().unwrap() as usize, at["col"].as_u64().unwrap() as usize)
        })
        .collect();
    edits.sort();
    for (line, col) in edits.into_iter().rev() {
        lines[line - 1].insert(col - 1, '?');
    }
    (found.len(), lines.join("\n"))
}

/// A listen's WHERE and a write's field read `?.` as a function body does,
/// and the refusal of `.` carries the same safe fix.
#[test]
fn optional_chaining_reads_a_row_in_a_listens_where_and_a_writes_field() {
    let listen = |where_: &str| format!("function f(c: <at-[:`Candidates Change`]->>) {{\n  return c.Kind\n}}\nlisten to at{NARROWED}-[c:Changes WHERE {where_}]-> fire f\n");
    assert_eq!(errors_of(&listen("c.Previous?.Stage != \"Interview\"")), Vec::<(String, String)>::new());
    let (refused, after) = absent_fixed(&listen("c.Previous.Stage != \"Interview\" AND c.Current.Stage == \"Interview\""));
    assert_eq!(refused, 2);
    assert!(after.contains("WHERE c.Previous?.Stage != \"Interview\" AND c.Current?.Stage == \"Interview\"]->"), "{after}");
    assert_eq!(absent_fixed(after.split_once("at = connect at_module\n").unwrap().1).0, 0);

    // The catalog's table has no edge a write could create a row through
    // (MOV_LINKED_UNKNOWN_EDGE); the field's value is judged all the same.
    let write = |value: &str| format!("function g(c: <at-[:`Candidates Change`]->>) {{\n  r = write at-[:Candidates]-> {{ Name: {value} }}\n  return r\n}}\n");
    let (refused, after) = absent_fixed(&write("c.Previous.Name"));
    assert_eq!(refused, 1);
    assert!(after.contains("{ Name: c.Previous?.Name }"), "{after}");
    assert_eq!(absent_fixed(&write("c.Previous?.Name")).0, 0);
}

#[test]
fn a_listen_judges_the_rows_it_carries_and_never_walks_to_the_live_one() {
    let listen = |where_: &str| errors_of(&format!("function f(c: <at-[:`Candidates Change`]->>) {{\n  return c.Kind\n}}\nlisten to at{NARROWED}-[c:Changes WHERE {where_}]-> fire f\n"));
    assert_eq!(
        listen("exists(c.Current) AND c.Current.Stage == \"Interview\" AND (NOT exists(c.Previous) OR c.Previous.Stage != \"Interview\")"),
        Vec::<(String, String)>::new()
    );
    assert_eq!(codes(&listen("exists(c.Current) AND c.Current.Stge == \"Interview\"")), ["MOV_UNKNOWN_PROPERTY"]);
    let walked = listen("only(c-[:Record]->).Stage == \"Interview\"");
    assert_eq!(codes(&walked), ["MOV_LISTEN_IMPURE_WHERE"], "{walked:#?}");
}

#[test]
fn a_listen_on_the_unnarrowed_table_reads_the_generic_row() {
    let found = errors_of("function f(c: <at-[:Change]->>) {\n  return c.Kind\n}\nlisten to at-[:Tables]->-[c:Changes WHERE exists(c.Current) AND c.Current.Stage == \"Interview\"]-> fire f\n");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:#?}");
}

/// A narrowed type is assignable to the type it narrows, by the narrowing
/// walk that made it (not field by field): the changes of one table are changes.
/// Never the other way (a change of any table is not one of Candidates'),
/// and never across unrelated types.
#[test]
fn a_narrowed_landing_is_accepted_where_its_unnarrowed_type_is_asked_for() {
    let listen = |param: &str| {
        errors_of(&format!("function f(c: <{param}>) {{\n  return \"seen\"\n}}\nlisten to at{NARROWED}-[c:Changes WHERE c.Kind == \"created\"]-> fire f\n"))
    };
    assert_eq!(listen("at-[:Change]->"), Vec::<(String, String)>::new());
    assert_eq!(listen("at-[:`Candidates Change`]->"), Vec::<(String, String)>::new());
    assert_eq!(codes(&listen("at-[:Table]->")), ["MOV_LISTEN_PARAM_MISMATCH"]);

    let unnarrowed = errors_of(
        "function f(c: <at-[:`Candidates Change`]->>) {\n  return c.Kind\n}\nlisten to at-[:Tables]->-[c:Changes WHERE c.Kind == \"created\"]-> fire f\n",
    );
    assert_eq!(codes(&unnarrowed), ["MOV_LISTEN_PARAM_MISMATCH"], "{unnarrowed:#?}");
}

/// A function over any table's changes or the Candidates table's alone
/// takes the union of the two, as TypeScript writes `Change | CandidatesChange`:
/// a Candidates change is accepted (narrowed by a listen, or held by a
/// parameter spelled by its name), and so is a change of any table. What it
/// reads is what both have; the live row is a Row or a Candidates row.
#[test]
fn a_general_or_narrowed_function_takes_the_union_of_the_two() {
    const AUDIT: &str = "function audit(c: <at-[:Change]-> | at-[:`Candidates Change`]->>) {\n  return c.Kind\n}\n";
    assert_eq!(errors_of(AUDIT), Vec::<(String, String)>::new());
    let fired = |path: &str| errors_of(&format!("{AUDIT}listen to at{path}-[c:Changes WHERE c.Kind == \"created\"]-> fire audit\n"));
    assert_eq!(fired(NARROWED), Vec::<(String, String)>::new());
    assert_eq!(fired("-[:Tables]->"), Vec::<(String, String)>::new());
    let called = |param: &str| errors_of(&format!("{AUDIT}function f(c: <{param}>) {{\n  audit(c)\n}}\n"));
    assert_eq!(called("at-[:`Candidates Change`]->"), Vec::<(String, String)>::new());
    assert_eq!(called("at-[:Change]->"), Vec::<(String, String)>::new());
    assert_eq!(codes(&called("at-[:Table]->")), ["MOV_CALL_ARG_TYPE"]);
    // A field only the Candidates rows have is refused off the union's live row.
    let live = errors_of("function audit(c: <at-[:Change]-> | at-[:`Candidates Change`]->>) {\n  return only(c-[:Record]->).Stage\n}\n");
    assert_eq!(codes(&live), ["MOV_UNKNOWN_PROPERTY"], "{live:#?}");
    assert_eq!(errors_of("function audit(c: <at-[:Change]-> | at-[:`Candidates Change`]->>) {\n  return only(c-[:Record]->).Id\n}\n"), Vec::<(String, String)>::new());
}

#[test]
fn a_selected_member_passes_to_a_function_of_its_type() {
    let call = |param: &str| {
        errors_of(&format!(
            "function k(x: <{param}>) {{\n  return x.Name\n}}\nfunction f() {{\n  at{NARROWED} {{\n    k(t)\n  }}\n}}\n"
        ))
    };
    assert_eq!(call("at-[:Table]->"), Vec::<(String, String)>::new());
    assert_eq!(call("at-[:`Table \"Candidates\"`]->"), Vec::<(String, String)>::new());
    assert_eq!(codes(&call("at-[:Candidates]->")), ["MOV_CALL_ARG_TYPE"]);
}

/// A held row is a value with typed fields, as TypeScript types a plain
/// object: read through a name as directly, but no edges, no identity, and
/// never a record a function or a write asks for. The live row is `Record`.
#[test]
fn a_held_row_bound_to_a_name_reads_its_fields() {
    let held = |body: &str| candidates(&format!("r = c.Current\n  if (exists(r)) {{\n    {body}\n  }}"));
    assert_eq!(held("x = r.Stage"), Vec::<(String, String)>::new());
    assert_eq!(codes(&held("x = r.Stage == \"Intervew\"")), ["MOV_ENUM_UNKNOWN_VALUE"]);
    let typo = held("x = r.Stge");
    assert_eq!(codes(&typo), ["MOV_UNKNOWN_PROPERTY"], "{typo:#?}");
    assert!(typo[0].1.contains("Stage"), "{typo:#?}");
    // Maybe absent through the name, as directly; a guard proves it present.
    let found = candidates("r = c.Previous\n  x = r.Score + 1");
    assert_eq!(codes(&found), ["MOV_ABSENT_REQUIRED"]);
    assert!(found[0].1.contains("`exists(r) && r.Score …`"), "{found:#?}");
    assert_eq!(candidates("r = c.Previous\n  if (r != null) {\n    x = r.Score + 1\n  }"), Vec::<(String, String)>::new());
}

#[test]
fn an_edge_is_never_walked_off_a_held_row() {
    let named = candidates("r = c.Current\n  if (r != null) {\n    x = r-[:Role]->\n  }");
    assert_eq!(codes(&named), ["MOV_WALK_OFF_HELD_RECORD"], "{named:#?}");
    assert!(named[0].1.contains("-[:Record]->"), "{named:#?}");
    let head = candidates("r = c.Current\n  if (r != null) {\n    r-[:Role]-> {\n      y = 1\n    }\n  }");
    assert_eq!(codes(&head), ["MOV_WALK_OFF_HELD_RECORD"], "{head:#?}");
    assert!(head[0].1.contains("-[:Record]->"), "{head:#?}");
    let direct = candidates("x = c.Current-[:Role]->");
    assert_eq!(codes(&direct), ["MOV_WALK_OFF_HELD_RECORD"], "{direct:#?}");
    assert!(direct[0].1.contains("c-[:Record]->"), "{direct:#?}");
}

#[test]
fn a_held_row_is_not_the_record_a_function_asks_for() {
    let call = |arg: &str| {
        errors_of(&format!(
            "function g(x: <at-[:Candidates]->>) {{\n  y = x-[:Role]->\n}}\nfunction f(c: <at-[:`Candidates Change`]->>) {{\n  g({arg})\n}}\n"
        ))
    };
    assert_eq!(codes(&call("c.Current")), ["MOV_CALL_ARG_TYPE"]);
    assert_eq!(codes(&call("c.Previous")), ["MOV_CALL_ARG_TYPE"]);
    assert_eq!(call("only(c-[:Record]->)"), Vec::<(String, String)>::new());

    let write = |target: &str| candidates(&format!("r = {target}\n  if (r != null) {{\n    write r {{ Name: \"x\" }}\n  }}"));
    assert_eq!(codes(&write("c.Current")), ["MOV_WRITE_POSITION_NOT_RECORD"]);
    assert_eq!(write("only(c-[:Record]->)"), Vec::<(String, String)>::new());
}

#[test]
fn a_maybe_absent_held_row_is_refused_where_a_value_must_be_present() {
    let call = |arg: &str| errors_of(&format!("function g(x: <json>) {{\n  return x\n}}\nfunction f(c: <at-[:`Candidates Change`]->>) {{\n  g({arg})\n}}\n"));
    let found = call("c.Previous");
    assert_eq!(codes(&found), ["MOV_CALL_ARG_TYPE"], "{found:#?}");
    assert!(found[0].1.contains("absent"), "{found:#?}");
}

#[test]
fn reading_on_past_a_field_never_points_into_a_walk_off_a_held_row() {
    let found = present("c.Current", "x = c.Current.Role.Id");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:#?}");
    assert!(found[0].1.contains("c-[:Record]->"), "{found:#?}");
    assert!(!found[0].1.contains("Bind the field"), "{found:#?}");
}

#[test]
fn a_walk_off_a_held_row_is_refused_inside_exists_too() {
    let found = candidates("r = c.Current\n  if (r != null) {\n    if (exists(r-[:Role]->)) {\n      y = 1\n    }\n  }");
    assert_eq!(codes(&found), ["MOV_WALK_OFF_HELD_RECORD"], "{found:#?}");
    assert!(found[0].1.contains("-[:Record]->"), "{found:#?}");
}

/// A walk starts at a record. A name holding anything else has no edges, so
/// the walk is refused where it is written, naming what the root holds.
#[test]
fn a_walk_off_a_name_that_holds_no_record_is_refused() {
    let walk = |bind: &str, walked: &str| candidates(&format!("{bind}\n  x = {walked}-[:Role]->"));
    for (bind, walked, holds) in [
        ("t = \"x\"", "t", "text"),
        ("n = 1", "n", "number"),
        ("l = [1, 2]", "l", "number"),
        ("d = { a: \"x\" }", "d", "a: text"),
    ] {
        let found = walk(bind, walked);
        assert_eq!(codes(&found), ["MOV_WALK_ROOT_NOT_RECORD"], "{bind}: {found:#?}");
        assert!(found[0].1.contains(holds), "{bind}: {found:#?}");
    }
    let member = candidates("d = { a: \"x\" }\n  x = d.a-[:Role]->");
    assert_eq!(codes(&member), ["MOV_WALK_ROOT_NOT_RECORD"], "{member:#?}");
    // A held row, through any path, is the held row's refusal.
    for body in ["d = { a: c.Current }\n  x = d.a-[:Role]->", "l = [c.Current]\n  x = l-[:Role]->"] {
        let held = candidates(body);
        assert_eq!(codes(&held), ["MOV_WALK_OFF_HELD_RECORD"], "{body}: {held:#?}");
    }
    let exists = candidates("t = \"x\"\n  if (exists(t-[:Role]->)) {\n    y = 1\n  }");
    assert_eq!(codes(&exists), ["MOV_WALK_ROOT_NOT_RECORD"], "{exists:#?}");
    let block = candidates("t = \"x\"\n  t-[:Role]-> {\n    y = 1\n  }");
    assert_eq!(codes(&block), ["MOV_HEAD_NOT_A_POSITION"], "{block:#?}");
}

/// A listen's WHERE narrows as a function does, in its own spelling: the
/// row tested by `exists` is present to the right of `AND`, and by `NOT
/// exists` to the right of `OR`, written through the alias or not.
#[test]
fn a_listen_reads_through_a_row_only_once_it_is_tested() {
    let listen = |where_: &str| errors_of(&format!("function f(c: <at-[:`Candidates Change`]->>) {{\n  return c.Kind\n}}\nlisten to at{NARROWED}-[c:Changes WHERE {where_}]-> fire f\n"));
    for where_ in [
        "exists(c.Previous) AND c.Previous.Stage == \"Applied\"",
        "NOT exists(c.Previous) OR c.Previous.Stage != \"Interview\"",
        "c.Kind == \"updated\" AND (exists(c.Current) AND (c.Current.Score > 3))",
        "(exists(c.Current) AND exists(c.Previous) AND c.Current.Stage != c.Previous.Stage) OR (exists(c.Current) AND NOT exists(c.Previous) AND exists(c.Current.Stage))",
        "c.Previous != null AND c.Previous.Stage == \"Applied\"",
    ] {
        assert_eq!(listen(where_), Vec::<(String, String)>::new(), "{where_}");
    }
    let found = listen("c.Current.Stage == \"Interview\" AND c.Previous.Stage != \"Interview\"");
    assert_eq!(codes(&found), ["MOV_ABSENT_REQUIRED", "MOV_ABSENT_REQUIRED"], "{found:#?}");
    assert!(found[1].1.contains("`exists(c.Previous) AND c.Previous.Stage …`, or `NOT exists(c.Previous) OR c.Previous.Stage …`"), "{found:#?}");
    for where_ in [
        "exists(c.Previous) OR c.Previous.Stage == \"Applied\"",
        "NOT exists(c.Previous) AND c.Previous.Stage == \"Applied\"",
        "exists(c.Current) AND c.Previous.Stage == \"Applied\"",
    ] {
        assert_eq!(codes(&listen(where_)), ["MOV_ABSENT_REQUIRED"], "{where_}");
    }
}

/// What a map holds may be absent too: no field is read through it untested.
#[test]
fn a_field_is_never_read_through_a_map_member_that_may_be_absent() {
    let found = candidates("d = { a: c.Previous }\n  x = d.a.Score");
    assert_eq!(codes(&found), ["MOV_ABSENT_REQUIRED"], "{found:#?}");
    assert!(found[0].1.contains("'d.a' may be absent"), "{found:#?}");
    assert_eq!(candidates("d = { a: c.Previous }\n  if (exists(d.a)) {\n    x = d.a.Score\n  }"), Vec::<(String, String)>::new());
}

/// A row held as a value is a plain object type, so `{ ...c.Current }` copies
/// its fields, each with its type, as spreading a map with known keys does.
#[test]
fn a_row_held_as_a_value_spreads_into_a_map_with_its_typed_fields() {
    for spread in ["m = { ...c.Current }", "r = c.Current\n  m = { ...r }"] {
        let body = |read: &str| present("c.Current", &format!("{spread}\n    {read}"));
        assert_eq!(body("x = m.Stage"), Vec::<(String, String)>::new(), "{spread}");
        // The field's own type: its enum refuses a value it does not hold.
        assert_eq!(codes(&body("x = m.Stage == \"Intervew\"")), ["MOV_ENUM_UNKNOWN_VALUE"], "{spread}");
        let misspelt = body("x = m.Stagee");
        assert_eq!(codes(&misspelt), ["MOV_DICT_UNKNOWN_KEY"], "{spread}: {misspelt:#?}");
        assert!(misspelt[0].1.contains("Stagee") && misspelt[0].1.contains("Stage"), "{misspelt:#?}");
    }
}

#[test]
fn a_member_after_a_spread_of_a_held_row_overrides_it() {
    let overridden = |read: &str| present("c.Current", &format!("m = {{ ...c.Current, Stage: 3 }}\n    {read}"));
    assert_eq!(overridden("x = m.Stage + 1"), Vec::<(String, String)>::new());
    let found = overridden("x = m.Stage == \"Applied\"");
    assert_ne!(codes(&found), Vec::<&str>::new(), "the override is a number, not the field's enum");
    // A member written before a spread that always has the key is overwritten.
    let before = present("c.Current", "m = { Stage: 3, ...c.Current }");
    assert_eq!(codes(&before), ["MOV_MAP_KEY_OVERWRITTEN"], "{before:#?}");
}

#[test]
fn a_held_row_that_may_be_absent_spreads_its_fields_as_maybe_absent() {
    let found = candidates("m = { ...c.Current }\n  x = m.Stage");
    assert_eq!(found, Vec::<(String, String)>::new(), "{found:#?}");
    let compared = candidates("m = { ...c.Current }\n  x = m.Stage == \"Intervew\"");
    assert_eq!(codes(&compared), ["MOV_ENUM_UNKNOWN_VALUE"], "{compared:#?}");
}

/// Two rows are not compared whole: the refusal says each is a record held
/// as a value, and to read the fields meant off it.
#[test]
fn a_row_compared_whole_is_told_to_read_its_fields() {
    let found = present("c.Current", "x = exists(c.Previous) && c.Current == c.Previous");
    assert_eq!(codes(&found), ["MOV_JSON_OPAQUE"]);
    assert!(found[0].1.contains("is a record held as a value, and it can't be compared as a whole — read the fields you mean off it (`c.Current.Stage`)"), "{found:?}");
}

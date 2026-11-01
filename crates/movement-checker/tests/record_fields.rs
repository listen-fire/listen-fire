//! A field that holds a record (`{ kind: "record", position: { kind:
//! "position", position: "Row" } }`) is a value: a dot read goes on through
//! it as the record it is
//! (`c.Current.Stage`), typed by its position, and a name it does not have is
//! refused there. Read-through stays refused past every other field — a
//! reference is an edge, walked, never read past, since reading through it
//! would hide a fetch.
//!
//! The changes of a table: `Change` holds its row before and after as
//! `Previous` and `Current` (each maybe absent), typed by the generic `Row`;
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
        "collections": { "Tables": { "target": "Table", "cheapToList": true } },
        "writableRoots": {},
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

#[test]
fn a_read_through_a_row_held_inline_is_typed_by_the_rows_type() {
    assert_eq!(candidates("x = c.Current.Stage"), Vec::<(String, String)>::new());
    assert_eq!(candidates("x = c.Previous.Name"), Vec::<(String, String)>::new());
    // The row's own type: its enum refuses a value it does not hold.
    assert_eq!(codes(&candidates("x = c.Current.Stage == \"Intervew\"")), ["MOV_ENUM_UNKNOWN_VALUE"]);
}

#[test]
fn a_name_the_row_does_not_have_is_refused_naming_its_fields() {
    let found = candidates("x = c.Current.Stge");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:#?}");
    assert!(found[0].1.contains("Stge") && found[0].1.contains("Stage"), "{found:#?}");
}

#[test]
fn unnarrowed_the_row_is_the_generic_row() {
    let found = errors_of("function f(c: <at-[:Change]->>) {\n  x = c.Current.Stage\n}\n");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:#?}");
    assert_eq!(errors_of("function f(c: <at-[:Change]->>) {\n  x = c.Current.Id\n}\n"), Vec::<(String, String)>::new());
}

#[test]
fn a_row_absent_reads_as_absent() {
    // `Previous` is absent on a created row, `Current` on a deleted one:
    // what is read through either may be.
    assert_eq!(codes(&candidates("x = c.Previous.Score + 1")), ["MOV_ABSENT_REQUIRED"]);
    assert_eq!(candidates("x = coalesce(c.Previous.Score, 0) + 1"), Vec::<(String, String)>::new());
}

#[test]
fn read_through_stays_refused_past_any_other_field() {
    // A reference is an edge: reading it as a field says so, with its walk.
    let found = candidates("x = c.Record.Stage");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:#?}");
    assert!(found[0].1.contains("-[:Record]->"), "{found:#?}");
    assert_eq!(codes(&candidates("x = c.Meta.crm_id")), ["MOV_READ_THROUGH_FIELD"]);
    // An edge of the held row is not walked off the value: the live record is `Record`.
    assert_eq!(codes(&candidates("x = c.Current.Role.Id")), ["MOV_UNKNOWN_PROPERTY"]);
    // And a field of the held row is read whole, as any record's is.
    assert_eq!(codes(&candidates("x = c.Current.Name.first")), ["MOV_TEXT_HAS_NO_FIELDS"]);
}

#[test]
fn the_live_record_is_walked_in_the_function() {
    assert_eq!(candidates("x = only(c-[:Record]->).Stage"), Vec::<(String, String)>::new());
}

#[test]
fn a_listen_judges_the_rows_it_carries_and_never_walks_to_the_live_one() {
    let listen = |where_: &str| errors_of(&format!("function f(c: <at-[:`Candidates Change`]->>) {{\n  return c.Kind\n}}\nlisten to at{NARROWED}-[c:Changes WHERE {where_}]-> fire f\n"));
    assert_eq!(listen("c.Current.Stage == \"Interview\" AND c.Previous.Stage != \"Interview\""), Vec::<(String, String)>::new());
    assert_eq!(codes(&listen("c.Current.Stge == \"Interview\"")), ["MOV_UNKNOWN_PROPERTY"]);
    let walked = listen("only(c-[:Record]->).Stage == \"Interview\"");
    assert_eq!(codes(&walked), ["MOV_LISTEN_IMPURE_WHERE"], "{walked:#?}");
}

#[test]
fn a_listen_on_the_unnarrowed_table_reads_the_generic_row() {
    let found = errors_of("function f(c: <at-[:Change]->>) {\n  return c.Kind\n}\nlisten to at-[:Tables]->-[c:Changes WHERE c.Current.Stage == \"Interview\"]-> fire f\n");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:#?}");
}

/// A narrowed type is assignable to the type it narrows, as TypeScript's
/// structural assignability has it: the changes of one table are changes.
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

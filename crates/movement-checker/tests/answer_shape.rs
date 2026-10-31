//! An edge may declare that what lands on it is typed by a node the write it
//! hangs off names in one of its fields (`answerShapeFrom`): the write gives
//! that field a node declared in the file (`Fields: Refund`), and each record
//! landing on the edge has that node's fields, typed as the node declares
//! them, beside the landing's own. The engine sends the node's fields to the
//! module as the field's value (the `nodeSchema` stamp). Nothing here knows a
//! module or a field by name: the edge names the field. Every rule is checked
//! on two catalog shapes: a form written at a root collection, a type the
//! program can only write, its answers named by `Id`; and a survey written
//! off a board, its responses named by `Respondent`.

use movement_checker::answer::check_answer;
use movement_checker::{CheckOptions, Severity, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::form_of_text;
use serde_json::{Value as Json, json};

const FORMS: &str = r#"{"adapters":{
  "forms":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Submission":{"properties":{"Id":"text"},"edges":{}}},
    "collections":{"Forms":{"target":"Form"}},
    "writableRoots":{"Form":{"fields":{"Title":"text","Fields":"json"},"requiredFields":["Title","Fields"],
      "resultShape":{"externalId":"text","Url":"text"},"edges":{
      "Submissions":{"target":"Submission","readable":false,"listenable":true,"identity":"Id","answerShapeFrom":"Fields"}}}}}}}
},"credentials":{},"plugins":{}}"#;

const SURVEYS: &str = r#"{"adapters":{
  "surveys":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Board":{"properties":{"Name":"text"},"edges":{"Surveys":{"target":"Survey","writable":true}}},
    "Survey":{"properties":{"Name":"text"},"edges":{
      "Responses":{"target":"Response","readable":false,"listenable":true,"identity":"Respondent","answerShapeFrom":"Questions"}}},
    "Response":{"properties":{"Respondent":"text"},"edges":{}}},
    "collections":{"Boards":{"target":"Board"}},
    "writableRoots":{"Survey":{"fields":{"Name":"text","Questions":"json"},"resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{}}"#;

/// One catalog shape: its header (a function whose body follows), the write
/// whose field is `VALUE`, and the await binding the answer as `s`.
struct Shape {
    catalog: &'static str,
    header: &'static str,
    write: &'static str,
    field: &'static str,
}

const FORM: Shape = Shape {
    catalog: FORMS,
    header: "import { forms as forms_module } from adapters\nforms = connect forms_module\nNODES\nfunction go(name: <text>) {\n",
    write: "  f = write forms-[:Forms]-> { Title: \"Refund?\", Fields: VALUE }\n  s = await f-[:Submissions]->\n",
    field: "Fields",
};

const SURVEY: Shape = Shape {
    catalog: SURVEYS,
    header: "import { surveys as surveys_module } from adapters\nsurveys = connect surveys_module\nNODES\nfunction go(board: <surveys-[:Board]->>, name: <text>) {\n",
    write: "  f = write board-[:Surveys]-> { Name: \"Refund?\", Questions: VALUE }\n  s = await f-[:Responses]->\n",
    field: "Questions",
};

const REFUND: &str = "node Refund {\n  Approve: <boolean>\n  Note: <text | null>\n}";

fn source(shape: &Shape, value: &str, body: &str) -> String {
    source_with(shape, REFUND, value, body)
}

fn source_with(shape: &Shape, nodes: &str, value: &str, body: &str) -> String {
    format!("{}{}{body}}}\n", shape.header.replace("NODES", nodes), shape.write.replace("VALUE", value))
}

/// Every diagnostic but information, as `CODE l:c-l:c message`. The node
/// declaration takes lines 3-6, so the write is line 8 and the body's first
/// line is 10.
fn check(shape: &Shape, value: &str, body: &str) -> Vec<String> {
    check_source_of(shape, &source(shape, value, body))
}

fn check_source_of(shape: &Shape, source: &str) -> Vec<String> {
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &CatalogSnapshot::load(shape.catalog).unwrap(), options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .filter(|d| d.severity != Some(Severity::Info))
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

#[test]
fn an_answer_is_typed_by_the_node_its_field_names() {
    for shape in [&FORM, &SURVEY] {
        let clean = "  if (s.Approve) { return coalesce(s.Note, \"none\") }\n";
        assert_eq!(check(shape, "Refund", clean), Vec::<String>::new(), "{}", shape.field);
        let compared = "  if (s.Note == 1) { return 1 }\n";
        assert_eq!(
            check(shape, "Refund", compared),
            ["MOV_COMPARE_TYPE_MISMATCH 10:7-10:18 Can't compare a text to a number — wrap one side in Date.from(…), DateTime.from(…), or Number.parse(…) to coerce it."],
            "{}",
            shape.field
        );
    }
}

#[test]
fn the_landing_keeps_its_own_fields_and_has_no_others() {
    let identity = "  return s.Id\n";
    assert_eq!(check(&FORM, "Refund", identity), Vec::<String>::new());
    let identity = "  return s.Respondent\n";
    assert_eq!(check(&SURVEY, "Refund", identity), Vec::<String>::new());
    for shape in [&FORM, &SURVEY] {
        let said = check(shape, "Refund", "  return s.Amount\n");
        assert_eq!(said.len(), 1, "{said:?}");
        assert!(said[0].contains("'Amount'"), "{said:?}");
    }
}

#[test]
fn the_field_must_name_a_node() {
    for shape in [&FORM, &SURVEY] {
        let f = shape.field;
        let message = format!("MOV_ANSWER_SHAPE '{f}' names the answer's shape: a node declared in this file — `node Refund {{ Approve: <boolean> }}` — then `{f}: Refund`");
        let start = shape.write.find("VALUE").unwrap() + 1;
        let at = |len: usize| format!("8:{start}-8:{}", start + len);
        assert_eq!(check(shape, "{ Approve: true }", ""), [format!("{} {} {}", "MOV_ANSWER_SHAPE", at(17), &message["MOV_ANSWER_SHAPE ".len()..])], "{f}");
        assert_eq!(check(shape, "name", ""), [format!("{} {} {}", "MOV_ANSWER_SHAPE", at(4), &message["MOV_ANSWER_SHAPE ".len()..])], "{f}");
    }
}

#[test]
fn the_node_cannot_redeclare_a_field_the_landing_has() {
    // What lands has the landing's fields and the node's: one name for two
    // fields would be neither (TypeScript makes a clash of types `never`).
    for (shape, own) in [(&FORM, "Id"), (&SURVEY, "Respondent")] {
        for declared in ["<number>", "<text>"] {
            let nodes = format!("node Refund {{\n  Approve: <boolean>\n  {own}: {declared}\n}}");
            let said = check_source_of(shape, &source_with(shape, &nodes, "Refund", ""));
            let start = shape.write.find("VALUE").unwrap() + 1;
            let edge = if own == "Id" { "Submissions" } else { "Responses" };
            let landing = if own == "Id" { "Submission" } else { "Response" };
            assert_eq!(
                said,
                [format!(
                    "MOV_ANSWER_SHAPE 8:{start}-8:{} 'Refund' declares '{own}', a field every {landing} landing on '{edge}' has already: rename it in 'Refund'",
                    start + 6
                )],
                "{own} {declared}"
            );
        }
    }
}

#[test]
fn the_mechanism_is_not_forms_specific() {
    // The survey's edge names another field on another module, off a record
    // written through an edge rather than a root collection: the same rule.
    assert_eq!(
        check(&SURVEY, "Refund", "  if (s.Approve == \"yes\") { return 1 }\n"),
        ["MOV_COMPARE_TYPE_MISMATCH 10:7-10:25 Can't compare a boolean to a text — wrap one side in Date.from(…), DateTime.from(…), or Number.parse(…) to coerce it."]
    );
}

#[test]
fn the_node_s_fields_are_stamped_on_the_field_s_value() {
    for shape in [&FORM, &SURVEY] {
        let source = source(shape, "Refund", "  return s.Approve\n");
        let catalog = CatalogSnapshot::load(shape.catalog).unwrap();
        let program = movement_parser::stmt::parse_program(&form_of_text(&source), false).unwrap();
        let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
        let answer = check_answer(&program, &catalog, options);
        assert_eq!(answer.unplaced, Vec::<String>::new());
        let stamped: Vec<&Json> = answer.stamps.iter().filter(|s| s.get("nodeSchema").is_some()).collect();
        assert_eq!(stamped.len(), 1, "{:?}", answer.stamps);
        let tree = serde_json::to_value(&program).unwrap();
        let path = stamped[0]["path"].as_str().unwrap();
        let node = tree.pointer(path).unwrap_or_else(|| panic!("{path}"));
        assert_eq!(node["raw"], json!("Refund"), "{path}");
        assert_eq!(stamped[0]["nodeSchema"], json!({ "fields": { "Approve": "boolean", "Note": { "kind": "maybeAbsent", "of": "text" } } }));
    }
}

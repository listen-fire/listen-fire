//! An edge may declare that a field of what lands on it takes the literals
//! written at a path in the write it hangs off (`literalsFrom`): the field is
//! then an enum of exactly those values, so comparing it against a value the
//! write never offered is the enum's error. A value written at that path that
//! is not a literal gives the field its declared type, with a warning naming
//! the path. Every rule is checked on two catalog shapes: a chat message with
//! buttons whose answer's value is one hop away (`Actions`), and a poll with
//! options whose vote's choice is on the vote itself. An awaited answer is
//! present where it is read: a wait whose message or poll is deleted never
//! answers.

use movement_checker::families::writes::literals::parse_write_path;
use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CHAT: &str = r#"{"adapters":{
  "chat":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Channel":{"properties":{"Name":"text"},"edges":{"Messages":{"target":"Message","writable":true}}},
    "Message":{"properties":{"Message":"text","Timestamp":"text"},"edges":{
      "Interactions":{"target":"Interaction","readable":false,"listenable":true,"identity":"Id",
        "literalsFrom":[{"at":["Actions","Value"],"from":"Buttons[].Value"}]}}},
    "Interaction":{"properties":{"Id":"text","User":"text"},"edges":{"Actions":{"target":"Action"},"By":{"target":"Member"}}},
    "Action":{"properties":{"Text":"text","Value":"text"},"edges":{}},
    "Member":{"properties":{"Name":"text"},"edges":{}}},
    "collections":{},
    "writableRoots":{"Message":{"fields":{"Message":"text",
      "Buttons":{"kind":"list","of":{"kind":"dict","of":"text"}}},
      "resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{}}"#;

const POLL: &str = r#"{"adapters":{
  "polls":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Board":{"properties":{"Title":"text"},"edges":{"Polls":{"target":"Poll","writable":true}}},
    "Poll":{"properties":{"Question":"text"},"edges":{
      "Votes":{"target":"Vote","readable":false,"listenable":true,"identity":"Voter",
        "literalsFrom":[{"at":["Choice"],"from":"Options[].Key"}]}}},
    "Vote":{"properties":{"Voter":"text","Choice":"text"},"edges":{}}},
    "collections":{},
    "writableRoots":{"Poll":{"fields":{"Question":"text",
      "Options":{"kind":"list","of":{"kind":"dict","of":"text"}}},
      "resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{}}"#;

/// Every diagnostic on `body`, the body of a function holding a channel `ch`
/// (CHAT) or a board `board` (POLL), and a text `name`; its first line is
/// line 2.
fn check(catalog: &str, body: &str) -> Vec<String> {
    diagnostics(catalog, body)
        .into_iter()
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

fn diagnostics(catalog: &str, body: &str) -> Vec<Diagnostic> {
    let header = if catalog == CHAT {
        "import { chat as chat_module } from adapters; chat = connect chat_module; function go(ch: <chat-[:Channel]->>, name: <text>) {"
    } else {
        "import { polls as polls_module } from adapters; polls = connect polls_module; function go(board: <polls-[:Board]->>, name: <text>) {"
    };
    let source = format!("{header}\n{body}}}\n");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &CatalogSnapshot::load(catalog).unwrap(), options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

const BUTTONS: &str = "  msg = write ch-[:Messages]-> { Message: \"Pursue?\", Buttons: [{ Text: \"Pursue\", Value: \"pursue\" }, { Text: \"Pass\", Value: \"pass\" }] }\n  i = await msg-[:Interactions]->\n";
const OPTIONS: &str = "  poll = write board-[:Polls]-> { Question: \"Lunch?\", Options: [{ Key: \"yes\" }, { Key: \"no\" }] }\n  v = await poll-[:Votes]->\n";

#[test]
fn the_answer_is_typed_by_the_literals_written() {
    let src = format!("{BUTTONS}  if (only(i-[:Actions]->)?.Value == \"pursu\") {{ return 1 }}\n");
    assert_eq!(
        check(CHAT, &src),
        ["MOV_ENUM_UNKNOWN_VALUE 4:7-4:45 \"pursu\" isn't a value of \"pursue\" | \"pass\" — expected one of: pursue | pass. Did you mean \"pursue\"?"]
    );
    let src = format!("{BUTTONS}  if (only(i-[:Actions]->)?.Value == \"pursue\") {{ return 1 }}\n");
    assert_eq!(check(CHAT, &src), Vec::<String>::new());
}

#[test]
fn a_second_shape_narrows_a_field_on_the_landing_itself() {
    let src = format!("{OPTIONS}  if (v.Choice == \"nope\") {{ return 1 }}\n");
    assert_eq!(
        check(POLL, &src),
        ["MOV_ENUM_UNKNOWN_VALUE 4:7-4:25 \"nope\" isn't a value of \"yes\" | \"no\" — expected one of: yes | no. Did you mean \"no\"?"]
    );
    let src = format!("{OPTIONS}  if (v.Choice == \"no\") {{ return 1 }}\n");
    assert_eq!(check(POLL, &src), Vec::<String>::new());
}

#[test]
fn a_field_the_edge_names_no_path_for_keeps_its_type() {
    let src = format!("{BUTTONS}  if (only(i-[:Actions]->)?.Text == \"anything\" && i.User == \"anyone\") {{ return 1 }}\n");
    assert_eq!(check(CHAT, &src), Vec::<String>::new());
    let src = format!("{OPTIONS}  if (v.Voter == \"anyone\") {{ return 1 }}\n");
    assert_eq!(check(POLL, &src), Vec::<String>::new());
}

#[test]
fn a_built_value_gives_the_base_type_with_a_warning() {
    let chat = "  msg = write ch-[:Messages]-> { Message: \"Pursue?\", Buttons: [{ Text: \"Pursue\", Value: name }, { Text: \"Pass\", Value: \"pass\" }] }\n  i = await msg-[:Interactions]->\n  if (only(i-[:Actions]->)?.Value == \"anything\") { return 1 }\n";
    assert_eq!(
        check(CHAT, chat),
        ["MOV_WRITE_GENERIC_UNTYPED 2:63-2:129 'Buttons[].Value' is not all text literals here, so the 'Actions.Value' of what '-[:Interactions]->' delivers on Message keeps its declared type instead of the values offered. Write each 'Buttons[].Value' as a text literal to have the answer checked against them"]
    );
    let poll = "  poll = write board-[:Polls]-> { Question: \"Lunch?\", Options: [{ Key: name }] }\n  v = await poll-[:Votes]->\n  if (v.Choice == \"anything\") { return 1 }\n";
    assert_eq!(
        check(POLL, poll),
        ["MOV_WRITE_GENERIC_UNTYPED 2:64-2:79 'Options[].Key' is not all text literals here, so the 'Choice' of what '-[:Votes]->' delivers on Poll keeps its declared type instead of the values offered. Write each 'Options[].Key' as a text literal to have the answer checked against them"]
    );
}

#[test]
fn a_built_value_is_told_as_a_warning() {
    let chat = "  msg = write ch-[:Messages]-> { Message: \"Pursue?\", Buttons: [{ Text: \"Pursue\", Value: name }] }\n";
    let poll = "  poll = write board-[:Polls]-> { Question: \"Lunch?\", Options: [{ Key: name }] }\n";
    for (catalog, body) in [(CHAT, chat), (POLL, poll)] {
        let told = diagnostics(catalog, body);
        assert_eq!(told.iter().map(|d| (d.code.as_str(), d.is_error())).collect::<Vec<_>>(), [("MOV_WRITE_GENERIC_UNTYPED", false)]);
    }
}

#[test]
fn a_list_held_by_a_name_is_not_literal() {
    let chat = "  buttons = [{ Text: \"Pursue\", Value: \"pursue\" }]\n  msg = write ch-[:Messages]-> { Message: \"Pursue?\", Buttons: buttons }\n  i = await msg-[:Interactions]->\n  if (only(i-[:Actions]->)?.Value == \"anything\") { return 1 }\n";
    assert_eq!(check(CHAT, chat), ["MOV_WRITE_GENERIC_UNTYPED 3:63-3:70 'Buttons[].Value' is not all text literals here, so the 'Actions.Value' of what '-[:Interactions]->' delivers on Message keeps its declared type instead of the values offered. Write each 'Buttons[].Value' as a text literal to have the answer checked against them"]);
    let poll = "  options = [{ Key: \"yes\" }]\n  poll = write board-[:Polls]-> { Question: \"Lunch?\", Options: options }\n  v = await poll-[:Votes]->\n  if (v.Choice == \"anything\") { return 1 }\n";
    assert_eq!(check(POLL, poll), ["MOV_WRITE_GENERIC_UNTYPED 3:64-3:71 'Options[].Key' is not all text literals here, so the 'Choice' of what '-[:Votes]->' delivers on Poll keeps its declared type instead of the values offered. Write each 'Options[].Key' as a text literal to have the answer checked against them"]);
}

#[test]
fn a_write_without_the_path_is_not_narrowed_and_not_told() {
    let chat = "  msg = write ch-[:Messages]-> { Message: \"Pursue?\" }\n  i = await msg-[:Interactions]->\n  if (only(i-[:Actions]->)?.Value == \"anything\") { return 1 }\n";
    assert_eq!(check(CHAT, chat), Vec::<String>::new());
    let poll = "  poll = write board-[:Polls]-> { Question: \"Lunch?\" }\n  v = await poll-[:Votes]->\n  if (v.Choice == \"anything\") { return 1 }\n";
    assert_eq!(check(POLL, poll), Vec::<String>::new());
}

#[test]
fn one_of_two_answers_takes_the_values_of_either() {
    let chat = "  a = write ch-[:Messages]-> { Message: \"A?\", Buttons: [{ Text: \"Yes\", Value: \"yes\" }] }\n  b = write ch-[:Messages]-> { Message: \"B?\", Buttons: [{ Text: \"No\", Value: \"no\" }] }\n  i = await a-[:Interactions]->\n  j = await b-[:Interactions]->\n  k = only([i, j])\n  if (k != null) {\n    if (only(k-[:Actions]->)?.Value == \"no\") { return 1 }\n    if (only(k-[:Actions]->)?.Value == \"maybe\") { return 2 }\n  }\n";
    assert_eq!(check(CHAT, chat), ["MOV_ENUM_UNKNOWN_VALUE 9:9-9:47 \"maybe\" isn't a value of \"yes\" | \"no\" — expected one of: yes | no."]);
    let poll = "  p = write board-[:Polls]-> { Question: \"P?\", Options: [{ Key: \"yes\" }] }\n  q = write board-[:Polls]-> { Question: \"Q?\", Options: [{ Key: \"no\" }] }\n  v = await p-[:Votes]->\n  w = await q-[:Votes]->\n  x = only([v, w])\n  if (x?.Choice == \"no\") { return 1 }\n  if (x?.Choice == \"maybe\") { return 2 }\n";
    assert_eq!(check(POLL, poll), ["MOV_ENUM_UNKNOWN_VALUE 8:7-8:27 \"maybe\" isn't a value of \"yes\" | \"no\" — expected one of: yes | no."]);
}

#[test]
fn an_awaited_answer_is_present_where_it_is_read() {
    // The expense approval's shape: the await in a race arm, walked off unguarded.
    let chat = "  msg = write ch-[:Messages]-> { Message: \"Approve?\", Buttons: [{ Text: \"Approve\", Value: \"approve\" }, { Text: \"Reject\", Value: \"reject\" }] }\n  r = race(\n    () => {\n      press = await msg-[:Interactions]->\n      return { choice: only(press-[:Actions]->)?.Value, by: press-[:By]->.Name, who: press.User }\n    },\n    () => { await sleep(1d) },\n  )\n  if (r[0] == null) { return \"expired\" }\n  return r[0].choice\n";
    assert_eq!(check(CHAT, chat), Vec::<String>::new());
    let poll = "  poll = write board-[:Polls]-> { Question: \"Lunch?\", Options: [{ Key: \"yes\" }] }\n  v = await poll-[:Votes]->\n  return v.Choice == \"yes\" && v.Voter == name\n";
    assert_eq!(check(POLL, poll), Vec::<String>::new());
}

/// The grammar's cases, shared with engine-contracts' reader of the same
/// paths so the two cannot drift.
const WRITE_PATHS: &str = include_str!("../../../packages/engine-contracts/__test__/write_paths.cases.json");

#[test]
fn the_path_grammar() {
    let cases: serde_json::Value = serde_json::from_str(WRITE_PATHS).unwrap();
    for case in cases["read"].as_array().unwrap() {
        let path = parse_write_path(case["path"].as_str().unwrap()).unwrap_or_else(|e| panic!("{case}: {e}"));
        let steps: Vec<serde_json::Value> = path.0.iter().map(|s| serde_json::json!([s.field, s.each])).collect();
        assert_eq!(serde_json::Value::Array(steps), case["steps"], "{case}");
    }
    for case in cases["refused"].as_array().unwrap() {
        assert_eq!(parse_write_path(case["path"].as_str().unwrap()), Err(case["message"].as_str().unwrap().to_string()), "{case}");
    }
}

#[test]
fn an_empty_list_at_the_path_is_told_and_keeps_the_declared_type() {
    let chat = "  msg = write ch-[:Messages]-> { Message: \"Pursue?\", Buttons: [] }\n  i = await msg-[:Interactions]->\n  if (only(i-[:Actions]->)?.Value == \"anything\") { return 1 }\n";
    assert_eq!(
        check(CHAT, chat),
        ["MOV_WRITE_LITERALS_EMPTY 2:63-2:65 this write sets no 'Buttons[].Value', so no answer on '-[:Interactions]->' from Message can take its 'Actions.Value' from it; the field keeps its declared type. Add the entries the answer may choose from, or leave 'Buttons' out of the write"]
    );
    let poll = "  poll = write board-[:Polls]-> { Question: \"Lunch?\", Options: [{ Label: \"Yes\" }] }\n  v = await poll-[:Votes]->\n  if (v.Choice == \"anything\") { return 1 }\n";
    assert_eq!(
        check(POLL, poll),
        ["MOV_WRITE_LITERALS_EMPTY 2:64-2:82 this write sets no 'Options[].Key', so no answer on '-[:Votes]->' from Poll can take its 'Choice' from it; the field keeps its declared type. Add the entries the answer may choose from, or leave 'Options' out of the write"]
    );
    assert!(diagnostics(CHAT, chat).iter().chain(&diagnostics(POLL, poll)).all(|d| !d.is_error()));
}

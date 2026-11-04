//! A parameter type's address that names no position names the address to
//! write instead, where the catalog says which one it is, and offers it as a
//! rewrite that is never safe: `listen-fire upgrade` lists it, and applies it
//! only with `--all`.
//!
//! - A longer walk (`<chat-[:Channels]->-[:Messages]->-[:Files]->>`, as 0.12
//!   allowed) names the record it lands on: `<chat-[:File]->>`.
//! - A hop naming a position the connection no longer has, on a connection
//!   with only one (a 0.12 system event kind), names that one.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{
  "chat":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Channel":{"properties":{"Name":"text"},"edges":{"Messages":{"target":"Message"}}},
    "Message":{"properties":{"Text":"text"},"edges":{"Files":{"target":"File"}}},
    "File":{"properties":{"Name":"text","URL":"text"},"edges":{}}},
    "collections":{"Channels":{"target":"Channel"}},"writableRoots":{}}}},
  "sys":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Event":{"properties":{"Kind":"text","Reason":"text"},"edges":{}}},
    "collections":{"Events":{"target":"Event"}},"writableRoots":{}}}}
},"credentials":{},"plugins":{}}"#;

const PRELUDE: &str = "import { chat as chat_module, sys as sys_module } from adapters\nchat = connect chat_module\nsys = connect sys_module\n";

fn unknown_positions(body: &str) -> Vec<Diagnostic> {
    let source = format!("{PRELUDE}{body}");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: Some("0.12.13"), zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}")).into_iter().filter(|d| d.code == "MOV_UNKNOWN_POSITION").collect()
}

fn offered(d: &Diagnostic) -> (Option<&str>, Option<bool>) {
    let fix = d.fix.as_ref().expect("a replacement is offered");
    (fix["edits"][0]["text"].as_str(), fix.get("safe").and_then(|s| s.as_bool()))
}

/// The source with the diagnostic's one edit applied (spans are 1-based line and column).
fn rewritten(body: &str, d: &Diagnostic) -> String {
    let source = format!("{PRELUDE}{body}");
    let edit = &d.fix.as_ref().expect("a replacement is offered")["edits"][0];
    let offset = |at: &serde_json::Value| {
        let (line, col) = (at["line"].as_u64().unwrap() as usize, at["col"].as_u64().unwrap() as usize);
        source.split_inclusive('\n').take(line - 1).map(str::len).sum::<usize>() + col - 1
    };
    let (start, end) = (offset(&edit["span"]["start"]), offset(&edit["span"]["end"]));
    format!("{}{}{}", &source[..start], edit["text"].as_str().unwrap(), &source[end..])
}

#[test]
fn a_longer_walk_names_the_record_it_lands_on() {
    let found = unknown_positions("function digest(f: <chat-[:Channels]->-[:Messages]->-[:Files]->>) {\n  return f.Name\n}\n");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(
        found[0].message,
        "'<chat-[:Channels]->-[:Messages]->-[:Files]->>' names no position: a type's address is one hop off the system; its walk lands on 'File', so write `<chat-[:File]->>`"
    );
    assert_eq!(offered(&found[0]), (Some("<chat-[:File]->>"), None));
    let edit = &found[0].fix.as_ref().unwrap()["edits"][0]["span"];
    assert_eq!((edit["start"]["line"].as_u64(), edit["start"]["col"].as_u64()), (Some(4), Some(20)), "{edit}");
    // The edit ends after the closing `>`: it replaces the whole type, brackets included.
    assert_eq!((edit["end"]["line"].as_u64(), edit["end"]["col"].as_u64()), (Some(4), Some(20 + "<chat-[:Channels]->-[:Messages]->-[:Files]->>".len() as u64)), "{edit}");
    assert_eq!(
        rewritten("function digest(f: <chat-[:Channels]->-[:Messages]->-[:Files]->>) {\n  return f.Name\n}\n", &found[0]),
        format!("{PRELUDE}function digest(f: <chat-[:File]->>) {{\n  return f.Name\n}}\n")
    );
}

#[test]
fn a_union_member_is_replaced_without_brackets_so_the_union_keeps_its_own() {
    let body = "function digest(f: <chat-[:Channels]->-[:Messages]->-[:Files]-> | chat-[:Message]->>) {\n  return f.Name\n}\n";
    let found = unknown_positions(body);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(offered(&found[0]), (Some("chat-[:File]->"), None));
    assert_eq!(
        rewritten(body, &found[0]),
        format!("{PRELUDE}function digest(f: <chat-[:File]-> | chat-[:Message]->>) {{\n  return f.Name\n}}\n")
    );
    let edit = &found[0].fix.as_ref().unwrap()["edits"][0]["span"];
    assert_eq!(edit["start"]["col"].as_u64(), Some(20 + 1), "{edit}");
}

#[test]
fn a_later_union_member_the_connection_no_longer_has_names_the_one_it_has() {
    let body = "function issue(e: <chat-[:Message]-> | sys-[:`Validation Issue`]->>) {\n  return e.Reason\n}\n";
    let found = unknown_positions(body);
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(rewritten(body, &found[0]), format!("{PRELUDE}function issue(e: <chat-[:Message]-> | sys-[:Event]->>) {{\n  return e.Reason\n}}\n"));
}

#[test]
fn a_walk_the_catalog_does_not_have_names_nothing_to_write() {
    let found = unknown_positions("function digest(f: <chat-[:Channels]->-[:Mesages]->>) {\n  return f.Name\n}\n");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].message, "'<chat-[:Channels]->-[:Mesages]->>' names no position: a type's address is one hop off the system");
    assert!(found[0].fix.is_none());
}

#[test]
fn a_position_the_connection_no_longer_has_names_the_one_it_has() {
    let found = unknown_positions("function issue(e: <sys-[:`Validation Issue`]->>) {\n  return e.Reason\n}\n");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].message, "'sys' has no position type 'Validation Issue' — it has: Event; write `<sys-[:Event]->>`");
    assert_eq!(offered(&found[0]), (Some("<sys-[:Event]->>"), None));
}

#[test]
fn a_position_missing_among_several_names_them_and_nothing_to_write() {
    let found = unknown_positions("function f(m: <chat-[:Mesage]->>) {\n  return m.Text\n}\n");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].message, "'chat' has no position type 'Mesage' — it has: Channel, Message, File");
    assert!(found[0].fix.is_none());
}

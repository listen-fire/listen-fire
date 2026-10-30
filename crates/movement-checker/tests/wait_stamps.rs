//! Where a record enters the run, for the waits on it. The program awaits an
//! edge off records of some type; every place a record of that type enters
//! the run (a bound write, a bound read, a traversal block's head, a
//! function's parameter) is stamped with the edges awaited off it
//! (`opensWaits`), so the run can open those waits from that moment. A plain
//! `await` on an edge that can also be listed reads the listing first
//! (`listsFirst`). Every rule is checked on two catalog shapes: a chat
//! (Messages, awaited for their Interactions or Replies) and a CRM (Deals,
//! awaited for their Notes).

use movement_checker::{CheckOptions, Severity};
use movement_checker::answer::check_answer;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::form_of_text;
use serde_json::Value as Json;

const CATALOG: &str = r#"{"adapters":{
  "chat":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Channel":{"properties":{"Name":"text"},"edges":{"Messages":{"target":"Message","writable":true}}},
    "Message":{"properties":{"Message":"text","Timestamp":"text"},"edges":{
      "Interactions":{"target":"Interaction","readable":false,"listenable":true,"identity":"Id"},
      "Replies":{"target":"Message","listenable":true,"sequenced":"chronological","identity":"Timestamp"},
      "Channel":{"target":"Channel"}}},
    "Interaction":{"properties":{"Id":"text"},"edges":{}}},
    "collections":{"Channels":{"target":"Channel"}},"supportsInPlaceUpdate":true,
    "writableRoots":{"Message":{"fields":{"Message":"text"},"resultShape":{"externalId":"text"}}}}}},
  "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Company":{"properties":{"Name":"text"},"edges":{"Deals":{"target":"Deal","writable":true}}},
    "Deal":{"properties":{"Name":"text"},"edges":{
      "Notes":{"target":"Note","listenable":true,"sequenced":"document"},
      "Changes":{"target":"Change","readable":false,"listenable":true},
      "Company":{"target":"Company"}}},
    "Note":{"properties":{"Body":"text"},"edges":{}},
    "Change":{"properties":{"Field":"text"},"edges":{}}},
    "collections":{"Deals":{"target":"Deal"},"Companies":{"target":"Company"}},"supportsInPlaceUpdate":true,
    "writableRoots":{"Deal":{"fields":{"Name":"text"},"resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{},"files":FILES}"#;

const HEAD: &str = "import { chat as chat_module, crm as crm_module } from adapters\nchat = connect chat_module\ncrm = connect crm_module\n";

/// The check's stamps on `source` (after HEAD), with `library` linked as
/// "lib/waits"; the check must be clean and place every stamp.
fn stamps(source: &str, library: Option<&str>) -> (Json, Option<Json>, Vec<Json>) {
    let files = match library {
        Some(library) => serde_json::json!({ "lib/waits": { "source": library } }).to_string(),
        None => "{}".to_string(),
    };
    let catalog = CatalogSnapshot::load(&CATALOG.replace("FILES", &files)).unwrap();
    let source = format!("{HEAD}{source}");
    let program = movement_parser::stmt::parse_program(&form_of_text(&source), false).unwrap_or_else(|e| panic!("{source}: {}", e.message));
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let answer = check_answer(&program, &catalog, options);
    // A function no listen fires is told so, as information.
    let diagnostics: Vec<String> =
        answer.diagnostics.iter().filter(|d| d.severity != Some(Severity::Info)).map(|d| format!("{} {}", d.code, d.message)).collect();
    assert_eq!(diagnostics, Vec::<String>::new(), "{source}");
    assert_eq!(answer.unplaced, Vec::<String>::new());
    let tree = serde_json::to_value(&program).unwrap();
    let library = library.map(|l| serde_json::to_value(movement_parser::stmt::parse_program(&form_of_text(l), false).unwrap()).unwrap());
    (tree, library, answer.stamps)
}

/// What a stamp's node is, in words: `param m`, `write msg`, `assign d`,
/// `block -[each:Deals]->`, `await r`.
fn label(tree: &Json, path: &str) -> String {
    let node = tree.pointer(path).unwrap_or_else(|| panic!("no node at {path}"));
    let named = |at: &str| tree.pointer(at).and_then(|n| n["name"].as_str()).unwrap_or_else(|| panic!("no name at {at}")).to_string();
    if let Some(assign) = path.strip_suffix("/value/write") {
        return format!("write {}", named(assign));
    }
    if let Some(assign) = path.strip_suffix("/value/await/source") {
        return format!("await {}", named(assign));
    }
    if path.ends_with("/block/head") {
        return format!("block {}", node["hopsRaw"].as_str().unwrap());
    }
    if path.rsplit('/').nth(1) == Some("params") {
        return format!("param {}", named(path));
    }
    if node["kind"] == "assign" {
        return format!("assign {}", named(path));
    }
    panic!("a stamp on an unexpected node at {path}: {node}")
}

/// Each `opensWaits` stamp in the file `file` (none: the program checked),
/// as (its node, the edges).
fn opens(tree: &Json, stamps: &[Json], file: Option<&str>) -> Vec<(String, Vec<String>)> {
    stamps
        .iter()
        .filter(|s| s["file"].as_str() == file)
        .filter_map(|s| {
            let edges = s.get("opensWaits")?.as_array()?.iter().map(|e| e.as_str().unwrap().to_string()).collect();
            Some((label(tree, s["path"].as_str().unwrap()), edges))
        })
        .collect()
}

/// Each `listsFirst` stamp in the program checked, by its node.
fn lists_first(tree: &Json, stamps: &[Json]) -> Vec<String> {
    stamps.iter().filter(|s| s["file"].is_null() && s["listsFirst"] == true).map(|s| label(tree, s["path"].as_str().unwrap())).collect()
}

fn pairs(expected: &[(&str, &[&str])]) -> Vec<(String, Vec<String>)> {
    expected.iter().map(|(at, edges)| (at.to_string(), edges.iter().map(|e| e.to_string()).collect())).collect()
}

#[test]
fn every_place_an_awaited_record_enters_is_stamped_and_no_other() {
    let chat = "function f(m: <chat-[:Message]->>) {\n  ch = only(chat-[:Channels]->)\n  if (ch == null) {\n    fail(\"no channel\")\n  }\n  msg = write ch-[:Messages]-> { Message: \"Pursue?\" }\n  d = only(crm-[:Deals]->)\n  i = await msg-[:Interactions]->\n}\n";
    let (tree, _, found) = stamps(chat, None);
    // The Channel and the Deal enter too, and nothing awaits off them.
    assert_eq!(opens(&tree, &found, None), pairs(&[("param m", &["Interactions"]), ("write msg", &["Interactions"])]));

    let crm = "function g(c: <crm-[:Companies]->>) {\n  d = only(c-[:Deals]->)\n  crm-[each:Deals]-> {\n    n = await new each-[:Notes]->\n  }\n  ch = only(chat-[:Channels]->)\n  first_note = await d-[:Notes]->\n  change = await d-[:Changes]->\n}\n";
    let (tree, _, found) = stamps(crm, None);
    // The Company and the Channel enter, and nothing awaits off them; the
    // awaited Note does not enter anywhere a wait is opened off it.
    assert_eq!(opens(&tree, &found, None), pairs(&[("assign d", &["Changes", "Notes"]), ("block -[each:Deals]->", &["Changes", "Notes"])]));
}

#[test]
fn a_record_read_back_whole_is_stamped_where_it_was_bound_not_where_it_is_renamed() {
    let chat = "function f(ch: <chat-[:Channel]->>) {\n  msg = only(ch-[:Messages]->)\n  same = msg\n  r = await same-[:Replies]->\n}\n";
    let (tree, _, found) = stamps(chat, None);
    // `r` is a Message too: a Message's Replies are awaited, so it opens.
    assert_eq!(opens(&tree, &found, None), pairs(&[("assign msg", &["Replies"]), ("assign r", &["Replies"])]));

    let crm = "function g(c: <crm-[:Companies]->>) {\n  d = only(c-[:Deals]->)\n  again = d\n  n = await new again-[:Notes]->\n}\n";
    let (tree, _, found) = stamps(crm, None);
    assert_eq!(opens(&tree, &found, None), pairs(&[("assign d", &["Notes"])]));
}

#[test]
fn a_library_that_awaits_stamps_the_callers_read() {
    // The library imports and connects the adapter under names of its own:
    // a record's type is the catalog's adapter, whatever a file calls it.
    let library = "import { chat as talk } from adapters\nsystem = connect talk\nexport function answer(msg: <system-[:Message]->>) {\n  i = await msg-[:Interactions]->\n  return i\n}\n";
    let root = "import { answer } from \"lib/waits\"\nfunction f(ch: <chat-[:Channel]->>) {\n  m = only(ch-[:Messages]->)\n  if (m != null) {\n    i = answer(m)\n  }\n}\n";
    let (tree, library_tree, found) = stamps(root, Some(library));
    assert_eq!(opens(&tree, &found, None), pairs(&[("assign m", &["Interactions"])]));
    assert_eq!(opens(&library_tree.unwrap(), &found, Some("lib/waits")), pairs(&[("param msg", &["Interactions"])]));

    let library = "import { crm as deals_module } from adapters\npipeline = connect deals_module\nexport function next_note(deal: <pipeline-[:Deal]->>) {\n  return await new deal-[:Notes]->\n}\n";
    let root = "import { next_note } from \"lib/waits\"\nfunction g(c: <crm-[:Companies]->>) {\n  d = only(c-[:Deals]->)\n  if (d != null) {\n    n = next_note(d)\n  }\n}\n";
    let (tree, library_tree, found) = stamps(root, Some(library));
    assert_eq!(opens(&tree, &found, None), pairs(&[("assign d", &["Notes"])]));
    assert_eq!(opens(&library_tree.unwrap(), &found, Some("lib/waits")), pairs(&[("param deal", &["Notes"])]));
}

#[test]
fn plain_await_on_an_iterable_edge_lists_first_and_await_new_does_not() {
    let chat = "function f(msg: <chat-[:Message]->>) {\n  r = await msg-[:Replies]->\n  later = await new msg-[:Replies]->\n  i = await msg-[:Interactions]->\n}\n";
    let (tree, _, found) = stamps(chat, None);
    assert_eq!(lists_first(&tree, &found), ["await r"]);

    let crm = "function g(d: <crm-[:Deal]->>) {\n  n = await d-[:Notes]->\n  later = await new d-[:Notes]->\n  c = await d-[:Changes]->\n}\n";
    let (tree, _, found) = stamps(crm, None);
    assert_eq!(lists_first(&tree, &found), ["await n"]);
}

#[test]
fn a_closure_parameter_is_where_a_record_no_name_held_enters() {
    let chat = "function f(ch: <chat-[:Channel]->>) {\n  answers = map(ch-[:Messages]->, (m) => {\n    return await m-[:Interactions]->\n  })\n}\n";
    let (tree, _, found) = stamps(chat, None);
    assert_eq!(opens(&tree, &found, None), pairs(&[("param m", &["Interactions"])]));

    let crm = "function g(c: <crm-[:Company]->>) {\n  notes = map(c-[:Deals]->, (d) => {\n    n = await d-[:Notes]->\n    return n\n  })\n}\n";
    let (tree, _, found) = stamps(crm, None);
    assert_eq!(opens(&tree, &found, None), pairs(&[("param d", &["Notes"])]));
}

#[test]
fn a_write_no_name_holds_and_a_write_in_place_open_nothing() {
    let chat = "function f(ch: <chat-[:Channel]->>, m: <chat-[:Message]->>) {\n  write ch-[:Messages]-> { Message: \"Posted\" }\n  again = write m { Message: \"Edited\" }\n  i = await m-[:Interactions]->\n}\n";
    let (tree, _, found) = stamps(chat, None);
    assert_eq!(opens(&tree, &found, None), pairs(&[("param m", &["Interactions"])]));

    let crm = "function g(c: <crm-[:Company]->>, d: <crm-[:Deal]->>) {\n  write c-[:Deals]-> { Name: \"Renewal\" }\n  again = write d { Name: \"Renamed\" }\n  n = await new d-[:Notes]->\n}\n";
    let (tree, _, found) = stamps(crm, None);
    assert_eq!(opens(&tree, &found, None), pairs(&[("param d", &["Notes"])]));
}

#[test]
fn a_where_reading_a_record_the_run_holds_still_stamps_its_wait() {
    // A field of a run record read in the awaited hop's WHERE is typed by a
    // walk of its own: the await still waits on its own hop's edge.
    let chat = "function f(m: <chat-[:Message]->>, ch: <chat-[:Channel]->>) {\n  msg = write ch-[:Messages]-> { Message: \"Pursue?\" }\n  i = await msg-[i:Interactions WHERE i.Id == m.Message]->\n  r = await msg-[r:Replies WHERE r.Message == m.Message]->\n}\n";
    let (tree, _, found) = stamps(chat, None);
    assert_eq!(opens(&tree, &found, None), pairs(&[("param m", &["Interactions", "Replies"]), ("write msg", &["Interactions", "Replies"]), ("assign r", &["Interactions", "Replies"])]));
    assert_eq!(lists_first(&tree, &found), ["await r"]);

    let crm = "function g(c: <crm-[:Company]->>) {\n  d = only(c-[:Deals]->)\n  n = await d-[n:Notes WHERE n.Body == c.Name]->\n}\n";
    let (tree, _, found) = stamps(crm, None);
    assert_eq!(opens(&tree, &found, None), pairs(&[("assign d", &["Notes"])]));
    assert_eq!(lists_first(&tree, &found), ["await n"]);
}

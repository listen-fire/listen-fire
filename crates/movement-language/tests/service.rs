//! Each query of the language service on small programs, whole and half-typed.

use movement_language::{ConnectAction, DiagSeverity, Item, ItemKind, ModuleNamespace, ModuleRef, Pos, Range, Service};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = include_str!("fixtures/service/catalog.json");

const PROGRAM: &str = include_str!("fixtures/service/program.mvt");

fn service() -> Service {
    Service::new(CatalogSnapshot::load(CATALOG).unwrap())
}

/// The position just after the `n`th (0-based) occurrence of `marker` in `source`.
fn after(source: &str, marker: &str, n: usize) -> Pos {
    let at = source.match_indices(marker).nth(n).unwrap_or_else(|| panic!("no {marker}")).0 + marker.len();
    let before = &source[..at];
    let line = before.matches('\n').count() as u32;
    let character = before.rsplit('\n').next().unwrap().encode_utf16().count() as u32;
    Pos { line, character }
}

/// `source` with `inserted` written at `pos`'s line end... at the byte after `marker`.
fn typed(source: &str, marker: &str, inserted: &str) -> (String, Pos) {
    let at = source.find(marker).unwrap() + marker.len();
    let text = format!("{}{inserted}{}", &source[..at], &source[at..]);
    let pos = after(&text, &format!("{marker}{inserted}"), 0);
    (text, pos)
}

fn labels(items: &[Item]) -> Vec<&str> {
    items.iter().map(|i| i.label.as_str()).collect()
}

#[test]
fn a_whole_program_checks_clean() {
    let found = service().diagnostics(PROGRAM);
    assert!(found.iter().all(|d| d.severity != DiagSeverity::Error), "{found:?}");
}

#[test]
fn a_file_that_does_not_parse_reports_its_refusal() {
    let found = service().diagnostics("function f( {\n");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].code, "MOV_PARSE");
}

#[test]
fn the_scope_at_the_cursor_holds_what_is_bound_above_it() {
    // Half-typed: a new line `  x = ` inside hello, after `greeting`.
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  x = gr");
    let items = service().complete(&text, pos);
    let names = labels(&items);
    for expected in ["greeting", "run", "hello", "scan", "chat", "greet", "manual", "cron", "map", "Text"] {
        assert!(names.contains(&expected), "{expected} missing from {names:?}");
    }
    // `c` is scan's parameter, not hello's; `ms` is bound in scan.
    assert!(!names.contains(&"c") && !names.contains(&"ms"), "{names:?}");
    let greeting = items.iter().find(|i| i.label == "greeting").unwrap();
    assert_eq!(greeting.detail.as_deref(), Some("text"));
}

#[test]
fn a_wait_for_only_what_arrives_is_offered() {
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  x = aw");
    let items = service().complete(&text, pos);
    let offered = items.iter().find(|i| i.label == format!("await {}", movement_parser::stmt::AWAIT_ARRIVALS_WORD)).expect("await new offered");
    assert_eq!(offered.kind, ItemKind::Keyword);
    assert!(labels(&items).contains(&"await"), "{:?}", labels(&items));
}

#[test]
fn a_binding_below_the_cursor_is_not_yet_in_scope() {
    let pos = after(PROGRAM, "function hello(run: <manual-[:Invocations]->>) {\n", 0);
    let names: Vec<String> = labels(&service().complete(PROGRAM, pos)).into_iter().map(String::from).collect();
    assert!(names.contains(&"run".to_string()) && !names.contains(&"greeting".to_string()), "{names:?}");
}

#[test]
fn fields_follow_a_dot_and_a_backtick() {
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  y = run.");
    let items = service().complete(&text, pos);
    assert_eq!(labels(&items), ["Text", "Run by (name)"]);
    assert_eq!(items[1].insert.as_deref(), Some("`Run by (name)`"));
    assert_eq!(items[0].detail.as_deref(), Some("text"));
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  y = run.`Ru");
    let items = service().complete(&text, pos);
    assert!(labels(&items).contains(&"Run by (name)"));
    assert!(items[0].insert.is_none() && items[0].replace.is_some());
}

#[test]
fn fields_follow_a_hop_alias() {
    let (text, pos) = typed(PROGRAM, "  ms = c-[m:Messages WHERE m.", "");
    let items = service().complete(&text, pos);
    assert_eq!(labels(&items), ["Body", "Score"]);
    // Half-typed: the WHERE not finished.
    let (text, pos) = typed(PROGRAM, "  return count(ms)\n", "  ns = c-[n:Messages WHERE n.");
    assert_eq!(labels(&service().complete(&text, pos)), ["Body", "Score"]);
}

#[test]
fn edges_follow_a_hop_opening() {
    let (text, pos) = typed(PROGRAM, "  return count(ms)\n", "  ns = c-[:");
    let items = service().complete(&text, pos);
    assert_eq!(labels(&items), ["Messages"]);
    assert_eq!(items[0].kind, ItemKind::Edge);
    assert!(items[0].detail.as_deref().unwrap().contains("message"), "{:?}", items[0].detail);
    // Off the instance itself: its collections.
    let (text, pos) = typed(PROGRAM, "  return count(ms)\n", "  all = chat-[:");
    assert_eq!(labels(&service().complete(&text, pos)), ["Channels"]);
    // Two hops deep: the message has no edges.
    let (text, pos) = typed(PROGRAM, "  return count(ms)\n", "  deep = c-[:Messages]->-[:");
    assert!(service().complete(&text, pos).is_empty());
}

#[test]
fn record_types_follow_an_instance_in_a_type() {
    let (text, pos) = typed(PROGRAM, "listen to manual-[:Invocations]-> fire hello\n", "function more(x: <chat-[:");
    assert_eq!(labels(&service().complete(&text, pos)), ["channel", "message"]);
}

#[test]
fn a_namespace_offers_its_functions_as_the_language_spells_them() {
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  z = Text.");
    let items = service().complete(&text, pos);
    let names = labels(&items);
    assert!(names.contains(&"upper") && names.contains(&"includes") && !names.contains(&"UPPER"), "{names:?}");
    assert_eq!(items.iter().find(|i| i.label == "upper").unwrap().detail.as_deref(), Some("Text.upper(text)"));
}

#[test]
fn module_tags_complete_inside_an_import() {
    let source = "import {  } from adapters\n";
    let items = service().complete(source, Pos { line: 0, character: 9 });
    assert_eq!(labels(&items), ["`@lf/slack`"]);
    let items = service().complete("import {  } from plugins\n", Pos { line: 0, character: 9 });
    assert_eq!(labels(&items), ["`@lf/web`", "summarise"]);
    assert_eq!(items[0].insert.as_deref(), Some("`@lf/web` as web"));
    let items = service().complete("import {  } from \"lib/greet\"\n", Pos { line: 0, character: 9 });
    assert_eq!(labels(&items), ["greet"]);
}

#[test]
fn credential_names_follow_using() {
    let (text, pos) = typed(PROGRAM, "chat = connect slack", " using ");
    let items = service().complete(&text, pos);
    assert_eq!(labels(&items), ["acme_bot"]);
}

#[test]
fn adapters_follow_connect_with_no_import() {
    let items = service().complete("chat = connect ", Pos { line: 0, character: 15 });
    assert_eq!(labels(&items), ["@lf/slack"]);
    assert_eq!(items[0].insert.as_deref(), Some("`@lf/slack`"));
}

#[test]
fn credential_names_follow_using_with_no_import() {
    let source = "chat = connect `@lf/slack` using ";
    let items = service().complete(source, Pos { line: 0, character: source.len() as u32 });
    assert_eq!(labels(&items), ["acme_bot"]);
}

#[test]
fn connect_s_adapter_and_credential_hover_with_no_import() {
    let source = "chat = connect `@lf/slack` using acme_bot\n";
    let adapter = service().hover(source, after(source, "@lf/sla", 0)).unwrap();
    assert!(adapter.contents.contains("An adapter."), "{}", adapter.contents);
    let credential = service().hover(source, after(source, "acme_b", 0)).unwrap();
    assert!(credential.contents.contains("Sign-in for slack"), "{}", credential.contents);
    let module = |marker: &str| service().definition(source, after(source, marker, 0)).and_then(|l| l.module);
    assert_eq!(module("@lf/sla"), Some(ModuleRef { namespace: ModuleNamespace::Adapters, name: "slack".into() }));
    assert_eq!(module("acme_b"), Some(ModuleRef { namespace: ModuleNamespace::Credentials, name: "acme_bot".into() }));
}

const HOVERED: &str ="import { `@lf/slack` as slack } from adapters
import { `@lf/web` as web } from plugins
chat = connect slack

# Reads the `count` of what only arrives first.
function scan(c: <chat-[:channel]->>) {
  page = web.fetchUrl(c.Name)
  ms = c-[m:Messages]->
  return count(ms)
}
";

#[test]
fn hover_leads_with_the_adapter_s_own_words() {
    let service = service();
    let hover = service.hover(HOVERED, after(HOVERED, "c-[m:Mess", 0)).unwrap();
    assert!(hover.contents.starts_with("```movement\nc-[:Messages]-> message\n```\nWhat was said in the channel, oldest first.\n\nmessage records in chat."), "{}", hover.contents);
    assert!(hover.contents.contains("Fields: Body: text, Score: number"), "{}", hover.contents);
    let hover = service.hover(HOVERED, after(HOVERED, "c.Na", 0)).unwrap();
    assert!(hover.contents.contains("Name: text\n```\nThe channel's name, without its #.\n\nOn a channel record from chat."), "{}", hover.contents);
    let hover = service.hover(HOVERED, after(HOVERED, "function scan(", 0)).unwrap();
    assert!(hover.contents.contains("c: channel (from chat)\n```\nA place the team talks.\n\nParameter of scan."), "{}", hover.contents);
    assert!(hover.contents.contains("Walk on: Messages → message"), "{}", hover.contents);
    let hover = service.hover(HOVERED, after(HOVERED, "\ncha", 0)).unwrap();
    assert!(hover.contents.contains("chat = connect slack\n```\nThe team's chat.\n\nA connection to slack.\n\nHolds: channel, message"), "{}", hover.contents);
}

#[test]
fn a_plugin_package_and_its_members_have_cards() {
    let service = service();
    let hover = service.hover(HOVERED, after(HOVERED, "page = we", 0)).unwrap();
    assert!(hover.contents.contains("Plugin package @lf/web.\n\n`fetchUrl(url: text) → text`"), "{}", hover.contents);
    let hover = service.hover(HOVERED, after(HOVERED, "as we", 0)).unwrap();
    assert!(hover.contents.contains("Plugin package @lf/web."), "{}", hover.contents);
    let hover = service.hover(HOVERED, after(HOVERED, "web.fetch", 0)).unwrap();
    assert!(hover.contents.contains("web.fetchUrl(url: text) → text\n```\nThe page at a URL, as text.\n\nFrom plugin package @lf/web."), "{}", hover.contents);
}

#[test]
fn words_in_a_comment_have_no_card() {
    let service = service();
    assert!(service.hover(HOVERED, after(HOVERED, "# Reads the `co", 0)).is_none());
    assert!(service.hover(HOVERED, after(HOVERED, "what on", 0)).is_none());
    assert!(service.hover(HOVERED, after(HOVERED, "return cou", 0)).is_some());
}

#[test]
fn a_built_in_s_card_is_the_reference_s_own_line() {
    let service = service();
    let hover = service.hover(HOVERED, after(HOVERED, "return cou", 0)).unwrap();
    assert!(hover.contents.contains("`count(list | walk)` → `number`, always present"), "{}", hover.contents);
    assert!(!hover.contents.contains("before this release") && !hover.contents.contains("follows from its arguments"), "{}", hover.contents);
}

#[test]
fn hover_shows_the_type_a_doc_line_and_a_versioned_link() {
    let service = service();
    let hover = service.hover(PROGRAM, after(PROGRAM, "return greet(gree", 0)).unwrap();
    assert!(hover.contents.contains("greeting: text"), "{}", hover.contents);
    assert!(hover.contents.contains(&format!("{}/reference#top-level", movement_language::docs_base())), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "Text.up", 0)).unwrap();
    assert!(hover.contents.contains("Text.upper(text)") && hover.contents.contains("the text, uppercased"), "{}", hover.contents);
    assert!(hover.contents.contains(&format!("/docs/{}/builtins#textupper", movement_language::DOCS_SLUG)), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "run.`Te", 0)).unwrap();
    assert!(hover.contents.contains("Text: text"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "m.Sco", 0)).unwrap();
    assert!(hover.contents.contains("Score: number"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "c-[m:Mess", 0)).unwrap();
    assert!(hover.contents.contains("c-[:Messages]-> message"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "function sc", 0)).unwrap();
    assert!(hover.contents.contains("function scan(c: <chat-[:channel]->>)\n```\nNo listen fires it"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "function hel", 0)).unwrap();
    assert!(hover.contents.contains("Runs when: `listen to manual-[:Invocations]->`."), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "<manu", 0)).unwrap();
    assert!(hover.contents.contains("Built into listen-fire; no import needed.\n\nListen to: Invocations"), "{}", hover.contents);
    let hover = service.hover(PROGRAM, after(PROGRAM, "  greeti", 0)).unwrap();
    assert!(hover.contents.contains("Set on line 6."), "{}", hover.contents);
}

#[test]
fn definition_finds_bindings_functions_and_library_declarations() {
    let service = service();
    let found = service.definition(PROGRAM, after(PROGRAM, "return greet(gree", 0)).unwrap();
    assert_eq!(found.file, None);
    assert_eq!(found.range.start, Pos { line: 5, character: 2 });
    let found = service.definition(PROGRAM, after(PROGRAM, "listen to manual-[:Invocations]-> fire hel", 0)).unwrap();
    assert_eq!(found.range.start, Pos { line: 4, character: 9 });
    let found = service.definition(PROGRAM, after(PROGRAM, "return gre", 0)).unwrap();
    assert_eq!(found.file.as_deref(), Some("lib/greet"));
    assert_eq!(found.range.start.line, 0);
    let found = service.definition(PROGRAM, after(PROGRAM, "from \"lib/gr", 0)).unwrap();
    assert_eq!(found.file.as_deref(), Some("lib/greet"));
    // A parameter.
    let found = service.definition(PROGRAM, after(PROGRAM, "Text.upper(ru", 0)).unwrap();
    assert_eq!(found.range.start, Pos { line: 4, character: 15 });
}

#[test]
fn code_actions_are_the_checker_s_fixes() {
    // An old spelling under 5: MOV_V5_SPELLING with its rewrite.
    let source = PROGRAM.replace("Text.upper(run.`Text`)", "UPPER(run.`Text`)");
    let service = service();
    let found = service.diagnostics(&source);
    let spelling = found.iter().find(|d| d.code == "MOV_V5_SPELLING").unwrap_or_else(|| panic!("{found:?}"));
    let actions = service.code_actions(&source, spelling.range);
    let action = actions.iter().find(|a| a.code == "MOV_V5_SPELLING").unwrap();
    assert!(action.edits.iter().any(|e| e.new_text.contains("Text.upper")), "{actions:?}");
}

#[test]
fn a_did_you_mean_becomes_a_rewrite() {
    let source = PROGRAM.replace("run.`Text`", "run.`Txt`");
    let service = service();
    let found = service.diagnostics(&source);
    let unknown = found.iter().find(|d| d.code == "MOV_UNKNOWN_PROPERTY").unwrap_or_else(|| panic!("{found:?}"));
    let actions = service.code_actions(&source, Range { start: unknown.range.start, end: unknown.range.start });
    let action = actions.iter().find(|a| a.title.contains("'Text'")).unwrap_or_else(|| panic!("{} {actions:?}", unknown.message));
    assert_eq!(action.edits[0].new_text, "Text");
}

#[test]
fn completion_on_a_line_that_breaks_the_parse_still_sees_the_scope() {
    // `(` left open on the cursor's line.
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  bad = Text.upper(gr");
    assert!(service().diagnostics(&text).iter().any(|d| d.code == "MOV_PARSE"));
    assert!(labels(&service().complete(&text, pos)).contains(&"greeting"));
    // A function header half written: everything above still answers.
    let (text, pos) = typed(PROGRAM, "listen to manual-[:Invocations]-> fire hello\n", "function late(x: <num");
    let names: Vec<String> = labels(&service().complete(&text, pos)).into_iter().map(String::from).collect();
    assert!(names.contains(&"hello".to_string()), "{names:?}");
}

#[test]
fn a_name_from_a_module_namespace_defines_as_that_module() {
    let service = service();
    let found = service.definition(PROGRAM, after(PROGRAM, "chat = connect sla", 0)).unwrap();
    assert_eq!(found.file, None);
    assert_eq!(found.module, Some(ModuleRef { namespace: ModuleNamespace::Adapters, name: "slack".into() }));
    let source = format!("import {{ summarise }} from plugins\n{PROGRAM}");
    let found = service.definition(&source, after(&source, "import { summa", 0)).unwrap();
    assert_eq!(found.module, Some(ModuleRef { namespace: ModuleNamespace::Plugins, name: "summarise".into() }));
    // A binding of the file's own is no module's.
    let found = service.definition(PROGRAM, after(PROGRAM, "return greet(gree", 0)).unwrap();
    assert_eq!(found.module, None);
}

#[test]
fn an_instance_whose_adapter_declares_connect_actions_offers_them_after_a_dot() {
    let (text, pos) = typed(PROGRAM, "  return count(ms)\n", "  x = chat.");
    let items = service().complete(&text, pos);
    let connect: Vec<&Item> = items.iter().filter(|i| i.connect_action.is_some()).collect();
    assert_eq!(connect.len(), 1, "{items:?}");
    assert_eq!(connect[0].label, "+ Connect a channel");
    assert_eq!(connect[0].detail.as_deref(), Some("slack"));
    assert_eq!(connect[0].connect_action, Some(ConnectAction { kind: "slack-channel-picker".into(), adapter: "slack".into(), credential: None }));
    // A record's fields are not an instance's: no action.
    let (text, pos) = typed(PROGRAM, "  greeting = Text.upper(run.`Text`)\n", "  y = run.");
    assert!(service().complete(&text, pos).iter().all(|i| i.connect_action.is_none()));
}

/// A listen's hops: Channels are listed only; a Channel's Messages are
/// listed and announced, its Drafts written only; a Message's Interactions
/// are announced only.
const LISTEN_CATALOG: &str = r#"{"adapters":{"chat":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
  "Channel":{"properties":{"Name":"text"},"edges":{
    "Drafts":{"target":"Message","readable":false,"writable":true},
    "Messages":{"target":"Message","listenable":true}}},
  "Message":{"properties":{"Text":"text"},"edges":{"Interactions":{"target":"Interaction","readable":false,"listenable":true}}},
  "Interaction":{"properties":{"Id":"text"},"edges":{}}},
  "collections":{"Channels":{"target":"Channel"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

#[test]
fn a_listen_is_offered_the_edges_it_can_take_those_it_can_end_on_first() {
    let listen = Service::new(CatalogSnapshot::load(LISTEN_CATALOG).unwrap());
    let head = "import { chat as chat_module } from adapters\nchat = connect chat_module\n";
    let at_end = |text: &str| Pos { line: text.matches('\n').count() as u32, character: text.rsplit('\n').next().unwrap().encode_utf16().count() as u32 };
    let text = format!("{head}listen to chat-[:");
    assert_eq!(labels(&listen.complete(&text, at_end(&text))), ["Channels"]);
    let text = format!("{head}listen to chat-[:Channels]->-[:");
    let items = listen.complete(&text, at_end(&text));
    assert_eq!(labels(&items), ["Messages"], "a written-only edge is no hop of a listen");
    assert!(items[0].detail.as_deref().unwrap().contains("a listen can end here"), "{:?}", items[0].detail);
    let text = format!("{head}listen as \"Presses\" to chat-[:Channels]->-[:Messages]->-[i:");
    let items = listen.complete(&text, at_end(&text));
    assert_eq!(labels(&items), ["Interactions"]);
    assert!(items[0].detail.as_deref().unwrap().contains("only announced: a listen ends here"), "{:?}", items[0].detail);
    // Outside a listen, a walk is offered every edge, as before.
    let (text, pos) = typed(&format!("{head}function f(c: <chat-[:Channel]->>) {{\n  return 1\n}}\n"), ">>) {\n", "  x = c-[:");
    assert_eq!(labels(&listen.complete(&text, pos)), ["Drafts", "Messages"]);
}

/// A connection's hover names every edge a listen may end on, off the
/// connection or off its records: a chat announces nothing at its root.
#[test]
fn the_hover_lists_every_edge_a_listen_may_end_on() {
    let listen = Service::new(CatalogSnapshot::load(LISTEN_CATALOG).unwrap());
    let text = "import { chat as chat_module } from adapters\nchat = connect chat_module\nlisten to chat-[:Channels]->-[:Messages]-> fire f\nfunction f(m: <chat-[:Message]->>) { return 1 }\n";
    let hover = listen.hover(text, after(text, "listen to cha", 0)).unwrap();
    assert!(hover.contents.contains("Listen to: Messages, Interactions"), "{}", hover.contents);
}

const UNION_CATALOG: &str = r#"{"adapters":{"crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
  "Memo":{"properties":{"Text":"text","Mood":"text"},"edges":{}},
  "Remark":{"properties":{"Text":"text","Tone":"text"},"edges":{}}},
  "collections":{"Memos":{"target":"Memo"},"Remarks":{"target":"Remark"}},
  "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

/// A parameter of a written union type is one of its records, and offers
/// what every one of them has.
#[test]
fn a_union_parameter_hovers_as_one_of_its_records() {
    let service = Service::new(CatalogSnapshot::load(UNION_CATALOG).unwrap());
    let text = "import { crm as m } from adapters\ncrm = connect m\nfunction noted(n: <crm-[:Memo]-> | crm-[:Remark]->>) {\n  return n.Text\n}\n";
    let hover = service.hover(text, after(text, "return n", 0)).unwrap();
    assert!(hover.contents.contains("n: crm.Memo or crm.Remark"), "{}", hover.contents);
    assert!(hover.contents.contains("Fields: Text (text)"), "{}", hover.contents);
    let hover = service.hover(text, after(text, "function no", 0)).unwrap();
    assert!(hover.contents.contains("function noted(n: <crm-[:Memo]-> | crm-[:Remark]->>)"), "{}", hover.contents);
}

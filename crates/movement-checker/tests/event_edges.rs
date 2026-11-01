//! `await` and `await new` on an edge its module announces arrivals on
//! (`listenable`). Whether the edge can also be listed is `readable`: an edge
//! that can only announce is refused anywhere but a wait, an edge that
//! announces nothing cannot be waited on, and a plain `await` takes the first
//! match already on a listable edge, so the edge must declare an order.
//! Every rule is checked on two catalog shapes: a chat (`msg`, a Message)
//! and a CRM (`deal`, a Deal).

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{
  "chat":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Message":{"properties":{"Text":"text","Timestamp":"text"},"edges":{
      "Interactions":{"target":"Interaction","readable":false,"listenable":true,"identity":"Id"},
      "Replies":{"target":"Message","listenable":true,"sequenced":"chronological","identity":"Timestamp"},
      "Thread":{"target":"Message","listenable":true},
      "Reactions":{"target":"Reaction","readable":false,"writable":true},
      "Channel":{"target":"Channel"}}},
    "Interaction":{"properties":{"Id":"text","Action":"text"},"edges":{}},
    "Reaction":{"properties":{"Emoji":"text"},"edges":{}},
    "Channel":{"properties":{"Name":"text"},"edges":{}}},
    "collections":{},"writableRoots":{}}}},
  "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Deal":{"properties":{"Name":"text"},"edges":{
      "Notes":{"target":"Note","listenable":true,"sequenced":"document"},
      "Changes":{"target":"Change","readable":false,"listenable":true},
      "Emails":{"target":"Email","listenable":true},
      "Company":{"target":"Company"}}},
    "Note":{"properties":{"Body":"text"},"edges":{}},
    "Change":{"properties":{"Field":"text"},"edges":{}},
    "Email":{"properties":{"Subject":"text"},"edges":{}},
    "Company":{"properties":{"Name":"text"},"edges":{
      "Updates":{"target":"Change","readable":false,"listenable":true}}}},
    "collections":{},"writableRoots":{}}}}
},"credentials":{},"plugins":{}}"#;

/// `body` as the body of a function holding a chat message `msg` and a CRM
/// deal `deal`; its first line is line 2.
fn diagnostics(body: &str) -> Vec<Diagnostic> {
    let source = format!(
        "import {{ chat as chat_module, crm as crm_module }} from adapters; chat = connect chat_module; crm = connect crm_module; function waits(msg: <chat-[:Message]->>, deal: <crm-[:Deal]->>) {{\n{body}}}\n"
    );
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

fn check(body: &str) -> Vec<String> {
    diagnostics(body)
        .into_iter()
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

fn fix_text(d: &Diagnostic) -> String {
    let fix = d.fix.as_ref().expect("a fix");
    fix["edits"][0]["text"].as_str().expect("an edit's text").to_string()
}

#[test]
fn await_and_await_new_take_one_record_off_a_listenable_edge() {
    assert_eq!(check("  i = await msg-[:Interactions]->\n  t = i.Id\n  n = await new deal-[:Notes]->\n"), Vec::<String>::new());
    assert_eq!(check("  r = await msg-[:Replies]->\n  t = r.Timestamp\n  c = await deal-[:Changes]->\n  f = c.Field\n"), Vec::<String>::new());
}

#[test]
fn a_non_iterable_edge_is_refused_outside_a_wait() {
    assert_eq!(
        check("  xs = msg-[:Interactions]->\n"),
        ["MOV_AWAIT_REQUIRED 2:8-2:29 '-[:Interactions]->' on chat's Message can't be listed — its module only announces what arrives on it. Wait for one: `await msg-[:Interactions]->`"]
    );
    assert_eq!(
        check("  xs = deal-[:Changes]->\n"),
        ["MOV_AWAIT_REQUIRED 2:8-2:25 '-[:Changes]->' on crm's Deal can't be listed — its module only announces what arrives on it. Wait for one: `await deal-[:Changes]->`"]
    );
    // Past the first hop no one name holds the record, so no wait is offered.
    assert_eq!(
        check("  xs = deal-[:Company]->-[:Updates]->\n"),
        ["MOV_AWAIT_REQUIRED 2:8-2:38 '-[:Updates]->' on crm's Company can't be listed — its module only announces what arrives on it."]
    );
}

#[test]
fn an_edge_that_announces_nothing_cannot_be_awaited() {
    assert_eq!(
        check("  c = await msg-[:Channel]->\n"),
        ["MOV_AWAIT_NOT_AWAITABLE 2:13-2:29 '-[:Channel]->' on chat's Message announces nothing, so 'await' has nothing to wait for — only an edge its module announces arrivals on can be awaited. Read it without 'await', or wait on a condition: `await until(() => { return exists(msg-[:Channel]->) }, { every: 15m })`"]
    );
    assert_eq!(
        check("  c = await new deal-[:Company]->\n"),
        ["MOV_AWAIT_NOT_AWAITABLE 2:17-2:34 '-[:Company]->' on crm's Deal announces nothing, so 'await' has nothing to wait for — only an edge its module announces arrivals on can be awaited. Read it without 'await', or wait on a condition: `await until(() => { return exists(deal-[:Company]->) }, { every: 15m })`"]
    );
}

#[test]
fn an_await_walks_one_edge_off_a_record_a_name_holds() {
    assert_eq!(
        check("  r = await msg-[:Thread]->-[:Interactions]->\n"),
        ["MOV_AWAIT_BARE_WALK 2:13-2:46 'await msg-[:Thread]->-[:Interactions]->' walks more than one edge, and 'await' waits on one edge of a record a name holds — bind that record first, and wait only when it is there: `one = only(msg-[:Thread]->)`, then `if (one != null) { x = await one-[:Interactions]-> }`"]
    );
    assert_eq!(check("  one = only(msg-[:Thread]->)\n  if (one != null) { r = await one-[:Interactions]-> }\n"), Vec::<String>::new());
    assert_eq!(
        check("  u = await deal-[:Company]->-[c:Updates WHERE c.Field == \"Name\"]->\n"),
        ["MOV_AWAIT_BARE_WALK 2:13-2:68 'await deal-[:Company]->-[c:Updates WHERE c.Field == \"Name\"]->' walks more than one edge, and 'await' waits on one edge of a record a name holds — bind that record first, and wait only when it is there: `one = only(deal-[:Company]->)`, then `if (one != null) { x = await one-[c:Updates WHERE c.Field == \"Name\"]-> }`"]
    );
    assert_eq!(check("  one = only(deal-[:Company]->)\n  if (one != null) { u = await one-[c:Updates WHERE c.Field == \"Name\"]-> }\n"), Vec::<String>::new());
}

#[test]
fn an_unordered_iterable_edge_needs_await_new() {
    assert_eq!(
        check("  t = await msg-[:Thread]->\n"),
        ["MOV_AWAIT_UNORDERED 2:13-2:28 'await' takes the first match already on '-[:Thread]->', and chat's Message declares no order for it, so 'first' would be a guess. Write `await new msg-[:Thread]->` to wait only for what arrives (see handbook: reviews#await-and-await-new)"]
    );
    assert_eq!(check("  t = await new msg-[:Thread]->\n"), Vec::<String>::new());
    assert_eq!(
        check("  e = await deal-[:Emails]->\n"),
        ["MOV_AWAIT_UNORDERED 2:13-2:29 'await' takes the first match already on '-[:Emails]->', and crm's Deal declares no order for it, so 'first' would be a guess. Write `await new deal-[:Emails]->` to wait only for what arrives (see handbook: reviews#await-and-await-new)"]
    );
    assert_eq!(check("  e = await new deal-[:Emails]->\n"), Vec::<String>::new());
}

#[test]
fn await_first_is_respelled_safely() {
    let d = diagnostics("  r = await first(msg-[:Replies]->)\n");
    assert_eq!(d[0].code, "MOV_V5_SPELLING");
    assert_eq!(d[0].message, "`await first(…)` is retired in 0.13: write `await msg-[:Replies]->` — it waits for the same one record");
    assert_eq!(fix_text(&d[0]), "await msg-[:Replies]->");
    assert_eq!(d[0].fix.as_ref().unwrap()["safe"], true);
    let d = diagnostics("  n = await FIRST(deal-[:Notes]->)\n");
    assert_eq!(d.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_V5_SPELLING"]);
    assert_eq!(fix_text(&d[0]), "await deal-[:Notes]->");
}

#[test]
fn awaiting_a_list_points_at_all() {
    assert_eq!(
        check("  ms = msg-[m:Replies]-> {\n    return m\n  }\n  r = await ms-[:Replies]->\n"),
        ["MOV_AWAIT_ON_LIST 5:13-5:28 'await' parks on one record, under one key, and 'ms' holds a list of records, so there is no one record to wait at — waiting on many records is all(…) over them"]
    );
}

/// Only the missing name is said: the edge's own rules wait for the rewrite.
#[test]
fn an_await_off_an_expression_names_the_record_first() {
    assert_eq!(
        check("  r = await only([msg])-[:Thread]->\n"),
        ["MOV_HEAD_NEEDS_A_NAME 2:13-2:36 'await' parks on the record it waits at, and a parked run finds that record again by NAME — so this one is bound first: 'waiting = only([msg])', then 'await waiting-[:Thread]->'."]
    );
}

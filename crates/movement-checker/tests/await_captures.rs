//! A wait's WHERE reads a run record's field once, when the wait is reached
//! (0.13); under an older pin it was read again at every check. A check for
//! an upgrade from such a pin says so on each wait this changes
//! (MOV_AWAIT_VALUE_CAPTURED, a warning with nothing to rewrite). What the
//! WHERE reads from a system (a walk off a connection) is read at every
//! check, as before, and is not told. Every rule is checked on two catalog
//! shapes: mail to a CRM's person, and a chat post about a desk's ticket.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const MAIL: &str = r#"{"adapters":{
  "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Person":{"properties":{"Email":"text","Name":"text"},"edges":{}}},
    "collections":{"People":{"target":"Person"}},"writableRoots":{}}}},
  "mail":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Message":{"properties":{"To":"text","Title":"text","From":"text","Sent":"text"},"edges":{
      "Replies":{"target":"Message","listenable":true,"sequenced":"chronological","identity":"Sent"}}}},
    "collections":{"Messages":{"target":"Message"}},
    "writableRoots":{"Message":{"fields":{"To":"text"},"resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{}}"#;

const CHAT: &str = r#"{"adapters":{
  "desk":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Ticket":{"properties":{"Owner":"text","Subject":"text"},"edges":{}}},
    "collections":{"Tickets":{"target":"Ticket"}},"writableRoots":{}}}},
  "chat":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Post":{"properties":{"Text":"text","Author":"text","Ts":"text"},"edges":{
      "Replies":{"target":"Post","listenable":true,"identity":"Ts"}}}},
    "collections":{"Posts":{"target":"Post"}},
    "writableRoots":{"Post":{"fields":{"Text":"text"},"resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{}}"#;

/// Every diagnostic on `body`, checked as an upgrade from `pin` if given.
/// It is the body of a function taking a text `t` and a person `p` (MAIL)
/// or a ticket `p` (CHAT); its first line is line 2.
fn diagnostics(catalog: &str, body: &str, pin: Option<&str>) -> Vec<Diagnostic> {
    let header = if catalog == MAIL {
        "import { crm as crm_module, mail as mail_module } from adapters; crm = connect crm_module; mail = connect mail_module; function go(t: <text>, p: <crm-[:People]->>) {"
    } else {
        "import { desk as desk_module, chat as chat_module } from adapters; desk = connect desk_module; chat = connect chat_module; function go(t: <text>, p: <desk-[:Tickets]->>) {"
    };
    let source = format!("{header}\n{body}}}\n");
    let options = CheckOptions { upgrading_from: pin, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &CatalogSnapshot::load(catalog).unwrap(), options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

fn found(catalog: &str, body: &str, pin: Option<&str>) -> Vec<String> {
    diagnostics(catalog, body, pin)
        .into_iter()
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

/// The part of each message before "in this wait's WHERE": what it names.
fn named(catalog: &str, body: &str) -> Vec<String> {
    found(catalog, body, Some("0.12.13")).into_iter().map(|d| d.split(" in this wait's WHERE").next().unwrap().to_string()).collect()
}

const MAIL_WAIT: &str = "  founder = only(crm-[:People]->)\n  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE x.From == founder.Email]->\n";
const CHAT_WAIT: &str = "  ticket = only(desk-[:Tickets]->)\n  post = write chat-[:Posts]-> { Text: t }\n  r = await new post-[x:Replies WHERE x.Author == ticket.Owner]->\n";

#[test]
fn a_wait_reading_a_run_record_is_told_its_value_is_captured_when_upgrading() {
    assert_eq!(
        found(MAIL, MAIL_WAIT, Some("0.12.13")),
        ["MOV_AWAIT_VALUE_CAPTURED 4:13-4:58 'founder.Email' in this wait's WHERE is read once, when the wait is reached (0.13); under 0.12.13 it was read again at every check, so a change while the run waited changed what the wait accepted. Nothing to rewrite unless the wait should follow the live value: then test it after the wait against `refresh(founder)`"]
    );
    assert_eq!(
        found(CHAT, CHAT_WAIT, Some("0.12.13")),
        ["MOV_AWAIT_VALUE_CAPTURED 4:17-4:66 'ticket.Owner' in this wait's WHERE is read once, when the wait is reached (0.13); under 0.12.13 it was read again at every check, so a change while the run waited changed what the wait accepted. Nothing to rewrite unless the wait should follow the live value: then test it after the wait against `refresh(ticket)`"]
    );
    assert_eq!(found(MAIL, MAIL_WAIT, None), Vec::<String>::new());
    assert_eq!(found(CHAT, CHAT_WAIT, None), Vec::<String>::new());
}

#[test]
fn it_is_a_warning_raised_for_the_upgrade_with_nothing_to_rewrite() {
    let told = diagnostics(MAIL, MAIL_WAIT, Some("0.12.13"));
    assert_eq!(told.len(), 1);
    assert!(!told[0].is_error());
    assert_eq!((told[0].upgrade, told[0].fix.is_none()), (Some(true), true));
}

#[test]
fn a_pin_of_this_release_is_not_told() {
    let own = Some(movement_parser::version::LANGUAGE_VERSION);
    assert_eq!(found(MAIL, MAIL_WAIT, own), Vec::<String>::new());
    assert_eq!(found(CHAT, CHAT_WAIT, own), Vec::<String>::new());
}

#[test]
fn a_plain_value_or_a_literal_is_not_reported() {
    let mail = "  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE x.Title == t AND x.From == \"a@b.c\"]->\n";
    let chat = "  post = write chat-[:Posts]-> { Text: t }\n  r = await new post-[x:Replies WHERE x.Text == t AND x.Author == \"ann\"]->\n";
    assert_eq!(found(MAIL, mail, Some("0.12.13")), Vec::<String>::new());
    assert_eq!(found(CHAT, chat, Some("0.12.13")), Vec::<String>::new());
}

#[test]
fn a_record_a_parameter_holds_is_a_run_record() {
    let mail = "  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE x.From == p.Email]->\n";
    let chat = "  post = write chat-[:Posts]-> { Text: t }\n  r = await new post-[x:Replies WHERE x.Author == p.Owner]->\n";
    assert_eq!(named(MAIL, mail), ["MOV_AWAIT_VALUE_CAPTURED 3:13-3:52 'p.Email'"]);
    assert_eq!(named(CHAT, chat), ["MOV_AWAIT_VALUE_CAPTURED 3:17-3:61 'p.Owner'"]);
}

#[test]
fn each_part_reading_a_run_record_is_told_once() {
    let body = "  founder = only(crm-[:People]->)\n  m = write mail-[:Messages]-> { To: t }\n  r = await new m-[x:Replies WHERE x.From == founder.Email OR x.Title == founder.Name OR x.To == founder.Email]->\n";
    assert_eq!(
        named(MAIL, body),
        ["MOV_AWAIT_VALUE_CAPTURED 4:17-4:114 'founder.Email'", "MOV_AWAIT_VALUE_CAPTURED 4:17-4:114 'founder.Name'"]
    );
}

#[test]
fn a_part_computed_from_several_fields_names_each() {
    let mail = "  founder = only(crm-[:People]->)\n  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE x.Title == \"${founder.Name} <${founder.Email}>\"]->\n";
    let told = found(MAIL, mail, Some("0.12.13"));
    assert_eq!(
        told,
        ["MOV_AWAIT_VALUE_CAPTURED 4:13-4:82 'founder.Name' and 'founder.Email' in this wait's WHERE are read once, when the wait is reached (0.13); under 0.12.13 they were read again at every check, so a change while the run waited changed what the wait accepted. Nothing to rewrite unless the wait should follow the live value: then test it after the wait against `refresh(founder)`"]
    );
    let chat = "  ticket = only(desk-[:Tickets]->)\n  post = write chat-[:Posts]-> { Text: t }\n  r = await new post-[x:Replies WHERE x.Text == \"${ticket.Subject} (${p.Owner})\"]->\n";
    assert_eq!(named(CHAT, chat), ["MOV_AWAIT_VALUE_CAPTURED 4:17-4:84 'ticket.Subject' and 'p.Owner'"]);
}

// A wait's WHERE that walks is refused today (MOV_AWAIT_IMPURE_WHERE), so the
// two below are refused programs; they show what the upgrade would also say.

#[test]
fn a_walk_off_a_connection_is_read_at_every_check_and_not_told() {
    let mail = "  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE EXISTS(crm-[c:People WHERE c.Email == x.From]->)]->\n";
    let chat = "  post = write chat-[:Posts]-> { Text: t }\n  r = await new post-[x:Replies WHERE EXISTS(desk-[k:Tickets WHERE k.Owner == x.Author]->)]->\n";
    let codes = |catalog, body| diagnostics(catalog, body, Some("0.12.13")).into_iter().map(|d| d.code).collect::<Vec<_>>();
    assert_eq!(codes(MAIL, mail), ["MOV_AWAIT_IMPURE_WHERE"]);
    assert_eq!(codes(CHAT, chat), ["MOV_AWAIT_IMPURE_WHERE"]);
}

#[test]
fn a_run_record_read_inside_a_nested_walk_is_told() {
    let mail = "  founder = only(crm-[:People]->)\n  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE EXISTS(crm-[c:People WHERE c.Email == founder.Email]->)]->\n";
    let chat = "  ticket = only(desk-[:Tickets]->)\n  post = write chat-[:Posts]-> { Text: t }\n  r = await new post-[x:Replies WHERE EXISTS(desk-[k:Tickets WHERE k.Owner == ticket.Owner]->)]->\n";
    let told = |catalog, body| named(catalog, body).into_iter().filter(|d| d.starts_with("MOV_AWAIT_VALUE_CAPTURED")).collect::<Vec<_>>();
    assert_eq!(told(MAIL, mail), ["MOV_AWAIT_VALUE_CAPTURED 4:13-4:90 'founder.Email'"]);
    assert_eq!(told(CHAT, chat), ["MOV_AWAIT_VALUE_CAPTURED 4:17-4:98 'ticket.Owner'"]);
}

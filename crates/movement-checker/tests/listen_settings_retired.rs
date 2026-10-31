//! `listen to x { settings }` is retired in 0.13: each one is told the
//! traversal it becomes, rewritten from its module's `listenSettingsBecome`.
//! Two shapes:
//!
//! - `gh`: a root `Notifications` its module announces, the 0.12 `events`
//!   setting becoming `Reason IN` on that one hop.
//! - `at`: `Bases` → `Tables` → `Changes`, `base` and `table` each an `Id ==`
//!   on their hop, `field` and `becomes` a `Field ==` and a `New ==` on the
//!   last, and `events` a `Kind IN` spelled as the field holds it
//!   (`"record.created"` is `"created"`); a connection positioned at a base
//!   stands on the first hop.
//!
//! A warning on this release (the settings form still serves until every
//! module has moved); an error on a check for a move up from 0.12, so the
//! upgrade rewrites it or holds the pin.

use movement_checker::{CheckOptions, Diagnostic, Severity, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::Value;

const CATALOG: &str = r#"{"adapters":{
  "gh":{"canFire":true,"constructionArgs":[],"triggerConfig":["events","participating","every"],
    "triggerConfigOptions":{"events":["mention","assign","review_requested"]},
    "listenSettingsBecome":{"path":["Notifications"],"aliases":["n"],"paramFrom":"Notification",
      "keys":{"events":{"hop":0,"field":"Reason","op":"in"}}},
    "schemas":{"":{"positions":{
      "Notification":{"properties":{"Reason":"text","Title":"text"},"edges":{}}},
      "collections":{"Notifications":{"target":"Notification","listenable":true,"identity":"Id","delivery":"polled","pollEverySeconds":60}},
      "writableRoots":{},"eventPosition":"Notification","eventPositions":[{"position":"Notification"}]}}},
  "ghd":{"canFire":true,"constructionArgs":[],"triggerConfig":["events"],
    "triggerConfigOptions":{"events":["mention","assign","review_requested"]},"defaultEvents":["mention","assign"],
    "listenSettingsBecome":{"path":["Notifications"],"aliases":["n"],"paramFrom":"Notification",
      "keys":{"events":{"hop":0,"field":"Reason","op":"in"}}},
    "schemas":{"":{"positions":{
      "Notification":{"properties":{"Reason":"text","Title":"text"},"edges":{}}},
      "collections":{"Notifications":{"target":"Notification","listenable":true,"identity":"Id","delivery":"polled","pollEverySeconds":60}},
      "writableRoots":{},"eventPosition":"Notification","eventPositions":[{"position":"Notification"}]}}},
  "ghv":{"canFire":true,"constructionArgs":[],"triggerConfig":["events"],
    "triggerConfigOptions":{"events":["mention","assign"]},"defaultEvents":["mention","assign"],
    "listenSettingsBecome":{"path":["Notifications"],"aliases":["n"],"paramFrom":"Notification",
      "keys":{"events":{"hop":0,"field":"Reason","op":"in","values":{"mention":"mentioned"}}}},
    "schemas":{"":{"positions":{
      "Notification":{"properties":{"Reason":"text","Title":"text"},"edges":{}}},
      "collections":{"Notifications":{"target":"Notification","listenable":true,"identity":"Id","delivery":"polled","pollEverySeconds":60}},
      "writableRoots":{},"eventPosition":"Notification","eventPositions":[{"position":"Notification"}]}}},
  "ghk":{"canFire":true,"constructionArgs":[],"triggerConfig":["kind"],
    "listenSettingsBecome":{"path":["Notifications"],"aliases":["n"],
      "keys":{"kind":{"hop":0,"field":"Subject","op":"eq","values":{"pr":"PullRequest"}}}},
    "schemas":{"":{"positions":{
      "Notification":{"properties":{"Subject":"text"},"edges":{}}},
      "collections":{"Notifications":{"target":"Notification","listenable":true,"identity":"Id","delivery":"polled","pollEverySeconds":60}},
      "writableRoots":{},"eventPosition":"Notification","eventPositions":[{"position":"Notification"}]}}},
  "at":{"canFire":true,
    "constructionArgs":[{"name":"base","kind":"position","required":false,"optionsFromType":"Base"}],
    "triggerConfig":["base","table","field","becomes","events"],
    "listenSettingsBecome":{"path":["Bases","Tables","Changes"],"aliases":["b","t","c"],"paramFrom":"Record Change",
      "keys":{"base":{"hop":0,"field":"Id","op":"eq"},"table":{"hop":1,"field":"Id","op":"eq"},
        "field":{"hop":2,"field":"Field","op":"eq"},"becomes":{"hop":2,"field":"New","op":"eq"},
        "events":{"hop":2,"field":"Kind","op":"in","values":{"record.created":"created","record.updated":"updated"}}}},
    "schemas":{
      "":{"positions":{
        "Base":{"properties":{"Id":"text","Name":"text"},"edges":{"Tables":{"target":"Table","cheapToList":true,"parentChanges":"pushed"}}},
        "Table":{"properties":{"Id":"text","Name":"text"},"edges":{"Changes":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"scope"}}},
        "Change":{"properties":{"Id":"text","Field":"text","New":"text","Kind":"text"},"edges":{}},
        "Record Change":{"properties":{"Field":"text"},"edges":{}}},
        "collections":{"Bases":{"target":"Base","cheapToList":true,"relistEverySeconds":300}},
        "writableRoots":{},"eventPosition":"Record Change","eventPositions":[{"position":"Record Change"}]},
      "::[[\"base\",\"Hiring\"]]":{"positions":{
        "Table":{"properties":{"Id":"text","Name":"text"},"edges":{"Changes":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"scope"}}},
        "Change":{"properties":{"Id":"text","Field":"text","New":"text","Kind":"text"},"edges":{}},
        "Record Change":{"properties":{"Field":"text"},"edges":{}}},
        "collections":{"Tables":{"target":"Table","cheapToList":true,"parentChanges":"pushed"}},
        "writableRoots":{},"eventPosition":"Record Change","eventPositions":[{"position":"Record Change"}]}}},
  "hook":{"canFire":true,"constructionArgs":[],"triggerConfig":["payload"],"triggerConfigFormats":{"payload":"type"},
    "listenSettingsBecome":{"path":["Requests"],"aliases":["r"],"keys":{"payload":{"hop":0,"op":"type"}}},
    "schemas":{"":{"positions":{"Request":{"properties":{"Body":"json"},"edges":{}}},
      "collections":{"Requests":{"target":"Request","readable":false,"listenable":true,"identity":"Id","delivery":"connection"}},
      "writableRoots":{},"eventPosition":"Request","eventPositions":[{"position":"Request"}]}}},
  "feed":{"canFire":true,"constructionArgs":[],"triggerConfig":["topic"],
    "schemas":{"":{"positions":{"Item":{"properties":{"Topic":"text"},"edges":{}}},
      "collections":{"Items":{"target":"Item","listenable":true,"identity":"Id","delivery":"connection"}},
      "writableRoots":{},"eventPosition":"Item","eventPositions":[{"position":"Item"}]}}}
},"credentials":{},"plugins":{}}"#;

const GH: &str = "import { gh as gh_module } from adapters\ngh = connect gh_module\n";
const GHD: &str = "import { ghd as ghd_module } from adapters\nghd = connect ghd_module\n";
const GHV: &str = "import { ghv as ghv_module } from adapters\nghv = connect ghv_module\n";
const GHK: &str = "import { ghk as ghk_module } from adapters\nghk = connect ghk_module\n";
const HIRING: &str = "import { at as at_module } from adapters\nhiring = connect at_module { base: \"Hiring\" }\n";
const AT: &str = "import { at as at_module } from adapters\nat = connect at_module\n";
const HOOK: &str = "import { hook as hook_module } from adapters\nhook = connect hook_module\nnode Payment { amount: <number> }\n";
const FEED: &str = "import { feed as feed_module } from adapters\nfeed = connect feed_module\n";

fn checked(source: &str, pin: Option<&str>) -> Vec<Diagnostic> {
    let options = CheckOptions { upgrading_from: pin, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &CatalogSnapshot::load(CATALOG).unwrap(), options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

/// Every diagnostic on `source`, checked on this release.
fn diagnostics(source: &str) -> Vec<Diagnostic> {
    checked(source, None)
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

/// The one retirement among `found`.
fn retired(found: &[Diagnostic]) -> &Diagnostic {
    let told: Vec<&Diagnostic> = found.iter().filter(|d| d.code == "MOV_LISTEN_SETTINGS_RETIRED").collect();
    assert_eq!(told.len(), 1, "{found:?}");
    told[0]
}

/// `source` with the retirement's fix applied (ASCII columns).
fn fixed(source: &str, found: &[Diagnostic]) -> String {
    let fix = retired(found).fix.as_ref().unwrap_or_else(|| panic!("no fix: {found:?}"));
    let lines: Vec<&str> = source.split('\n').collect();
    let offset = |at: &Value| {
        let (line, col) = (at["line"].as_u64().unwrap() as usize, at["col"].as_u64().unwrap() as usize);
        lines[..line - 1].iter().map(|l| l.len() + 1).sum::<usize>() + col - 1
    };
    let mut edits: Vec<(usize, usize, String)> = fix["edits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| (offset(&e["span"]["start"]), offset(&e["span"]["end"]), e["text"].as_str().unwrap().to_string()))
        .collect();
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut text = source.to_string();
    for (start, end, replacement) in edits {
        text.replace_range(start..end, &replacement);
    }
    text
}

/// The fix's text checks clean on this release.
fn assert_rechecks_clean(text: &str) {
    let found = diagnostics(text);
    assert_eq!(found, Vec::<Diagnostic>::new(), "{text}");
}

#[test]
fn an_events_listen_is_rewritten_safely() {
    let source = format!("{GH}function triage(n: <gh-[:Notification]->>) {{ return 1 }}\nlisten to gh {{ events: [\"mention\", \"assign\"] }} fire triage\n");
    let d = diagnostics(&source);
    assert_eq!(codes(&d), ["MOV_LISTEN_SETTINGS_RETIRED"]);
    assert_eq!(d[0].severity, Some(Severity::Warning));
    assert_eq!(
        d[0].message,
        "`listen to gh { … }` is retired in 0.13: a listen is a traversal ending on the edge its events arrive on. Write `listen to gh-[n:Notifications WHERE n.Reason IN [\"mention\", \"assign\"]]-> fire triage`"
    );
    let text = fixed(&source, &d);
    assert_eq!(
        text,
        format!("{GH}function triage(n: <gh-[:Notifications]->>) {{ return 1 }}\nlisten to gh-[n:Notifications WHERE n.Reason IN [\"mention\", \"assign\"]]-> fire triage\n")
    );
    assert_eq!(d[0].fix.as_ref().unwrap()["safe"], true);
    assert_rechecks_clean(&text);
}

#[test]
fn a_hop_the_connection_consumes_is_dropped() {
    let source = format!(
        "{HIRING}function moved(c: <hiring-[:`Record Change`]->>) {{ return 1 }}\nlisten to hiring {{ base: \"appHIRE01\", table: \"tblCAND01\", field: \"Stage\", becomes: \"Interview\" }} fire moved\n"
    );
    let d = diagnostics(&source);
    let told = retired(&d);
    assert_eq!(told.fix.as_ref().unwrap()["safe"], true);
    let text = fixed(&source, &d);
    assert_eq!(
        text,
        format!(
            "{HIRING}function moved(c: <hiring-[:Change]->>) {{ return 1 }}\nlisten to hiring-[t:Tables WHERE t.Id == \"tblCAND01\"]->-[c:Changes WHERE c.Field == \"Stage\" AND c.New == \"Interview\"]-> fire moved\n"
        )
    );
    assert_rechecks_clean(&text);
}

#[test]
fn an_unpositioned_connection_keeps_every_hop() {
    let source = format!("{AT}function moved(c: <at-[:`Record Change`]->>) {{ return 1 }}\nlisten to at {{ base: \"appHIRE01\", table: \"tblCAND01\" }} fire moved\n");
    let d = diagnostics(&source);
    let text = fixed(&source, &d);
    assert_eq!(
        text,
        format!(
            "{AT}function moved(c: <at-[:Change]->>) {{ return 1 }}\nlisten to at-[b:Bases WHERE b.Id == \"appHIRE01\"]->-[t:Tables WHERE t.Id == \"tblCAND01\"]->-[:Changes]-> fire moved\n"
        )
    );
    assert_rechecks_clean(&text);
}

#[test]
fn suppress_self_makes_the_fix_unsafe_and_says_why() {
    let source = format!("{GH}function triage(n: <gh-[:Notification]->>) {{ return 1 }}\nlisten to gh {{ events: [\"mention\"], suppress_self: true }} fire triage\n");
    let d = diagnostics(&source);
    let told = retired(&d);
    assert!(
        told.message.ends_with("Write `listen to gh-[n:Notifications WHERE n.Reason IN [\"mention\"]]-> fire triage` (`suppress_self` is gone: a two-way sync's own echo now runs once more and finds nothing to change)"),
        "{}",
        told.message
    );
    assert_eq!(told.fix.as_ref().unwrap().get("safe"), None, "the meaning changes: --all applies it");
    let text = fixed(&source, &d);
    assert!(text.ends_with("listen to gh-[n:Notifications WHERE n.Reason IN [\"mention\"]]-> fire triage\n"), "{text}");
    assert_rechecks_clean(&text);
    // `suppress_self: false` was the default: dropping it changes nothing.
    let quiet = format!("{GH}function triage(n: <gh-[:Notification]->>) {{ return 1 }}\nlisten to gh {{ events: [\"mention\"], suppress_self: false }} fire triage\n");
    assert_eq!(retired(&diagnostics(&quiet)).fix.as_ref().unwrap()["safe"], true);
}

#[test]
fn every_makes_the_fix_unsafe_and_names_where_the_interval_went() {
    let source = format!("{GH}function triage(n: <gh-[:Notification]->>) {{ return 1 }}\nlisten to gh {{ events: [\"assign\"], every: 5m }} fire triage\n");
    let d = diagnostics(&source);
    let told = retired(&d);
    assert!(
        told.message.ends_with("fire triage` (`every` is gone: the module sets the interval; set `pollEvery` for this connection in lf.yaml)"),
        "{}",
        told.message
    );
    assert_eq!(told.fix.as_ref().unwrap().get("safe"), None);
    assert_rechecks_clean(&fixed(&source, &d));
}

#[test]
fn a_key_with_no_mapping_has_no_fix() {
    let source = format!("{GH}function triage(n: <gh-[:Notification]->>) {{ return 1 }}\nlisten to gh {{ events: [\"mention\"], participating: true }} fire triage\n");
    let d = diagnostics(&source);
    let told = retired(&d);
    assert_eq!(told.fix, None);
    assert!(told.message.ends_with("Write `listen to gh-[:Notifications]-> fire triage`"), "{}", told.message);
}

#[test]
fn a_value_that_is_not_a_literal_has_no_fix() {
    let source = format!("{GH}reasons = [\"mention\"]\nfunction triage(n: <gh-[:Notification]->>) {{ return 1 }}\nlisten to gh {{ events: reasons }} fire triage\n");
    let d = diagnostics(&source);
    assert_eq!(retired(&d).fix, None, "{d:?}");
}

#[test]
fn a_module_that_maps_nothing_is_told_with_no_fix() {
    let source = format!("{FEED}function seen(i: <feed-[:Item]->>) {{ return 1 }}\nlisten to feed {{ topic: \"news\" }} fire seen\n");
    let d = diagnostics(&source);
    let told = retired(&d);
    assert_eq!(told.fix, None);
    assert_eq!(
        told.message,
        "`listen to feed { … }` is retired in 0.13: a listen is a traversal ending on the edge its events arrive on. Write `listen to feed-[:…]-> fire seen`"
    );
}

#[test]
fn a_parameter_typed_otherwise_is_left_as_written() {
    let source = format!("{GH}function triage(n: <gh-[:Notifications]->>) {{ return 1 }}\nlisten to gh {{ events: [\"mention\"] }} fire triage\n");
    let d = diagnostics(&source);
    let edits = retired(&d).fix.as_ref().unwrap()["edits"].as_array().unwrap().len();
    assert_eq!(edits, 1, "only the listen is rewritten: {d:?}");
}

#[test]
fn a_move_up_from_0_12_is_held_by_it_and_this_release_only_warns() {
    let source = format!("{GH}function triage(n: <gh-[:Notification]->>) {{ return 1 }}\nlisten to gh {{ events: [\"mention\"], participating: true }} fire triage\n");
    let up = checked(&source, Some("0.12.13"));
    assert!(retired(&up).is_error(), "{up:?}");
    let here = checked(&source, Some("0.13.0"));
    assert_eq!(retired(&here).severity, Some(Severity::Warning));
    // The traversal it becomes is not told anything.
    let traversal = format!("{GH}function triage(n: <gh-[:Notifications]->>) {{ return 1 }}\nlisten to gh-[n:Notifications WHERE n.Reason IN [\"mention\"]]-> fire triage\n");
    assert_eq!(checked(&traversal, Some("0.12.13")), Vec::<Diagnostic>::new());
}

#[test]
fn a_declared_payload_is_told_with_no_fix() {
    // A listen's traversal does not state its landing's type, so a `type`
    // key has no rewrite yet: the pin holds.
    let source = format!("{HOOK}function paid(p: <Payment>) {{ return p.amount }}\nlisten to hook {{ payload: <Payment> }} fire paid\n");
    let d = diagnostics(&source);
    let told = retired(&d);
    assert_eq!(told.fix, None);
    assert!(told.message.ends_with("Write `listen to hook-[:Requests]-> fire paid`"), "{}", told.message);
}

#[test]
fn a_settings_value_is_spelled_as_its_field_holds_it() {
    let source = format!("{HIRING}function moved(c: <hiring-[:`Record Change`]->>) {{ return 1 }}\nlisten as \"Hiring\" to hiring {{ table: \"tblCAND01\", events: [\"record.created\", \"record.updated\"] }} fire moved\n");
    let d = diagnostics(&source);
    let text = fixed(&source, &d);
    assert!(
        text.ends_with("listen as \"Hiring\" to hiring-[t:Tables WHERE t.Id == \"tblCAND01\"]->-[c:Changes WHERE c.Kind IN [\"created\", \"updated\"]]-> fire moved\n"),
        "{text}"
    );
    assert_rechecks_clean(&text);
    // A value the module does not spell has no rewrite.
    let unknown = source.replace("record.updated", "record.moved");
    assert_eq!(retired(&diagnostics(&unknown)).fix, None);
}

#[test]
fn a_listen_that_writes_no_events_is_rewritten_to_the_events_its_module_defaults() {
    let source = format!("{GHD}function f(n: <ghd-[:Notification]->>) {{ return 1 }}\nlisten to ghd {{}} fire f\n");
    let d = diagnostics(&source);
    let text = fixed(&source, &d);
    assert_eq!(
        text,
        format!("{GHD}function f(n: <ghd-[:Notifications]->>) {{ return 1 }}\nlisten to ghd-[n:Notifications WHERE n.Reason IN [\"mention\", \"assign\"]]-> fire f\n")
    );
    assert_eq!(retired(&d).fix.as_ref().unwrap()["safe"], true);
    assert_rechecks_clean(&text);
}

#[test]
fn the_events_a_listen_writes_take_the_place_of_the_defaults() {
    let source = format!("{GHD}function f(n: <ghd-[:Notification]->>) {{ return 1 }}\nlisten to ghd {{ events: [\"review_requested\"] }} fire f\n");
    let text = fixed(&source, &diagnostics(&source));
    assert!(text.contains("n.Reason IN [\"review_requested\"]]-> fire f"), "{text}");
}

#[test]
fn a_default_the_events_mapping_cannot_spell_leaves_the_listen_unrewritten() {
    let source = format!("{GHV}function f(n: <ghv-[:Notification]->>) {{ return 1 }}\nlisten to ghv {{}} fire f\n");
    let d = diagnostics(&source);
    assert!(retired(&d).fix.is_none(), "{d:?}");
    assert!(retired(&d).message.contains("Write `listen to ghv-[:Notifications]-> fire f`"), "{}", retired(&d).message);
}

#[test]
fn a_settings_value_missing_from_an_eq_keys_values_map_has_no_rewrite() {
    let at = |kind: &str| format!("{GHK}function f(n: <ghk-[:Notification]->>) {{ return 1 }}\nlisten to ghk {{ kind: \"{kind}\" }} fire f\n");
    let mapped = at("pr");
    assert!(fixed(&mapped, &diagnostics(&mapped)).contains("listen to ghk-[n:Notifications WHERE n.Subject == \"PullRequest\"]-> fire f"));
    let unmapped = at("issue");
    assert!(retired(&diagnostics(&unmapped)).fix.is_none());
}

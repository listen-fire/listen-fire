//! `listen to x { settings }` is retired in 0.13: each one is told the
//! traversal it becomes, rewritten from its module's `listenSettingsBecome`.
//! Two shapes:
//!
//! - `gh`: a root `Notifications` its module announces, the 0.12 `events`
//!   setting becoming `Reason IN` on that one hop.
//! - `at`: `Bases` → `Tables` → `Changes`, `base` and `table` each an `Id ==`
//!   on their hop, `field` and `becomes` comparing the row before and after
//!   on the last (`c.Current.Stage != c.Previous.Stage`; with a value,
//!   `c.Current.Stage == "Interview" AND c.Previous.Stage != "Interview"`),
//!   and `events` a `Kind IN` spelled as the field holds it
//!   (`"record.created"` is `"created"`); a connection positioned at a base
//!   stands on the first hop. Where the host narrowed the table by its WHERE,
//!   the parameter is retyped to that table's changes and the field is
//!   checked against its rows.
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
        "events":{"hop":2,"field":"Kind","op":"in","values":{"record.created":"created","record.updated":"updated"}}},
      "fieldChange":{"hop":2,"field":"field","becomes":"becomes","current":"Current","previous":"Previous"}},
    "schemas":{
      "":{"positions":{
        "Base":{"properties":{"Id":"text","Name":"text"},"edges":{"Tables":{"target":"Table","cheapToList":true,"parentChanges":"pushed"}}},
        "Table":{"properties":{"Id":"text","Name":"text"},"edges":{"Changes":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"scope"}}},
        "Change":{"properties":{"Id":"text","Kind":"text","Current":__HELD_ROW__,"Previous":__HELD_ROW__},"edges":{}},
        "Row":{"properties":{"Id":"text"},"edges":{}},
        "Record Change":{"properties":{"Field":"text"},"edges":{}}},
        "collections":{"Bases":{"target":"Base","cheapToList":true,"relistEverySeconds":300}},
        "writableRoots":{},"eventPosition":"Record Change","eventPositions":[{"position":"Record Change"}]},
      "::[[\"base\",\"Hiring\"]]":{"positions":{
        "Table":{"properties":{"Id":"text","Name":"text"},"edges":{"Changes":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"scope"}}},
        "Table \"Candidates\"":{"properties":{"Id":"text","Name":"text","Stage":"text"},"edges":{"Changes":{"target":"Candidates Change","readable":false,"listenable":true,"identity":"Id","delivery":"scope"}}},
        "Change":{"properties":{"Id":"text","Kind":"text","Current":__HELD_ROW__,"Previous":__HELD_ROW__},"edges":{}},
        "Candidates Change":{"properties":{"Id":"text","Kind":"text","Current":__HELD_CANDIDATES__,"Previous":__HELD_CANDIDATES__},"edges":{}},
        "Row":{"properties":{"Id":"text"},"edges":{}},
        "Candidates":{"properties":{"Id":"text","Stage":"text","Files":{"kind":"list","of":"file"}},"edges":{}},
        "Record Change":{"properties":{"Field":"text"},"edges":{}}},
        "collections":{"Tables":{"target":"Table","cheapToList":true,"parentChanges":"pushed"}},
        "refinements":{"__CANDIDATES_KEY__":"Table \"Candidates\""},
        "writableRoots":{},"eventPosition":"Record Change","eventPositions":[{"position":"Record Change"}]}}},
  "hook":{"canFire":true,"constructionArgs":[],"triggerConfig":["payload"],"triggerConfigFormats":{"payload":"type"},
    "listenSettingsBecome":{"path":["Requests"],"aliases":["r"],"keys":{"payload":{"hop":0,"op":"type"}}},
    "schemas":{"":{"positions":{"Request":{"properties":{},"edges":{},"undescribed":true}},
      "collections":{"Requests":{"target":"Request","readable":false,"listenable":true,"delivery":"connection"}},
      "writableRoots":{},"eventPosition":"Request","eventPositions":[{"position":"Request"}]}}},
  "inbox":{"canFire":true,"constructionArgs":[],"triggerConfig":["key"],
    "listenSettingsBecome":{"path":["Emails"],"aliases":["e"],"paramFrom":"Email","keys":{"key":{"hop":0,"field":"Key","op":"eq","absent":"","lowercase":true}}},
    "schemas":{"":{"positions":{"Email":{"properties":{"Key":{"kind":"owned","name":"InboxKey","owner":"inbox","allowPattern":"^[a-z0-9.!#$%&'*+/=?^_`{|}~-]*$"},"Subject":"text"},"edges":{},
        "propertyCapabilities":{"Key":{"filterOperators":["eq","in"]}}}},
      "collections":{"Emails":{"target":"Email","readable":false,"listenable":true,"bounded":false,"boundedBy":["Key"],"delivery":"connection",
        "capability":{"filter":"native","supportsLimit":false}}},
      "writableRoots":{},"eventPosition":"Email","eventPositions":[{"position":"Email"}]}}},
  "mbox":{"canFire":true,"constructionArgs":[],"triggerConfig":["key"],
    "listenSettingsBecome":{"path":["Emails"],"aliases":["e"],"paramFrom":"Email","keys":{"key":{"hop":0,"field":"Key","op":"eq"}}},
    "schemas":{"":{"positions":{"Email":{"properties":{"Key":{"kind":"owned","name":"InboxKey","owner":"mbox","allowPattern":"^[a-z0-9]+$"},"Subject":"text"},"edges":{},
        "propertyCapabilities":{"Key":{"filterOperators":["eq","in"]}}}},
      "collections":{"Emails":{"target":"Email","readable":false,"listenable":true,"bounded":false,"boundedBy":["Key"],"delivery":"connection",
        "capability":{"filter":"native","supportsLimit":false}}},
      "writableRoots":{},"eventPosition":"Email","eventPositions":[{"position":"Email"}]}}},
  "ghx":{"canFire":true,"constructionArgs":[],"triggerConfig":["events"],
    "triggerConfigOptions":{"events":["mention","assign","review_requested"]},"defaultEvents":["mention","assign"],
    "listenSettingsBecome":{"path":["Notifications"],"aliases":["n"],"paramFrom":"Notification",
      "keys":{"events":{"hop":0,"field":"Reason","op":"in","absent":["review_requested"]}}},
    "schemas":{"":{"positions":{
      "Notification":{"properties":{"Reason":"text","Title":"text"},"edges":{}}},
      "collections":{"Notifications":{"target":"Notification","listenable":true,"identity":"Id","delivery":"polled","pollEverySeconds":60}},
      "writableRoots":{},"eventPosition":"Notification","eventPositions":[{"position":"Notification"}]}}},
  "bell":{"canFire":true,"constructionArgs":[],
    "listenSettingsBecome":{"path":["Rings"],"aliases":["r"],"paramFrom":"Ring","keys":{}},
    "schemas":{"":{"positions":{"Ring":{"properties":{"At":"datetime"},"edges":{}}},
      "collections":{"Rings":{"target":"Ring","readable":false,"listenable":true,"delivery":"connection"}},
      "writableRoots":{},"eventPosition":"Ring","eventPositions":[{"position":"Ring"}]}}},
  "mail":{"canFire":true,"constructionArgs":[],"triggerConfig":["query","labels","subjects","events","every"],
    "listenSettingsBecome":{"path":["Messages"],"aliases":["m"],"paramFrom":"Message",
      "keys":{"query":{"hop":0,"field":"Query","op":"eq"},"labels":{"hop":0,"field":"Labels","op":"contains","absent":"INBOX"},"subjects":{"hop":0,"field":"Subject","op":"contains"}},
      "byEvent":{
        "message_received":{"path":["Messages"],"aliases":["m"],"paramFrom":"Message",
          "keys":{"query":{"hop":0,"field":"Query","op":"eq"},"labels":{"hop":0,"field":"Labels","op":"contains","absent":"INBOX"}}},
        "label_added":{"path":["Labelings"],"aliases":["l"],"paramFrom":"Message",
          "keys":{"query":{"hop":0,"field":"Query","op":"eq"},"labels":{"hop":0,"field":"Label","op":"in","absent":"user","absentField":"Label Type"}}}}},
    "schemas":{"":{"positions":{"Message":{"properties":{"Query":{"kind":"owned","name":"GmailQuery","owner":"mail"},"Labels":{"kind":"list","of":"text"},"Subject":"text"},"edges":{},
        "propertyCapabilities":{"Query":{"filterOperators":["eq"]},"Labels":{"filterOperators":["eq","in","contains","containsAny"]},"Subject":{"filterOperators":["eq","contains"]}}},
        "Labeling":{"properties":{"Query":{"kind":"owned","name":"GmailQuery","owner":"mail"},"Label":"text","Label Type":{"kind":"enum","options":["system","user"]},"Subject":"text"},"edges":{},
        "propertyCapabilities":{"Query":{"filterOperators":["eq"]},"Label":{"filterOperators":["eq","in"]},"Label Type":{"filterOperators":["eq"]}}}},
      "collections":{"Messages":{"target":"Message","listenable":true,"identity":"Message Id","delivery":"polled","pollEverySeconds":60,"cursor":true,
        "capability":{"filter":"native","supportsLimit":true}},
        "Labelings":{"target":"Labeling","listenable":true,"readable":false,"identity":"Id","delivery":"polled","pollEverySeconds":60,"cursor":true,
        "capability":{"filter":"native","supportsLimit":false}}},
      "writableRoots":{},"eventPosition":"Message","eventPositions":[{"position":"Message"}]}}},
  "pay":{"canFire":true,"constructionArgs":[],"triggerConfig":["events"],
    "listenSettingsBecome":{"path":["Invoices","Changes"],"aliases":["i","c"],"paramFrom":"Event",
      "keys":{"events":{"hop":1,"field":"Kind","op":"in","values":{"invoice.paid":"paid","invoice.payment_failed":"payment_failed"},
        "absent":["invoice.paid","invoice.payment_failed","charge.failed"]}},
      "byEvent":{
        "invoice.paid":{"path":["Invoices","Changes"],"aliases":["i","c"],"paramFrom":"Event",
          "keys":{"events":{"hop":1,"field":"Kind","op":"in","values":{"invoice.paid":"paid","invoice.payment_failed":"payment_failed"}}}},
        "invoice.payment_failed":{"path":["Invoices","Changes"],"aliases":["i","c"],"paramFrom":"Event",
          "keys":{"events":{"hop":1,"field":"Kind","op":"in","values":{"invoice.paid":"paid","invoice.payment_failed":"payment_failed"}}}},
        "charge.failed":{"path":["Charges","Changes"],"aliases":["ch","c"],"paramFrom":"Event",
          "keys":{"events":{"hop":1,"field":"Kind","op":"in","values":{"charge.failed":"failed"}}}}}},
    "schemas":{"":{"positions":{
        "Invoice":{"properties":{"Id":"text"},"edges":{"Changes":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"connection","carries":["Invoices"],"attributes":true}}},
        "Charge":{"properties":{"Id":"text"},"edges":{"Changes":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"connection","carries":["Charges"],"attributes":true}}},
        "Change":{"properties":{"Id":"text","Kind":{"kind":"enum","options":["paid","payment_failed","failed"]}},"edges":{}},
        "Event":{"properties":{"Id":"text"},"edges":{}}},
      "collections":{"Invoices":{"target":"Invoice"},"Charges":{"target":"Charge"}},
      "writableRoots":{},"eventPosition":"Event","eventPositions":[{"position":"Event"}]}}},
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
const INBOX: &str = "import { inbox as inbox_module } from adapters\ninbox = connect inbox_module\n";
const MBOX: &str = "import { mbox as mbox_module } from adapters\nmbox = connect mbox_module\n";
const GHX: &str = "import { ghx as ghx_module } from adapters\nghx = connect ghx_module\n";
const MAIL: &str = "import { mail as mail_module } from adapters\nmail = connect mail_module\n";
const PAY: &str = "import { pay as pay_module } from adapters\npay = connect pay_module\n";
const BELL: &str = "import { bell as bell_module } from adapters\nbell = connect bell_module\n";

/// The catalog, the Hiring connection's `Table` narrowed to Candidates by
/// `t.Id == "tblCAND01"` under the key a check of that WHERE looks up.
fn catalog() -> CatalogSnapshot {
    use movement_parser::lowering::expression::{Expression, TraversalStep};
    let Ok(Expression::Traverse { steps, .. }) = movement_checker::slots::expression_of_text("__movement_path_root__-[t:Tables WHERE t.Id == \"tblCAND01\"]->.`__probe__`") else { panic!() };
    let [TraversalStep::Edge(edge)] = steps.as_slice() else { panic!() };
    let key = movement_parser::catalog::helpers::refinement_key("Table", &serde_json::to_value(edge.expression_filter.as_deref().unwrap()).unwrap());
    let held = |row: &str| format!(r#"{{"kind":"maybeAbsent","of":{{"kind":"record","position":{{"kind":"position","position":"{row}"}}}}}}"#);
    let text = CATALOG
        .replace("__HELD_ROW__", &held("Row"))
        .replace("__HELD_CANDIDATES__", &held("Candidates"))
        .replace("\"__CANDIDATES_KEY__\"", &serde_json::to_string(&key).unwrap());
    CatalogSnapshot::load(&text).unwrap()
}

fn checked(source: &str, pin: Option<&str>) -> Vec<Diagnostic> {
    let options = CheckOptions { upgrading_from: pin, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog(), options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
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
    let text = fixed(&source, &d);
    assert_eq!(
        text,
        format!(
            "{HIRING}function moved(c: <hiring-[:`Candidates Change`]->>) {{ return 1 }}\nlisten to hiring-[t:Tables WHERE t.Id == \"tblCAND01\"]->-[c:Changes WHERE c.Current.Stage == \"Interview\" AND c.Previous.Stage != \"Interview\"]-> fire moved\n"
        )
    );
    assert_rechecks_clean(&text);
}

/// `field` and `becomes` compare the row before and after the change
/// (`fieldChange`), as 0.12 did: the field came to hold the value, which a
/// row created holding it did too (no row before). A list is no value `!=`
/// compares.
#[test]
fn a_field_and_the_value_it_becomes_compare_the_row_before_and_after() {
    let source = format!(
        "{HIRING}function moved(c: <hiring-[:`Record Change`]->>) {{ return 1 }}\nlisten to hiring {{ table: \"tblCAND01\", field: \"Stage\", becomes: \"Interview\", events: [\"record.updated\"] }} fire moved\n"
    );
    let d = diagnostics(&source);
    let told = retired(&d);
    assert_eq!(told.fix.as_ref().unwrap()["safe"], true, "{told:?}");
    let text = fixed(&source, &d);
    assert!(
        text.ends_with("listen to hiring-[t:Tables WHERE t.Id == \"tblCAND01\"]->-[c:Changes WHERE c.Kind IN [\"updated\"] AND c.Current.Stage == \"Interview\" AND c.Previous.Stage != \"Interview\"]-> fire moved\n"),
        "{text}"
    );
    assert_rechecks_clean(&text);
    let listed = source.replace("becomes: \"Interview\"", "becomes: [\"Interview\", \"Offer\"]");
    assert_eq!(retired(&diagnostics(&listed)).fix, None, "several values: no one value to compare by `!=`");
}

/// Every rewrite keeps 0.12's meaning, so each is safe: a field alone is
/// the field changed; a value with no field narrows nothing, as in 0.12; one
/// change per row an edit touched is one run per update, as 0.12 ran.
#[test]
fn a_field_change_keeps_what_0_12_heard() {
    let rewritten = |settings: &str| {
        let source = format!("{HIRING}function moved(c: <hiring-[:`Record Change`]->>) {{ return 1 }}\nlisten to hiring {{ table: \"tblCAND01\"{settings} }} fire moved\n");
        let d = diagnostics(&source);
        assert_eq!(retired(&d).fix.as_ref().unwrap()["safe"], true, "{settings}: {d:?}");
        let text = fixed(&source, &d);
        assert_rechecks_clean(&text);
        text.lines().last().unwrap().to_string()
    };
    assert_eq!(rewritten(", field: \"Stage\""), "listen to hiring-[t:Tables WHERE t.Id == \"tblCAND01\"]->-[c:Changes WHERE c.Current.Stage != c.Previous.Stage]-> fire moved");
    assert_eq!(rewritten(", becomes: \"Interview\""), "listen to hiring-[t:Tables WHERE t.Id == \"tblCAND01\"]->-[:Changes]-> fire moved");
    assert_eq!(rewritten(""), "listen to hiring-[t:Tables WHERE t.Id == \"tblCAND01\"]->-[:Changes]-> fire moved");
}

/// The field is the narrowed table's own: one its rows lack has no rewrite,
/// and the listen is told the fields there are.
#[test]
fn a_field_the_table_does_not_have_has_no_rewrite() {
    let source = format!("{HIRING}function moved(c: <hiring-[:`Record Change`]->>) {{ return 1 }}\nlisten to hiring {{ table: \"tblCAND01\", field: \"Stge\" }} fire moved\n");
    let d = diagnostics(&source);
    let told = retired(&d);
    assert_eq!(told.fix, None);
    assert!(told.message.contains("(there is no rewrite: Candidates has no field `Stge` (its fields: `Id`, `Stage`, `Files`))"), "{}", told.message);
}

/// Where the host has not narrowed the table, its rows are every table's
/// (`Row`), and the field is checked against those: one they lack has no
/// rewrite, so `upgrade` never writes a listen that does not check.
#[test]
fn a_field_of_a_table_the_host_did_not_narrow_has_no_rewrite() {
    for settings in ["table: \"tblROLE01\", field: \"Stage\"", "field: \"Stage\""] {
        let source = format!("{HIRING}function moved(c: <hiring-[:`Record Change`]->>) {{ return 1 }}\nlisten to hiring {{ {settings} }} fire moved\n");
        let d = diagnostics(&source);
        let told = retired(&d);
        assert_eq!(told.fix, None, "{settings}: {told:?}");
        assert!(
            told.message.contains("(there is no rewrite: Row has no field `Stage` (its fields: `Id`), and its table is not narrowed to one whose rows hold it)"),
            "{settings}: {}",
            told.message
        );
        // The traversal the withheld rewrite walks, for a host to narrow by and check again.
        assert!(told.walks.as_deref().is_some_and(|walks| walks.contains("c.Current.Stage != c.Previous.Stage")), "{settings}: {told:?}");
    }
    // A field the narrowed table lacks is refused for good: nothing to narrow by.
    let narrowed = format!("{HIRING}function moved(c: <hiring-[:`Record Change`]->>) {{ return 1 }}\nlisten to hiring {{ table: \"tblCAND01\", field: \"Stge\" }} fire moved\n");
    assert_eq!(retired(&diagnostics(&narrowed)).walks, None);
}

/// A field a listen compares by identity (a list of files: two copies are
/// never one) is rewritten, but not safely: the rewrite may hear every
/// update where 0.12 heard the field change, and the listen is told so.
#[test]
fn a_field_compared_by_identity_is_rewritten_unsafely_and_says_why() {
    let source = format!("{HIRING}function moved(c: <hiring-[:`Record Change`]->>) {{ return 1 }}\nlisten to hiring {{ table: \"tblCAND01\", field: \"Files\" }} fire moved\n");
    let d = diagnostics(&source);
    let told = retired(&d);
    let fix = told.fix.as_ref().unwrap_or_else(|| panic!("{told:?}"));
    assert_eq!(fix.get("safe"), None, "{told:?}");
    assert!(told.message.contains("`Files` holds list of file, which a listen compares by identity"), "{}", told.message);
    let text = fixed(&source, &d);
    assert!(text.contains("c.Current.Files != c.Previous.Files"), "{text}");
    assert_rechecks_clean(&text);
}

#[test]
fn a_parameter_typed_by_the_event_narrowed_to_its_table_is_retyped_too() {
    let source = format!(
        "{HIRING}function moved(c: <hiring-[:`Record Change` WHERE `table` == \"tblCAND01\"]->>) {{ return 1 }}\nlisten to hiring {{ base: \"appHIRE01\", table: \"tblCAND01\" }} fire moved\n"
    );
    let d = diagnostics(&source);
    let text = fixed(&source, &d);
    assert_eq!(
        text,
        format!("{HIRING}function moved(c: <hiring-[:`Candidates Change`]->>) {{ return 1 }}\nlisten to hiring-[t:Tables WHERE t.Id == \"tblCAND01\"]->-[:Changes]-> fire moved\n")
    );
    assert_rechecks_clean(&text);
    // Where the host has not narrowed the table, the parameter takes every table's changes.
    let unnarrowed = source.replace("tblCAND01", "tblROLE01");
    let text = fixed(&unnarrowed, &diagnostics(&unnarrowed));
    assert!(text.contains("function moved(c: <hiring-[:Change]->>)"), "{text}");
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
fn a_declared_payload_becomes_the_type_stated_after_the_traversal() {
    let source = format!("{HOOK}function paid(p: <Payment>) {{ return p.amount }}\nlisten to hook {{ payload: <Payment> }} fire paid\n");
    let d = diagnostics(&source);
    let told = retired(&d);
    assert!(told.message.ends_with("Write `listen to hook-[:Requests]-><Payment> fire paid`"), "{}", told.message);
    assert_eq!(told.fix.as_ref().unwrap()["safe"], true);
    let text = fixed(&source, &d);
    assert_eq!(text, format!("{HOOK}function paid(p: <Payment>) {{ return p.amount }}\nlisten to hook-[:Requests]-><Payment> fire paid\n"));
    assert_rechecks_clean(&text);
}

#[test]
fn a_bare_listen_becomes_the_whole_edge_its_module_maps_it_to() {
    for listen in ["listen to bell fire rung", "listen to bell {} fire rung"] {
        let source = format!("{BELL}function rung(r: <bell-[:Ring]->>) {{ return r.At }}\n{listen}\n");
        let d = diagnostics(&source);
        assert_eq!(retired(&d).fix.as_ref().unwrap()["safe"], true, "{listen}");
        let text = fixed(&source, &d);
        assert_eq!(text, format!("{BELL}function rung(r: <bell-[:Rings]->>) {{ return r.At }}\nlisten to bell-[:Rings]-> fire rung\n"));
        assert_rechecks_clean(&text);
    }
}

#[test]
fn a_keyed_inbox_listen_is_rewritten_lowercased_as_0_12_compared_it() {
    let keyed = |key: &str| format!("{INBOX}function deal(m: <inbox-[:Email]->>) {{ return m.Subject }}\nlisten to inbox {{ key: \"{key}\" }} fire deal\n");
    for (written, compared) in [("deals", "deals"), ("Deals", "deals"), ("deals_q3", "deals_q3")] {
        let source = keyed(written);
        let d = diagnostics(&source);
        assert_eq!(retired(&d).fix.as_ref().unwrap()["safe"], true, "{written}");
        let text = fixed(&source, &d);
        assert_eq!(
            text,
            format!("{INBOX}function deal(m: <inbox-[:Emails]->>) {{ return m.Subject }}\nlisten to inbox-[e:Emails WHERE e.Key == \"{compared}\"]-> fire deal\n"),
            "{written}"
        );
        assert_rechecks_clean(&text);
    }
}

#[test]
fn a_listen_that_leaves_out_a_key_is_compared_with_what_leaving_it_out_meant() {
    // A 0.12 inbox listen with no key heard mail sent to the box itself: its key is "".
    for listen in ["listen to inbox {} fire deal", "listen to inbox fire deal"] {
        let source = format!("{INBOX}function deal(m: <inbox-[:Email]->>) {{ return m.Subject }}\n{listen}\n");
        let d = diagnostics(&source);
        assert_eq!(retired(&d).fix.as_ref().unwrap()["safe"], true, "{listen}");
        let text = fixed(&source, &d);
        assert_eq!(text, format!("{INBOX}function deal(m: <inbox-[:Emails]->>) {{ return m.Subject }}\nlisten to inbox-[e:Emails WHERE e.Key == \"\"]-> fire deal\n"));
        assert_rechecks_clean(&text);
    }
    // A mapping's `absent` takes the place of the module's default events.
    let source = format!("{GHX}function f(n: <ghx-[:Notification]->>) {{ return 1 }}\nlisten to ghx {{}} fire f\n");
    let text = fixed(&source, &diagnostics(&source));
    assert!(text.ends_with("listen to ghx-[n:Notifications WHERE n.Reason IN [\"review_requested\"]]-> fire f\n"), "{text}");
    assert_rechecks_clean(&text);
}

#[test]
fn a_listen_that_leaves_an_unbounded_edge_unbounded_has_no_fix_and_is_told_the_field_that_bounds_it() {
    let keyed = format!("{MBOX}function deal(m: <mbox-[:Email]->>) {{ return m.Subject }}\nlisten to mbox {{ key: \"deals\" }} fire deal\n");
    let text = fixed(&keyed, &diagnostics(&keyed));
    assert_eq!(text, format!("{MBOX}function deal(m: <mbox-[:Emails]->>) {{ return m.Subject }}\nlisten to mbox-[e:Emails WHERE e.Key == \"deals\"]-> fire deal\n"));
    assert_rechecks_clean(&text);
    for listen in ["listen to mbox {} fire deal", "listen to mbox fire deal"] {
        let source = format!("{MBOX}function deal(m: <mbox-[:Email]->>) {{ return m.Subject }}\n{listen}\n");
        let d = diagnostics(&source);
        let told = retired(&d);
        assert_eq!(told.fix, None, "{listen}");
        assert!(
            told.message.ends_with(
                "Write `listen to mbox-[e:Emails WHERE e.Key == \"…\"]-> fire deal` (its settings name no value that bounds the edge, so there is no rewrite: name the one it listens for)"
            ),
            "{}",
            told.message
        );
    }
}

#[test]
fn a_rewrite_never_writes_a_literal_its_field_refuses() {
    // mbox's keys are lowercase letters and digits; 0.12 did not lowercase them for it.
    let source = format!("{MBOX}function deal(m: <mbox-[:Email]->>) {{ return m.Subject }}\nlisten to mbox {{ key: \"Deals\" }} fire deal\n");
    let d = diagnostics(&source);
    let told = retired(&d);
    assert_eq!(told.fix, None);
    assert!(
        told.message.ends_with("Write `listen to mbox-[e:Emails WHERE e.Key == \"…\"]-> fire deal` (there is no rewrite: \"Deals\" is not an InboxKey: it does not match ^[a-z0-9]+$)"),
        "{}",
        told.message
    );
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

#[test]
fn a_list_key_mapped_by_contains_is_one_contains_or_an_or_of_them_and_leaving_it_out_is_what_it_meant() {
    let one = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ query: \"from:acme\", labels: [\"Deals\"] }} fire f\n");
    let text = fixed(&one, &diagnostics(&one));
    assert!(text.contains("listen to mail-[m:Messages WHERE m.Query == \"from:acme\" AND m.Labels CONTAINS \"Deals\"]-> fire f"), "{text}");
    assert_rechecks_clean(&text);

    // Labels takes several values together (`containsAny`): the OR is the
    // module's, so the fix is safe.
    let two = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ labels: [\"INBOX\", \"SPAM\"] }} fire f\n");
    let d = diagnostics(&two);
    assert_eq!(retired(&d).fix.as_ref().unwrap().get("safe"), Some(&Value::Bool(true)), "{:?}", retired(&d));
    let text = fixed(&two, &d);
    assert!(text.contains("listen to mail-[m:Messages WHERE m.Labels CONTAINS \"INBOX\" OR m.Labels CONTAINS \"SPAM\"]-> fire f"), "{text}");
    assert_rechecks_clean(&text);

    // Subject takes one value at a time: the host would compare each, so the
    // fix is offered unsafe, saying so.
    let subjects = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ subjects: [\"invoice\", \"receipt\"] }} fire f\n");
    let d = diagnostics(&subjects);
    assert_eq!(retired(&d).fix.as_ref().unwrap().get("safe"), None, "an unsafe fix");
    assert!(retired(&d).message.contains("(the module can't take several values of `Subject` together"), "{}", retired(&d).message);
    let one_subject = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ subjects: [\"invoice\"] }} fire f\n");
    let d = diagnostics(&one_subject);
    assert_eq!(retired(&d).fix.as_ref().unwrap().get("safe"), Some(&Value::Bool(true)), "{:?}", retired(&d));

    let left_out = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ query: \"from:acme\", every: 5m }} fire f\n");
    let d = diagnostics(&left_out);
    assert!(retired(&d).message.ends_with("(`every` is gone: the module sets the interval; set `pollEvery` for this connection in lf.yaml)"), "{}", retired(&d).message);
    assert_eq!(retired(&d).fix.as_ref().unwrap().get("safe"), None, "an unsafe fix");
    let text = fixed(&left_out, &d);
    assert!(text.contains("listen to mail-[m:Messages WHERE m.Query == \"from:acme\" AND m.Labels CONTAINS \"INBOX\"]-> fire f"), "{text}");
    assert_rechecks_clean(&text);
}

#[test]
fn a_listen_naming_an_event_that_arrives_on_another_edge_is_rewritten_onto_that_edge() {
    let labelled = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ events: [\"label_added\"], labels: [\"Deals\", \"Hiring\"] }} fire f\n");
    let text = fixed(&labelled, &diagnostics(&labelled));
    assert!(text.contains("listen to mail-[l:Labelings WHERE l.Label IN [\"Deals\", \"Hiring\"]]-> fire f"), "{text}");
    assert!(text.contains("function f(m: <mail-[:Labelings]->>)"), "{text}");
    assert_rechecks_clean(&text);

    // Leaving `labels` out of a label listen meant the mailbox's own labels.
    let own = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ events: \"label_added\", query: \"from:acme\" }} fire f\n");
    let text = fixed(&own, &diagnostics(&own));
    assert!(text.contains("listen to mail-[l:Labelings WHERE l.Query == \"from:acme\" AND l.`Label Type` == \"user\"]-> fire f"), "{text}");
    assert_rechecks_clean(&text);

    let received = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ events: [\"message_received\"] }} fire f\n");
    let text = fixed(&received, &diagnostics(&received));
    assert!(text.contains("listen to mail-[m:Messages WHERE m.Labels CONTAINS \"INBOX\"]-> fire f"), "{text}");
    assert_rechecks_clean(&text);
}

#[test]
fn a_listen_naming_events_that_arrive_on_two_edges_has_no_fix_and_is_told_to_write_one_per_edge() {
    let both = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ events: [\"message_received\", \"label_added\"] }} fire f\n");
    let d = diagnostics(&both);
    assert!(retired(&d).fix.is_none(), "{:?}", retired(&d).fix);
    assert!(retired(&d).message.ends_with("(there is no rewrite: its events arrive on `Messages` and `Labelings`, so write one listen for each)"), "{}", retired(&d).message);

    // An edge named twice, apart, is named once.
    let repeated = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ events: [\"message_received\", \"label_added\", \"message_received\"] }} fire f\n");
    let d = diagnostics(&repeated);
    assert!(retired(&d).message.ends_with("(there is no rewrite: its events arrive on `Messages` and `Labelings`, so write one listen for each)"), "{}", retired(&d).message);

    // An event the mapping does not name, beside one landing where it would,
    // is no second edge: the event is what has no rewrite.
    let unknown = format!("{MAIL}function f(m: <mail-[:Message]->>) {{ return 1 }}\nlisten to mail {{ events: [\"message_received\", \"x\"] }} fire f\n");
    let d = diagnostics(&unknown);
    assert!(retired(&d).fix.is_none(), "{:?}", retired(&d).fix);
    assert!(
        retired(&d).message.ends_with("(there is no rewrite: mail has no event `x`; its events are `message_received` and `label_added`)"),
        "{}",
        retired(&d).message
    );
}

#[test]
fn an_event_that_chooses_its_edge_is_still_compared_when_its_mapping_compares_it() {
    let failed = format!("{PAY}function f(e: <pay-[:Event]->>) {{ return 1 }}\nlisten to pay {{ events: [\"invoice.payment_failed\", \"invoice.paid\"] }} fire f\n");
    let text = fixed(&failed, &diagnostics(&failed));
    assert!(text.contains("listen to pay-[:Invoices]->-[c:Changes WHERE c.Kind IN [\"payment_failed\", \"paid\"]]-> fire f"), "{text}");
    assert!(text.contains("function f(e: <pay-[:Change]->>)"), "{text}");
    assert_rechecks_clean(&text);

    let charge = format!("{PAY}function f(e: <pay-[:Event]->>) {{ return 1 }}\nlisten to pay {{ events: \"charge.failed\" }} fire f\n");
    let text = fixed(&charge, &diagnostics(&charge));
    assert!(text.contains("listen to pay-[:Charges]->-[c:Changes WHERE c.Kind == \"failed\"]-> fire f"), "{text}");
    assert_rechecks_clean(&text);
}

#[test]
fn a_listen_that_names_no_events_where_leaving_them_out_heard_every_edge_is_told_to_write_one_per_edge() {
    let everything = format!("{PAY}function f(e: <pay-[:Event]->>) {{ return 1 }}\nlisten to pay {{ }} fire f\n");
    let d = diagnostics(&everything);
    assert!(retired(&d).fix.is_none(), "{:?}", retired(&d).fix);
    assert!(retired(&d).message.ends_with("(there is no rewrite: its events arrive on `-[:Invoices]->-[:Changes]->` and `-[:Charges]->-[:Changes]->`, so write one listen for each)"), "{}", retired(&d).message);
}

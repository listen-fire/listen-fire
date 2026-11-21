//! What 0.16 retired, and what an upgrade to it tells: a Slack listen a host
//! may have limited to registered senders is open now (MOV_LISTEN_NOW_OPEN,
//! on an upgrade only); `Actor` is gone from what lands (MOV_ACTOR_RETIRED);
//! `@user_*` and `@actor_*` are gone (MOV_ACTING_USER_RETIRED).

use movement_checker::{CheckOptions, Diagnostic, Severity, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::json;

fn catalog() -> CatalogSnapshot {
    catalog_with_member("@lf-platform/team/isMember", "isMember")
}

fn catalog_with_member(key: &str, spec_name: &str) -> CatalogSnapshot {
    let email = json!({ "kind": "branded", "of": "text", "brands": ["claim:email/address"] });
    catalog_asking(key, spec_name, email)
}

fn catalog_asking(key: &str, spec_name: &str, asked: serde_json::Value) -> CatalogSnapshot {
    let email = json!({ "kind": "branded", "of": "text", "brands": ["claim:email/address"] });
    let message = |claims: serde_json::Value| {
        let mut properties = json!({ "Channel": "text", "Text": "text" });
        properties.as_object_mut().unwrap().extend(claims.as_object().unwrap().clone());
        json!({
            "positions": { "Message": { "properties": properties, "edges": {} } },
            "collections": { "Messages": { "target": "Message", "listenable": true, "delivery": "connection" } },
            "writableRoots": {}
        })
    };
    let slack = message(json!({ "User Email": { "kind": "maybeAbsent", "of": email }, "Sent By This App": "boolean" }));
    let telegram = message(json!({ "Sender Email": email }));
    let catalog = json!({
        "adapters": {
            "slack": { "canFire": true, "constructionArgs": [], "listensLimitedBefore": "0.16.0", "schemas": { "": slack } },
            "telegram": { "canFire": true, "constructionArgs": [], "schemas": { "": telegram } }
        },
        "credentials": {},
        "plugins": {
            key: {
                "args": ["e"], "priced": false, "requiredArgs": ["e"], "argTypes": { "e": asked }, "effects": {},
                "output": { "kind": "value", "type": "boolean" }, "package": "@lf-platform/team", "name": spec_name,
                "pure": true, "maxAgeSeconds": 300
            }
        }
    });
    CatalogSnapshot::load(&catalog.to_string()).unwrap()
}

const SLACK: &str = "import { slack } from adapters\ns = connect slack\nfunction f(m: <s-[:Message]->>) { return m.Text }\n";

#[derive(Clone, Copy)]
struct Asked<'a> {
    upgrading_from: Option<&'a str>,
    limiting_function: Option<&'a str>,
}

const UPGRADE: Asked<'static> = Asked { upgrading_from: Some("0.15.3"), limiting_function: None };

fn check(source: &str, asked: Asked) -> Vec<Diagnostic> {
    let options = CheckOptions { upgrading_from: asked.upgrading_from, limiting_function: asked.limiting_function, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog(), options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

fn now_open(source: &str, asked: Asked) -> Vec<Diagnostic> {
    check(source, asked).into_iter().filter(|d| d.code == "MOV_LISTEN_NOW_OPEN").collect()
}

/// `source` with the fix's edits made, as `listen-fire upgrade` makes them:
/// lines and columns from 1, columns in UTF-16 units.
fn applied(source: &str, fix: &serde_json::Value) -> String {
    let units: Vec<u16> = source.encode_utf16().collect();
    let mut starts = vec![0usize];
    starts.extend(units.iter().enumerate().filter(|(_, u)| **u == u16::from(b'\n')).map(|(i, _)| i + 1));
    let offset = |at: &serde_json::Value| starts[at["line"].as_u64().unwrap() as usize - 1] + at["col"].as_u64().unwrap() as usize - 1;
    let mut edits: Vec<(usize, usize, &str)> = fix["edits"].as_array().unwrap().iter().map(|e| (offset(&e["span"]["start"]), offset(&e["span"]["end"]), e["text"].as_str().unwrap())).collect();
    edits.sort_by_key(|(from, _, _)| std::cmp::Reverse(*from));
    let mut result = units;
    for (from, to, text) in edits {
        result.splice(from..to, text.encode_utf16());
    }
    String::from_utf16_lossy(&result)
}

#[test]
fn an_open_slack_listen_is_told_on_upgrade() {
    let source = format!("{SLACK}listen to s-[m:Messages WHERE m.Channel == \"C1\"]-> fire f\n");
    let told = now_open(&source, UPGRADE);
    assert_eq!(told.len(), 1, "{told:#?}");
    let note = &told[0];
    assert_eq!((note.severity, note.upgrade, &note.fix), (Some(Severity::Warning), Some(true), &None), "a fixless note: it holds the pin until checked");
    assert!(note.message.contains("may have let only registered senders set this listen off"), "{}", note.message);
    assert!(note.message.contains("the app's own messages reach it too"), "{}", note.message);
    assert!(note.message.contains("its claims: `User Email`"), "{}", note.message);
    assert!(note.message.contains("`NOT m.`Sent By This App``"), "{}", note.message);
    assert_eq!(check(&source, UPGRADE).iter().filter(|d| d.is_error()).count(), 0);
}

#[test]
fn a_slack_listen_written_under_0_16_is_told_nothing() {
    let source = format!("{SLACK}listen to s-[m:Messages WHERE m.Channel == \"C1\"]-> fire f\n");
    assert_eq!(now_open(&source, Asked { upgrading_from: None, limiting_function: None }).len(), 0);
    assert_eq!(now_open(&source, Asked { upgrading_from: Some("0.16.0"), limiting_function: None }).len(), 0);
}

#[test]
fn a_slack_listen_that_calls_a_limiting_function_is_told_nothing() {
    let source = format!(
        "import {{ `@lf-platform/team` as t }} from plugins\n{SLACK}listen to s-[m:Messages WHERE m.Channel == \"C1\" AND m.`User Email` != null AND t.isMember(m.`User Email`)]-> fire f\n"
    );
    assert_eq!(now_open(&source, UPGRADE).len(), 0);
    assert_eq!(check(&source, UPGRADE).iter().filter(|d| d.is_error()).count(), 0, "{:#?}", check(&source, UPGRADE));
}

#[test]
fn a_telegram_listen_is_told_nothing() {
    let source = "import { telegram } from adapters\nt = connect telegram\nfunction f(m: <t-[:Message]->>) { return m.Text }\nlisten to t-[:Messages]-> fire f\n";
    assert_eq!(now_open(source, UPGRADE).len(), 0);
}

#[test]
fn the_fix_inserts_the_import_and_the_checks() {
    let host = Asked { upgrading_from: Some("0.15.3"), limiting_function: Some("@lf-platform/team/isMember") };
    let source = format!("{SLACK}listen to s-[m:Messages WHERE m.Channel == \"C1\" OR m.Channel == \"C2\"]-> fire f\n");
    let told = now_open(&source, host);
    assert_eq!(told.len(), 1, "{told:#?}");
    let fix = told[0].fix.as_ref().expect("the host named its limiting function");
    assert_eq!(fix["safe"], json!(false), "it changes who sets the listen off");
    let fixed = applied(&source, fix);
    assert_eq!(
        fixed,
        "import { slack } from adapters\nimport { `@lf-platform/team` as team } from plugins\ns = connect slack\nfunction f(m: <s-[:Message]->>) { return m.Text }\nlisten to s-[m:Messages WHERE (m.Channel == \"C1\" OR m.Channel == \"C2\") AND m.`User Email` != null AND team.isMember(m.`User Email`) AND NOT m.`Sent By This App`]-> fire f\n"
    );
    let after = check(&fixed, Asked { upgrading_from: Some("0.15.3"), limiting_function: Some("@lf-platform/team/isMember") });
    assert_eq!(after.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), Vec::<&str>::new(), "the fixed text checks clean and is told nothing");

    // A hop with no alias and no filter gains both; an import already there is used.
    let source = format!("import {{ `@lf-platform/team` as t }} from plugins\n{SLACK}listen to s-[:Messages]-> fire f\n");
    let fix = now_open(&source, host).remove(0).fix.expect("a fix");
    assert_eq!(fix["edits"].as_array().map(Vec::len), Some(1), "no second import");
    assert!(
        applied(&source, &fix).ends_with("listen to s-[m:Messages WHERE m.`User Email` != null AND t.isMember(m.`User Email`) AND NOT m.`Sent By This App`]-> fire f\n"),
        "{}",
        applied(&source, &fix)
    );
}

#[test]
fn reading_actor_lists_the_claim_fields() {
    let source = "import { slack } from adapters\ns = connect slack\nfunction f(m: <s-[:Message]->>) { return m.Actor }\nlisten to s-[:Messages]-> fire f\n";
    let found: Vec<Diagnostic> = check(source, Asked { upgrading_from: None, limiting_function: None }).into_iter().filter(|d| d.is_error()).collect();
    assert_eq!(found.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_ACTOR_RETIRED"], "{found:#?}");
    assert!(found[0].message.starts_with("'Actor' is retired in 0.16"), "{}", found[0].message);
    assert!(found[0].message.contains("who acted is a claim it carries: `User Email`"), "{}", found[0].message);
    assert_eq!(found[0].fix, None);
}

#[test]
fn acting_user_meta_keys_are_retired() {
    for key in ["user_email", "user_name", "user_id", "actor_email", "actor_name", "actor_id"] {
        let source = format!("import {{ slack }} from adapters\ns = connect slack\nfunction f(m: <s-[:Message]->>) {{\n  x = @{key}\n  return x\n}}\nlisten to s-[:Messages]-> fire f\n");
        let found: Vec<Diagnostic> = check(&source, Asked { upgrading_from: None, limiting_function: None }).into_iter().filter(|d| d.is_error()).collect();
        assert_eq!(found.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_ACTING_USER_RETIRED"], "{key}: {found:#?}");
        assert!(found[0].message.starts_with(&format!("'@{key}' is retired in 0.16: who acted is a claim on the event")), "{}", found[0].message);
        assert!(found[0].message.contains("host function"), "{}", found[0].message);
        assert_eq!(found[0].fix, None);
    }
    let source = "import { slack } from adapters\ns = connect slack\nfunction f(m: <s-[:Message]->>) {\n  x = @current_date\n  return x\n}\nlisten to s-[:Messages]-> fire f\n";
    assert_eq!(check(source, Asked { upgrading_from: None, limiting_function: None }).iter().filter(|d| d.is_error()).count(), 0);
}

#[test]
fn the_fix_spells_the_member_as_a_program_calls_it() {
    for spec_name in ["is-member", "is_member"] {
        let catalog = catalog_with_member("@lf-platform/team/is_member", spec_name);
        let asked = Asked { upgrading_from: Some("0.15.3"), limiting_function: Some("@lf-platform/team/is_member") };
        let options = || CheckOptions { upgrading_from: asked.upgrading_from, limiting_function: asked.limiting_function, zones: &movement_checker::host::native::NativeZones };
        let source = format!("{SLACK}listen to s-[m:Messages WHERE m.Channel == \"C1\"]-> fire f\n");
        let told: Vec<Diagnostic> = check_source(&source, &catalog, options()).unwrap().into_iter().filter(|d| d.code == "MOV_LISTEN_NOW_OPEN").collect();
        let fix = told[0].fix.as_ref().expect("a fix");
        let fixed = applied(&source, fix);
        assert!(fixed.contains("team.isMember("), "{spec_name}: {fixed}");
        let after = check_source(&fixed, &catalog, options()).unwrap();
        assert_eq!(after.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), Vec::<&str>::new(), "{spec_name}: {fixed}");
    }
}

#[test]
fn the_fix_finds_the_claim_through_a_union_of_brands() {
    let email = json!({ "kind": "branded", "of": "text", "brands": ["claim:email/address"] });
    let phone = json!({ "kind": "branded", "of": "text", "brands": ["claim:phone/e164"] });
    let key = "@lf-platform/team/is_member";
    for asked in [json!({ "kind": "union", "of": [email, phone] }), json!({ "kind": "maybeAbsent", "of": { "kind": "union", "of": [phone, email] } })] {
        let catalog = catalog_asking(key, "is_member", asked);
        let options = || CheckOptions { upgrading_from: Some("0.15.3"), limiting_function: Some(key), zones: &movement_checker::host::native::NativeZones };
        let source = format!("{SLACK}listen to s-[m:Messages WHERE m.Channel == \"C1\"]-> fire f\n");
        let told: Vec<Diagnostic> = check_source(&source, &catalog, options()).unwrap().into_iter().filter(|d| d.code == "MOV_LISTEN_NOW_OPEN").collect();
        let fix = told[0].fix.as_ref().expect("a fix through the union");
        let fixed = applied(&source, fix);
        assert!(fixed.contains("team.isMember(m.`User Email`)"), "{fixed}");
        let after = check_source(&fixed, &catalog, options()).unwrap();
        assert_eq!(after.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), Vec::<&str>::new(), "{fixed}");
    }
}

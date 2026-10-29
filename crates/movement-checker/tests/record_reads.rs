//! A dot read off a record reads one of its fields, whole. The engine runs
//! nothing else off a record, so the checker refuses the rest by name: a
//! name that is not a field (listing the fields and the edges), an edge read
//! as a field (with the walk that reaches it), and a read past a field
//! (`n.Meta.crm_id`), whose remedy is to bind the field first. Each fails
//! every run that reaches it, so each is an error under every 0.12 pin.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::json;

fn catalog() -> CatalogSnapshot {
    let schema = json!({
        "positions": {
            "Notification": {
                "properties": { "Reason": { "kind": "enum", "options": ["mention", "review_requested"] }, "Title": "text", "Count": "number", "Meta": "json" },
                "edges": { "Repository": { "target": "Repository" }, "Pull Request": { "target": "Repository" } }
            },
            "Repository": { "properties": { "Name": "text" }, "edges": {} }
        },
        "collections": { "Notifications": { "target": "Notification" } },
        "writableRoots": {}
    });
    let catalog = json!({
        "adapters": { "hub": { "canFire": false, "constructionArgs": [], "schemas": { "": schema } } },
        "credentials": {},
        "plugins": {}
    });
    CatalogSnapshot::load(&catalog.to_string()).unwrap()
}

/// Each error's code and message (a warning is not one).
fn errors_of(source: &str) -> Vec<(String, String)> {
    let source = format!("import {{ hub }} from adapters\nh = connect hub\n{source}");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog(), options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .filter(|d| d.severity.is_none())
        .map(|d| (d.code, d.message))
        .collect()
}

/// The errors of `read`, bound inside a block over the notifications.
fn in_block(read: &str) -> Vec<(String, String)> {
    errors_of(&format!("function m() {{\n  h-[n:Notifications]-> {{\n    t = {read}\n  }}\n}}\n"))
}

fn one(found: Vec<(String, String)>) -> (String, String) {
    assert_eq!(found.len(), 1, "{found:#?}");
    found.into_iter().next().unwrap()
}

#[test]
fn a_name_past_a_record_that_it_does_not_have_names_its_fields_and_its_edges() {
    let (code, message) = one(in_block("n.subject.title"));
    assert_eq!(code, "MOV_UNKNOWN_PROPERTY");
    assert_eq!(
        message,
        "h.Notification has no field 'subject' — it has: Count, Meta, Reason, Title; and edges, walked (`-[:…]->`) rather than read: Pull Request, Repository"
    );
}

#[test]
fn a_field_a_record_does_not_have_names_its_edges_too() {
    let (code, message) = one(in_block("n.Titel"));
    assert_eq!(code, "MOV_UNKNOWN_PROPERTY");
    assert!(message.ends_with("; and edges, walked (`-[:…]->`) rather than read: Pull Request, Repository — did you mean 'Title'?"), "{message}");
}

#[test]
fn an_edge_read_as_a_field_says_so_and_shows_the_walk() {
    let (code, message) = one(in_block("n.Repository"));
    assert_eq!(code, "MOV_UNKNOWN_PROPERTY");
    assert_eq!(message, "'Repository' is an edge of h.Notification, not a field — walk it: `n-[:Repository]->`");
    let (_, message) = one(in_block("n.Repository.Name"));
    assert_eq!(message, "'Repository' is an edge of h.Notification, not a field — walk it: `n-[:Repository]->.Name`");
    let (_, message) = one(in_block("n.`Pull Request`"));
    assert_eq!(message, "'Pull Request' is an edge of h.Notification, not a field — walk it: `n-[:`Pull Request`]->`");
}

#[test]
fn a_read_past_a_text_field_is_a_read_off_text() {
    let (code, message) = one(in_block("n.Title.foo"));
    assert_eq!(code, "MOV_TEXT_HAS_NO_FIELDS");
    assert_eq!(
        message,
        "'n.Title' is text, and a text has no fields — 'foo' is not something it holds. Use the text itself ('n.Title'), or read 'foo' off the record the text came from"
    );
    let (code, _) = one(in_block("n.Reason.x"));
    assert_eq!(code, "MOV_TEXT_HAS_NO_FIELDS");
}

#[test]
fn a_read_past_a_structured_field_binds_the_field_first() {
    let (code, message) = one(in_block("n.Meta.crm_id"));
    assert_eq!(code, "MOV_READ_THROUGH_FIELD");
    assert_eq!(
        message,
        "'n.Meta' is a field of json, which a record hands over whole: `n.Meta.crm_id` does not run. Bind the field to a name first — `meta = n.Meta` — then read `meta.crm_id`"
    );
    let (code, _) = one(in_block("n.Meta.a.b"));
    assert_eq!(code, "MOV_READ_THROUGH_FIELD");
}

#[test]
fn a_read_off_the_event_is_held_the_same() {
    let (code, _) = one(errors_of("function f(n: <h-[:Notification]->>) {\n  t = n.subject.title\n}\n"));
    assert_eq!(code, "MOV_UNKNOWN_PROPERTY");
    let (code, _) = one(errors_of("function f(n: <h-[:Notification]->>) {\n  t = n.Meta.crm_id\n}\n"));
    assert_eq!(code, "MOV_READ_THROUGH_FIELD");
}

#[test]
fn what_the_engine_reads_off_a_record_still_checks_clean() {
    for read in ["n.Title", "n.Meta", "n-[:Repository]->.Name", "n-[:Repository]->", "exists(n-[:Repository]->)"] {
        assert_eq!(in_block(read), Vec::<(String, String)>::new(), "{read}");
    }
    // A field bound to a name is a value, and a value's members read.
    assert_eq!(errors_of("function m() {\n  h-[n:Notifications]-> {\n    meta = n.Meta\n    t = meta.crm_id\n  }\n}\n"), Vec::<(String, String)>::new());
    // A dict is a value, never a record.
    assert_eq!(errors_of("function m() {\n  d = { a: { b: 1 } }\n  t = d.a.b\n}\n"), Vec::<(String, String)>::new());
}

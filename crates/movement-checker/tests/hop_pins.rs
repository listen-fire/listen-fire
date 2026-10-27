//! A type whose fields a read must pin (`pinnedProperties`, a describe's
//! `pinned: true`): the source takes them as the read's arguments (an MCP
//! tool's required inputs), so a hop landing on it must state each with `==`
//! among its WHERE's top-level conjuncts, against a literal or a name in
//! scope, in a WHERE the engine pushes to the source (a pure one). Anything
//! else is MOV_HOP_PIN_REQUIRED, naming the fields and the form to write.
//! Writes of the type are unaffected.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::json;

const CODE: &str = "MOV_HOP_PIN_REQUIRED";

fn catalog() -> CatalogSnapshot {
    let fields = json!({ "query": "text", "team": "text", "count": "number" });
    let schema = json!({
        "positions": {
            "search_issues": { "properties": fields, "edges": {}, "pinnedProperties": ["query", "team"] },
            "list_teams": { "properties": { "name": "text" }, "edges": {} }
        },
        "collections": { "search_issues": { "target": "search_issues" }, "list_teams": { "target": "list_teams" } },
        "writableRoots": {
            "search_issues": { "fields": { "query": "text", "team": "text" }, "resultShape": { "count": "number" }, "position": "search_issues" }
        }
    });
    let catalog = json!({
        "adapters": { "tracker": {
            "canFire": true,
            "constructionArgs": [{ "name": "credentials", "kind": "credential", "required": true }],
            "schemas": { "Tracker": schema }
        } },
        "credentials": { "Tracker": { "adapters": ["tracker"] } },
        "plugins": {}
    });
    CatalogSnapshot::load(&catalog.to_string()).unwrap()
}

fn errors_of(body: &str) -> Vec<String> {
    let source = format!(
        "import {{ tracker }} from adapters\nimport {{ Tracker }} from credentials\n\nt = connect tracker using Tracker\n\nfunction `Find` (name: <text>, squad: <text>) {{\n{body}\n}}\n"
    );
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog(), options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .filter(|d| d.severity.is_none())
        .map(|d| format!("{} {}", d.code, d.message))
        .collect()
}

fn read(hop_where: &str) -> Vec<String> {
    errors_of(&format!("  return t-[r:search_issues WHERE {hop_where}]-> {{\n    return r.count\n  }}"))
}

fn refused(found: &[String]) -> &str {
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].starts_with(CODE), "{found:?}");
    &found[0]
}

#[test]
fn a_read_that_pins_every_field_is_accepted_in_any_order() {
    for hop_where in ["r.query == \"login\" AND r.team == \"ENG\"", "\"ENG\" == r.team AND r.query == \"login\""] {
        assert_eq!(read(hop_where), Vec::<String>::new(), "{hop_where}");
    }
}

#[test]
fn a_pin_may_be_a_name_in_scope() {
    assert_eq!(errors_of("  eng = squad\n  return t-[r:search_issues WHERE r.query == name AND r.team == eng]-> {\n    return r.count\n  }"), Vec::<String>::new());
}

#[test]
fn other_conjuncts_beside_the_pins_are_fine() {
    assert_eq!(read("r.query == name AND r.count > 2 AND r.team == \"ENG\""), Vec::<String>::new());
}

#[test]
fn a_read_missing_a_pin_is_refused_naming_it_and_the_form() {
    let found = read("r.query == name");
    let message = refused(&found);
    assert!(message.contains("'search_issues'") && message.contains("`team`"), "{message}");
    assert!(!message.contains("`query`"), "{message}");
    assert!(message.contains("-[r:search_issues WHERE r.query == … AND r.team == …]->"), "{message}");
}

#[test]
fn a_read_with_no_where_is_refused_naming_every_field() {
    let found = errors_of("  return t-[:search_issues]-> {\n    return 1\n  }");
    let message = refused(&found);
    assert!(message.contains("`query` and `team`"), "{message}");
    assert!(message.contains("-[:search_issues WHERE query == … AND team == …]->"), "{message}");
}

#[test]
fn an_or_pins_nothing() {
    let found = read("(r.query == \"a\" OR r.query == \"b\") AND r.team == \"ENG\"");
    let message = refused(&found);
    assert!(message.contains("`query`") && !message.contains("`team`"), "{message}");
}

#[test]
fn another_comparison_pins_nothing() {
    let found = read("r.query != \"a\" AND r.team == \"ENG\"");
    assert!(refused(&found).contains("`query`"), "{found:?}");
}

#[test]
fn a_where_the_engine_cannot_send_to_the_source_is_refused_saying_so() {
    let found = read("r.query == name AND r.team == \"ENG\" AND LOWER(r.query) == \"x\"");
    let message = refused(&found);
    assert!(message.to_lowercase().contains("calls a function or tests exists"), "{message}");
    assert!(message.contains("`query` and `team`"), "{message}");
}

#[test]
fn a_type_with_no_pinned_fields_reads_as_before() {
    assert_eq!(errors_of("  return t-[:list_teams]-> {\n    return 1\n  }"), Vec::<String>::new());
}

#[test]
fn a_write_of_the_type_is_unaffected() {
    assert_eq!(errors_of("  issue = write t-[:search_issues]-> { query: name, team: \"ENG\" }\n  return issue.count"), Vec::<String>::new());
}

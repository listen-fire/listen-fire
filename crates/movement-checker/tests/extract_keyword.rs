//! The extraction keyword in the current language: MOV_EXTRACT_KEYWORD_RETIRED
//! with the same rewrite the TypeScript checker writes
//! (lf-platform's packages/legacy-lang/checker/__test__/extract_keyword_retired.unit.test.ts).

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"slack":{"constructionArgs":[],"schemas":{"":{"positions":{"message":{"properties":{"Text":"text"},"edges":{}},"note":{"properties":{"Body":"text"},"edges":{}}},"collections":{"note":{"target":"note"}},"writableRoots":{"note":{"fields":{"Body":"text"},"resultShape":{"Body":"text"},"edges":{}}}}}}},"credentials":{},"plugins":{"fetchUrl":{"args":["url"],"priced":true,"output":{"kind":"value","type":"text"}}}}"#;

fn check(source: &str) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.code == "MOV_EXTRACT_KEYWORD_RETIRED").collect()
}

const PRELUDE: &str = "import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\n";

#[test]
fn the_keyword_is_refused_with_the_typescripts_rewrite() {
    let source = format!(
        "{PRELUDE}function go(m: <chat-[:message]->>) {{\n  found = extract \"careful\" from [m.Text, \"the subject\"] {{\n    node company: \"each company named\" {{\n      name: <text> \"its name\"\n      node person: \"each person\" {{ name: \"their name\" }}\n    }}\n  }}\n}}\n"
    );
    let found = check(&source);
    assert_eq!(found.len(), 1);
    assert!(found[0].message.contains("writes 'found = extractOne(content, FoundShape, { tier: \"careful\" })'"), "{}", found[0].message);
    assert!(found[0].message.ends_with("(see handbook: front#extraction)"), "{}", found[0].message);
    let fix = found[0].fix.as_ref().expect("a fix");
    assert_eq!(fix.get("safe"), None);
    assert_eq!(
        fix["edits"][0]["text"],
        "node FoundShape: \"the relevant information in the content\" {\n  node company: \"each company named\" {\n    name: <text> \"its name\"\n    node person: \"each person\" {\n      name: <text> \"their name\"\n    }\n  }\n}\n\n"
    );
    assert_eq!(fix["edits"][0]["span"]["start"], serde_json::json!({ "line": 4, "col": 1 }));
    assert_eq!(fix["edits"][1]["text"], "extractOne([m.Text, \"the subject\"], FoundShape, { tier: \"careful\" })");
}

#[test]
fn a_through_stage_has_no_rewrite() {
    let source = format!("import {{ fetchUrl }} from plugins\n{PRELUDE}function go(m: <chat-[:message]->>) {{\n  found = extract from [m.Text] through [fetchUrl(m.Text)] {{ summary: \"s\" }}\n}}\n");
    let found = check(&source);
    assert_eq!(found.len(), 1);
    assert!(found[0].fix.is_none());
    assert!(found[0].message.contains("No rewrite keeps a 'through […]' stage's meaning"));
}

fn check_all(source: &str, files: serde_json::Value) -> Vec<Diagnostic> {
    let mut snapshot: serde_json::Value = serde_json::from_str(CATALOG).unwrap();
    snapshot["files"] = files;
    let catalog = CatalogSnapshot::load(&snapshot.to_string()).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap()
}

fn apply(source: &str, fix: &serde_json::Value) -> String {
    let mut lines: Vec<String> = source.split('\n').map(String::from).collect();
    let mut edits: Vec<&serde_json::Value> = fix["edits"].as_array().unwrap().iter().collect();
    edits.sort_by_key(|e| std::cmp::Reverse((e["span"]["start"]["line"].as_u64().unwrap(), e["span"]["start"]["col"].as_u64().unwrap())));
    for edit in edits {
        let at = |side: &str| (edit["span"][side]["line"].as_u64().unwrap() as usize - 1, edit["span"][side]["col"].as_u64().unwrap() as usize - 1);
        let ((sl, sc), (el, ec)) = (at("start"), at("end"));
        let tail = lines[el][ec..].to_string();
        let head = lines[sl][..sc].to_string();
        let joined = format!("{head}{}{tail}", edit["text"].as_str().unwrap());
        lines.splice(sl..=el, joined.split('\n').map(String::from));
    }
    lines.join("\n")
}

#[test]
fn a_type_name_that_is_not_an_identifier_keeps_its_backticks_in_the_rewrite() {
    let source = format!(
        "{PRELUDE}type `Pass Reason` = <\"yes\" | \"no\">\nfunction go(m: <chat-[:message]->>) {{\n  found = extract \"careful\" from [m.Text] {{ reason: <`Pass Reason`> \"why\" }}\n}}\n"
    );
    let fix = check(&source).remove(0).fix.expect("a fix");
    let rewritten = apply(&source, &fix);
    assert!(rewritten.contains("reason: <`Pass Reason`> \"why\""), "{rewritten}");
    let remaining = check_all(&rewritten, serde_json::json!({}));
    assert!(remaining.iter().all(|d| d.severity == Some(movement_checker::Severity::Info)), "{rewritten}\n{remaining:?}");
}

#[test]
fn a_librarys_fix_is_not_carried_to_the_import_that_surfaces_it() {
    let library = format!("{PRELUDE}export function go(m: <chat-[:message]->>) {{\n  found = extract \"careful\" from [m.Text] {{ reason: \"why\" }}\n}}");
    let files = serde_json::json!({ "lib/go": { "source": library } });

    let importer = "import { go } from \"lib/go\"\nx = 1";
    let surfaced: Vec<Diagnostic> = check_all(importer, files.clone()).into_iter().filter(|d| d.code == "MOV_EXTRACT_KEYWORD_RETIRED").collect();
    assert_eq!(surfaced.len(), 1);
    assert_eq!(surfaced[0].span.start.line, 1);
    assert!(surfaced[0].message.starts_with("\"lib/go\" line "), "{}", surfaced[0].message);
    assert!(surfaced[0].fix.is_none());

    let own: Vec<Diagnostic> = check_all(&library, serde_json::json!({})).into_iter().filter(|d| d.code == "MOV_EXTRACT_KEYWORD_RETIRED").collect();
    assert!(own[0].fix.is_some());
}

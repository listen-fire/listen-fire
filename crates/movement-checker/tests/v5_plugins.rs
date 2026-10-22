//! A plugin's arguments by position (design §2.7),
//! through the Rust checker: its required inputs in the manifest's order,
//! then one settings record; the named form is refused with the positional
//! rewrite. The TypeScript twin is
//! lf-platform's packages/legacy-lang/checker/__test__/v5_plugins.unit.test.ts.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{},"credentials":{},"plugins":{
  "fetch_url":{"args":["url","email"],"priced":false,"requiredArgs":["url"],"argTypes":{"url":"text","email":"text"},"effects":{},"output":{"kind":"value","type":"text"}},
  "research":{"args":["name","context","questions"],"priced":false,"requiredArgs":["name"],"argTypes":{"name":"text","context":"text","questions":"text"},"effects":{},"output":{"kind":"record","fields":{"summary":"text"}}},
  "vc_url_retrieval":{"args":["email"],"priced":false,"fedArgs":[{"name":"text","required":true}],"argTypes":{"text":"text","email":"text"},"effects":{},"output":{"kind":"value","type":"text"}},
  "linkedin_enrichment":{"args":["depth"],"priced":false,"fedArgs":[{"name":"text","required":true}],"requiredArgs":["depth"],"argTypes":{"depth":"number"}}
}}"#;

const HEAD5: &str = "import { fetchUrl, research, vcUrlRetrieval } from plugins\n\n";

fn check(source: &str) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.is_error()).collect()
}

fn codes(source: &str) -> Vec<String> {
    check(source).into_iter().map(|d| d.code).collect()
}

fn current_form(body: &str) -> String {
    format!("{HEAD5}function go(u: <text>, n: <text>, s: <text>, t: <text>) {{\n{body}\n}}\n")
}

/// The source with each diagnostic's fix applied (ASCII text: a column is a character).
fn apply_fixes(source: &str, diagnostics: &[Diagnostic]) -> String {
    let lines: Vec<&str> = source.split('\n').collect();
    let offset = |line: u64, col: u64| lines[..line as usize - 1].iter().map(|l| l.len() + 1).sum::<usize>() + col as usize - 1;
    let mut edits: Vec<(usize, usize, String)> = diagnostics
        .iter()
        .filter_map(|d| d.fix.as_ref())
        .flat_map(|fix| fix["edits"].as_array().unwrap().clone())
        .map(|edit| {
            let at = |end: &str| offset(edit["span"][end]["line"].as_u64().unwrap(), edit["span"][end]["col"].as_u64().unwrap());
            (at("start"), at("end"), edit["text"].as_str().unwrap().to_string())
        })
        .collect();
    edits.sort_by_key(|e| std::cmp::Reverse(e.0));
    let mut out = source.to_string();
    for (start, end, text) in edits {
        out.replace_range(start..end, &text);
    }
    out
}

#[test]
fn a_plugin_takes_its_required_inputs_by_position_and_the_rest_in_a_settings_record() {
    let program = current_form("  p = fetchUrl(u)\n  r = research(n, { context: s, questions: s })\n  v = vcUrlRetrieval(t, { email: u })\n  w = fetchUrl(u, { email: s })");
    assert_eq!(check(&program), Vec::<Diagnostic>::new());
    // A bare statement, a call as another's argument, and one nested in an expression.
    let nested = current_form("  fetchUrl(u)
  r = research(fetchUrl(u), { context: s })
  x = Text.length(fetchUrl(u)) + 1");
    assert_eq!(check(&nested), Vec::<Diagnostic>::new());
    assert_eq!(codes(&current_form("  x = Text.upper(fetchUrl(u, s))")), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
}

#[test]
fn the_bound_call_is_checked_as_the_named_one_is() {
    // Too many by position, a setting that is positional, an unknown setting,
    // a last extra argument that is no record, a missing input.
    assert_eq!(codes(&current_form("  p = fetchUrl(u, { url: s })")), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&current_form("  r = research(n, { nope: s })")), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&current_form("  p = fetchUrl(u, s)")), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&current_form("  p = fetchUrl(u, { email: s }, s)")), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(codes(&current_form("  r = research()")), vec!["MOV_THROUGH_ARG_MISSING".to_string()]);
    let missing_fed = check(&current_form("  v = vcUrlRetrieval()"));
    assert_eq!(missing_fed.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["MOV_PLUGIN_FED_BY_EXTRACTION"]);
    assert!(missing_fed[0].message.contains("`vcUrlRetrieval(text)`"), "{}", missing_fed[0].message);
    // Each value is held to the type declared for the parameter it binds.
    assert_eq!(codes(&current_form("  r = research(n)\n  p = fetchUrl(r)")), vec!["MOV_CALL_ARG_TYPE".to_string()]);
    assert_eq!(codes(&current_form("  r = research(n)\n  p = fetchUrl(u, { email: r })")), vec!["MOV_CALL_ARG_TYPE".to_string()]);
    let extra = check(&current_form("  p = fetchUrl(u, s)"));
    assert_eq!(extra[0].message, "'fetchUrl' takes one argument by position (url), then its settings as one record `{ name: value }` — this argument is past them");
    assert_eq!((extra[0].span.start.line, extra[0].span.start.col), (4, 19));
    let past = check(&current_form("  p = fetchUrl(u, { email: s }, s)"));
    assert_eq!((past[0].span.start.col, past[0].span.end.col), (33, 34));
}

#[test]
fn a_settings_entry_is_reported_where_it_is_written() {
    let found = check(&current_form("  r = research(n, { context: s, name: s })"));
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].message, "'name' is an argument 'research' takes by position — write it in its place, not in the settings record");
    assert_eq!((found[0].span.start.line, found[0].span.start.col, found[0].span.end.col), (4, 33, 37));
    let typed = check(&current_form("  r = research(n)\n  q = research(n, { context: r })"));
    assert_eq!(typed.iter().map(|d| (d.code.as_str(), d.span.start.line, d.span.start.col)).collect::<Vec<_>>(), vec![("MOV_CALL_ARG_TYPE", 5, 30)]);
}

#[test]
fn the_named_form_under_5_is_rewritten_by_position_from_the_manifest() {
    let fixes_of = |source: &str| -> Vec<(Option<String>, bool)> {
        check(source)
            .into_iter()
            .filter(|d| d.code == "MOV_V5_SPELLING")
            .map(|d| {
                let text = d.fix.as_ref().map(|f| f["edits"][0]["text"].as_str().unwrap().to_string());
                (text, d.fix.as_ref().is_some_and(|f| f.get("safe") == Some(&serde_json::json!(true))))
            })
            .collect()
    };
    assert_eq!(fixes_of(&current_form("  p = fetchUrl(url: u)")), vec![(Some("u".to_string()), true)]);
    assert_eq!(fixes_of(&current_form("  r = research(name: n, context: s)")), vec![(Some("n, { context: s }".to_string()), true)]);
    assert_eq!(fixes_of(&current_form("  v = vcUrlRetrieval(text: t, email: u)")), vec![(Some("t, { email: u }".to_string()), true)]);
    // Moved, the arguments would run in another order: a fix, not a safe one.
    assert_eq!(fixes_of(&current_form("  r = research(context: s, name: n)")), vec![(Some("n, { context: s }".to_string()), false)]);
    // A name the manifest does not know, or an input never written: no rewrite.
    assert_eq!(fixes_of(&current_form("  r = research(name: n, nope: s)")), vec![(None, false)]);
    assert_eq!(fixes_of(&current_form("  r = research(context: s)")), vec![(None, false)]);
}

#[test]
fn the_rewrite_applied_checks_clean() {
    let program = current_form("  p = fetchUrl(url: u)\n  r = research(name: n, context: s, questions: t)\n  v = vcUrlRetrieval(text: t, email: u)");
    let fixed = apply_fixes(&program, &check(&program));
    assert!(fixed.contains("fetchUrl(u)") && fixed.contains("research(n, { context: s, questions: t })") && fixed.contains("vcUrlRetrieval(t, { email: u })"), "{fixed}");
    assert_eq!(check(&fixed), Vec::<Diagnostic>::new());
}

fn stage(through: &str) -> String {
    format!(
        "import {{ research, linkedinEnrichment }} from plugins\n\nfunction go(u: <text>, n: <text>, s: <text>) {{\n  found = extract from [u] {{\n    name: \"the name\"\n  }} through [{through}] {{\n    detail: \"more\"\n  }}\n}}\n"
    )
}

/// A `through` stage's own checks, beside the keyword's retirement under 5
/// (MOV_EXTRACT_KEYWORD_RETIRED, which has no rewrite for a stage).
fn stage_diagnostics(found: Vec<Diagnostic>) -> Vec<Diagnostic> {
    found.into_iter().filter(|d| d.code != "MOV_EXTRACT_KEYWORD_RETIRED").collect()
}

fn stage_codes(source: &str) -> Vec<String> {
    stage_diagnostics(check(source)).into_iter().map(|d| d.code).collect()
}

#[test]
fn a_through_stage_takes_its_arguments_by_position_too() {
    assert_eq!(stage_diagnostics(check(&stage("linkedinEnrichment(2)"))), Vec::<Diagnostic>::new());
    assert_eq!(stage_diagnostics(check(&stage("research(n, { context: s })"))), Vec::<Diagnostic>::new());
    assert_eq!(stage_diagnostics(check(&stage("linkedinEnrichment"))).iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), vec!["MOV_THROUGH_ARG_MISSING"]);
    // A stage is never fed by its author: the fed input is no positional parameter.
    assert_eq!(stage_codes(&stage("linkedinEnrichment(u, 2)")), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
    assert_eq!(stage_codes(&stage("research(n, { name: s })")), vec!["MOV_THROUGH_BAD_ARG".to_string()]);
}

#[test]
fn a_through_stage_s_named_arguments_under_5_are_rewritten_by_position() {
    let program = stage("research(name: n, context: s)");
    let found = stage_diagnostics(check(&program));
    let fixes: Vec<_> = found.iter().filter(|d| d.code == "MOV_V5_SPELLING").map(|d| d.fix.as_ref().map(|f| f["edits"][0]["text"].clone())).collect();
    assert_eq!(fixes, vec![Some(serde_json::json!("n, { context: s }"))]);
    assert_eq!(stage_diagnostics(check(&apply_fixes(&program, &found))), Vec::<Diagnostic>::new());
}

fn all(source: &str) -> Vec<(String, bool, String)> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &catalog, options).unwrap().into_iter().map(|d| (d.code.clone(), d.is_error(), d.message)).collect()
}

#[test]
fn a_record_value_handed_to_a_text_input_is_refused() {
    let refused = all(&current_form("  r = research({ context: s })"));
    assert_eq!(
        refused,
        vec![(
            "MOV_CALL_ARG_MAYBE_RECORD".to_string(),
            true,
            "'research' takes text for 'name', and this is { context: text } — a record, not text, as in TypeScript. Pass the text it should read: one of its fields ('name: r.name'), or the text built from them".to_string()
        )]
    );
    let may = codes(&current_form("  r = research(n, { context: s == \"\" ? { a: 1 } : s })"));
    assert_eq!(may, vec!["MOV_CALL_ARG_MAYBE_RECORD".to_string()]);
    assert_eq!(codes(&current_form("  r = research(n, { context: s })")), Vec::<String>::new());
}

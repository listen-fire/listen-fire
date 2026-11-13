//! A listen's filter and a wait's WHERE may call a pure function: a stdlib
//! function with no effects, or a plugin whose spec declares itself pure
//! (a host function such as `team.isMember`). Its arguments are judged as
//! the filter is: a hop's fields, literals, other pure calls. Anywhere else
//! a call nested in an expression is bound first (MOV_CALL_NESTED), and the
//! plan orders each AND and OR so a host is asked last.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::listen_plan::ListenPlan;
use movement_parser::lowering::expression::{Expression, LogicalOp};
use serde_json::json;

fn branded(brands: &[&str]) -> serde_json::Value {
    json!({ "kind": "branded", "of": "text", "brands": brands })
}

fn catalog() -> CatalogSnapshot {
    let email = branded(&["claim:email/address"]);
    let schema = json!({
        "positions": {
            "Message": {
                "properties": {
                    "Channel": "text",
                    "From": "text",
                    "User Email": email,
                    "Maybe Email": { "kind": "maybeAbsent", "of": email },
                    "Name": "text"
                },
                "propertyCapabilities": { "Channel": { "filterOperators": ["eq"] } },
                "edges": {
                    "Replies": { "target": "Message", "readable": false, "listenable": true, "delivery": "connection" }
                }
            }
        },
        "collections": {
            "Messages": { "target": "Message", "listenable": true, "delivery": "connection" },
            "Threads": { "target": "Message", "listenable": true, "delivery": "connection", "capability": { "filter": "native", "supportsLimit": false } }
        },
        "writableRoots": {}
    });
    let catalog = json!({
        "adapters": { "slack": { "canFire": true, "constructionArgs": [], "schemas": { "": schema } } },
        "credentials": {},
        "plugins": {
            "@lf-platform/team/isMember": {
                "args": ["e"], "priced": false, "requiredArgs": ["e"], "argTypes": { "e": email }, "effects": {},
                "output": { "kind": "value", "type": "boolean" }, "package": "@lf-platform/team", "name": "isMember",
                "pure": true, "maxAgeSeconds": 300
            },
            "@lf-platform/team/isGuest": {
                "args": ["e"], "priced": false, "requiredArgs": ["e"], "argTypes": { "e": email }, "effects": {},
                "output": { "kind": "value", "type": "boolean" }, "package": "@lf-platform/team", "name": "isGuest"
            }
        }
    });
    CatalogSnapshot::load(&catalog.to_string()).unwrap()
}

const PRELUDE: &str = "import { `@lf-platform/team` as t } from plugins\nimport { slack } from adapters\ns = connect slack\nfunction f(m: <s-[:Message]->>) { return m.Name }\n";

fn options() -> CheckOptions<'static> {
    CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones }
}

/// Every error (a warning is not one).
fn errors_of(source: &str) -> Vec<Diagnostic> {
    let source = format!("{PRELUDE}{source}");
    check_source(&source, &catalog(), options()).unwrap_or_else(|e| panic!("{source}: {e:?}")).into_iter().filter(|d| d.is_error()).collect()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

fn listen(filter: &str) -> Vec<Diagnostic> {
    errors_of(&format!("listen to s-[m:Messages WHERE {filter}]-> fire f\n"))
}

/// The errors of a run that waits for a reply to the message it was fired with.
fn wait(filter: &str) -> Vec<Diagnostic> {
    errors_of(&format!("function go(p: <s-[:Message]->>) {{\n  r = await new p-[x:Replies WHERE {filter}]->\n  return r.Name\n}}\n"))
}

fn plans_of(filter: &str) -> Vec<ListenPlan> {
    plans_on("Messages", filter)
}

fn plans_on(collection: &str, filter: &str) -> Vec<ListenPlan> {
    let source = format!("{PRELUDE}listen to s-[m:{collection} WHERE {filter}]-> fire f\n");
    let program = movement_parser::stmt::parse_program(&source, false).unwrap_or_else(|e| panic!("{source}: {}", e.message));
    let answer = movement_checker::answer::check_answer(&program, &catalog(), options());
    let errors: Vec<_> = answer.diagnostics.iter().filter(|d| d.is_error()).map(|d| d.code.clone()).collect();
    assert_eq!(errors, Vec::<String>::new(), "{source}");
    answer.listens
}

#[test]
fn a_pure_plugin_call_checks_in_a_listen_filter() {
    let found = listen("m.Channel == \"C1\" AND t.isMember(m.`User Email`)");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:#?}");
}

#[test]
fn an_impure_plugin_in_a_filter_is_refused() {
    let found = listen("m.Channel == \"C1\" AND t.isGuest(m.`User Email`)");
    assert_eq!(codes(&found), ["MOV_LISTEN_IMPURE_WHERE"], "{found:#?}");
    assert!(found[0].message.contains("'t.isGuest' does not declare itself pure"), "{}", found[0].message);
}

#[test]
fn a_stdlib_function_checks_in_a_listen_filter() {
    let found = listen("Text.regexExtract(m.From, \"@([^@]+)$\", 1) == \"acme.com\"");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:#?}");
    let found = listen("m.Channel == \"C1\" AND Text.lower(m.Name) == \"deals\"");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:#?}");
    // A function with an effect stays refused: `Date.today` reads the clock.
    let found = listen("Text.concat(m.Name, Date.today(\"UTC\")) == \"x\"");
    assert_eq!(codes(&found), ["MOV_LISTEN_IMPURE_WHERE"], "{found:#?}");
}

#[test]
fn a_pure_call_reads_only_what_the_filter_may() {
    // An argument of a pure call is judged as the filter is: a name the run
    // binds is not a hop.
    let found = errors_of("e = \"x\"\nlisten to s-[m:Messages WHERE Text.lower(e) == \"deals\"]-> fire f\n");
    assert_eq!(codes(&found), ["MOV_LISTEN_IMPURE_WHERE"], "{found:#?}");
    assert!(found[0].message.contains("'e' is neither"), "{}", found[0].message);
    // An impure call nested in a pure one is refused by its own name.
    let found = listen("t.isMember(Text.concat(m.Name, Date.today(\"UTC\"))) == true");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED", "MOV_LISTEN_IMPURE_WHERE"], "{found:#?}");
}

#[test]
fn the_brand_rule_holds_inside_a_filter() {
    let found = listen("t.isMember(m.From)");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
    let found = listen("t.isMember(\"a@x.com\")");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
    // An operation drops the brand.
    let found = listen("t.isMember(Text.lower(m.`User Email`))");
    assert_eq!(codes(&found), ["MOV_BRAND_REQUIRED"], "{found:#?}");
}

#[test]
fn a_maybe_absent_claim_must_be_narrowed_before_a_pure_call() {
    let found = listen("t.isMember(m.`Maybe Email`)");
    assert_eq!(codes(&found), ["MOV_ABSENT_REQUIRED"], "{found:#?}");
    assert!(found[0].message.contains("may be missing"), "{}", found[0].message);
    let found = listen("m.`Maybe Email` != null AND t.isMember(m.`Maybe Email`)");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:#?}");
}

#[test]
fn a_pure_call_checks_in_a_wait_where() {
    let found = wait("x.Channel == \"C1\" AND t.isMember(x.`User Email`)");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:#?}");
    let found = wait("Text.lower(x.Name) == \"yes\"");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:#?}");
    let found = wait("t.isGuest(x.`User Email`)");
    assert_eq!(codes(&found), ["MOV_AWAIT_IMPURE_WHERE"], "{found:#?}");
    assert!(found[0].message.contains("'t.isGuest', which does not declare itself pure"), "{}", found[0].message);
    assert_eq!(codes(&wait("t.isMember(x.`Maybe Email`)")), ["MOV_ABSENT_REQUIRED"]);
    let found = wait("x.`Maybe Email` != null AND t.isMember(x.`Maybe Email`)");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:#?}");
}

#[test]
fn a_call_outside_a_filter_still_binds_first() {
    // A run's walk reads its WHERE once per landing, so a call there is
    // bound first, pure or not.
    let found = errors_of("function go() {\n  xs = s-[m:Messages WHERE t.isMember(m.`User Email`)]->\n  return xs\n}\n");
    assert_eq!(codes(&found), ["MOV_CALL_NESTED"], "{found:#?}");
    let found = errors_of("function go() {\n  xs = s-[m:Messages WHERE m.Channel == \"C1\"]->-[x:Replies WHERE t.isMember(x.`User Email`)]->\n  return xs\n}\n");
    assert!(codes(&found).contains(&"MOV_CALL_NESTED"), "{found:#?}");
    // A wait judges only the hop it waits on.
    let found = errors_of("function go(c: <s-[:Message]->>) {\n  r = await new c-[x:Replies WHERE x.Name == \"y\"]->\n  xs = s-[m:Messages WHERE t.isMember(m.`User Email`)]->\n  return xs\n}\n");
    assert_eq!(codes(&found), ["MOV_CALL_NESTED"], "{found:#?}");
    // A call in a value's expression is run first and its answer read in
    // its place, as before.
    let found = errors_of("function go(e: <text & Brand<\"claim:email/address\">>) {\n  x = t.isMember(e) == true\n  return x\n}\n");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:#?}");
}

/// The top-level terms of `filter` as the plan keeps them: its operands when
/// it is an AND, else itself.
fn terms(filter: &Expression) -> Vec<String> {
    match filter {
        Expression::Logical { op: LogicalOp::And, operands } => operands.iter().map(|o| movement_checker::families::filter_split::spell(o, Some("m"))).collect(),
        other => vec![movement_checker::families::filter_split::spell(other, Some("m"))],
    }
}

#[test]
fn host_calls_are_ordered_last() {
    let plans = plans_of("t.isMember(m.`User Email`) AND m.Channel == \"C1\"");
    let hop = &plans[0].hops[0];
    let checked = hop.checked.as_ref().expect("the host checks the filter");
    // The plan names the plugin by its catalog key, which is what the host
    // invokes: the program's name for it is the program's alone.
    assert_eq!(terms(checked), ["m.Channel == \"C1\"", "@lf-platform/team/isMember(m.`User Email`)"]);
    assert!(hop.asks_host, "{hop:#?}");
    // An OR is ordered alike, inside an AND.
    let plans = plans_of("(t.isMember(m.`User Email`) OR m.Name == \"ann\") AND m.Channel == \"C1\"");
    let checked = plans[0].hops[0].checked.as_ref().unwrap();
    assert_eq!(terms(checked), ["m.Channel == \"C1\"", "m.Name == \"ann\" OR @lf-platform/team/isMember(m.`User Email`)"]);
    // Terms that ask no host keep the order they were written in.
    let plans = plans_of("m.Name == \"ann\" AND t.isMember(m.`User Email`) AND m.Channel == \"C1\"");
    let checked = plans[0].hops[0].checked.as_ref().unwrap();
    assert_eq!(terms(checked), ["m.Name == \"ann\"", "m.Channel == \"C1\"", "@lf-platform/team/isMember(m.`User Email`)"]);
    // A stdlib call is evaluated by the judge, and asks no host.
    let plans = plans_of("Text.lower(m.Name) == \"deals\"");
    assert!(!plans[0].hops[0].asks_host, "{:#?}", plans[0].hops[0]);
    // A plan whose filter asks no host says nothing of it.
    let plans = plans_of("m.Channel == \"C1\"");
    assert!(serde_json::to_value(&plans[0]).unwrap()["hops"][0].get("asksHost").is_none());
    let plans = plans_of("t.isMember(m.`User Email`)");
    assert_eq!(serde_json::to_value(&plans[0]).unwrap()["hops"][0]["asksHost"], json!(true));
}


#[test]
fn a_call_is_never_taken_by_the_module() {
    let plans = plans_on("Threads", "t.isMember(m.`User Email`) AND Text.lower(m.Name) == \"ann\" AND m.Channel == \"C1\"");
    let hop = &plans[0].hops[0];
    let spelled = |e: &Option<Expression>| e.as_ref().map(terms).unwrap_or_default();
    assert_eq!(spelled(&hop.taken), ["m.Channel == \"C1\""]);
    assert_eq!(spelled(&hop.checked), ["Text.lower(m.Name) == \"ann\"", "@lf-platform/team/isMember(m.`User Email`)"]);
    assert!(hop.asks_host);
}

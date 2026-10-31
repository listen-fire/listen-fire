//! What 0.13 retires is refused where it is written, naming what replaces it.
//! `callback(…)` gives way to a form from the `@lf/forms` adapter and to
//! buttons written on a message: one MOV_CALLBACK_RETIRED per `callback(…)`,
//! and the binding keeps its old type, so its `.id`, `.url` and `Called`
//! edge raise nothing more.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const EMPTY: &str = r#"{"adapters":{},"credentials":{},"plugins":{}}"#;

const RETIRED: &str = "'callback(…)' is retired in 0.13. For a form a person opens, connect `@lf/forms` and write one: `form = write forms-[:Forms]-> { Title: …, Fields: … }`, send `form.Url`, and `await form-[:Submissions]->`. For buttons, write them on the message (`Buttons: [{ Text: …, Value: … }]`) and `await msg-[:Interactions]->`.";

/// The handbook section a refusal points to.
const SEE: &str = " (see handbook: reviews#waiting-on-a-person)";

const MANY: &str = " Many answers in one run (`once: false`) become a standing `listen` on the message's `Interactions` (from the listen half of 0.13) that keeps its state in a table.";

/// Every diagnostic on `source`, as `"CODE l:c-l:c message"`.
fn found(source: &str) -> Vec<String> {
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(source, &CatalogSnapshot::load(EMPTY).unwrap(), options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .map(|d| format!("{} {}:{}-{}:{} {}", d.code, d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col, d.message))
        .collect()
}

#[test]
fn a_callback_is_refused_once_naming_the_forms_adapter_and_buttons() {
    let inline = "function ask(t: <text>) {\n  go = callback({ })\n  m = \"${go.id} ${go.url} ${t}\"\n  c = await go-[:Called]->\n  return \"${m} ${c.At}\"\n}\n";
    assert_eq!(found(inline), [format!("MOV_CALLBACK_RETIRED 2:8-2:21 {RETIRED}{SEE}")]);
    let with_values = "function ask() {\n  go = callback((note: <text>) => { })\n  c = await go-[:Called]->\n  return c.note\n}\n";
    assert_eq!(found(with_values), [format!("MOV_CALLBACK_RETIRED 2:8-2:39 {RETIRED}{SEE}")]);
    let named = "function book(name: <text>, day: <date>) {\n  return \"${name} ${day}\"\n}\n\nfunction offer() {\n  pick = callback(book)\n  c = await pick-[:Called]->\n  return \"${pick.url} ${c.day}\"\n}\n";
    assert_eq!(found(named), [format!("MOV_CALLBACK_RETIRED 6:10-6:24 {RETIRED}{SEE}")]);
    let two = "function ask() {\n  a = callback({ })\n  b = callback({ })\n  return \"${a.url} ${b.url}\"\n}\n";
    assert_eq!(found(two), [format!("MOV_CALLBACK_RETIRED 2:7-2:20 {RETIRED}{SEE}"), format!("MOV_CALLBACK_RETIRED 3:7-3:20 {RETIRED}{SEE}")]);
}

#[test]
fn once_false_adds_its_replacement_and_a_ttl_adds_nothing() {
    let config = |settings: &str| format!("function ask() {{\n  go = callback({{ }}, {settings})\n  return go.url\n}}\n");
    let many = found(&config("{ once: false }"));
    assert_eq!(many.len(), 1, "{many:?}");
    assert!(many[0].ends_with(&format!("{RETIRED}{MANY}{SEE}")), "{many:?}");
    let expiring = found(&config("{ ttl: 4h }"));
    assert_eq!(expiring.len(), 1, "{expiring:?}");
    assert!(expiring[0].ends_with(&format!("{RETIRED}{SEE}")), "a form has no expiry, a timeout is the program's race with sleep: {expiring:?}");
    let both = found(&config("{ once: false, ttl: 4h }"));
    assert!(both[0].ends_with(&format!("{RETIRED}{MANY}{SEE}")), "{both:?}");
    let once = found(&config("{ once: true }"));
    assert!(once[0].ends_with(&format!("{RETIRED}{SEE}")), "{once:?}");
}

#[test]
fn it_is_an_error_whatever_the_pin() {
    let source = "function ask() {\n  go = callback({ })\n  return go.url\n}\n";
    for pin in [None, Some("0.12.13")] {
        let options = CheckOptions { upgrading_from: pin, zones: &movement_checker::host::native::NativeZones };
        let told = check_source(source, &CatalogSnapshot::load(EMPTY).unwrap(), options).unwrap();
        assert_eq!(told.len(), 1, "{told:?}");
        assert_eq!(told[0].code, "MOV_CALLBACK_RETIRED");
        assert!(told[0].severity.is_none(), "an error carries no severity: {:?}", told[0]);
        assert!(told[0].fix.is_none(), "replaced by hand: {:?}", told[0]);
    }
}

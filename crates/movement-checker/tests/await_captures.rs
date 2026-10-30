//! A wait's WHERE reads a run record's field once, when the wait is reached
//! (0.13); under an older pin it was read again at every check. A check for
//! an upgrade from such a pin says so on each wait this changes
//! (MOV_AWAIT_VALUE_CAPTURED, a warning with nothing to rewrite).

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{
  "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Person":{"properties":{"Email":"text","Name":"text"},"edges":{}}},
    "collections":{"People":{"target":"Person"}},"writableRoots":{}}}},
  "mail":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Message":{"properties":{"To":"text","Title":"text","From":"text","Sent":"text"},"edges":{
      "Replies":{"target":"Message","listenable":true,"sequenced":"chronological","identity":"Sent"}}}},
    "collections":{"Messages":{"target":"Message"}},
    "writableRoots":{"Message":{"fields":{"To":"text"},"resultShape":{"externalId":"text"}}}}}}
},"credentials":{},"plugins":{}}"#;

/// Every diagnostic on `body`, the body of a function taking a text `t` and
/// a person `p`, whose first line is line 2, checked as an upgrade from `pin` if given.
fn found(body: &str, pin: Option<&str>) -> Vec<String> {
    let source = format!(
        "import {{ crm as crm_module, mail as mail_module }} from adapters; crm = connect crm_module; mail = connect mail_module; function go(t: <text>, p: <crm-[:People]->>) {{\n{body}}}\n"
    );
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: pin, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .map(|d| {
            let severity = if d.is_error() { "error" } else { "warning" };
            let upgrade = if d.upgrade == Some(true) { " (upgrade)" } else { "" };
            format!("{} {severity}{upgrade} {}:{} {}", d.code, d.span.start.line, d.span.start.col, d.message)
        })
        .collect()
}

const WAIT_ON_FOUNDER: &str =
    "  founder = only(crm-[:People]->)\n  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE x.From == founder.Email]->\n";

#[test]
fn a_wait_reading_a_run_record_is_told_its_value_is_captured_when_upgrading() {
    assert_eq!(
        found(WAIT_ON_FOUNDER, Some("0.12.13")),
        ["MOV_AWAIT_VALUE_CAPTURED warning (upgrade) 4:13 'founder.Email' in this wait's WHERE is read once, when the wait is reached (0.13); under 0.12.13 it was read again at every check, so a change while the run waited changed what the wait accepted. Nothing to rewrite unless the wait should follow the live value: then test it after the wait against `refresh(founder)`"]
    );
    assert_eq!(found(WAIT_ON_FOUNDER, None), Vec::<String>::new());
}

#[test]
fn a_pin_of_this_release_is_not_told() {
    assert_eq!(found(WAIT_ON_FOUNDER, Some(movement_parser::version::LANGUAGE_VERSION)), Vec::<String>::new());
}

#[test]
fn a_plain_value_or_a_literal_is_not_reported() {
    let body = "  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE x.Title == t AND x.From == \"a@b.c\"]->\n";
    assert_eq!(found(body, Some("0.12.13")), Vec::<String>::new());
}

#[test]
fn each_part_reading_a_run_record_is_told_once() {
    let body = "  founder = only(crm-[:People]->)\n  m = write mail-[:Messages]-> { To: t }\n  r = await new m-[x:Replies WHERE x.From == founder.Email OR x.Title == founder.Name OR x.To == founder.Email]->\n";
    let told: Vec<String> = found(body, Some("0.12.13")).into_iter().map(|d| d.split(" in this wait").next().unwrap().to_string()).collect();
    assert_eq!(told, ["MOV_AWAIT_VALUE_CAPTURED warning (upgrade) 4:17 'founder.Email'", "MOV_AWAIT_VALUE_CAPTURED warning (upgrade) 4:17 'founder.Name'"]);
}

#[test]
fn a_part_computed_from_a_run_record_names_the_record_it_reads() {
    let body = "  founder = only(crm-[:People]->)\n  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE x.Title == \"Re: ${founder.Name}\"]->\n";
    let told: Vec<String> = found(body, Some("0.12.13")).into_iter().map(|d| d.split(" in this wait").next().unwrap().to_string()).collect();
    assert_eq!(told, ["MOV_AWAIT_VALUE_CAPTURED warning (upgrade) 4:13 'founder.Name'"]);
}

#[test]
fn a_record_a_parameter_holds_is_a_run_record() {
    let body = "  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE x.From == p.Email]->\n";
    let told: Vec<String> = found(body, Some("0.12.13")).into_iter().map(|d| d.split(" in this wait").next().unwrap().to_string()).collect();
    assert_eq!(told, ["MOV_AWAIT_VALUE_CAPTURED warning (upgrade) 3:13 'p.Email'"]);
}

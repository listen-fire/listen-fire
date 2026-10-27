//! A listen that declares what its events are (`payload: <Payment>`, a key
//! of the catalog's `type` format): the node the program declares types the
//! event, and the movement it fires is checked against it as a parameter is
//! against its argument.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"webhook":{"canFire":true,"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"triggerConfig":["payload"],"triggerConfigRequired":["payload"],"triggerConfigFormats":{"payload":"type"},"schemas":{"StripeHook":{"positions":{"Delivery":{"properties":{},"edges":{},"undescribed":true}},"collections":{},"writableRoots":{},"eventPosition":"Delivery","eventPositions":[{"position":"Delivery"}]}}},"feed":{"constructionArgs":[],"canFire":true,"triggerConfig":["table"],"schemas":{}}},"credentials":{"StripeHook":{"adapters":["webhook"]}},"plugins":{}}"#;

const HEAD: &str = "import { webhook, feed } from adapters\nimport { StripeHook } from credentials\nstripe = connect webhook using StripeHook\nnode Payment {\n  id: <text>\n  amount: <number>\n}\n";

fn check(rest: &str) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&format!("{HEAD}{rest}"), &catalog, options).unwrap()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

fn fired(param: &str, body: &str, config: &str) -> Vec<Diagnostic> {
    check(&format!("function `Payment Failed`(e: {param}) {{\n{body}\n}}\nlisten to stripe {{ {config} }} fire `Payment Failed`\n"))
}

#[test]
fn a_declared_payload_types_the_event_and_the_movement_reads_its_fields() {
    let found = fired("<Payment>", "  x = e.amount + 1\n  y = e.id", "payload: <Payment>");
    assert_eq!(codes(&found), Vec::<&str>::new(), "{found:?}");
}

#[test]
fn a_field_the_declaration_lacks_is_refused_where_it_is_read() {
    let found = fired("<Payment>", "  x = e.nope", "payload: <Payment>");
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"]);
    assert!(found[0].message.contains("has no field 'nope' — it has: id, amount"), "{}", found[0].message);
}

#[test]
fn the_parameter_is_checked_against_the_declared_payload() {
    let refund = "node Refund {\n  amount: <number>\n  reason: <text>\n}\n";
    let found = check(&format!("{refund}function `Payment Failed`(e: <Refund>) {{\n}}\nlisten to stripe {{ payload: <Payment> }} fire `Payment Failed`\n"));
    assert_eq!(codes(&found), ["MOV_LISTEN_SHAPE_MISMATCH"]);
    assert!(found[0].message.contains("has no field `reason` that the declaration 'Refund' requires"), "{}", found[0].message);

    let narrower = "node Amount {\n  amount: <number>\n}\n";
    let found = check(&format!("{narrower}function `Payment Failed`(e: <Amount>) {{\n  x = e.amount\n}}\nlisten to stripe {{ payload: <Payment> }} fire `Payment Failed`\n"));
    assert_eq!(codes(&found), Vec::<&str>::new(), "a parameter asking for less than the payload carries is satisfied: {found:?}");
}

#[test]
fn a_parameter_typed_as_the_connections_event_is_told_to_take_the_payload() {
    let found = fired("<stripe-[:Delivery]->>", "", "payload: <Payment>");
    assert_eq!(codes(&found), ["MOV_LISTEN_PARAM_MISMATCH"]);
    assert!(found[0].message.contains("type the parameter as it: 'e: <Payment>'"), "{}", found[0].message);
}

#[test]
fn a_payload_that_is_not_a_declared_node_is_refused_by_what_it_is() {
    let message = |config: &str| {
        let found = fired("<Payment>", "", config);
        let refused: Vec<&Diagnostic> = found.iter().filter(|d| d.code == "MOV_LISTEN_BAD_CONFIG").collect();
        assert_eq!(refused.len(), 1, "{config}: {found:?}");
        refused[0].message.clone()
    };
    assert!(message("payload: \"Payment\"").contains("'payload' takes a node the program declares, as a type — e.g. `payload: <Payment>`"));
    assert!(message("payload: <text>").contains("not the value type '<text>'"));
    assert!(message("payload: <Paymnt>").contains("no node 'Paymnt' is declared"));
    assert!(message("payload: <stripe>").contains("'stripe' is "));
}

#[test]
fn a_missing_payload_is_refused_with_the_type_form() {
    let found = fired("<Payment>", "", "");
    let refused: Vec<&Diagnostic> = found.iter().filter(|d| d.code == "MOV_LISTEN_BAD_CONFIG").collect();
    assert_eq!(refused.len(), 1, "{found:?}");
    assert!(refused[0].message.contains("payload: <Payment>"), "{}", refused[0].message);
}

#[test]
fn a_key_of_another_format_still_takes_a_plain_value() {
    let found = check("function seen() {\n}\nf = connect feed\nlisten to f { table: <Payment> } fire seen\n");
    assert!(found.iter().any(|d| d.code == "MOV_LISTEN_BAD_CONFIG" && d.message.contains("takes a plain value")), "{found:?}");
}

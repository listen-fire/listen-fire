//! A type's address names a position in the graph, or it is refused where it
//! is written: an address that names nothing used to leave the parameter
//! untyped, so every read off it went unchecked. The catalog is a base, as
//! the host narrows one: its events narrowed by `table`, one table grafted
//! under the address that pins it, and a `Deals` collection.

use movement_checker::{CheckOptions, Diagnostic, Severity, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const GRAFTED: &str = r#"["Record Change",[["table","tblDEALS"]]]"#;

fn catalog(published: bool) -> String {
    let values = if published { r#","eventNarrowingValues":{"[]":{"table":["tblDEALS"]}}"# } else { "" };
    format!(
        r#"{{"adapters":{{"base":{{"canFire":true,"constructionArgs":[],"schemas":{{"":{{"positions":{{
            "Deal":{{"properties":{{"Name":"text","Amount":"number"}},"edges":{{}}}},
            "Record Change":{{"properties":{{"table":"text"}},"edges":{{}}}},
            {GRAFTED:?}:{{"properties":{{"table":"text"}},"edges":{{"Record":{{"target":"Deal"}}}}}}
        }},"collections":{{"Deals":{{"target":"Deal"}}}},"eventPositions":[{{"position":"Record Change"}}],"eventNarrowingKeys":["table"]{values}}}}}}}}},"credentials":{{}},"plugins":{{}}}}"#
    )
}

fn check(param: &str, body: &str, published: bool) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(&catalog(published)).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let source = format!("import {{ base }} from adapters\nb = connect base\nfunction m(x: <b{param}>) {{\n  {body}\n}}\n");
    // Info notes (the function has no listener) are not what is tested.
    check_source(&source, &catalog, options).unwrap().into_iter().filter(|d| d.severity != Some(Severity::Info)).collect()
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

const READ_AMOUT: &str = "r = only(x-[:Record]->)\n  y = r.Amout";

#[test]
fn an_address_the_graph_has_types_its_record() {
    let found = check("-[e:`Record Change` WHERE e.table == \"tblDEALS\"]->", READ_AMOUT, true);
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:?}");
    assert!(found[0].message.contains("'Amout'"), "{}", found[0].message);
}

#[test]
fn an_address_pinning_a_table_nobody_lists_is_refused_where_it_is_written() {
    let found = check("-[e:`Record Change` WHERE e.table == \"Expenses\"]->", READ_AMOUT, false);
    assert_eq!(codes(&found), ["MOV_UNKNOWN_POSITION"], "{found:?}");
    assert_eq!(found[0].span.start.line, 3);
    assert_eq!(found[0].message, "'<b-[e:`Record Change` WHERE e.table == \"Expenses\"]->>' names no position: 'b' has no table \"Expenses\"");
}

#[test]
fn an_address_pinning_a_table_the_base_does_not_list_is_the_enum_refusal_alone() {
    let found = check("-[e:`Record Change` WHERE e.table == \"Expenses\"]->", "", true);
    assert_eq!(codes(&found), ["MOV_ENUM_UNKNOWN_VALUE"], "{found:?}");
}

#[test]
fn an_address_pinning_a_key_the_events_are_not_narrowed_by_is_refused() {
    let found = check("-[e:`Record Change` WHERE e.view == \"Grid\"]->", "", true);
    assert_eq!(codes(&found), ["MOV_UNKNOWN_POSITION"], "{found:?}");
    assert!(found[0].message.contains("narrows 'Record Change' by action, table, never by 'view'"), "{}", found[0].message);
}

#[test]
fn an_address_of_two_hops_is_refused() {
    let found = check("-[:Deals]->-[:Deals]->", "", true);
    assert_eq!(codes(&found), ["MOV_UNKNOWN_POSITION"], "{found:?}");
    assert!(found[0].message.contains("a type's address is one hop"), "{}", found[0].message);
}

#[test]
fn a_where_on_records_keeps_their_type() {
    assert_eq!(codes(&check("-[d:Deals WHERE d.Name == \"Acme\"]->", "y = x.Amount", true)), Vec::<&str>::new());
    assert_eq!(codes(&check("-[d:Deals WHERE d.Amount > 5]->", "y = x.Amount", true)), Vec::<&str>::new());
    let found = check("-[d:Deals WHERE d.Name == \"Acme\"]->", "y = x.Amout", true);
    assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{found:?}");
}

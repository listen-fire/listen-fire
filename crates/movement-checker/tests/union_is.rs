//! `is` narrows a value that is one of several records, as TypeScript
//! narrows `Memo | Remark`: inside `if (n is <crm-[:Memo]->>) { … }` it is the
//! Memo, and in the `else` (and each later arm) the rest of the union. The
//! value may be what lands past a union walk, a union parameter, or a conditional
//! or `COALESCE` of records. A read only some members offer, outside such a
//! test, is refused (MOV_UNION_MEMBER_ONLY), naming the test.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Person":{"properties":{"Name":"text"},"edges":{"Notes":{"target":"Memo"}}},
    "Company":{"properties":{"Name":"text"},"edges":{"Notes":{"target":"Remark"}}},
    "Memo":{"properties":{"Text":"text","Mood":"text"},"edges":{"Author":{"target":"Person"},"Pinned":{"target":"Person"}}},
    "Remark":{"properties":{"Text":"text","Tone":"text"},"edges":{"Author":{"target":"Person"}}}},
    "unions":{"Subject":["Person","Company"]},
    "collections":{"Subjects":{"target":"Subject"},"Memos":{"target":"Memo"},"Remarks":{"target":"Remark"}},
    "supportsInPlaceUpdate":true,
    "writableRoots":{"Memo":{"fields":{"Text":"text","Mood":"text"},"requiredFields":[],"resultShape":{"externalId":"text"}},
                     "Remark":{"fields":{"Text":"text","Tone":"text"},"requiredFields":[],"resultShape":{"externalId":"text"}}}}}}},
    "credentials":{},"plugins":{}}"#;

fn errors(functions: &str) -> Vec<String> {
    let source = format!("import {{ crm as m }} from adapters\ncrm = connect m\n{functions}\n");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .filter(|d| d.severity.is_none())
        .map(|d| format!("{} {}", d.code, d.message))
        .collect()
}

fn codes(found: &[String]) -> Vec<&str> {
    found.iter().map(|e| e.split(' ').next().unwrap()).collect()
}

/// `body` in a function where `n` is one of a Memo or a Remark, each way a
/// value comes to be one.
fn each_value(body: &str) -> Vec<(&'static str, String)> {
    let indented = |pad: &str| body.lines().map(|l| format!("{pad}{l}")).collect::<Vec<_>>().join("\n");
    vec![
        ("a union walk's landing", format!("function go() {{\n  crm-[:Subjects]->-[n:Notes]-> {{\n{}\n  }}\n}}", indented("    "))),
        ("a union parameter", format!("function go(n: <crm-[:Memo]-> | crm-[:Remark]->>) {{\n{}\n}}", indented("  "))),
        ("a conditional of records", format!("function go(k: <number>) {{\n  n = k > 1 ? only(crm-[:Memos]->) : only(crm-[:Remarks]->)\n{}\n}}", indented("  "))),
        ("a COALESCE of records", format!("function go() {{\n  n = coalesce(only(crm-[:Memos]->), only(crm-[:Remarks]->))\n{}\n}}", indented("  "))),
    ]
}

#[test]
fn is_narrows_the_value_to_the_member_in_the_arm_and_to_the_rest_in_the_else() {
    let body = "if (n is <crm-[:Memo]->>) {\n  mood = n.Mood\n  pinned = n-[:Pinned]->\n} else {\n  tone = n.Tone\n}\ntext = n.Text";
    for (how, functions) in each_value(body) {
        assert_eq!(errors(&functions), Vec::<String>::new(), "{how}:\n{functions}");
    }
}

#[test]
fn a_later_arm_sees_the_rest_of_the_union() {
    let body = "if (n is <crm-[:Remark]->>) {\n  tone = n.Tone\n} else if (n.Mood == \"calm\") {\n  mood = n.Mood\n}";
    for (how, functions) in each_value(body) {
        assert_eq!(errors(&functions), Vec::<String>::new(), "{how}:\n{functions}");
    }
}

#[test]
fn the_narrowed_value_reads_only_what_its_member_has() {
    for (how, functions) in each_value("if (n is <crm-[:Memo]->>) {\n  tone = n.Tone\n} else {\n  mood = n.Mood\n}") {
        assert_eq!(codes(&errors(&functions)), ["MOV_UNKNOWN_PROPERTY", "MOV_UNKNOWN_PROPERTY"], "{how}:\n{functions}");
    }
}

#[test]
fn a_member_only_read_outside_the_test_is_refused_naming_it() {
    let found = errors(&each_value("mood = n.Mood")[0].1);
    assert_eq!(codes(&found), ["MOV_UNION_MEMBER_ONLY"], "{found:?}");
    assert!(found[0].contains("Narrow it first (`if (n is <crm-[:Memo]->>) { … n.Mood … }`), or read what every one of them has"), "{}", found[0]);
}

#[test]
fn a_walk_or_a_write_off_the_narrowed_landing_is_held_to_its_member() {
    let walk = "function go() {\n  crm-[:Subjects]->-[n:Notes]-> {\n    if (n is <crm-[:Memo]->>) {\n      write n { Mood: \"calm\" }\n      p = n-[:Pinned]->\n    } else {\n      write n { Tone: \"dry\" }\n    }\n  }\n}";
    assert_eq!(errors(walk), Vec::<String>::new());
    let unnarrowed = errors("function go() {\n  crm-[:Subjects]->-[n:Notes]-> {\n    p = n-[:Pinned]->\n  }\n}");
    assert_eq!(codes(&unnarrowed), ["MOV_UNION_MEMBER_ONLY"], "{unnarrowed:?}");
    assert!(unnarrowed[0].contains("Narrow it first (`if (n is <crm-[:Memo]->>) { … n-[:Pinned]-> … }`), or walk what every one of them has"), "{}", unnarrowed[0]);
}

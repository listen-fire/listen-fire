//! A run's walk off a union whose members' edge lands on different record
//! types (a Person's `Notes` on a Memo, a Company's on a Remark) lands one of
//! them, TypeScript's `Memo | Remark`: it reads, walks and writes only what
//! every one has. Since 0.14 a step only some offer is refused
//! (MOV_UNION_MEMBER_ONLY), naming the narrowing that reaches it; 0.13 typed
//! nothing there and checked every such program clean. Each walk form: a
//! block, a bound walk, `map` over a walk, a walk inside an expression, and
//! `exists`.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Person":{"properties":{"Name":"text"},"edges":{"Notes":{"target":"Memo"}}},
    "Company":{"properties":{"Name":"text"},"edges":{"Notes":{"target":"Remark"}}},
    "Memo":{"properties":{"Text":"text","Mood":"text"},"edges":{"Author":{"target":"Person"},"Pinned":{"target":"Person"}}},
    "Remark":{"properties":{"Text":"text","Tone":"text"},"edges":{"Author":{"target":"Person"}}}},
    "unions":{"Subject":["Person","Company"]},
    "collections":{"Subjects":{"target":"Subject"}},
    "supportsInPlaceUpdate":true,
    "writableRoots":{"Memo":{"fields":{"Text":"text","Mood":"text"},"requiredFields":[],"resultShape":{"externalId":"text"}},
                     "Remark":{"fields":{"Text":"text","Tone":"text"},"requiredFields":[],"resultShape":{"externalId":"text"}}}}}}},
    "credentials":{},"plugins":{}}"#;

fn errors(body: &str) -> Vec<String> {
    let source = format!("import {{ crm as m }} from adapters\ncrm = connect m\nfunction go() {{\n{body}\n}}\n");
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

/// Each walk form, its body reading `{read}` off what lands past the union
/// (`walk` spelled from the connection), and the same form walked from a
/// Subject narrowed to a Person (`s`).
struct Form {
    name: &'static str,
    unnarrowed: fn(&str) -> String,
    narrowed: fn(&str) -> String,
}

const NARROW: &str = "  crm-[s:Subjects]-> {\n    if (s is <crm-[:Person]->>) {\n";
const CLOSE: &str = "\n    }\n  }";

const FORMS: &[Form] = &[
    Form {
        name: "block",
        unnarrowed: |read| format!("  crm-[:Subjects]->-[n:Notes]-> {{ x = n.{read} }}"),
        narrowed: |read| format!("{NARROW}      s-[n:Notes]-> {{ x = n.{read} }}{CLOSE}"),
    },
    Form {
        name: "bound walk",
        unnarrowed: |read| format!("  l = crm-[:Subjects]->-[:Notes]->\n  x = only(l).{read}"),
        narrowed: |read| format!("{NARROW}      l = s-[:Notes]->\n      x = only(l).{read}{CLOSE}"),
    },
    Form {
        name: "map over a walk",
        unnarrowed: |read| format!("  x = map(crm-[:Subjects]->-[:Notes]->, (n) => n.{read})"),
        narrowed: |read| format!("{NARROW}      x = map(s-[:Notes]->, (n) => n.{read}){CLOSE}"),
    },
    Form {
        name: "expression walk",
        unnarrowed: |read| format!("  x = only(crm-[:Subjects]->-[:Notes]->).{read}"),
        narrowed: |read| format!("{NARROW}      x = only(s-[:Notes]->).{read}{CLOSE}"),
    },
];

#[test]
fn a_field_every_landing_has_is_read_in_every_walk_form() {
    for form in FORMS {
        assert_eq!(errors(&(form.unnarrowed)("Text")), Vec::<String>::new(), "{}", form.name);
    }
}

#[test]
fn a_field_only_one_landing_has_is_refused_in_every_walk_form() {
    for form in FORMS {
        let found = errors(&(form.unnarrowed)("Mood"));
        assert_eq!(codes(&found), ["MOV_UNION_MEMBER_ONLY"], "{}: {found:#?}", form.name);
        // A value with a name is narrowed by it; one without, through the
        // record walked from.
        let narrowing = match form.name {
            "block" | "map over a walk" => "Narrow it first (`if (n is <crm-[:Memo]->>) { … n.Mood … }`)",
            _ => "Narrow the record you walk from first (`if (x is <crm-[:Person]->>) { x-[:Notes]-> … }`)",
        };
        assert_eq!(
            found[0],
            format!("MOV_UNION_MEMBER_ONLY 'Mood' can't be read here: since 0.14, what '-[:Notes]->' off crm.Subject lands is crm.Memo or crm.Remark (0.13 checked nothing there), and it reads only what every one of them has — crm.Remark refuses it (crm.Remark has no field 'Mood' — it has: Text, Tone; and edges, walked (`-[:…]->`) rather than read: Author). {narrowing}, or read what every one of them has"),
            "{}",
            form.name
        );
    }
}

#[test]
fn the_same_field_is_read_where_the_record_walked_from_is_narrowed() {
    for form in FORMS {
        assert_eq!(errors(&(form.narrowed)("Mood")), Vec::<String>::new(), "{}", form.name);
    }
}

/// 0.13 checked a field no landing has clean too: it is an unknown field.
#[test]
fn a_field_no_landing_has_is_unknown() {
    for form in FORMS {
        let found = errors(&(form.unnarrowed)("Nope"));
        assert_eq!(codes(&found), ["MOV_UNKNOWN_PROPERTY"], "{}: {found:#?}", form.name);
    }
}

#[test]
fn a_walk_on_along_an_edge_every_landing_has_is_typed() {
    assert_eq!(errors("  x = only(crm-[:Subjects]->-[:Notes]->-[:Author]->).Name"), Vec::<String>::new());
    let typo = errors("  x = only(crm-[:Subjects]->-[:Notes]->-[:Author]->).Nmae");
    assert_eq!(codes(&typo), ["MOV_UNKNOWN_PROPERTY"], "{typo:#?}");
    assert!(typo[0].contains("crm.Person has no field 'Nmae'"), "{typo:#?}");
}

#[test]
fn an_edge_only_one_landing_has_is_refused_until_narrowed() {
    for body in ["  x = only(crm-[:Subjects]->-[:Notes]->-[:Pinned]->).Name", "  x = exists(crm-[:Subjects]->-[:Notes]->-[:Pinned]->)"] {
        let found = errors(body);
        assert_eq!(codes(&found), ["MOV_UNION_MEMBER_ONLY"], "{body}: {found:#?}");
        assert!(found[0].starts_with("MOV_UNION_MEMBER_ONLY '-[:Pinned]->' can't be walked here: since 0.14,"), "{found:#?}");
        assert!(found[0].contains("Narrow the record you walk from first (`if (x is <crm-[:Person]->>) { x-[:Notes]-> … }`)"), "{found:#?}");
    }
    assert_eq!(errors("  x = exists(crm-[:Subjects]->-[:Notes]->-[:Author]->)"), Vec::<String>::new());
    assert_eq!(errors(&format!("{NARROW}      x = exists(s-[:Notes]->-[:Pinned]->){CLOSE}")), Vec::<String>::new());
}

#[test]
fn a_write_is_held_to_every_landing_until_narrowed() {
    assert_eq!(errors("  crm-[:Subjects]->-[n:Notes]-> { write n { Text: \"x\" } }"), Vec::<String>::new());
    let found = errors("  crm-[:Subjects]->-[n:Notes]-> { write n { Mood: \"x\" } }");
    assert_eq!(codes(&found), ["MOV_UNION_MEMBER_ONLY"], "{found:#?}");
    assert!(found[0].contains("crm.Remark has no field 'Mood'") && found[0].contains("since 0.14, what '-[:Notes]->' off crm.Subject lands is crm.Memo or crm.Remark"), "{found:#?}");
    assert!(found[0].ends_with("Narrow it first (`if (n is <crm-[:Memo]->>) { … write n { … } … }`))"), "{found:#?}");
    assert_eq!(errors(&format!("{NARROW}      s-[n:Notes]-> {{ write n {{ Mood: \"x\" }} }}{CLOSE}")), Vec::<String>::new());
}

/// A value that is one of several records for another reason (a parameter
/// written as a union) keeps the union rule's own code: nothing changed there.
#[test]
fn a_union_made_otherwise_keeps_its_code() {
    let source = "import { crm as m } from adapters\ncrm = connect m\nfunction go(n: <crm-[:Memo]-> | crm-[:Remark]->>) {\n  x = n.Mood\n}\n";
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let found: Vec<String> = check_source(source, &catalog, options).unwrap().into_iter().filter(|d| d.severity.is_none()).map(|d| d.code).collect();
    assert_eq!(found, ["MOV_UNKNOWN_PROPERTY"]);
}

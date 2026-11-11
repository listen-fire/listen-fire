//! A written union type — TypeScript's `Memo | Remark`:
//! `function noted(n: <crm-[:Memo]-> | crm-[:Remark]->>)`. A value that is one
//! of those records, joined by the union rule (`A | A` is `A`): it reads,
//! walks and writes only what every member offers, a record is accepted where
//! it fits some member, and a union where every member it may be fits.

use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Person":{"properties":{"Name":"text"},"edges":{"Jots":{"target":"Memo","readable":false,"listenable":true,"delivery":"connection"}}},
    "Company":{"properties":{"Name":"text"},"edges":{"Jots":{"target":"Remark","readable":false,"listenable":true,"delivery":"connection"}}},
    "Memo":{"properties":{"Text":"text","Mood":"text"},"edges":{"Author":{"target":"Person"},"Pinned":{"target":"Person"}}},
    "Remark":{"properties":{"Text":"text","Tone":"text"},"edges":{"Author":{"target":"Person"}}},
    "Note":{"properties":{"Text":"text"},"edges":{}}},
    "unions":{"Subject":["Person","Company"]},
    "collections":{"Subjects":{"target":"Subject","membersChange":{"relistEverySeconds":300}},
                   "Memos":{"target":"Memo"},"Remarks":{"target":"Remark"},"Notes":{"target":"Note"}},
    "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

const PRELUDE: &str = "import { crm as m } from adapters\ncrm = connect m\n";

fn errors(source: &str) -> Vec<String> {
    let source = format!("{PRELUDE}{source}");
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

const WRITING: &str = "<crm-[:Memo]-> | crm-[:Remark]->>";

fn reads(body: &str) -> Vec<String> {
    errors(&format!("function noted(n: {WRITING}) {{\n  {body}\n}}\n"))
}

#[test]
fn what_every_member_has_is_read_and_walked() {
    assert_eq!(reads("return n.Text"), Vec::<String>::new());
    assert_eq!(reads("return only(n-[:Author]->)?.Name"), Vec::<String>::new());
}

#[test]
fn what_one_member_lacks_is_refused_by_the_union_rule() {
    let field = reads("return n.Mood");
    assert_eq!(codes(&field), ["MOV_UNKNOWN_PROPERTY"], "{field:#?}");
    assert!(field[0].contains("Memo | Remark") && field[0].contains("Remark refuses it"), "{field:#?}");
    let edge = reads("return n-[:Pinned]->");
    assert_eq!(codes(&edge), ["MOV_TRAVERSE_UNKNOWN_EDGE"], "{edge:#?}");
}

#[test]
fn a_member_written_twice_is_one_type() {
    assert_eq!(errors("function f(n: <crm-[:Memo]-> | crm-[:Memo]->>) {\n  return n.Mood\n}\n"), Vec::<String>::new());
}

/// Assignability, as TypeScript's: `Memo` fits `Memo | Remark`;
/// `Memo | Remark` fits `Memo | Remark | Note` but not `Memo`.
#[test]
fn a_member_fits_the_union_and_the_union_fits_only_a_wider_one() {
    let call = |param: &str, arg_type: &str| errors(&format!("function g(x: {param}) {{\n  return x.Text\n}}\nfunction f(a: {arg_type}) {{\n  g(a)\n}}\n"));
    assert_eq!(call(WRITING, "<crm-[:Memo]->>"), Vec::<String>::new());
    assert_eq!(call(WRITING, "<crm-[:Remark]->>"), Vec::<String>::new());
    assert_eq!(call(WRITING, WRITING), Vec::<String>::new());
    assert_eq!(call("<crm-[:Remark]-> | crm-[:Memo]->>", WRITING), Vec::<String>::new());
    assert_eq!(call("<crm-[:Memo]-> | crm-[:Remark]-> | crm-[:Note]->>", WRITING), Vec::<String>::new());
    let narrower = call("<crm-[:Memo]->>", WRITING);
    assert_eq!(narrower, ["MOV_CALL_ARG_TYPE 'g' expects Memo for 'x' (argument 1), but this argument is Memo | Remark"], "{narrower:#?}");
    let other = call(WRITING, "<crm-[:Note]->>");
    assert_eq!(other, ["MOV_CALL_ARG_TYPE 'g' expects Memo | Remark for 'x' (argument 1), but this argument is Note"], "{other:#?}");
}

#[test]
fn a_return_type_may_be_a_union() {
    let returns = |param: &str| errors(&format!("function f(n: {param}): {WRITING} {{\n  return n\n}}\n"));
    assert_eq!(returns("<crm-[:Remark]->>"), Vec::<String>::new());
    assert_eq!(codes(&returns("<crm-[:Note]->>")), ["MOV_RETURN_TYPE"]);
}

#[test]
fn every_member_is_a_record_type_the_program_can_name() {
    let unknown = errors("function f(n: <crm-[:Memo]-> | crm-[:Remrk]->>) {\n  return n\n}\n");
    assert_eq!(codes(&unknown), ["MOV_UNKNOWN_POSITION"], "{unknown:#?}");
    assert!(unknown[0].contains("'crm' has no position type 'Remrk'"), "{unknown:#?}");
    let value = errors("function f(n: <crm-[:Memo]-> | text>) {\n  return n\n}\n");
    assert_eq!(value, ["MOV_UNKNOWN_TYPE_NAME 'text' is a value type, and a union type's members are records ('<crm-[:Memo]-> | crm-[:Remark]->>') — a closed set of values is declared as its own type (`type Stage = <\"A\" | \"B\">`)"]);
    let nameless = errors("function f(n: <crm-[:Memo]-> | crn-[:Remark]->>) {\n  return n\n}\n");
    assert_eq!(codes(&nameless), ["MOV_NAME_UNRESOLVED"], "{nameless:#?}");
}

/// A listen through a union whose members' edges land on different record
/// types fires a function typed by the union of the landings.
#[test]
fn a_listen_through_a_union_fires_a_function_typed_by_the_union_of_its_landings() {
    let listen = |param: &str| errors(&format!("function noted(n: {param}) {{\n  return n.Text\n}}\nlisten to crm-[:Subjects]->-[:Jots]-> fire noted\n"));
    assert_eq!(listen(WRITING), Vec::<String>::new());
    assert_eq!(listen("<crm-[:Remark]-> | crm-[:Memo]-> | crm-[:Note]->>"), Vec::<String>::new());
    let narrow = listen("<crm-[:Memo]-> | crm-[:Note]->>");
    assert_eq!(codes(&narrow), ["MOV_LISTEN_PARAM_MISMATCH"], "{narrow:#?}");
    assert!(narrow[0].contains("'noted' takes 'n: <crm-[:Memo]-> | crm-[:Note]->>'") && narrow[0].contains("lands Remark"), "{narrow:#?}");
    // What lands is the listen's connection's: a member of another is refused.
    let other = errors(&format!("other = connect m\nfunction noted(n: <crm-[:Memo]-> | other-[:Remark]->>) {{\n  return n.Text\n}}\nlisten to crm-[:Subjects]->-[:Jots]-> fire noted\n"));
    assert_eq!(codes(&other), ["MOV_LISTEN_PARAM_MISMATCH"], "{other:#?}");
    assert!(other[0].contains("fires with records of 'crm' alone, and '<other-[:Remark]->>' is another connection's"), "{other:#?}");
}

//! A wait off a name that may hold no record fails the run at the wait when
//! the record is absent, as a block's walk does: refused (MOV_ABSENT_REQUIRED)
//! until a guard proves the record there.

use movement_checker::CheckOptions;
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"at":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
  "Table":{"properties":{"Name":"text"},
    "edges":{"Changes":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"connection"}}},
  "Change":{"properties":{"Id":"text","Kind":"text"},"edges":{}}},
  "collections":{"Tables":{"target":"Table"}},
  "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

fn check(body: &str) -> Vec<String> {
    let source = format!("import {{ at as m }} from adapters\nat = connect m\nfunction go() {{\n{body}\n}}\n");
    let catalog = CatalogSnapshot::load(CATALOG).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    movement_checker::check_source(&source, &catalog, options)
        .unwrap_or_else(|e| panic!("{source}: {e:?}"))
        .into_iter()
        .filter(|d| d.severity.is_none())
        .map(|d| format!("{} {}", d.code, d.message))
        .collect()
}

#[test]
fn a_wait_off_a_record_that_may_be_absent_is_refused() {
    for awaited in ["await new t-[:Changes]->", "await t-[:Changes]->"] {
        let found = check(&format!("  t = only(at-[:Tables]->)\n  x = {awaited}\n  return x.Kind"));
        assert_eq!(
            found,
            ["MOV_ABSENT_REQUIRED 't' may be absent, and a wait off a record that is not there fails the run rather than waiting. Guard the wait: 'if (t != null) { … }'. (see handbook: front#maybe-absent)"],
            "{awaited}"
        );
    }
}

#[test]
fn a_guard_proves_the_record_there() {
    assert_eq!(check("  t = only(at-[:Tables]->)\n  if (t != null) {\n    x = await new t-[:Changes]->\n    return x.Kind\n  }\n  return \"none\""), Vec::<String>::new());
    assert_eq!(check("  t = only(at-[:Tables]->)\n  if (exists(t)) {\n    x = await new t-[:Changes]->\n    return x.Kind\n  }\n  return \"none\""), Vec::<String>::new());
}

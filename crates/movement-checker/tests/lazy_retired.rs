//! 0.14 retires `lazy` for a closure: `tables = () => s-[t:Tables]->`, read
//! as `tables()`. Each `lazy` is refused where it is written
//! (MOV_LAZY_RETIRED), telling the author the closure to write by hand: no
//! refusal carries a rewrite, so `listen-fire upgrade` leaves it to them.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const STORE: &str = r#"{"adapters":{
  "store":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Table":{"properties":{"Name":"text"},"edges":{"History":{"target":"Change"}}},
    "Change":{"properties":{"Id":"text","Kind":"text"},"edges":{}}},
    "collections":{"Tables":{"target":"Table"}},"writableRoots":{}}}}
},"credentials":{},"plugins":{}}"#;

const HEAD: &str = "import { store } from adapters\n\ns = connect store\n\n";

fn check(body: &str) -> Vec<Diagnostic> {
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let source = format!("{HEAD}{body}");
    check_source(&source, &CatalogSnapshot::load(STORE).unwrap(), options).unwrap_or_else(|e| panic!("{source}: {e:?}"))
}

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().filter(|d| d.severity != Some(movement_checker::Severity::Info)).map(|d| d.code.as_str()).collect()
}

/// The one MOV_LAZY_RETIRED `body` raises: an error with no rewrite.
fn refused(body: &str) -> Diagnostic {
    let mut told: Vec<Diagnostic> = check(body).into_iter().filter(|d| d.code == "MOV_LAZY_RETIRED").collect();
    assert_eq!(told.len(), 1, "{told:?}");
    let d = told.remove(0);
    assert!(d.is_error(), "{d:?}");
    assert!(d.fix.is_none(), "{d:?}");
    assert!(d.message.ends_with("(`listen-fire upgrade` does not rewrite it)"), "{}", d.message);
    d
}

#[test]
fn a_lazy_binding_is_refused_naming_the_closure_to_write() {
    let d = refused("function lz() {\n  tables = lazy s-[t:Tables]->\n  return count(tables)\n}\n");
    assert!(d.message.starts_with("`lazy` is retired in 0.14; replace it by hand with a closure, `tables = () => s-[t:Tables]->`, read as `tables()`"), "{}", d.message);
    assert_eq!((d.span.start.line, d.span.start.col), (6, 12));
}

#[test]
fn a_mapped_lazy_binding_names_a_closure_returning_the_walks_block() {
    let d = refused("function lz() {\n  labelled = lazy s-[t:Tables]-> node { label: t.Name }\n  return labelled.label\n}\n");
    assert!(d.message.contains("`labelled = () => { return s-[t:Tables]-> { return node { … } } }`"), "{}", d.message);
}

#[test]
fn a_returned_lazy_walk_is_refused() {
    let d = refused("function kept() {\n  return lazy s-[t:Tables]->\n}\n");
    assert!(d.message.contains("`return s-[t:Tables]->` runs the walk where it is returned"), "{}", d.message);
}

#[test]
fn a_lazy_node_entry_is_refused() {
    let d = refused("function lz() {\n  g = node { tabs: lazy s-[t:Tables]->, label: \"x\" }\n  return count(g-[:tabs]->)\n}\n");
    assert!(d.message.contains("`tabs = () => s-[t:Tables]->`, read as `tabs()`: no node entry walks again at each read"), "{}", d.message);
}

#[test]
fn the_closure_forms_check_clean() {
    let body = "function lz() {
  tables = () => s-[t:Tables]->
  labelled = () => {
    return s-[t:Tables]-> {
      return node { label: t.Name }
    }
  }
  g = node { tabs: s-[t:Tables]-> }
  return { n: count(tables()), labels: labelled().label, tabs: count(g-[:tabs]->), past: count(tables()-[:History]->) }
}
";
    assert_eq!(codes(&check(body)), Vec::<&str>::new());
}

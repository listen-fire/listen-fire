//! A hop's alias names its record to every hop after it and to the block the
//! walk opens. One walk naming two hops alike is refused where it is
//! written (MOV_HOP_ALIAS_REPEATED), on a block, inside an expression and on
//! a listen (listen_traversal.rs) alike: each reader would otherwise have to
//! guess which hop the name means.

use movement_checker::CheckOptions;
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"at":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
  "Table":{"properties":{"Name":"text"},
    "edges":{"History":{"target":"Change"},
      "Changes":{"target":"Change","readable":false,"listenable":true,"identity":"Id","delivery":"connection"}}},
  "Change":{"properties":{"Id":"text","Kind":"text"},"edges":{"Replies":{"target":"Reply","readable":false,"listenable":true,"delivery":"connection"}}},
  "Reply":{"properties":{"Text":"text"},"edges":{}}},
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

const REPEATED: &str = "MOV_HOP_ALIAS_REPEATED 't' names two hops of this walk, '-[t:Tables]->' and '-[t:History]->' — a name means one thing everywhere it is visible: give each hop its own alias";

#[test]
fn one_walk_naming_two_hops_alike_is_refused_wherever_it_walks() {
    for body in [
        "  at-[t:Tables]->-[t:History]-> { x = t.Kind }",
        "  n = count(at-[t:Tables]->-[t:History]->)\n  return n",
    ] {
        let found = check(body);
        assert!(found.iter().any(|d| d == REPEATED), "{body}: {found:?}");
        assert_eq!(found.iter().filter(|d| d.starts_with("MOV_HOP_ALIAS_REPEATED")).count(), 1, "{body}: {found:?}");
    }
}

#[test]
fn distinct_aliases_and_one_alias_in_two_walks_are_accepted() {
    assert_eq!(check("  at-[t:Tables]->-[c:History]-> { x = c.Kind }"), Vec::<String>::new());
    assert_eq!(check("  a = count(at-[t:Tables]->)\n  b = count(at-[t:Tables]->-[c:History]->)\n  return a + b"), Vec::<String>::new());
}

/// A later hop's WHERE and ORDER BY read an earlier hop's alias, in a run as
/// on a listen: each path through the walk carries its own records, so `t`
/// is the Table that path crossed. Accepted in a block head, inside an
/// expression, in a bound walk and inside `exists`, as from inside a block.
#[test]
fn a_hop_reading_an_earlier_hop_of_its_walk_is_accepted_in_a_run() {
    for body in [
        "  at-[t:Tables]->-[c:History WHERE c.Id == t.Name]-> {\n    y = c.Kind\n  }",
        "  n = count(at-[t:Tables]->-[c:History WHERE c.Id == t.Name]->)\n  return n",
        "  l = at-[t:Tables]->-[c:History ORDER BY t.Name LIMIT 2]->\n  return l",
        "  found = exists(at-[t:Tables]->-[c:History WHERE c.Id == t.Name]->)\n  return found",
        "  at-[t:Tables]-> {\n    t-[c:History WHERE c.Id == t.Name]-> {\n      y = c.Kind\n    }\n  }",
        "  at-[t:Tables]-> {\n    n = count(t-[c:History WHERE c.Id == t.Name]->)\n  }",
    ] {
        assert_eq!(check(body), Vec::<String>::new(), "{body}");
    }
}

/// The earlier hop's record is typed as its own: a field it lacks is refused
/// where the later hop reads it.
#[test]
fn an_earlier_hop_s_missing_field_is_refused_where_a_later_hop_reads_it() {
    let found = check("  n = count(at-[t:Tables]->-[c:History WHERE c.Id == t.Nmae]->)\n  return n");
    assert!(found.iter().any(|d| d.contains("Nmae")), "{found:?}");
    assert!(!found.iter().any(|d| d.starts_with("MOV_HOP_READS_EARLIER_HOP")), "{found:?}");
}

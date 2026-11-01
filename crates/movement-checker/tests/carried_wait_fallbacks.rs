//! A record a listen's arrival carries opens the waits awaited off it at
//! the delivery, keyed by the edge it was carried for. Where two hops walk
//! that edge's name, the key names neither, so those waits open where the
//! function walks to the record instead, and the listen is told so
//! (`MOV_CARRIED_WAIT_FROM_WALK`, a warning): never silently.

use movement_checker::{CheckOptions, Severity, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

const CATALOG: &str = r#"{"adapters":{"desk":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
    "Folder":{"properties":{"Name":"text"},"edges":{
      "Folders":{"target":"Folder"},
      "Pins":{"target":"Pin","readable":false,"listenable":true},
      "Notes":{"target":"Note","readable":false,"listenable":true,"carries":["Folders"]}}},
    "Note":{"properties":{"Body":"text"},"edges":{"Folder":{"target":"Folder"}}},
    "Pin":{"properties":{"Id":"text"},"edges":{}}},
    "collections":{"Folders":{"target":"Folder"}},
    "writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;

/// Each warning's code and message, the source after a line connecting `desk`.
fn warnings_of(source: &str) -> Vec<(String, String)> {
    let source = format!("import {{ desk as desk_module }} from adapters\ndesk = connect desk_module\n{source}");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let found = check_source(&source, &CatalogSnapshot::load(CATALOG).unwrap(), options).unwrap_or_else(|e| panic!("{source}: {e:?}"));
    let errors: Vec<_> = found.iter().filter(|d| d.severity.is_none()).collect();
    assert!(errors.is_empty(), "{source}: {errors:#?}");
    found.into_iter().filter(|d| d.severity == Some(Severity::Warning)).map(|d| (d.code, d.message)).collect()
}

#[test]
fn a_carried_edge_walked_twice_tells_its_waits_count_from_the_walk() {
    let fired = "function pinned(c: <desk-[:Note]->>) {\n  c-[f:Folder]-> {\n    p = await new f-[:Pins]->\n  }\n}\n";
    let found = warnings_of(&format!("{fired}listen to desk-[:Folders]->-[:Folders]->-[c:Notes]-> fire pinned\n"));
    assert_eq!(found.len(), 1, "{found:#?}");
    assert_eq!(found[0].0, "MOV_CARRIED_WAIT_FROM_WALK");
    assert!(found[0].1.contains("`Pins`") && found[0].1.contains("2 of its hops walk `Folders`"), "{found:#?}");
    // Walked once, the carried folder opens its waits at the delivery: nothing to tell.
    assert_eq!(warnings_of(&format!("{fired}listen to desk-[:Folders]->-[c:Notes]-> fire pinned\n")), Vec::<(String, String)>::new());
}

//! A hop's WHERE that the host evaluated over a type's members and found to
//! select none of them (`unselected`, under the hop's refinement key) is
//! refused where it is written, naming the members there are. Nothing read
//! off it after is refused again. Without that record the hop stays on the
//! unnarrowed type, as before.

use movement_checker::slots::expression_of_text;
use movement_checker::{CheckOptions, check_source};
use movement_parser::catalog::helpers::refinement_key;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::lowering::expression::{Expression, TraversalStep};
use serde_json::json;

const HOP: &str = "-[b:Base WHERE b.Name == \"Pipeline Trackr\"]->";

/// The key a host files the hop's selection under.
fn key_of(hop: &str) -> String {
    let Ok(Expression::Traverse { steps, .. }) = expression_of_text(&format!("__movement_path_root__{hop}.`__probe__`")) else { panic!("{hop}") };
    let [TraversalStep::Edge(edge)] = steps.as_slice() else { panic!("{hop}") };
    refinement_key("Base", &serde_json::to_value(edge.expression_filter.as_deref().unwrap()).unwrap())
}

fn errors(unselected: bool, body: &str) -> Vec<String> {
    let mut schema = json!({
        "positions": { "Base": { "properties": { "Name": "text" }, "edges": {} } },
        "collections": { "Base": { "target": "Base" } },
        "writableRoots": {}
    });
    if unselected {
        schema["unselected"] = json!({ key_of(HOP): ["Pipeline Tracker", "Ops"] });
    }
    let catalog = json!({ "adapters": { "at": { "canFire": false, "constructionArgs": [], "schemas": { "": schema } } }, "credentials": {}, "plugins": {} });
    let catalog = CatalogSnapshot::load(&catalog.to_string()).unwrap();
    let source = format!("import {{ at }} from adapters\npipeline = connect at\n\nfunction f() {{\n  base = only(pipeline{HOP})\n{body}\n}}\n");
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    check_source(&source, &catalog, options).unwrap().into_iter().filter(|d| d.severity.is_none()).map(|d| format!("{}:{} {}", d.span.start.line, d.code, d.message)).collect()
}

#[test]
fn a_where_that_selects_no_member_is_refused_at_the_hop_naming_the_members() {
    assert_eq!(
        errors(true, ""),
        ["5:MOV_UNKNOWN_POSITION 'pipeline' has no Base whose Name is \"Pipeline Trackr\" — it has: \"Pipeline Tracker\", \"Ops\" — did you mean 'Pipeline Tracker'?"]
    );
}

#[test]
fn what_is_read_off_it_after_is_not_refused_again() {
    let found = errors(true, "  if (base == null) { fail(\"none\") }\n  x = base.Nmae");
    assert_eq!(found.len(), 1, "{found:?}");
}

#[test]
fn without_the_hosts_record_the_hop_stays_on_the_type() {
    assert_eq!(errors(false, ""), Vec::<String>::new());
    let found = errors(false, "  if (base == null) { fail(\"none\") }\n  x = base.Nmae");
    assert!(found.len() == 1 && found[0].contains("MOV_UNKNOWN_PROPERTY"), "{found:?}");
}

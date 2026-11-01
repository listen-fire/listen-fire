//! The listens, systems and imports families on their own programs. Parity
//! with the TypeScript checker is the harness's job (parity/run.sh); these
//! pin the behaviours that span statements.

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn codes(found: &[Diagnostic]) -> Vec<&str> {
    found.iter().map(|d| d.code.as_str()).collect()
}

const FEED: &str = r#""feed":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"Note":{"properties":{},"edges":{}}},"collections":{},"writableRoots":{}}}}"#;

fn check_feed(listen: &str) -> Vec<Diagnostic> {
    let snapshot = format!(r#"{{"adapters":{{{FEED}}},"credentials":{{}},"plugins":{{}}}}"#);
    let catalog = CatalogSnapshot::load(&snapshot).unwrap();
    let options = CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
    let source = format!("import {{ feed }} from adapters\nf = connect feed\nfunction seen(n: <f-[:Note]->>) {{}}\n{listen}");
    // The settings form's retirement is listen_settings_retired.rs's to pin.
    check_source(&source, &catalog, options).unwrap().into_iter().filter(|d| d.code != "MOV_LISTEN_SETTINGS_RETIRED").collect()
}

#[test]
fn the_old_poll_interval_key_is_respelled() {
    let old = check_feed("listen to f { pollIntervalSeconds: 300 } fire seen");
    assert_eq!(codes(&old), ["MOV_V5_SPELLING"]);
    assert!(old[0].message.contains("every: 5m"), "{}", old[0].message);
}

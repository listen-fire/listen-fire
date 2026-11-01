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

/// The settings form is retired whole, and its poll interval with it: the
/// module sets the interval now, so no spelling of `every:` is offered.
#[test]
fn the_old_poll_interval_key_is_not_respelled_as_the_retired_every() {
    assert_eq!(codes(&check_feed("listen to f { pollIntervalSeconds: 300 } fire seen")), Vec::<&str>::new());
}

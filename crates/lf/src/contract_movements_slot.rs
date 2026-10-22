//! `lf --contract-movements-slot`: the project's movements slot served as a
//! movements module, its methods (docs/contracts/movements-slot.md) as adapter
//! protocol 2 calls over HTTP (crate::slot_server), each passed on through
//! lf's own client of the module (crate::movements_slot), or its in-process
//! default, `@lf/folder-movements`. The conformance cases (module-runtime
//! `module_wire/conformance.ts` `movementsSlotCases`) then hold lf's side of
//! the wire to the same meaning they hold the module to. The settings a
//! request carries are not used: the module's own come from the environment
//! and the secrets file, as they do for every lf command.

use std::rc::Rc;

use crate::json::Js;
use crate::movements_slot::{MOVEMENTS_METHODS, MovementsStore, is_movement_path, text_js, written_js};
use crate::slot_server::{Listen, Refusal};

pub async fn serve(store: Rc<dyn MovementsStore>, name: &str, listen: Listen) -> Result<(), String> {
    let manifest = crate::slot_server::manifest(name, "movements", MOVEMENTS_METHODS);
    crate::slot_server::serve(listen, manifest, move |method, params, _settings| answer(&*store, method, params)).await
}

fn path_of<'p>(method: &str, params: &'p Js) -> Result<&'p str, Refusal> {
    params
        .get("path")
        .and_then(Js::as_str)
        .filter(|path| is_movement_path(path))
        .ok_or_else(|| Refusal::bad_request(format!("{method}: path: expected a movement file's path (relative to the movements folder, `/`-separated, ending .mvt)")))
}

/// `expectedVersion` is present: a version, or null for "nothing is there".
fn expected_of<'p>(method: &str, params: &'p Js) -> Result<Option<&'p str>, Refusal> {
    match params.get("expectedVersion") {
        Some(Js::Null) => Ok(None),
        Some(Js::Str(version)) if !version.is_empty() => Ok(Some(version.as_str())),
        _ => Err(Refusal::bad_request(format!("{method}: expectedVersion: expected a version, or null to create"))),
    }
}

fn answer(store: &dyn MovementsStore, method: &str, params: &Js) -> Result<Js, Refusal> {
    match method {
        "movements.list" => store.list().map(|all| crate::movements_slot::listed_js(&all)).map_err(Refusal::failed),
        "movements.read" => Ok(store.read(path_of(method, params)?).map_err(Refusal::failed)?.as_ref().map_or(Js::Null, text_js)),
        "movements.write" => {
            let path = path_of(method, params)?;
            let text = params.get("text").and_then(Js::as_str).ok_or_else(|| Refusal::bad_request(format!("{method}: text: expected a string")))?;
            let expected = expected_of(method, params)?;
            written_js(&store.write(path, text, expected)).map_err(Refusal::failed)
        }
        other => Err(Refusal::unknown(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::movements_slot::FolderMovements;

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("lf-contract-movements-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ask(store: &dyn MovementsStore, method: &str, params: &str) -> Result<String, String> {
        answer(store, method, &Js::parse(params.as_bytes()).unwrap()).map(|js| js.to_json()).map_err(|refusal| refusal.message)
    }

    #[test]
    fn the_runner_checks_params_before_it_touches_the_store() {
        let dir = temp();
        let store = FolderMovements::at(&dir);
        for bad in [r#"{"path":"/a.mvt"}"#, r#"{"path":"a/../b.mvt"}"#, r#"{"path":"a.txt"}"#, r#"{}"#] {
            assert!(ask(&store, "movements.read", bad).unwrap_err().contains("path"), "{bad}");
        }
        assert!(ask(&store, "movements.write", r#"{"path":"a.mvt","text":"x"}"#).unwrap_err().contains("expectedVersion"));
        assert!(ask(&store, "movements.write", r#"{"path":"a.mvt","expectedVersion":null}"#).unwrap_err().contains("text"));
        assert!(!dir.join("a.mvt").exists());
        assert_eq!(ask(&store, "movements.read", r#"{"path":"a.mvt"}"#).unwrap(), "null");
    }

    #[test]
    fn a_write_and_a_conflict_are_answered_by_kind() {
        let dir = temp();
        let store = FolderMovements::at(&dir);
        let written = ask(&store, "movements.write", r#"{"path":"a/b.mvt","text":"one","expectedVersion":null}"#).unwrap();
        assert!(written.contains("\"written\""), "{written}");
        let again = ask(&store, "movements.write", r#"{"path":"a/b.mvt","text":"two","expectedVersion":null}"#).unwrap();
        assert!(again.contains("\"conflict\""), "{again}");
        assert_eq!(std::fs::read_to_string(dir.join("a/b.mvt")).unwrap(), "one");
        assert!(ask(&store, "movements.nope", "{}").is_err());
    }
}

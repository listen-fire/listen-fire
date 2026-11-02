//! `listen-fire --contract-guard`: listen-fire's built-in loop guard (`@lf/fingerprint-guard`)
//! served as a loop guard module, the loopGuard slot's methods
//! (docs/contracts/loop-guard-slot.md) as adapter protocol 2 calls over HTTP
//! (crate::slot_server), so the TypeScript contract suite (movement-engine
//! `services/loop_guard/contract.ts`) holds it to the meaning every guard
//! has. The built-in is opened by `guard.open`, with the settings it is sent
//! (no `path` or `url`: a file in a temporary folder). `--contract-guard-slot`
//! serves the project's loopGuard slot instead, a guard module included.

use std::cell::RefCell;
use std::sync::Arc;

use crate::json::Js;
use crate::loop_guard::{FingerprintGuard, LoopGuard, Wrote};
use crate::slot_server::{Listen, Refusal};

pub const GUARD_METHODS: &[&str] = &["guard.open", "guard.recordWrite"];

/// The guard being served: the project's, or the built-in once `guard.open` has made it.
pub enum Serving {
    Slot(Arc<dyn LoopGuard>),
    BuiltIn(Option<FingerprintGuard>),
}

pub async fn serve(serving: Serving, listen: Listen) -> Result<(), String> {
    let serving = RefCell::new(serving);
    let manifest = crate::slot_server::manifest("@lf/fingerprint-guard", "loopGuard", GUARD_METHODS);
    crate::slot_server::serve(listen, manifest, move |method, params, _settings| answer(&mut serving.borrow_mut(), method, params)).await
}

fn answer(serving: &mut Serving, method: &str, params: &Js) -> Result<Js, Refusal> {
    match method {
        "guard.open" => open(serving, params).map(|()| Js::Null).map_err(Refusal::failed),
        "guard.recordWrite" => match guard_of(serving) {
            Some(guard) => record_write(guard, params),
            None => Err(Refusal::failed("open me with guard.open first")),
        },
        other => Err(Refusal::unknown(other)),
    }
}

fn guard_of(serving: &Serving) -> Option<&dyn LoopGuard> {
    match serving {
        Serving::Slot(guard) => Some(&**guard),
        Serving::BuiltIn(guard) => guard.as_ref().map(|g| g as &dyn LoopGuard),
    }
}

fn open(serving: &mut Serving, params: &Js) -> Result<(), String> {
    let Serving::BuiltIn(guard) = serving else { return Ok(()) };
    let mut settings: std::collections::BTreeMap<String, String> = match params.get("settings") {
        Some(Js::Obj(given)) => given.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect(),
        _ => Default::default(),
    };
    let dir = std::env::temp_dir().join(format!("lf-guard-{}", uuid::Uuid::new_v4()));
    if !settings.contains_key("url") {
        settings.entry("path".into()).or_insert_with(|| "guard.db".into());
    }
    *guard = Some(FingerprintGuard::open(&settings, &dir, &dir)?);
    Ok(())
}

fn record_write(guard: &dyn LoopGuard, params: &Js) -> Result<Js, Refusal> {
    let text = |key: &str| -> Result<String, Refusal> {
        params.get(key).and_then(Js::as_str).map(str::to_string).ok_or_else(|| Refusal::bad_request(format!("guard.recordWrite: {key}: expected a string")))
    };
    let record = params.get("record").ok_or_else(|| Refusal::bad_request("guard.recordWrite: record: expected the record"))?;
    let wrote = Wrote { adapter: text("adapter")?, record_type: text("recordType")?, external_id: text("externalId")?, record: record.clone() };
    guard.record_write(&wrote, &text("writer")?).map(|()| Js::Null).map_err(Refusal::failed)
}

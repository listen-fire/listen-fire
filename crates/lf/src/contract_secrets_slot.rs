//! `lf --contract-secrets-slot`: the project's secrets slot served as a
//! secrets module, its methods (docs/contracts/secrets-slot.md) as adapter
//! protocol 2 calls over HTTP (crate::slot_server), each passed on through
//! lf's own client of the module (crate::secrets_slot), or its in-process
//! default, `@lf/file-secrets`. The conformance cases (module-runtime
//! `module_wire/conformance.ts` `secretsSlotCases`, and the family's
//! `secretsContractCases` through `SecretsSlotBackend`) then hold lf's side of
//! the wire to the same meaning they hold the module to. The settings a
//! request carries are not used: the module's own come from the environment
//! and the secrets file, as they do for every lf command.
//!
//! The lease is the one wrinkle. A store's `lock` waits for a lease another
//! holds; the wire's answers null instead. This runner answers null when it
//! has granted the credential and the lease has not lapsed, and when the store
//! does not grant it within `TRY_LOCK`. It keeps what it granted until
//! `secrets.unlock` or the ttl, since a file store's lease is released when
//! dropped.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::json::Js;
use crate::obj;
use crate::secret_stores::Entry;
use crate::secrets_slot::{EntryError, SECRETS_METHODS, SecretsStore, binding_of, fields_of, listed_js, record_js, write_back_js};
use crate::secrets_family::Lease;
use crate::slot_server::{Listen, Refusal, serve_async};

/// How long a lock waits on the store before it answers that another holds it.
const TRY_LOCK: Duration = Duration::from_millis(60);

struct Granted {
    token: String,
    until: Instant,
    lease: Lease,
}

pub async fn serve(store: Rc<dyn SecretsStore>, name: &str, listen: Listen) -> Result<(), String> {
    let manifest = crate::slot_server::manifest(name, "secrets", SECRETS_METHODS);
    let granted: Rc<RefCell<HashMap<String, Granted>>> = Rc::default();
    serve_async(listen, manifest, move |method, params, _settings| {
        let (store, granted) = (store.clone(), granted.clone());
        async move { answer(&*store, &granted, &method, &params).await }
    })
    .await
}

fn text<'p>(method: &str, params: &'p Js, key: &str) -> Result<&'p str, Refusal> {
    params.get(key).and_then(Js::as_str).filter(|v| !v.is_empty()).ok_or_else(|| Refusal::bad_request(format!("{method}: {key}: expected a string")))
}

fn entry_of(method: &str, params: &Js) -> Result<Entry, Refusal> {
    let external = text(method, params, "external")?;
    let binding = params.get("binding").and_then(binding_of).ok_or_else(|| Refusal::bad_request(format!("{method}: binding: expected install, legacy or {{ credential }}")))?;
    let fields = params.get("fields").and_then(fields_of).ok_or_else(|| Refusal::bad_request(format!("{method}: fields: expected an object of strings")))?;
    Ok(crate::connect::entry_content(external, &binding, &fields.into_iter().collect::<Vec<_>>()))
}

/// An entry method's answer: null when changed, `read_only` with its reason
/// when the module keeps its credentials where lf cannot change them.
fn changed(done: Result<(), EntryError>) -> Result<Js, Refusal> {
    match done {
        Ok(()) => Ok(Js::Null),
        Err(EntryError::ReadOnly { reason, .. }) => Ok(Js::from(obj! { "kind" => Js::str("read_only"), "reason" => Js::str(reason) })),
        Err(EntryError::Failed(message)) => Err(Refusal::failed(message)),
    }
}

async fn answer(store: &dyn SecretsStore, granted: &RefCell<HashMap<String, Granted>>, method: &str, params: &Js) -> Result<Js, Refusal> {
    if !SECRETS_METHODS.contains(&method) {
        return Err(Refusal::unknown(method));
    }
    let reference = text(method, params, "ref");
    match method {
        "secrets.list" => store.list().map(|all| Js::Arr(all.iter().map(listed_js).collect())).map_err(Refusal::failed),
        "secrets.resolve" => Ok(store.resolve(reference?).map_err(Refusal::failed)?.as_ref().map_or(Js::Null, record_js)),
        "secrets.writeBack" => {
            let fields = params.get("fields").and_then(fields_of).ok_or_else(|| Refusal::bad_request(format!("{method}: fields: expected an object of strings")))?;
            let expected = params.get("expectedVersion").and_then(Js::as_str).ok_or_else(|| Refusal::bad_request(format!("{method}: expectedVersion: expected a string")))?;
            store.write_back(reference?, &fields, expected).map(|outcome| write_back_js(&outcome)).map_err(Refusal::failed)
        }
        "secrets.lock" => {
            let reference = reference?;
            let ttl_ms = match params.get("ttlMs") {
                Some(Js::Num(n)) => n.as_u64(),
                _ => None,
            }.ok_or_else(|| Refusal::bad_request(format!("{method}: ttlMs: expected a whole number of milliseconds")))?;
            lock(store, granted, reference, ttl_ms).await
        }
        "secrets.unlock" => {
            let (reference, token) = (reference?, text(method, params, "token")?);
            // A token that is not the lease's unlocks nothing, and the lease stays.
            let mut all = granted.borrow_mut();
            let held = if all.get(reference).is_some_and(|held| held.token == token) { all.remove(reference) } else { None };
            drop(all);
            if let Some(held) = held {
                store.unlock(reference, held.lease);
            }
            Ok(Js::Null)
        }
        "secrets.assertWritable" => changed(store.entries_writable(reference?)),
        "secrets.create" => {
            let reference = reference?;
            changed(store.create(reference, entry_of(method, params)?).await)
        }
        "secrets.replace" => {
            let reference = reference?;
            let entry = entry_of(method, params)?;
            changed(store.replace(reference, &|_| Ok(entry.clone())).await)
        }
        "secrets.delete" => changed(store.delete(reference?).await),
        other => Err(Refusal::unknown(other)),
    }
}

async fn lock(store: &dyn SecretsStore, granted: &RefCell<HashMap<String, Granted>>, reference: &str, ttl_ms: u64) -> Result<Js, Refusal> {
    // A lease past its ttl is released, as the module's own would lapse.
    let lapsed = {
        let mut all = granted.borrow_mut();
        match all.get(reference) {
            Some(held) if held.until <= Instant::now() => all.remove(reference),
            Some(_) => return Ok(Js::Null),
            None => None,
        }
    };
    if let Some(held) = lapsed {
        store.unlock(reference, held.lease);
    }
    let Ok(lease) = tokio::time::timeout(TRY_LOCK, store.lock(reference, ttl_ms)).await else { return Ok(Js::Null) };
    let lease = lease.map_err(Refusal::failed)?;
    // A token of this runner's own: a file store's lease is named by its lock file, the same for every holder.
    let token = uuid::Uuid::new_v4().to_string();
    // Two locks of one credential can both pass the check above while the store is waited on; the second finds the first.
    let mut all = granted.borrow_mut();
    if all.contains_key(reference) {
        drop(all);
        store.unlock(reference, lease);
        return Ok(Js::Null);
    }
    all.insert(reference.to_string(), Granted { token: token.clone(), until: Instant::now() + Duration::from_millis(ttl_ms), lease });
    Ok(Js::from(obj! { "token" => Js::str(token) }))
}

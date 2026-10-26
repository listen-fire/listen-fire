//! A source's webhook, registered at the source by `lf serve` (the
//! platform's listen reconciliation, for one machine): when it starts, each
//! external that lists `ensureEventSubscription` and takes webhooks is asked
//! to register a webhook for the events its live listens name, pointed at the
//! webhook door under lf.yaml's `publicUrl`; one whose listens are all gone
//! has its webhook removed (`removeEventSubscription`). Each refresh of the
//! files does the same for the externals whose listens now want other
//! events, and tries again the ones that failed.
//!
//! Each connection has a webhook of its own (the platform's subscription per
//! provider and credential): it is made as the credential the connection's
//! construction names (`connect … using X`; the external's user credential
//! for a construction that names none), for the events that connection's
//! listens need, and kept on that credential, which names the door:
//! `/api/public/webhook-sync/<provider>/<credential>`. A delivery there runs
//! only that connection's listens (crate::routing::Listen::hears). A
//! credential no listen uses any more has its webhook removed.
//! A secret the source issues is that credential's webhook secret, so the
//! door verifies deliveries with it. Kept there, the next start sees what is
//! registered: the same events and URL ask the module, which leaves the
//! webhook as it is; other events change it in place; another URL replaces it.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use crate::connect::spread;
use crate::doors::inbound_of;
use crate::externals::{RunningExternal, rpc_as};
use crate::check::LOCAL_TENANT;
use crate::json::Js;
use crate::runs::{FileSet, Session};
use crate::secrets_slot::SecretsStore;
use crate::secrets::{Binding, Credential, Credentials, credential_for};

/// The source's id for the webhook it registered.
const WEBHOOK_ID_FIELD: &str = "webhook_id";
/// The events it is registered for, comma-separated.
const WEBHOOK_EVENTS_FIELD: &str = "webhook_events";
/// Where it delivers.
const WEBHOOK_URL_FIELD: &str = "webhook_url";

/// What one credential's entry holds of its registration.
struct Registered {
    id: Option<String>,
    events: Vec<String>,
    url: Option<String>,
}

/// Whether `external` has a webhook registered under any of its
/// credentials: lf starts it then even when no movement imports it any
/// more, so the webhook is removed.
pub fn has_registered_webhook(credentials: &Credentials, external: &str) -> bool {
    credentials.iter().any(|c| c.external == external && c.binding != Binding::Install && Registered::of(c).id.is_some())
}

impl Registered {
    fn of(credential: &Credential) -> Registered {
        let field = |name: &str| credential.fields.get(name).filter(|v| !v.is_empty()).cloned();
        Registered {
            id: field(WEBHOOK_ID_FIELD),
            events: field(WEBHOOK_EVENTS_FIELD).map(|e| e.split(',').map(str::to_string).collect()).unwrap_or_default(),
            url: field(WEBHOOK_URL_FIELD),
        }
    }
}

/// Each credential the external's webhooks are kept under, with the events
/// its connection's listens need: each listen's `events`, else the module's
/// default subscription, else everything it can subscribe to. A listen's
/// credential is its construction's, else the external's user credential
/// (None when it has none). Every other credential of the external that
/// holds a webhook wants no events, so its webhook is removed.
fn wanted_events(set: &FileSet, running: &RunningExternal, credentials: &Credentials) -> BTreeMap<Option<String>, Vec<String>> {
    let name = &running.external.manifest.name;
    let declared = |key: &str| -> Vec<String> {
        running.listen.get(key).and_then(Js::as_array).into_iter().flatten().filter_map(Js::as_str).map(str::to_string).collect()
    };
    let fallback = {
        let defaults = declared("defaultSubscribedEvents");
        if defaults.is_empty() { declared("subscribableEvents") } else { defaults }
    };
    let mut wanted: BTreeMap<Option<String>, BTreeSet<String>> = BTreeMap::new();
    for listen in set.listens.iter().filter(|l| l.adapter == *name) {
        let credential = listen.credential.clone().or_else(|| credential_for(credentials, name).map(|c| c.name.clone()));
        let events = wanted.entry(credential).or_default();
        match listen.config.get("events").and_then(Js::as_array) {
            Some(named) => events.extend(named.iter().filter_map(Js::as_str).map(str::to_string)),
            None => events.extend(fallback.iter().cloned()),
        }
    }
    for registered in credentials.iter().filter(|c| c.external == *name && c.binding != Binding::Install && Registered::of(c).id.is_some()) {
        wanted.entry(Some(registered.name.clone())).or_default();
    }
    wanted.into_iter().map(|(credential, events)| (credential, events.into_iter().collect())).collect()
}

/// One webhook to reconcile: the external's, kept under `credential`, for `events`.
struct Webhook {
    external: String,
    credential: Option<String>,
    events: Vec<String>,
    /// How its lines name it: the external, and the credential when the
    /// external's webhooks are kept under more than one.
    label: String,
}

/// The external's webhooks, as `wanted` (wanted_events) has them.
fn webhooks_of(external: &str, wanted: BTreeMap<Option<String>, Vec<String>>) -> Vec<Webhook> {
    let several = wanted.len() > 1;
    wanted
        .into_iter()
        .map(|(credential, events)| {
            let label = match (&credential, several) {
                (Some(credential), true) => format!("{external} as {credential}"),
                _ => external.to_string(),
            };
            Webhook { external: external.to_string(), credential, events, label }
        })
        .collect()
}

/// The externals in `set` whose webhook lf registers.
fn registering(set: &FileSet) -> impl Iterator<Item = &RunningExternal> {
    set.running.iter().map(|r| &**r).filter(|r| !r.is_plugin() && r.methods.iter().any(|m| m == "ensureEventSubscription") && inbound_of(r).is_some())
}

/// The failures a session's registrations last met, by external: a refresh
/// tries each again, and says one only when its message is new.
#[derive(Default)]
pub struct Registrations {
    failed: RefCell<BTreeMap<String, String>>,
}

impl Registrations {
    /// `line`, unless it is the very failure last said for `name`.
    fn failure(&self, name: &str, line: String) -> Option<String> {
        let said = self.failed.borrow_mut().insert(name.to_string(), line.clone());
        (said.as_ref() != Some(&line)).then_some(line)
    }

    fn success(&self, name: &str) {
        self.failed.borrow_mut().remove(name);
    }

    fn failing(&self, name: &str) -> bool {
        self.failed.borrow().contains_key(name)
    }
}

/// Register or remove each external's webhooks, as its listens need (`lf
/// serve` starting); a line per webhook it touched. One that fails is said
/// and the rest go on: the doors still answer whatever is registered.
pub async fn reconcile(session: &Session) -> Vec<String> {
    let secrets = session.secrets();
    let set = session.file_set();
    let webhooks = registering(&set).flat_map(|r| webhooks_of(&r.external.manifest.name, wanted_events(&set, r, secrets.credentials()))).collect();
    register(session, webhooks).await
}

/// A refresh's registrations: each webhook whose listens want other events
/// in `after` than in `before`, and each whose last registration failed. A
/// failure is said once per message; a success is always said.
pub async fn follow_refresh(session: &Session, before: &FileSet, after: &FileSet) -> Vec<String> {
    let secrets = session.secrets();
    let credentials = secrets.credentials();
    let webhooks = registering(after)
        .flat_map(|r| {
            let before = wanted_events(before, r, credentials);
            webhooks_of(&r.external.manifest.name, wanted_events(after, r, credentials))
                .into_iter()
                .filter(move |w| session.registrations.failing(&w.label) || before.get(&w.credential) != Some(&w.events))
        })
        .collect();
    register(session, webhooks).await
}

async fn register(session: &Session, webhooks: Vec<Webhook>) -> Vec<String> {
    let mut lines = Vec::new();
    let mut changed = false;
    for webhook in webhooks {
        let label = &webhook.label;
        match reconcile_one(session, &webhook).await {
            Ok(outcome) => {
                session.registrations.success(label);
                if let Some((line, wrote)) = outcome {
                    changed |= wrote;
                    lines.push(format!("{label}: {line}"));
                }
            }
            Err(message) => lines.extend(session.registrations.failure(label, format!("{label}: its webhook is not registered — {message}"))),
        }
    }
    if changed && let Err(message) = session.reload_secrets() {
        lines.push(format!("the secrets could not be read again after the webhooks changed: {message}"));
    }
    lines
}

/// One webhook: the line to print and whether its credential changed; None
/// when it has nothing registered and no listen.
async fn reconcile_one(session: &Session, webhook: &Webhook) -> Result<Option<(String, bool)>, String> {
    let set = session.file_set();
    let secrets = session.secrets();
    let credentials = secrets.credentials();
    let name = webhook.external.as_str();
    let running = set.running.iter().find(|r| r.external.manifest.name == name).ok_or("not running")?;
    let wanted = &webhook.events;
    let Some(credential) = webhook.credential.as_ref().and_then(|named| credentials.iter().find(|c| c.name == *named)) else {
        let missing = match &webhook.credential {
            Some(named) => format!("no credential \"{named}\" in the secrets to register its webhook under"),
            None => format!("no credential to register its webhook under: lf credential add --module {name} <name>"),
        };
        return Ok((!wanted.is_empty()).then_some((missing, false)));
    };
    let registered = Registered::of(credential);
    let setup = inbound_of(running).ok_or("it takes no webhooks")?;
    let provider = setup.declaration.provider_key.clone();
    let issued_by_provider = setup.declaration.secret_from_provider;
    let secret_field = setup.secret_field;
    let call = |method: &'static str, params: serde_json::Value| async move {
        let raw = rpc_as(running, credentials, Some(credential), LOCAL_TENANT, method, params).await?;
        module_wire::results::check(method, name, &raw)
    };

    if wanted.is_empty() {
        let Some(id) = registered.id else { return Ok(None) };
        let url = registered.url.clone().unwrap_or_default();
        call("removeEventSubscription", serde_json::json!({ "callbackUrl": url, "externalId": id })).await?;
        // Its secret too: nothing is delivered to that door now.
        forget(credential, &[WEBHOOK_ID_FIELD, WEBHOOK_EVENTS_FIELD, WEBHOOK_URL_FIELD, &secret_field]).await?;
        return Ok(Some((format!("no listen needs its webhook any more; removed webhook {id}"), true)));
    }
    let Some(public) = session.project.public_url.as_deref() else {
        return Ok(Some((format!("set publicUrl in lf.yaml to where {name} reaches lf serve; its webhook is not registered"), false)));
    };
    let callback = format!("{}/api/public/webhook-sync/{provider}/{}", public.trim_end_matches('/'), credential.name);

    // Another URL: the webhook there is replaced, not moved.
    let mut current = registered.id.clone().map(|id| (id, registered.events.clone()));
    if let (Some((id, _)), Some(url)) = (&current, &registered.url)
        && *url != callback
    {
        call("removeEventSubscription", serde_json::json!({ "callbackUrl": url, "externalId": id })).await?;
        current = None;
    }
    let mut params = serde_json::json!({ "events": wanted, "callbackUrl": callback });
    if let Some((id, events)) = &current {
        params["current"] = serde_json::json!({ "externalId": id, "events": events });
    }
    let had_webhook = current.is_some();
    let answer = call("ensureEventSubscription", params).await?;
    let events = wanted.join(",");
    if answer == Js::Null {
        let id = current.map(|(id, _)| id).unwrap_or_default();
        return Ok(Some((format!("webhook {id} is registered for {events} at {callback}"), false)));
    }
    let id = answer.get("externalId").and_then(Js::as_str).map(str::to_string).or(current.map(|(id, _)| id)).unwrap_or_default();
    let mut fields = vec![(WEBHOOK_ID_FIELD.to_string(), id.clone()), (WEBHOOK_EVENTS_FIELD.to_string(), events.clone()), (WEBHOOK_URL_FIELD.to_string(), callback.clone())];
    let issued = answer.get("secret").and_then(Js::as_str).filter(|s| !s.is_empty());
    // The provider issues the secret (`secretIssuedBy: provider`) and none is
    // held: nothing could verify a delivery, so the webhook is withdrawn.
    let held = credential.fields.get(&secret_field).is_some_and(|s| !s.is_empty()) && had_webhook;
    if issued_by_provider && issued.is_none() && !held {
        call("removeEventSubscription", serde_json::json!({ "callbackUrl": callback, "externalId": id })).await?;
        return Ok(Some((format!("registering its webhook returned no secret, and {name} issues the secret deliveries are signed with: withdrawn, as none could be verified"), false)));
    }
    if let Some(secret) = issued {
        fields.push((secret_field, secret.to_string()));
    }
    keep(credential, fields).await?;
    Ok(Some((format!("registered webhook {id} for {events} at {callback}"), true)))
}

/// The secrets module holding the credential's entry, as written by lf.
fn writable(credential: &Credential) -> Result<std::rc::Rc<dyn SecretsStore>, String> {
    let held = credential.origin.slot_ref.is_some() && credential.origin.env_fields.is_empty();
    match crate::secrets_slot::installed() {
        Some(store) if held => Ok(store),
        _ => Err(format!("credential \"{}\" comes from the environment, which lf cannot write the registration to", credential.name)),
    }
}

/// The credential's entry, its other fields kept.
async fn keep(credential: &Credential, fields: Vec<(String, String)>) -> Result<(), String> {
    let replaced = writable(credential)?.replace(&credential.name, &|stored| Ok(spread(stored.unwrap_or_default(), fields.clone()))).await;
    replaced.map_err(|e| e.refusal_for_webhook())
}

async fn forget(credential: &Credential, names: &[&str]) -> Result<(), String> {
    let replaced = writable(credential)?.replace(&credential.name, &|stored| Ok(stored.unwrap_or_default().into_iter().filter(|(k, _)| !names.contains(&k.as_str())).collect())).await;
    replaced.map_err(|e| e.refusal_for_webhook())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::doors::tests::{InboxProject, TWO_CONNECTIONS, TWO_CREDENTIALS, in_local};

    #[test]
    fn each_connection_registers_its_own_webhook_for_its_own_events_as_itself() {
        let project = InboxProject::with(TWO_CONNECTIONS, TWO_CREDENTIALS, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            let mut lines = reconcile(&session).await;
            lines.sort();
            assert_eq!(
                lines,
                [
                    "inbox as inbox_a: registered webhook wh-1 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a",
                    "inbox as inbox_b: registered webhook wh-2 for note.created,note.updated at https://lf.example/api/public/webhook-sync/inbox/inbox_b",
                ]
            );
            let made: Vec<String> = project.registrations.lock().unwrap().iter().map(Js::to_json).collect();
            assert_eq!(
                made,
                [
                    r#"{"token":"a","callbackUrl":"https://lf.example/api/public/webhook-sync/inbox/inbox_a","events":["note.created"]}"#,
                    r#"{"token":"b","callbackUrl":"https://lf.example/api/public/webhook-sync/inbox/inbox_b","events":["note.created","note.updated"]}"#,
                ],
                "each webhook is registered as its own connection"
            );
        });
        // b's listen gone: its webhook is removed, as b; a's is left as it is.
        let movement = project.root.join("movements/noted.mvt");
        let only_a = TWO_CONNECTIONS.replace("listen to b { events: [\"note.created\", \"note.updated\"] } fire noted_b\n", "");
        std::fs::write(&movement, only_a).unwrap();
        in_local(async {
            let session = project.session().await;
            let mut lines = reconcile(&session).await;
            lines.sort();
            assert_eq!(
                lines,
                [
                    "inbox as inbox_a: webhook wh-1 is registered for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a",
                    "inbox as inbox_b: no listen needs its webhook any more; removed webhook wh-2",
                ]
            );
            let made = project.registrations.lock().unwrap();
            assert_eq!(made.last().map(Js::to_json).as_deref(), Some(r#"{"token":"b","removed":"wh-2"}"#));
        });
    }

    #[test]
    fn a_single_connection_registers_as_it_always_has() {
        let movement = "import { inbox } from adapters\n\ni = connect inbox\n\nfunction noted(note: <i-[:Note]->>) {\n  return \"seen\"\n}\n\nlisten to i { events: [\"note.created\"] } fire noted\n";
        let project = InboxProject::with(movement, "inbox:\n  external: inbox\n  webhook_secret: s\n  token: t\n", "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            assert_eq!(reconcile(&session).await, ["inbox: registered webhook wh-1 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox"]);
            assert_eq!(reconcile(&session).await, ["inbox: webhook wh-1 is registered for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox"]);
        });
    }

    #[test]
    fn a_failure_is_said_once_per_message_and_again_after_a_success() {
        let registrations = Registrations::default();
        assert_eq!(registrations.failure("attio", "down".into()).as_deref(), Some("down"));
        assert!(registrations.failing("attio"), "tried again at the next refresh");
        assert_eq!(registrations.failure("attio", "down".into()), None, "the same failure again is not said");
        assert_eq!(registrations.failure("attio", "refused".into()).as_deref(), Some("refused"), "a new message is");
        assert_eq!(registrations.failure("slack", "down".into()).as_deref(), Some("down"), "each external its own");
        registrations.success("attio");
        assert!(!registrations.failing("attio"));
        assert_eq!(registrations.failure("attio", "refused".into()).as_deref(), Some("refused"), "after a success it is news again");
    }
}

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
//!
//! A module that declares `subscriptionScopeKeys` (Airtable: a webhook
//! watches one base and table) has a webhook per credential AND scope, the
//! scope being a listen's config values of those keys, sent as the calls'
//! `scope` as the platform sends it. Each is kept in the credential's
//! `webhook_subscriptions` record under its subscription key
//! (crate::routing::subscription_key), with its own secret, and its door
//! names it: `/api/public/webhook-sync/<provider>/<credential>/<key>`, with a
//! pull cursor of its own. A delivery there runs only the listens of that
//! credential and scope (crate::routing::Listen::hears_through). A module
//! that declares none keeps the one webhook per credential above, in the
//! credential's own fields, at the door it always had.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use crate::connect::spread;
use crate::doors::inbound_of;
use crate::externals::{RunningExternal, rpc_as};
use crate::check::LOCAL_TENANT;
use crate::json::{Js, Obj};
use crate::routing::{Scope, scope_of, subscription_key};
use crate::runs::{FileSet, Session};
use crate::secrets_slot::SecretsStore;
use crate::secrets::{Binding, Credential, Credentials, credential_for};

/// The source's id for the webhook it registered.
const WEBHOOK_ID_FIELD: &str = "webhook_id";
/// The events it is registered for, comma-separated.
const WEBHOOK_EVENTS_FIELD: &str = "webhook_events";
/// Where it delivers.
const WEBHOOK_URL_FIELD: &str = "webhook_url";
/// A credential's scoped webhooks (a module that declares
/// `subscriptionScopeKeys`): one JSON object, by subscription key, of each
/// one's `scope`, `id`, `events`, `url` and `secret`. The unscoped webhook
/// keeps the fields above, as it always has.
const WEBHOOK_SUBSCRIPTIONS_FIELD: &str = "webhook_subscriptions";

/// What one credential's entry holds of one registration.
#[derive(Default)]
struct Registered {
    id: Option<String>,
    events: Vec<String>,
    url: Option<String>,
    secret: Option<String>,
}

/// Whether `external` has a webhook registered under any of its
/// credentials: lf starts it then even when no movement imports it any
/// more, so the webhook is removed.
pub fn has_registered_webhook(credentials: &Credentials, external: &str) -> bool {
    credentials.iter().any(|c| c.external == external && c.binding != Binding::Install && !registered_channels(c).is_empty())
}

/// The scoped webhooks the credential's entry holds, by subscription key.
fn scoped_of(fields: impl Fn(&str) -> Option<String>) -> Obj {
    match fields(WEBHOOK_SUBSCRIPTIONS_FIELD).map(|text| Js::parse(text.as_bytes())) {
        Some(Ok(Js::Obj(scoped))) => scoped,
        _ => Obj::new(),
    }
}

fn credential_field(credential: &Credential) -> impl Fn(&str) -> Option<String> + '_ {
    |name| credential.fields.get(name).filter(|v| !v.is_empty()).cloned()
}

/// The secret a scoped webhook's deliveries are signed with, by its
/// subscription key: what the door verifies one with.
pub fn scoped_secret(credential: &Credential, key: &str) -> Option<String> {
    Registered::of(credential, key, "").secret
}

/// Whether the credential holds a scoped webhook under `key`.
pub fn has_scoped(credential: &Credential, key: &str) -> bool {
    scoped_of(credential_field(credential)).contains_key(key)
}

impl Registered {
    /// The registration under subscription `key` ("" the unscoped one, whose
    /// secret is the credential's `secret_field`).
    fn of(credential: &Credential, key: &str, secret_field: &str) -> Registered {
        let field = credential_field(credential);
        if key.is_empty() {
            return Registered {
                id: field(WEBHOOK_ID_FIELD),
                events: field(WEBHOOK_EVENTS_FIELD).map(|e| e.split(',').map(str::to_string).collect()).unwrap_or_default(),
                url: field(WEBHOOK_URL_FIELD),
                secret: field(secret_field),
            };
        }
        let scoped = scoped_of(field);
        let Some(record) = scoped.get(key) else { return Registered::default() };
        let text = |name: &str| record.get(name).and_then(Js::as_str).filter(|v| !v.is_empty()).map(str::to_string);
        Registered {
            id: text("id"),
            events: record.get("events").and_then(Js::as_array).unwrap_or_default().iter().filter_map(Js::as_str).map(str::to_string).collect(),
            url: text("url"),
            secret: text("secret"),
        }
    }
}

/// Every webhook the credential's entry holds: its subscription key ("" the
/// unscoped one) and scope.
fn registered_channels(credential: &Credential) -> Vec<(String, Scope)> {
    let field = credential_field(credential);
    let mut channels = Vec::new();
    if field(WEBHOOK_ID_FIELD).is_some() {
        channels.push((String::new(), Scope::new()));
    }
    for (key, record) in scoped_of(field) {
        let scope = match record.get("scope") {
            Some(Js::Obj(scope)) => scope.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect(),
            _ => Scope::new(),
        };
        channels.push((key, scope));
    }
    channels
}

/// One webhook subscription of an external: the credential it is kept under
/// and its subscription key ("" for a module that declares no scope keys).
type Channel = (Option<String>, String);

/// What a channel's listens want: its scope and their events.
struct Want {
    scope: Scope,
    events: BTreeSet<String>,
}

/// The external's webhook subscriptions, with the events each one's listens
/// need: each listen's `events`, else the module's default subscription,
/// else everything it can subscribe to. A listen's channel is its
/// credential (its construction's, else the external's user credential;
/// None when it has none) and its scope (its config's values of the module's
/// `subscriptionScopeKeys`, the platform's channel scope). Every other
/// webhook a credential of the external holds wants no events, so it is
/// removed. A listen whose config misses a scope key has no channel, and a
/// line saying so.
fn wanted(set: &FileSet, running: &RunningExternal, credentials: &Credentials) -> (BTreeMap<Channel, Want>, Vec<String>) {
    let name = &running.external.manifest.name;
    let declared = |key: &str| -> Vec<String> {
        running.listen.get(key).and_then(Js::as_array).into_iter().flatten().filter_map(Js::as_str).map(str::to_string).collect()
    };
    let fallback = {
        let defaults = declared("defaultSubscribedEvents");
        if defaults.is_empty() { declared("subscribableEvents") } else { defaults }
    };
    let scope_keys = running.subscription_scope_keys();
    let mut wanted: BTreeMap<Channel, Want> = BTreeMap::new();
    let mut notes = Vec::new();
    for listen in set.listens.iter().filter(|l| l.adapter == *name) {
        let scope = match scope_of(&listen.config, &scope_keys) {
            Ok(scope) => scope,
            Err(missing) => {
                let missing: Vec<String> = missing.iter().map(|k| format!("'{k}'")).collect();
                notes.push(format!("{name}: {} names no {} for its webhook, so none is registered for it", listen.pipeline(), missing.join(" or ")));
                continue;
            }
        };
        let credential = listen.credential.clone().or_else(|| credential_for(credentials, name).map(|c| c.name.clone()));
        let key = subscription_key(&scope);
        let want = wanted.entry((credential, key)).or_insert_with(|| Want { scope, events: BTreeSet::new() });
        match listen.config.get("events").and_then(Js::as_array) {
            Some(named) => want.events.extend(named.iter().filter_map(Js::as_str).map(str::to_string)),
            None => want.events.extend(fallback.iter().cloned()),
        }
    }
    for registered in credentials.iter().filter(|c| c.external == *name && c.binding != Binding::Install) {
        for (key, scope) in registered_channels(registered) {
            wanted.entry((Some(registered.name.clone()), key)).or_insert_with(|| Want { scope, events: BTreeSet::new() });
        }
    }
    (wanted, notes)
}

/// One webhook to reconcile: the external's, kept under `credential`, for
/// `scope` (under its subscription `key`, "" when unscoped), for `events`.
struct Webhook {
    external: String,
    credential: Option<String>,
    key: String,
    scope: Scope,
    events: Vec<String>,
    /// How its lines name it: the external, the credential when the
    /// external's webhooks are kept under more than one, and the scope.
    label: String,
}

/// The external's webhooks, as `wanted` has them.
fn webhooks_of(external: &str, wanted: BTreeMap<Channel, Want>) -> Vec<Webhook> {
    let several = wanted.keys().map(|(credential, _)| credential).collect::<BTreeSet<_>>().len() > 1;
    wanted
        .into_iter()
        .map(|((credential, key), want)| {
            let mut label = match (&credential, several) {
                (Some(credential), true) => format!("{external} as {credential}"),
                _ => external.to_string(),
            };
            if !want.scope.is_empty() {
                let scope: Vec<String> = want.scope.iter().map(|(k, v)| format!("{k} {v}")).collect();
                label.push_str(&format!(" ({})", scope.join(", ")));
            }
            Webhook { external: external.to_string(), credential, key, scope: want.scope, events: want.events.into_iter().collect(), label }
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
    let mut lines = Vec::new();
    let mut webhooks = Vec::new();
    for running in registering(&set) {
        let (wanted, notes) = wanted(&set, running, secrets.credentials());
        lines.extend(notes);
        webhooks.extend(webhooks_of(&running.external.manifest.name, wanted));
    }
    lines.extend(register(session, webhooks).await);
    lines
}

/// A refresh's registrations: each webhook whose listens want other events
/// in `after` than in `before`, and each whose last registration failed. A
/// failure is said once per message; a success is always said, and so is a
/// listen the refresh left without a scope.
pub async fn follow_refresh(session: &Session, before: &FileSet, after: &FileSet) -> Vec<String> {
    let secrets = session.secrets();
    let credentials = secrets.credentials();
    let mut lines = Vec::new();
    let mut webhooks = Vec::new();
    for running in registering(after) {
        let (was, said) = wanted(before, running, credentials);
        let (now, notes) = wanted(after, running, credentials);
        lines.extend(notes.into_iter().filter(|note| !said.contains(note)));
        let changed = webhooks_of(&running.external.manifest.name, now).into_iter().filter(|w| {
            let before = was.get(&(w.credential.clone(), w.key.clone())).map(|want| want.events.iter().cloned().collect::<Vec<_>>());
            session.registrations.failing(&w.label) || before.as_ref() != Some(&w.events)
        });
        webhooks.extend(changed);
    }
    lines.extend(register(session, webhooks).await);
    lines
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

/// The scope as the module's `scope` param and the stored record hold it.
fn scope_js(scope: &Scope) -> Js {
    Js::Obj(scope.iter().map(|(k, v)| (k.clone(), Js::str(v))).collect())
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
    let setup = inbound_of(running).ok_or("it takes no webhooks")?;
    let provider = setup.declaration.provider_key.clone();
    let issued_by_provider = setup.declaration.secret_from_provider;
    let secret_field = setup.secret_field;
    let registered = Registered::of(credential, &webhook.key, &secret_field);
    let kept = Kept { credential, key: &webhook.key, secret_field: &secret_field };
    let call = |method: &'static str, params: serde_json::Value| async move {
        let raw = rpc_as(running, credentials, Some(credential), LOCAL_TENANT, method, params).await?;
        module_wire::results::check(method, name, &raw)
    };
    // The scope rides every call of a scoped webhook (the platform's `scope`).
    let scoped = |mut params: serde_json::Value| {
        if !webhook.scope.is_empty() {
            params["scope"] = crate::wire::json_of_js(&scope_js(&webhook.scope));
        }
        params
    };

    if wanted.is_empty() {
        let Some(id) = registered.id else { return Ok(None) };
        let url = registered.url.clone().unwrap_or_default();
        call("removeEventSubscription", scoped(serde_json::json!({ "callbackUrl": url, "externalId": id }))).await?;
        // Its secret too: nothing is delivered to that door now.
        kept.forget().await?;
        return Ok(Some((format!("no listen needs its webhook any more; removed webhook {id}"), true)));
    }
    let Some(public) = session.project.public_url.as_deref() else {
        return Ok(Some((format!("set publicUrl in lf.yaml to where {name} reaches lf serve; its webhook is not registered"), false)));
    };
    // A scoped webhook's door names its subscription after the credential.
    let mut callback = format!("{}/api/public/webhook-sync/{provider}/{}", public.trim_end_matches('/'), credential.name);
    if !webhook.key.is_empty() {
        callback.push_str(&format!("/{}", webhook.key));
    }

    // Another URL: the webhook there is replaced, not moved.
    let mut current = registered.id.clone().map(|id| (id, registered.events.clone()));
    if let (Some((id, _)), Some(url)) = (&current, &registered.url)
        && *url != callback
    {
        call("removeEventSubscription", scoped(serde_json::json!({ "callbackUrl": url, "externalId": id }))).await?;
        current = None;
    }
    let mut params = scoped(serde_json::json!({ "events": wanted, "callbackUrl": callback }));
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
    let issued = answer.get("secret").and_then(Js::as_str).filter(|s| !s.is_empty());
    // The provider issues the secret (`secretIssuedBy: provider`) and none is
    // held: nothing could verify a delivery, so the webhook is withdrawn.
    let held = registered.secret.is_some() && had_webhook;
    if issued_by_provider && issued.is_none() && !held {
        call("removeEventSubscription", scoped(serde_json::json!({ "callbackUrl": callback, "externalId": id }))).await?;
        return Ok(Some((format!("registering its webhook returned no secret, and {name} issues the secret deliveries are signed with: withdrawn, as none could be verified"), false)));
    }
    let secret = issued.map(str::to_string).or(registered.secret);
    kept.keep(Registration { scope: &webhook.scope, id: &id, events: wanted, url: &callback, secret: secret.as_deref() }).await?;
    Ok(Some((format!("registered webhook {id} for {events} at {callback}"), true)))
}

/// A registration as it is kept.
struct Registration<'a> {
    scope: &'a Scope,
    id: &'a str,
    events: &'a [String],
    url: &'a str,
    secret: Option<&'a str>,
}

/// Where one webhook's registration is kept: the credential's flat fields
/// for the unscoped one, its record in `webhook_subscriptions` for a scoped one.
struct Kept<'a> {
    credential: &'a Credential,
    key: &'a str,
    secret_field: &'a str,
}

impl Kept<'_> {
    async fn keep(&self, registration: Registration<'_>) -> Result<(), String> {
        if self.key.is_empty() {
            let mut fields = vec![
                (WEBHOOK_ID_FIELD.to_string(), registration.id.to_string()),
                (WEBHOOK_EVENTS_FIELD.to_string(), registration.events.join(",")),
                (WEBHOOK_URL_FIELD.to_string(), registration.url.to_string()),
            ];
            if let Some(secret) = registration.secret {
                fields.push((self.secret_field.to_string(), secret.to_string()));
            }
            return replace(self.credential, &|stored| spread(stored, fields.clone())).await;
        }
        let mut record = crate::obj! {
            "scope" => scope_js(registration.scope),
            "id" => Js::str(registration.id),
            "events" => Js::strings(registration.events),
            "url" => Js::str(registration.url),
        };
        if let Some(secret) = registration.secret {
            record.insert("secret".into(), Js::str(secret));
        }
        let record = Js::Obj(record);
        replace(self.credential, &|stored| with_scoped(stored, self.key, Some(record.clone()))).await
    }

    async fn forget(&self) -> Result<(), String> {
        if self.key.is_empty() {
            let names = [WEBHOOK_ID_FIELD, WEBHOOK_EVENTS_FIELD, WEBHOOK_URL_FIELD, self.secret_field];
            return replace(self.credential, &|stored| stored.into_iter().filter(|(k, _)| !names.contains(&k.as_str())).collect()).await;
        }
        replace(self.credential, &|stored| with_scoped(stored, self.key, None)).await
    }
}

/// The entry with its scoped webhook `key` set to `record`, or dropped;
/// the field itself dropped when it holds none.
fn with_scoped(stored: Vec<(String, String)>, key: &str, record: Option<Js>) -> Vec<(String, String)> {
    let mut scoped = scoped_of(|name| stored.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()));
    match record {
        Some(record) => {
            scoped.insert(key.to_string(), record);
        }
        None => {
            scoped.shift_remove(key);
        }
    }
    let others = stored.into_iter().filter(|(k, _)| k != WEBHOOK_SUBSCRIPTIONS_FIELD).collect();
    if scoped.is_empty() {
        return others;
    }
    spread(others, vec![(WEBHOOK_SUBSCRIPTIONS_FIELD.to_string(), Js::Obj(scoped).to_json())])
}

/// The secrets module holding the credential's entry, as written by lf.
fn writable(credential: &Credential) -> Result<std::rc::Rc<dyn SecretsStore>, String> {
    let held = credential.origin.slot_ref.is_some() && credential.origin.env_fields.is_empty();
    match crate::secrets_slot::installed() {
        Some(store) if held => Ok(store),
        _ => Err(format!("credential \"{}\" comes from the environment, which lf cannot write the registration to", credential.name)),
    }
}

/// The credential's entry, as `next` makes it of the stored one.
async fn replace(credential: &Credential, next: &dyn Fn(Vec<(String, String)>) -> Vec<(String, String)>) -> Result<(), String> {
    let replaced = writable(credential)?.replace(&credential.name, &|stored| Ok(next(stored.unwrap_or_default()))).await;
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

    /// One connection of the scoped inbox, its listens on the shelves named.
    fn on_shelves(shelves: &[&str]) -> String {
        let mut movement = "import { inbox } from adapters\nimport { inbox_a } from credentials\n\ni = connect inbox using inbox_a\n".to_string();
        for shelf in shelves {
            movement.push_str(&format!("\nfunction noted_{shelf}(note: <i-[:Note]->>) {{\n  return \"{shelf}\"\n}}\n\nlisten to i {{ shelf: \"{shelf}\" }} fire noted_{shelf}\n"));
        }
        movement
    }

    const SCOPED_SECRETS: &str = "inbox_a:\n  external: inbox\n  webhook_secret: secret-a\n  token: a\n";

    /// A delivery of a note to `subscription`'s door, signed with `secret`:
    /// its answer's status and the movements it ran.
    async fn delivered(session: &Session, subscription: &str, secret: &str, id: &str) -> (u16, Vec<String>) {
        let body = br#"{"notes":[{"id":"n-1","Title":"hello"}]}"#;
        let mut mac = <hmac::Hmac<sha2::Sha256> as hmac::KeyInit>::new_from_slice(secret.as_bytes()).unwrap();
        hmac::Mac::update(&mut mac, body);
        let signature: String = hmac::Mac::finalize(mac).into_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let headers = vec![("x-listen-fire-signature".to_string(), signature), ("x-inbox-delivery".to_string(), id.to_string())];
        let delivery = crate::inbound::Delivery { provider: "inbox", subscription_id: subscription, raw_body: body, headers: &headers, method: "POST", path: "", query: "", source: crate::store::DeliverySource::Webhook };
        let (answer, fired) = crate::doors::deliver_inline(session, delivery, &|| {}).await;
        let mut movements: Vec<String> = fired.outcomes.into_iter().map(|o| o.movement).collect();
        movements.sort();
        (answer.status, movements)
    }

    #[test]
    fn each_scope_of_one_connection_has_its_own_webhook_door_and_secret() {
        // A webhook the credential held before its module scoped them: no
        // listen is unscoped now, so it is removed.
        let held = format!("{SCOPED_SECRETS}  webhook_id: wh-0\n  webhook_events: note.created\n  webhook_url: https://lf.example/api/public/webhook-sync/inbox/inbox_a\n");
        let project = InboxProject::scoped(&on_shelves(&["red", "blue"]), &held, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            let mut lines = reconcile(&session).await;
            lines.sort();
            assert_eq!(
                lines,
                [
                    "inbox (shelf blue): registered webhook wh-2 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/blue",
                    "inbox (shelf red): registered webhook wh-3 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/red",
                    "inbox: no listen needs its webhook any more; removed webhook wh-0",
                ]
            );
            let made: Vec<String> = project.registrations.lock().unwrap().iter().map(Js::to_json).collect();
            assert_eq!(
                made,
                [
                    r#"{"token":"a","removed":"wh-0"}"#,
                    r#"{"token":"a","callbackUrl":"https://lf.example/api/public/webhook-sync/inbox/inbox_a/blue","events":["note.created"],"scope":{"shelf":"blue"}}"#,
                    r#"{"token":"a","callbackUrl":"https://lf.example/api/public/webhook-sync/inbox/inbox_a/red","events":["note.created"],"scope":{"shelf":"red"}}"#,
                ],
                "each scope's webhook is registered with its scope, at a door of its own"
            );

            // Each door takes its own secret, and runs its own shelf's listen.
            assert_eq!(delivered(&session, "inbox_a/red", "secret-red", "d-1").await, (200, vec!["noted_red".to_string()]));
            assert_eq!(delivered(&session, "inbox_a/blue", "secret-blue", "d-2").await, (200, vec!["noted_blue".to_string()]));
            assert_eq!(delivered(&session, "inbox_a/red", "secret-blue", "d-3").await.0, 401, "another scope's secret");
            assert_eq!(delivered(&session, "inbox_a/green", "secret-a", "d-4").await.0, 404, "a scope with no webhook has no door");
            // The credential's own door went with its unscoped webhook, and its secret with it.
            assert_eq!(delivered(&session, "inbox_a", "secret-a", "d-5").await.0, 401);
            let receipts = session.store.deliveries(&crate::store::DeliveryQuery { subscription_id: None, since: None, limit: 10 }).unwrap();
            let red = receipts.iter().find(|r| r.external_id.as_deref() == Some("d-1")).unwrap();
            assert_eq!(red.subscription_id, "inbox_a/red");
            let events = session.store.delivery(&red.id).unwrap().unwrap().events.unwrap();
            assert_eq!(events[0].get("subscription"), Some(&Js::str("red")), "a kept event names its subscription, for a replay");
        });

        // The red listen gone: only its webhook is removed, as red.
        std::fs::write(project.root.join("movements/noted.mvt"), on_shelves(&["blue"])).unwrap();
        in_local(async {
            let session = project.session().await;
            let mut lines = reconcile(&session).await;
            lines.sort();
            assert_eq!(
                lines,
                [
                    "inbox (shelf blue): webhook wh-2 is registered for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/blue",
                    "inbox (shelf red): no listen needs its webhook any more; removed webhook wh-3",
                ]
            );
            assert_eq!(project.registrations.lock().unwrap().last().map(Js::to_json).as_deref(), Some(r#"{"token":"a","removed":"wh-3","scope":{"shelf":"red"}}"#));
            assert_eq!(delivered(&session, "inbox_a/red", "secret-red", "d-6").await.0, 404, "its door is gone with it");
            assert_eq!(delivered(&session, "inbox_a/blue", "secret-blue", "d-7").await, (200, vec!["noted_blue".to_string()]));
        });
    }

    #[test]
    fn a_refresh_registers_or_removes_only_the_scope_it_changed() {
        let project = InboxProject::scoped(&on_shelves(&["red"]), SCOPED_SECRETS, "publicUrl: https://lf.example\n");
        let movement = project.root.join("movements/noted.mvt");
        in_local(async {
            let session = project.session().await;
            assert_eq!(reconcile(&session).await, ["inbox (shelf red): registered webhook wh-1 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/red"]);
            let before = session.file_set();
            std::fs::write(&movement, on_shelves(&["red", "blue"])).unwrap();
            let refreshed = project.session().await;
            assert_eq!(
                follow_refresh(&refreshed, &before, &refreshed.file_set()).await,
                ["inbox (shelf blue): registered webhook wh-2 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/blue"]
            );
            let before = refreshed.file_set();
            std::fs::write(&movement, on_shelves(&["blue"])).unwrap();
            let refreshed = project.session().await;
            assert_eq!(follow_refresh(&refreshed, &before, &refreshed.file_set()).await, ["inbox (shelf red): no listen needs its webhook any more; removed webhook wh-1"]);
            assert_eq!(project.registrations.lock().unwrap().len(), 3, "the blue webhook was left as it is");
        });
    }

    #[test]
    fn a_listen_that_names_no_scope_has_no_webhook_and_a_line_saying_so() {
        let movement = on_shelves(&["red"]).replace("{ shelf: \"red\" }", "{ events: [\"note.created\"] }");
        let project = InboxProject::scoped(&movement, SCOPED_SECRETS, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            assert_eq!(reconcile(&session).await, ["inbox: listen:noted:noted_red names no 'shelf' for its webhook, so none is registered for it"]);
            assert!(project.registrations.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn a_webhook_registered_before_scopes_is_kept_at_its_door() {
        let movement = "import { inbox } from adapters\n\ni = connect inbox\n\nfunction noted(note: <i-[:Note]->>) {\n  return \"seen\"\n}\n\nlisten to i { events: [\"note.created\"] } fire noted\n";
        let held = "inbox:\n  external: inbox\n  webhook_secret: s\n  token: t\n  webhook_id: wh-0\n  webhook_events: note.created\n  webhook_url: https://lf.example/api/public/webhook-sync/inbox/inbox\n";
        let project = InboxProject::with(movement, held, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            assert_eq!(reconcile(&session).await, ["inbox: webhook wh-0 is registered for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox"]);
            assert!(project.registrations.lock().unwrap().is_empty(), "nothing registered anew");
            assert_eq!(delivered(&session, "inbox", "s", "d-1").await, (200, vec!["noted".to_string()]));
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

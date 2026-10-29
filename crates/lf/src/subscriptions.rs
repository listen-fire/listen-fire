//! A source's webhook, registered at the source by `listen-fire serve` (the
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
//!
//! A source that lets a webhook lapse (Airtable's expire 7 days after their
//! last refresh) answers its `expiresAt`, kept with the registration, and
//! lists `refreshEventSubscription` (adapter protocol 2.4). Each such webhook
//! has a `refresh_subscription` work row, due a day before it expires, so
//! `listen-fire serve` refreshes it on its tick and `listen-fire drain` does in a deployment
//! that scales to zero (its wake slot told when the row is due). A refresh
//! that fails is said once and tried again; a webhook found lapsed is
//! registered anew, and its pull cursor starts again with the new webhook.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use crate::connect::spread;
use crate::units::{iso_of, ms_of};
use crate::doors::inbound_of;
use crate::externals::{RunningExternal, rpc_as};
use crate::check::LOCAL_TENANT;
use crate::json::{Js, Obj};
use crate::routing::{Scope, subscription_key};
use crate::runs::{FileSet, Session};
use crate::secrets_slot::SecretsStore;
use crate::secrets::{Binding, Credential, Credentials, credential_for};

/// The source's id for the webhook it registered.
const WEBHOOK_ID_FIELD: &str = "webhook_id";
/// The events it is registered for, comma-separated.
const WEBHOOK_EVENTS_FIELD: &str = "webhook_events";
/// Where it delivers.
const WEBHOOK_URL_FIELD: &str = "webhook_url";
/// When the unscoped webhook lapses unless refreshed (an ISO time).
const WEBHOOK_EXPIRES_FIELD: &str = "webhook_expires";
/// A credential's scoped webhooks (a module that declares
/// `subscriptionScopeKeys`): one JSON object, by subscription key, of each
/// one's `scope`, `id`, `events`, `url`, `secret` and `expires`. The
/// unscoped webhook keeps the fields above, as it always has.
const WEBHOOK_SUBSCRIPTIONS_FIELD: &str = "webhook_subscriptions";

/// What one credential's entry holds of one registration.
#[derive(Default)]
struct Registered {
    id: Option<String>,
    events: Vec<String>,
    url: Option<String>,
    secret: Option<String>,
    /// When the source lets it lapse unless refreshed.
    expires: Option<String>,
}

/// Whether `external` has a webhook registered under any of its
/// credentials: listen-fire starts it then even when no movement imports it any
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
                expires: field(WEBHOOK_EXPIRES_FIELD),
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
            expires: text("expires"),
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
        let scope = match listen.scope(&scope_keys) {
            Ok(scope) => scope,
            Err(_) if let Err(why) = &listen.address => {
                notes.push(format!("{name}: {} has no webhook: {why}", listen.pipeline()));
                continue;
            }
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
            let label = label_of(external, credential.as_deref().filter(|_| several), &want.scope);
            Webhook { external: external.to_string(), credential, key, scope: want.scope, events: want.events.into_iter().collect(), label }
        })
        .collect()
}

/// How a webhook's lines name it: the external, the credential when it is
/// one of several the external's webhooks are kept under, and the scope.
fn label_of(external: &str, credential: Option<&str>, scope: &Scope) -> String {
    let mut label = match credential {
        Some(credential) => format!("{external} as {credential}"),
        None => external.to_string(),
    };
    if !scope.is_empty() {
        let scope: Vec<String> = scope.iter().map(|(k, v)| format!("{k} {v}")).collect();
        label.push_str(&format!(" ({})", scope.join(", ")));
    }
    label
}

/// The externals in `set` whose webhook listen-fire registers.
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

/// Register or remove each external's webhooks, as its listens need (`listen-fire
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
    lines.extend(arm_refreshes(session));
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
    lines.extend(arm_refreshes(session));
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
            None => format!("no credential to register its webhook under: listen-fire credential add --module {name} <name>"),
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
        return Ok(Some((format!("set publicUrl in lf.yaml to where {name} reaches listen-fire serve; its webhook is not registered"), false)));
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
    let expires = answer.get("expiresAt").and_then(Js::as_str);
    kept.keep(Registration { scope: &webhook.scope, id: &id, events: wanted, url: &callback, secret: secret.as_deref(), expires }).await?;
    if let Some(expires) = expires.and_then(ms_of) {
        schedule_refresh(session, running, &Refreshing { credential: &credential.name, key: &webhook.key }, Some(refresh_due_ms(session.now_ms(), expires)))?;
    }
    // Another webhook than the one held (its events or its door changed):
    // its payload feed starts at its beginning, not at the old one's cursor.
    if registered.id.as_deref() != Some(id.as_str()) {
        session.store.save_inbound_checkpoint(&subscription_id(&credential.name, &webhook.key), &Js::Null).map_err(|e| e.to_string())?;
    }
    Ok(Some((format!("registered webhook {id} for {events} at {callback}"), true)))
}

// ── Refreshing a webhook the source lets lapse ──────────────────────────────

/// A webhook's refresh in the work queue (crate::store::WORK_KINDS).
pub const REFRESH_WORK_KIND: &str = "refresh_subscription";
const DAY_MS: i64 = 86_400_000;
/// How long after a failed refresh it is tried again.
const REFRESH_RETRY_MS: i64 = 15 * 60_000;

/// When a webhook that lapses at `expires_ms` is next refreshed: a day
/// before, or halfway there when less than two days are left (a shorter
/// lifetime is refreshed well inside it, never in a loop); now once lapsed.
pub fn refresh_due_ms(now_ms: i64, expires_ms: i64) -> i64 {
    let left = expires_ms - now_ms;
    if left <= 0 {
        return now_ms;
    }
    expires_ms - DAY_MS.min(left / 2)
}

/// Whether a webhook that lapses at `expires_ms` is refreshed now: a day or
/// less is left. A row that comes due earlier (another webhook's expiry was
/// kept since) waits for its time.
fn refresh_needed(now_ms: i64, expires_ms: i64) -> bool {
    expires_ms - now_ms <= DAY_MS
}

/// The webhook a refresh row names: its credential and subscription key
/// ("" for a module that declares no scope keys).
struct Refreshing<'a> {
    credential: &'a str,
    key: &'a str,
}

fn lists(running: &RunningExternal, method: &str) -> bool {
    running.methods.iter().any(|m| m == method)
}

/// Queue the webhook's refresh row due at `due_ms` (now for None), moving
/// one already queued.
fn schedule_refresh(session: &Session, running: &RunningExternal, webhook: &Refreshing<'_>, due_ms: Option<i64>) -> Result<(), String> {
    if !lists(running, "refreshEventSubscription") {
        return Ok(());
    }
    let (key, payload) = refresh_row_of(&running.external.manifest.name, webhook);
    let due = due_ms.map(iso_of);
    session.store.enqueue(REFRESH_WORK_KIND, &key, &payload, due.as_deref(), None).map_err(|e| e.to_string())?;
    crate::wake::queued(REFRESH_WORK_KIND, due.as_deref());
    Ok(())
}

/// The id a webhook's deliveries (receipts, pull cursor) are kept under: its
/// credential, then `/<key>` for a scoped one, as its door names it.
fn subscription_id(credential: &str, key: &str) -> String {
    if key.is_empty() { credential.to_string() } else { format!("{credential}/{key}") }
}

fn refresh_row_of(external: &str, webhook: &Refreshing<'_>) -> (String, Js) {
    let key = format!("{REFRESH_WORK_KIND}:{external}:{}/{}", webhook.credential, webhook.key);
    let payload = Js::Obj(crate::obj! { "external" => Js::str(external), "credential" => Js::str(webhook.credential), "key" => Js::str(webhook.key) });
    (key, payload)
}

/// Give each webhook a source lets lapse its refresh row, where none is: due
/// a day before the expiry kept with it, or now for one kept with none (one
/// registered before expiries were kept), so the refresh learns it.
pub fn arm_refreshes(session: &Session) -> Vec<String> {
    let set = session.file_set();
    let secrets = session.secrets();
    let now = session.now_ms();
    let mut lines = Vec::new();
    for running in registering(&set).filter(|r| lists(r, "refreshEventSubscription")) {
        let Some(setup) = inbound_of(running) else { continue };
        let name = &running.external.manifest.name;
        for credential in secrets.credentials().iter().filter(|c| c.external == *name && c.binding != Binding::Install) {
            for (key, _) in registered_channels(credential) {
                let registered = Registered::of(credential, &key, &setup.secret_field);
                let due = registered.expires.as_deref().and_then(ms_of).map(|expires| iso_of(refresh_due_ms(now, expires)));
                let (row, payload) = refresh_row_of(name, &Refreshing { credential: &credential.name, key: &key });
                match session.store.enqueue_if_absent(REFRESH_WORK_KIND, &row, &payload, due.as_deref(), None) {
                    Ok(true) => crate::wake::queued(REFRESH_WORK_KIND, due.as_deref()),
                    Ok(false) => {}
                    Err(e) => lines.push(format!("{name}: the refresh of webhook {} was not queued — {e}", registered.id.unwrap_or_default())),
                }
            }
        }
    }
    lines
}

/// A `refresh_subscription` row: refresh the webhook it names once a day or
/// less is left of it, or register it anew once it lapsed. When the row is
/// next due; None once there is nothing to refresh (the webhook removed, or
/// the source stating no expiry).
pub async fn refresh_row(session: &Session, payload: &Js) -> Result<Option<String>, String> {
    let text = |k: &str| payload.get(k).and_then(Js::as_str).map(str::to_string).ok_or_else(|| format!("a {REFRESH_WORK_KIND} row has no {k}"));
    let (external, credential, key) = (text("external")?, text("credential")?, text("key")?);
    let (line, next) = refresh_one(session, &external, &Refreshing { credential: &credential, key: &key }, session.now_ms()).await;
    if let Some(line) = line {
        eprintln!("listen-fire: {line}");
    }
    Ok(next.map(iso_of))
}

/// One webhook's refresh at `now_ms`: the line to say, and when it is next due.
async fn refresh_one(session: &Session, external: &str, webhook: &Refreshing<'_>, now_ms: i64) -> (Option<String>, Option<i64>) {
    let set = session.file_set();
    let secrets = session.secrets();
    let credentials = secrets.credentials();
    let Some(running) = set.running.iter().find(|r| r.external.manifest.name == external).filter(|r| lists(r, "refreshEventSubscription")) else { return (None, None) };
    let Some(setup) = inbound_of(running) else { return (None, None) };
    let Some(credential) = credentials.iter().find(|c| c.name == webhook.credential) else { return (None, None) };
    let registered = Registered::of(credential, webhook.key, &setup.secret_field);
    let Some(id) = registered.id.clone() else { return (None, None) };
    let scope = registered_channels(credential).into_iter().find(|(k, _)| k == webhook.key).map(|(_, scope)| scope).unwrap_or_default();
    let several = credentials.iter().filter(|c| c.external == external && c.binding != Binding::Install && !registered_channels(c).is_empty()).count() > 1;
    let label = label_of(external, Some(webhook.credential).filter(|_| several), &scope);
    // Its own key in the failures said, apart from its registration's.
    let said_as = format!("{label} refresh");
    let call = |method: &'static str, mut params: serde_json::Value| {
        if !scope.is_empty() {
            params["scope"] = crate::wire::json_of_js(&scope_js(&scope));
        }
        async move {
            let raw = rpc_as(running, credentials, Some(credential), LOCAL_TENANT, method, params).await?;
            module_wire::results::check(method, external, &raw)
        }
    };
    let expires = registered.expires.as_deref().and_then(ms_of);
    let retry = |message: String| (session.registrations.failure(&said_as, message), Some(now_ms + REFRESH_RETRY_MS));
    match expires {
        Some(expires) if expires <= now_ms => {
            // Lapsed: the source no longer delivers to it. Registered anew,
            // the lapsed one removed first where the source still holds it.
            let url = registered.url.clone().unwrap_or_default();
            let _ = call("removeEventSubscription", serde_json::json!({ "callbackUrl": url, "externalId": id })).await;
            let answer = match call("ensureEventSubscription", serde_json::json!({ "events": registered.events, "callbackUrl": url })).await {
                Ok(Js::Null) => return retry(format!("{label}: webhook {id} lapsed, and registering it anew registered nothing; trying again in 15 minutes")),
                Ok(answer) => answer,
                Err(message) => return retry(format!("{label}: webhook {id} lapsed, and registering it anew failed — {message}; trying again in 15 minutes")),
            };
            session.registrations.success(&said_as);
            let new_id = answer.get("externalId").and_then(Js::as_str).unwrap_or_default().to_string();
            let secret = answer.get("secret").and_then(Js::as_str).filter(|s| !s.is_empty()).map(str::to_string).or(registered.secret.clone());
            let new_expires = answer.get("expiresAt").and_then(Js::as_str);
            let kept = Kept { credential, key: webhook.key, secret_field: &setup.secret_field };
            let registration = Registration { scope: &scope, id: &new_id, events: &registered.events, url: &url, secret: secret.as_deref(), expires: new_expires };
            if let Err(message) = kept.keep(registration).await {
                return retry(format!("{label}: webhook {id} lapsed and was registered anew as {new_id}, which could not be kept — {message}"));
            }
            // The new webhook's payload feed starts at its beginning.
            let subscription = subscription_id(webhook.credential, webhook.key);
            let mut line = format!("{label}: webhook {id} lapsed at {}; registered webhook {new_id} for {} at {url}", iso_of(expires), registered.events.join(","));
            if let Err(e) = session.store.save_inbound_checkpoint(&subscription, &Js::Null) {
                line.push_str(&format!(" (its pull cursor was not reset: {e})"));
            }
            if let Err(message) = session.reload_secrets() {
                line.push_str(&format!(" (the secrets could not be read again: {message})"));
            }
            (Some(line), new_expires.and_then(ms_of).map(|e| refresh_due_ms(now_ms, e)))
        }
        Some(expires) if !refresh_needed(now_ms, expires) => (None, Some(refresh_due_ms(now_ms, expires))),
        _ => match call("refreshEventSubscription", serde_json::json!({ "externalId": id })).await {
            Ok(answer) => {
                session.registrations.success(&said_as);
                let new_expires = answer.get("expiresAt").and_then(Js::as_str);
                let kept = Kept { credential, key: webhook.key, secret_field: &setup.secret_field };
                let registration = Registration {
                    scope: &scope,
                    id: &id,
                    events: &registered.events,
                    url: registered.url.as_deref().unwrap_or_default(),
                    secret: registered.secret.as_deref(),
                    expires: new_expires,
                };
                if let Err(message) = kept.keep(registration).await {
                    return retry(format!("{label}: webhook {id} was refreshed, and its expiry could not be kept — {message}"));
                }
                let mut line = match new_expires {
                    Some(at) => format!("{label}: refreshed webhook {id}; it expires at {at}"),
                    None => format!("{label}: refreshed webhook {id}"),
                };
                if let Err(message) = session.reload_secrets() {
                    line.push_str(&format!(" (the secrets could not be read again: {message})"));
                }
                (Some(line), new_expires.and_then(ms_of).map(|e| refresh_due_ms(now_ms, e)))
            }
            Err(message) => retry(format!("{label}: refreshing webhook {id} failed — {message}; trying again in 15 minutes")),
        },
    }
}

/// A registration as it is kept.
struct Registration<'a> {
    scope: &'a Scope,
    id: &'a str,
    events: &'a [String],
    url: &'a str,
    secret: Option<&'a str>,
    expires: Option<&'a str>,
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
            fields.extend(registration.expires.map(|e| (WEBHOOK_EXPIRES_FIELD.to_string(), e.to_string())));
            // An expiry the source no longer states is not kept.
            let unexpiring = |stored: Vec<(String, String)>| stored.into_iter().filter(|(k, _)| k != WEBHOOK_EXPIRES_FIELD).collect();
            return replace(self.credential, &|stored| spread(unexpiring(stored), fields.clone())).await;
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
        if let Some(expires) = registration.expires {
            record.insert("expires".into(), Js::str(expires));
        }
        let record = Js::Obj(record);
        replace(self.credential, &|stored| with_scoped(stored, self.key, Some(record.clone()))).await
    }

    async fn forget(&self) -> Result<(), String> {
        if self.key.is_empty() {
            let names = [WEBHOOK_ID_FIELD, WEBHOOK_EVENTS_FIELD, WEBHOOK_URL_FIELD, WEBHOOK_EXPIRES_FIELD, self.secret_field];
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

/// The secrets module holding the credential's entry, as written by listen-fire.
fn writable(credential: &Credential) -> Result<std::rc::Rc<dyn SecretsStore>, String> {
    let held = credential.origin.slot_ref.is_some() && credential.origin.env_fields.is_empty();
    match crate::secrets_slot::installed() {
        Some(store) if held => Ok(store),
        _ => Err(format!("credential \"{}\" comes from the environment, which listen-fire cannot write the registration to", credential.name)),
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
    fn a_webhook_replaced_for_other_events_reads_its_feed_from_the_start() {
        let held = format!("{SCOPED_SECRETS}  webhook_subscriptions: '{{\"red\":{{\"scope\":{{\"shelf\":\"red\"}},\"id\":\"wh-0\",\"events\":[\"note.updated\"],\"url\":\"https://lf.example/api/public/webhook-sync/inbox/inbox_a/red\",\"secret\":\"secret-red\"}}}}'\n");
        let project = InboxProject::scoped(&on_shelves(&["red"]), &held, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            let cursor = Js::parse(br#"{"cursor":7}"#).unwrap();
            session.store.save_inbound_checkpoint("inbox_a/red", &cursor).unwrap();
            assert_eq!(reconcile(&session).await, ["inbox (shelf red): registered webhook wh-1 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/red"]);
            assert_eq!(session.store.inbound_checkpoint("inbox_a/red").unwrap(), None, "the new webhook's feed is read from its start");
            // The same webhook left as it is keeps its cursor.
            session.store.save_inbound_checkpoint("inbox_a/red", &cursor).unwrap();
            assert_eq!(reconcile(&session).await, ["inbox (shelf red): webhook wh-1 is registered for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/red"]);
            assert_eq!(session.store.inbound_checkpoint("inbox_a/red").unwrap(), Some(cursor));
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

    #[test]
    fn a_refresh_is_due_a_day_before_expiry_or_halfway_when_less_than_two_days_are_left() {
        let now = 1_800_000_000_000;
        assert_eq!(refresh_due_ms(now, now + 7 * DAY_MS), now + 6 * DAY_MS);
        assert_eq!(refresh_due_ms(now, now + 2 * DAY_MS), now + DAY_MS);
        assert_eq!(refresh_due_ms(now, now + DAY_MS), now + DAY_MS / 2);
        assert_eq!(refresh_due_ms(now, now + 4_000), now + 2_000, "a short lifetime is refreshed inside it");
        assert_eq!(refresh_due_ms(now, now), now, "lapsed: now");
        assert_eq!(refresh_due_ms(now, now - 5), now);
        for left in [7 * DAY_MS, 2 * DAY_MS, DAY_MS + 1, DAY_MS, 4_000] {
            let due = refresh_due_ms(now, now + left);
            assert!(refresh_needed(due, now + left), "at its due time a refresh is needed ({left})");
            assert_eq!(refresh_needed(now, now + left), left <= DAY_MS, "and before it only within a day ({left})");
        }
    }

    /// The refresh rows due by `at` (ms from now), claimed.
    fn refresh_rows_due_by(session: &Session, at: i64) -> Vec<String> {
        let kinds = [REFRESH_WORK_KIND.to_string()];
        let due_by = crate::store::iso(at);
        let claim = crate::store::ClaimDue { limit: 10, lease_ms: 1, due_by: Some(&due_by), kinds: Some(&kinds) };
        session.store.claim_due(&claim).unwrap().into_iter().map(|w| w.key).collect()
    }

    #[test]
    fn a_webhook_that_lapses_is_refreshed_before_it_does_and_registered_anew_once_it_has() {
        let project = InboxProject::expiring(&on_shelves(&["red"]), SCOPED_SECRETS, "publicUrl: https://lf.example\n", 7 * DAY_MS);
        let calls = || project.registrations.lock().unwrap().iter().map(Js::to_json).collect::<Vec<_>>();
        in_local(async {
            let session = project.session().await;
            assert_eq!(reconcile(&session).await, ["inbox (shelf red): registered webhook wh-1 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/red"]);
            // Kept with when it lapses, and its refresh queued a day before.
            let kept = |session: &Session| {
                let credential = session.secrets().credentials().iter().find(|c| c.name == "inbox_a").cloned().unwrap();
                Registered::of(&credential, "red", "webhook_secret")
            };
            let expires = ms_of(&kept(&session).expires.expect("its expiry is kept")).unwrap();
            assert!((expires - crate::limiter::now_ms() - 7 * DAY_MS).abs() < 60_000);
            assert_eq!(refresh_rows_due_by(&session, 6 * DAY_MS - 60_000), Vec::<String>::new());
            assert_eq!(refresh_rows_due_by(&session, 6 * DAY_MS + 60_000), ["refresh_subscription:inbox:inbox_a/red"]);

            let webhook = Refreshing { credential: "inbox_a", key: "red" };
            // A row that comes early waits for its time, asking nothing.
            let early = expires - 3 * DAY_MS;
            assert_eq!(refresh_one(&session, "inbox", &webhook, early).await, (None, Some(expires - DAY_MS)));
            assert_eq!(calls().len(), 1);

            // Within a day: refreshed, its new expiry kept, the next refresh a day before it.
            let now = expires - DAY_MS / 2;
            let (line, next) = refresh_one(&session, "inbox", &webhook, now).await;
            let refreshed = kept(&session).expires.unwrap();
            assert_eq!(line, Some(format!("inbox (shelf red): refreshed webhook wh-1; it expires at {refreshed}")));
            assert_eq!(next, Some(refresh_due_ms(now, ms_of(&refreshed).unwrap())));
            assert_eq!(calls().last().map(String::as_str), Some(r#"{"token":"a","refreshed":"wh-1"}"#));

            // A failing refresh is said once, and tried again in 15 minutes.
            project.down.store(true, std::sync::atomic::Ordering::SeqCst);
            let (said, again) = refresh_one(&session, "inbox", &webhook, now).await;
            assert!(said.is_some_and(|l| l.starts_with("inbox (shelf red): refreshing webhook wh-1 failed — ") && l.ends_with("; trying again in 15 minutes")));
            assert_eq!(again, Some(now + REFRESH_RETRY_MS));
            assert_eq!(refresh_one(&session, "inbox", &webhook, now).await, (None, Some(now + REFRESH_RETRY_MS)), "the same failure is not said again");
            project.down.store(false, std::sync::atomic::Ordering::SeqCst);

            // Lapsed: removed and registered anew (the inbox numbers a webhook by its calls so far), its secret and expiry kept.
            let lapsed = ms_of(&refreshed).unwrap() + 60_000;
            let (line, _) = refresh_one(&session, "inbox", &webhook, lapsed).await;
            assert_eq!(
                line,
                Some(format!("inbox (shelf red): webhook wh-1 lapsed at {}; registered webhook wh-4 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/red", iso_of(ms_of(&refreshed).unwrap())))
            );
            let now_kept = kept(&session);
            assert_eq!((now_kept.id.as_deref(), now_kept.secret.as_deref()), (Some("wh-4"), Some("secret-red")));
            assert!(now_kept.expires.is_some());
            assert_eq!(
                calls()[calls().len() - 2..],
                [
                    r#"{"token":"a","removed":"wh-1","scope":{"shelf":"red"}}"#.to_string(),
                    r#"{"token":"a","callbackUrl":"https://lf.example/api/public/webhook-sync/inbox/inbox_a/red","events":["note.created"],"scope":{"shelf":"red"}}"#.to_string(),
                ]
            );
            // The new webhook's door takes its deliveries.
            assert_eq!(delivered(&session, "inbox_a/red", "secret-red", "d-1").await, (200, vec!["noted_red".to_string()]));
        });
    }

    #[test]
    fn a_webhook_kept_with_no_expiry_is_refreshed_at_once_to_learn_it() {
        let held = format!("{SCOPED_SECRETS}  webhook_subscriptions: '{{\"red\":{{\"scope\":{{\"shelf\":\"red\"}},\"id\":\"wh-0\",\"events\":[\"note.created\"],\"url\":\"https://lf.example/api/public/webhook-sync/inbox/inbox_a/red\",\"secret\":\"secret-red\"}}}}'\n");
        let project = InboxProject::expiring(&on_shelves(&["red"]), &held, "publicUrl: https://lf.example\n", 7 * DAY_MS);
        in_local(async {
            let session = project.session().await;
            assert_eq!(reconcile(&session).await, ["inbox (shelf red): webhook wh-0 is registered for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a/red"]);
            assert_eq!(refresh_rows_due_by(&session, 1_000), ["refresh_subscription:inbox:inbox_a/red"], "due now");
        });
    }
}

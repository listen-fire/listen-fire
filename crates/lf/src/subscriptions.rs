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
//!
//! A listen on a traversal whose last edge the module pushes to the
//! connection or per scope (`delivery: connection` or `scope`, adapter
//! protocol 2.6) is subscribed for differently: one webhook per poll key
//! (crate::edge_polls::PollKey: connection, position, edge, the filter the
//! module takes and scope), shared by every listen on that key, registered
//! as `ensureEventSubscription({ edge, filter?, scope?, callbackUrl,
//! current? })`. Each is kept in the credential's `edge_subscriptions`
//! record under its key (crate::edge_polls::edge_subscription), with its own
//! secret, at its own door; a delivery there is judged only against the
//! listens sharing its key (crate::runs `fire_arrivals`). Every later call
//! about it (`removeEventSubscription`, `refreshEventSubscription`, the
//! registration anew once it lapsed) names its edge, filter and scope too.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use crate::connect::spread;
use crate::units::{iso_of, ms_of};
use crate::doors::inbound_of;
use crate::edge_polls::{edge_subscription, pushed_keys};
use crate::externals::{RunningExternal, rpc_in};
use crate::check::LOCAL_TENANT;
use crate::json::{Js, Obj};
use crate::routing::Scope;
use crate::runs::{FileSet, Session};
use crate::secrets_slot::SecretsStore;
use crate::secrets::{Binding, Credential, Credentials, credential_for};
use crate::wire::{js_of_json, json_of_js};

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
/// A credential's webhooks for the arrivals on an edge: one JSON object, by
/// key (crate::edge_polls::edge_subscription), of each one's `edge`,
/// `filter`, `scope`, `position`, `id`, `url`, `secret` and `expires`.
const EDGE_SUBSCRIPTIONS_FIELD: &str = "edge_subscriptions";

/// What one webhook is registered for, as every call about it says.
#[derive(Debug, Clone, PartialEq)]
enum Subscribed {
    /// The events of listens in the settings form, under their values of
    /// the module's `subscriptionScopeKeys` (empty for a module that
    /// declares none).
    Events(Scope),
    /// The arrivals on one edge, for the listens sharing one poll key.
    Arrivals(EdgeArrivals),
}

/// What a webhook for the arrivals on an edge is registered for.
#[derive(Debug, Clone, PartialEq)]
struct EdgeArrivals {
    edge: String,
    /// The part of the listens' WHERE on the edge the module takes.
    filter: Option<serde_json::Value>,
    /// The record the edge hangs off, by its id, for listens watched under one.
    scope: Option<String>,
    /// The connection's position, handed the module on each call about it.
    position: Option<serde_json::Value>,
}

impl Subscribed {
    /// `params` naming what the webhook is for: its scope, or its edge,
    /// filter and scope.
    fn on(&self, mut params: serde_json::Value) -> serde_json::Value {
        match self {
            Subscribed::Events(scope) => {
                if !scope.is_empty() {
                    params["scope"] = json_of_js(&scope_js(scope));
                }
            }
            Subscribed::Arrivals(arrivals) => {
                params["edge"] = serde_json::Value::String(arrivals.edge.clone());
                if let Some(filter) = &arrivals.filter {
                    params["filter"] = filter.clone();
                }
                if let Some(scope) = &arrivals.scope {
                    params["scope"] = serde_json::Value::String(scope.clone());
                }
            }
        }
        params
    }

    /// `ensureEventSubscription`'s params, `current` the registration held
    /// (its id and events). An edge's names no events.
    fn ensure(&self, events: &[String], callback: &str, current: Option<(&str, &[String])>) -> serde_json::Value {
        let mut params = serde_json::json!({ "callbackUrl": callback });
        match self {
            Subscribed::Events(_) => {
                params["events"] = serde_json::json!(events);
                if let Some((id, held)) = current {
                    params["current"] = serde_json::json!({ "externalId": id, "events": held });
                }
            }
            Subscribed::Arrivals(_) => {
                if let Some((id, _)) = current {
                    params["current"] = serde_json::json!({ "externalId": id });
                }
            }
        }
        self.on(params)
    }

    /// The position each call about it is made in.
    fn position(&self) -> Option<serde_json::Value> {
        match self {
            Subscribed::Events(_) => None,
            Subscribed::Arrivals(arrivals) => arrivals.position.clone(),
        }
    }

    /// What its lines say it is registered for.
    fn describe(&self, events: &[String]) -> String {
        match self {
            Subscribed::Events(_) => events.join(","),
            Subscribed::Arrivals(arrivals) => format!("the arrivals on {}", arrivals.edge),
        }
    }

    /// The credential's field a scoped registration of it is kept in, and
    /// what its record keeps of what it is for.
    fn kept_as(&self) -> (&'static str, Obj) {
        match self {
            Subscribed::Events(scope) => (WEBHOOK_SUBSCRIPTIONS_FIELD, crate::obj! { "scope" => scope_js(scope) }),
            Subscribed::Arrivals(arrivals) => {
                let mut record = crate::obj! { "edge" => Js::str(&arrivals.edge) };
                if let Some(filter) = &arrivals.filter {
                    record.insert("filter".into(), js_of_json(filter));
                }
                if let Some(scope) = &arrivals.scope {
                    record.insert("scope".into(), Js::str(scope));
                }
                if let Some(position) = &arrivals.position {
                    record.insert("position".into(), js_of_json(position));
                }
                (EDGE_SUBSCRIPTIONS_FIELD, record)
            }
        }
    }

    /// What a record kept in `field` is registered for.
    fn of_record(field: &str, record: &Js) -> Subscribed {
        if field == EDGE_SUBSCRIPTIONS_FIELD {
            return Subscribed::Arrivals(EdgeArrivals {
                edge: record.get("edge").and_then(Js::as_str).unwrap_or_default().to_string(),
                filter: record.get("filter").map(json_of_js),
                scope: record.get("scope").and_then(Js::as_str).map(str::to_string),
                position: record.get("position").map(json_of_js),
            });
        }
        let scope = match record.get("scope") {
            Some(Js::Obj(scope)) => scope.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect(),
            _ => Scope::new(),
        };
        Subscribed::Events(scope)
    }
}

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

/// The registrations the credential's entry holds in `field`, by key.
fn records_of(fields: impl Fn(&str) -> Option<String>, field: &str) -> Obj {
    match fields(field).map(|text| Js::parse(text.as_bytes())) {
        Some(Ok(Js::Obj(records))) => records,
        _ => Obj::new(),
    }
}

/// The fields a keyed registration may be kept in.
const KEYED_FIELDS: [&str; 2] = [WEBHOOK_SUBSCRIPTIONS_FIELD, EDGE_SUBSCRIPTIONS_FIELD];

/// The record of the credential's webhook under `key` (never ""), and the
/// field it is kept in.
fn record_of(credential: &Credential, key: &str) -> Option<(&'static str, Js)> {
    KEYED_FIELDS.into_iter().find_map(|field| Some((field, records_of(credential_field(credential), field).get(key)?.clone())))
}

fn credential_field(credential: &Credential) -> impl Fn(&str) -> Option<String> + '_ {
    |name| credential.fields.get(name).filter(|v| !v.is_empty()).cloned()
}

/// The secret a scoped webhook's deliveries are signed with, by its
/// subscription key: what the door verifies one with.
pub fn scoped_secret(credential: &Credential, key: &str) -> Option<String> {
    Registered::of(credential, key, "").secret
}

/// Whether the credential holds a scoped webhook, or one for an edge's
/// arrivals, under `key`.
pub fn has_scoped(credential: &Credential, key: &str) -> bool {
    record_of(credential, key).is_some()
}

/// Whether `key` names a webhook one of `external`'s credentials holds for
/// the arrivals on an edge: a delivery through it is judged only against
/// the listens sharing its poll key.
pub fn is_edge_webhook(credentials: &Credentials, external: &str, key: &str) -> bool {
    credentials.iter().filter(|c| c.external == external).any(|c| records_of(credential_field(c), EDGE_SUBSCRIPTIONS_FIELD).contains_key(key))
}

/// The head a webhook the credential holds for an edge's arrivals was made
/// for, by its key: None for one made for the whole connection, and for a
/// key that names no such webhook.
pub fn edge_webhook_head(credential: &Credential, key: &str) -> Option<String> {
    records_of(credential_field(credential), EDGE_SUBSCRIPTIONS_FIELD).get(key)?.get("scope")?.as_str().map(str::to_string)
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
        let Some((_, record)) = record_of(credential, key) else { return Registered::default() };
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
/// unscoped one) and what it is registered for.
fn registered_channels(credential: &Credential) -> Vec<(String, Subscribed)> {
    let field = credential_field(credential);
    let mut channels = Vec::new();
    if field(WEBHOOK_ID_FIELD).is_some() {
        channels.push((String::new(), Subscribed::Events(Scope::new())));
    }
    for kept_in in KEYED_FIELDS {
        for (key, record) in records_of(&field, kept_in) {
            channels.push((key, Subscribed::of_record(kept_in, &record)));
        }
    }
    channels
}

/// One webhook subscription of an external: the credential it is kept under
/// and its subscription key ("" for a module that declares no scope keys).
type Channel = (Option<String>, String);

/// A webhook a listen in the settings form registered before 0.13: its scope.
struct Want {
    scope: Scope,
}

/// The external's webhooks for the events of listens in the settings form,
/// each registered before 0.13 retired them: no listen wants their events
/// any more, so each is removed.
fn retired(running: &RunningExternal, credentials: &Credentials) -> BTreeMap<Channel, Want> {
    let name = &running.external.manifest.name;
    let mut retired = BTreeMap::new();
    for registered in credentials.iter().filter(|c| c.external == *name && c.binding != Binding::Install) {
        for (key, subscribed) in registered_channels(registered) {
            let Subscribed::Events(scope) = subscribed else { continue };
            retired.entry((Some(registered.name.clone()), key)).or_insert(Want { scope });
        }
    }
    retired
}

/// The external's webhooks for the arrivals on its pushed edges: one per
/// poll key its listens share (crate::edge_polls::pushed_keys), kept under
/// the key's credential (else the external's user credential), and each
/// one a credential holds that no listen shares any more, to be removed.
fn edge_webhooks(set: &FileSet, running: &RunningExternal, credentials: &Credentials) -> BTreeMap<Channel, Webhook> {
    let name = &running.external.manifest.name;
    let mut webhooks: BTreeMap<Channel, (Subscribed, bool)> = BTreeMap::new();
    for key in pushed_keys(set).into_keys().filter(|key| key.adapter == *name) {
        let credential = key.credential.clone().or_else(|| credential_for(credentials, name).map(|c| c.name.clone()));
        let arrivals = EdgeArrivals { edge: key.edge.clone(), filter: key.filter(), scope: key.scope.clone(), position: key.position_settings() };
        webhooks.insert((credential, edge_subscription(&key)), (Subscribed::Arrivals(arrivals), true));
    }
    for registered in credentials.iter().filter(|c| c.external == *name && c.binding != Binding::Install) {
        for (key, subscribed) in registered_channels(registered) {
            if matches!(subscribed, Subscribed::Arrivals(_)) {
                webhooks.entry((Some(registered.name.clone()), key)).or_insert((subscribed, false));
            }
        }
    }
    let several = webhooks.keys().map(|(credential, _)| credential).collect::<BTreeSet<_>>().len() > 1;
    webhooks
        .into_iter()
        .map(|((credential, key), (subscribed, needed))| {
            let label = label_of(name, credential.as_deref().filter(|_| several), &subscribed, &key);
            let webhook = Webhook { external: name.clone(), credential: credential.clone(), key: key.clone(), subscribed, events: Vec::new(), needed, label };
            ((credential, key), webhook)
        })
        .collect()
}

/// One webhook to reconcile: the external's, kept under `credential`, under
/// its subscription `key` ("" when unscoped), for what it is `subscribed`
/// to.
struct Webhook {
    external: String,
    credential: Option<String>,
    key: String,
    subscribed: Subscribed,
    /// The events its listens in the settings form name; none for an edge's.
    events: Vec<String>,
    /// Whether any listen needs it: one none does is removed.
    needed: bool,
    /// How its lines name it: the external, the credential when the
    /// external's webhooks are kept under more than one, and what it is for.
    label: String,
}

/// The external's webhooks for events, as `retired` has them: none needed.
fn webhooks_of(external: &str, retired: BTreeMap<Channel, Want>) -> Vec<Webhook> {
    let several = retired.keys().map(|(credential, _)| credential).collect::<BTreeSet<_>>().len() > 1;
    retired
        .into_iter()
        .map(|((credential, key), want)| {
            let subscribed = Subscribed::Events(want.scope);
            let label = label_of(external, credential.as_deref().filter(|_| several), &subscribed, &key);
            Webhook { external: external.to_string(), credential, key, subscribed, needed: false, events: Vec::new(), label }
        })
        .collect()
}

/// How a webhook's lines name it: the external, the credential when it is
/// one of several the external's webhooks are kept under, and its scope, or
/// the edge it is for and its key.
fn label_of(external: &str, credential: Option<&str>, subscribed: &Subscribed, key: &str) -> String {
    let mut label = match credential {
        Some(credential) => format!("{external} as {credential}"),
        None => external.to_string(),
    };
    match subscribed {
        Subscribed::Events(scope) if !scope.is_empty() => {
            let scope: Vec<String> = scope.iter().map(|(k, v)| format!("{k} {v}")).collect();
            label.push_str(&format!(" ({})", scope.join(", ")));
        }
        Subscribed::Events(_) => {}
        Subscribed::Arrivals(arrivals) => {
            let of = arrivals.scope.as_ref().map(|scope| format!(" of {scope}")).unwrap_or_default();
            label.push_str(&format!(" ({}{of}, {key})", arrivals.edge));
        }
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
        webhooks.extend(webhooks_of(&running.external.manifest.name, retired(running, secrets.credentials())));
        webhooks.extend(edge_webhooks(&set, running, secrets.credentials()).into_values());
    }
    lines.extend(register(session, webhooks).await);
    lines.extend(arm_refreshes(session));
    lines
}

/// A refresh's registrations: each edge's webhook a listen newly shares or
/// none shares any more, and each whose last registration failed (a
/// retired webhook for events among them). A failure is said once per
/// message; a success is always said.
pub async fn follow_refresh(session: &Session, before: &FileSet, after: &FileSet) -> Vec<String> {
    let secrets = session.secrets();
    let credentials = secrets.credentials();
    let mut webhooks = Vec::new();
    for running in registering(after) {
        let failed = webhooks_of(&running.external.manifest.name, retired(running, credentials)).into_iter().filter(|w| session.registrations.failing(&w.label));
        webhooks.extend(failed);
        let was = edge_webhooks(before, running, credentials);
        let edges = edge_webhooks(after, running, credentials).into_iter().filter(|(channel, w)| {
            session.registrations.failing(&w.label) || was.get(channel).map(|before| before.needed) != Some(w.needed)
        });
        webhooks.extend(edges.map(|(_, w)| w));
    }
    let mut lines = register(session, webhooks).await;
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
        return Ok(webhook.needed.then_some((missing, false)));
    };
    let setup = inbound_of(running).ok_or("it takes no webhooks")?;
    let provider = setup.declaration.provider_key.clone();
    let issued_by_provider = setup.declaration.secret_from_provider;
    let secret_field = setup.secret_field;
    let registered = Registered::of(credential, &webhook.key, &secret_field);
    let kept = Kept { credential, key: &webhook.key, secret_field: &secret_field };
    let position = webhook.subscribed.position();
    let call = |method: &'static str, params: serde_json::Value| {
        let position = position.clone();
        async move {
            let raw = rpc_in(running, credentials, Some(credential), LOCAL_TENANT, method, params, position).await?;
            module_wire::results::check(method, name, &raw)
        }
    };
    // What it is for rides every call about it (the platform's `scope`).
    let on = |params: serde_json::Value| webhook.subscribed.on(params);

    if !webhook.needed {
        let Some(id) = registered.id else { return Ok(None) };
        let url = registered.url.clone().unwrap_or_default();
        call("removeEventSubscription", on(serde_json::json!({ "callbackUrl": url, "externalId": id }))).await?;
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
        call("removeEventSubscription", on(serde_json::json!({ "callbackUrl": url, "externalId": id }))).await?;
        current = None;
    }
    let params = webhook.subscribed.ensure(wanted, &callback, current.as_ref().map(|(id, events)| (id.as_str(), events.as_slice())));
    let had_webhook = current.is_some();
    let answer = call("ensureEventSubscription", params).await?;
    let described = webhook.subscribed.describe(wanted);
    if answer == Js::Null {
        let id = current.map(|(id, _)| id).unwrap_or_default();
        return Ok(Some((format!("webhook {id} is registered for {described} at {callback}"), false)));
    }
    let id = answer.get("externalId").and_then(Js::as_str).map(str::to_string).or(current.map(|(id, _)| id)).unwrap_or_default();
    let issued = answer.get("secret").and_then(Js::as_str).filter(|s| !s.is_empty());
    // The provider issues the secret (`secretIssuedBy: provider`) and none is
    // held: nothing could verify a delivery, so the webhook is withdrawn.
    let held = registered.secret.is_some() && had_webhook;
    if issued_by_provider && issued.is_none() && !held {
        call("removeEventSubscription", on(serde_json::json!({ "callbackUrl": callback, "externalId": id }))).await?;
        return Ok(Some((format!("registering its webhook returned no secret, and {name} issues the secret deliveries are signed with: withdrawn, as none could be verified"), false)));
    }
    let secret = issued.map(str::to_string).or(registered.secret);
    let expires = answer.get("expiresAt").and_then(Js::as_str);
    kept.keep(Registration { subscribed: &webhook.subscribed, id: &id, events: wanted, url: &callback, secret: secret.as_deref(), expires }).await?;
    if let Some(expires) = expires.and_then(ms_of) {
        schedule_refresh(session, running, &Refreshing { credential: &credential.name, key: &webhook.key }, Some(refresh_due_ms(session.now_ms(), expires)))?;
    }
    // Another webhook than the one held (its events or its door changed):
    // its payload feed starts at its beginning, not at the old one's cursor.
    if registered.id.as_deref() != Some(id.as_str()) {
        session.store.save_inbound_checkpoint(&subscription_id(&credential.name, &webhook.key), &Js::Null).map_err(|e| e.to_string())?;
    }
    Ok(Some((format!("registered webhook {id} for {described} at {callback}"), true)))
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
    let subscribed = registered_channels(credential).into_iter().find(|(k, _)| k == webhook.key).map(|(_, subscribed)| subscribed).unwrap_or(Subscribed::Events(Scope::new()));
    let several = credentials.iter().filter(|c| c.external == external && c.binding != Binding::Install && !registered_channels(c).is_empty()).count() > 1;
    let label = label_of(external, Some(webhook.credential).filter(|_| several), &subscribed, webhook.key);
    // Its own key in the failures said, apart from its registration's.
    let said_as = format!("{label} refresh");
    let call = |method: &'static str, params: serde_json::Value| {
        let params = subscribed.on(params);
        let position = subscribed.position();
        async move {
            let raw = rpc_in(running, credentials, Some(credential), LOCAL_TENANT, method, params, position).await?;
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
            // `on` adds what it is for to the registration anew, as to every call.
            let ensure = subscribed.ensure(&registered.events, &url, None);
            let answer = match call("ensureEventSubscription", ensure).await {
                Ok(Js::Null) => return retry(format!("{label}: webhook {id} lapsed, and registering it anew registered nothing; trying again in 15 minutes")),
                Ok(answer) => answer,
                Err(message) => return retry(format!("{label}: webhook {id} lapsed, and registering it anew failed — {message}; trying again in 15 minutes")),
            };
            session.registrations.success(&said_as);
            let new_id = answer.get("externalId").and_then(Js::as_str).unwrap_or_default().to_string();
            let secret = answer.get("secret").and_then(Js::as_str).filter(|s| !s.is_empty()).map(str::to_string).or(registered.secret.clone());
            let new_expires = answer.get("expiresAt").and_then(Js::as_str);
            let kept = Kept { credential, key: webhook.key, secret_field: &setup.secret_field };
            let registration = Registration { subscribed: &subscribed, id: &new_id, events: &registered.events, url: &url, secret: secret.as_deref(), expires: new_expires };
            if let Err(message) = kept.keep(registration).await {
                return retry(format!("{label}: webhook {id} lapsed and was registered anew as {new_id}, which could not be kept — {message}"));
            }
            // The new webhook's payload feed starts at its beginning.
            let subscription = subscription_id(webhook.credential, webhook.key);
            let mut line = format!("{label}: webhook {id} lapsed at {}; registered webhook {new_id} for {} at {url}", iso_of(expires), subscribed.describe(&registered.events));
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
                    subscribed: &subscribed,
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
    subscribed: &'a Subscribed,
    id: &'a str,
    events: &'a [String],
    url: &'a str,
    secret: Option<&'a str>,
    expires: Option<&'a str>,
}

/// Where one webhook's registration is kept: the credential's flat fields
/// for the unscoped one, its record in `webhook_subscriptions` for a scoped
/// one, in `edge_subscriptions` for one for an edge's arrivals.
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
        let (field, mut record) = registration.subscribed.kept_as();
        record.insert("id".into(), Js::str(registration.id));
        if let Subscribed::Events(_) = registration.subscribed {
            record.insert("events".into(), Js::strings(registration.events));
        }
        record.insert("url".into(), Js::str(registration.url));
        if let Some(secret) = registration.secret {
            record.insert("secret".into(), Js::str(secret));
        }
        if let Some(expires) = registration.expires {
            record.insert("expires".into(), Js::str(expires));
        }
        let record = Js::Obj(record);
        replace(self.credential, &|stored| with_scoped(stored, field, self.key, Some(record.clone()))).await
    }

    async fn forget(&self) -> Result<(), String> {
        if self.key.is_empty() {
            let names = [WEBHOOK_ID_FIELD, WEBHOOK_EVENTS_FIELD, WEBHOOK_URL_FIELD, WEBHOOK_EXPIRES_FIELD, self.secret_field];
            return replace(self.credential, &|stored| stored.into_iter().filter(|(k, _)| !names.contains(&k.as_str())).collect()).await;
        }
        replace(self.credential, &|stored| KEYED_FIELDS.into_iter().fold(stored, |stored, field| with_scoped(stored, field, self.key, None))).await
    }
}

/// The entry with the registration `key` in `field` set to `record`, or
/// dropped; the field itself dropped when it holds none.
fn with_scoped(stored: Vec<(String, String)>, field: &str, key: &str, record: Option<Js>) -> Vec<(String, String)> {
    let mut scoped = records_of(|name| stored.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()), field);
    match record {
        Some(record) => {
            scoped.insert(key.to_string(), record);
        }
        None => {
            scoped.shift_remove(key);
        }
    }
    let others = stored.into_iter().filter(|(k, _)| k != field).collect();
    if scoped.is_empty() {
        return others;
    }
    spread(others, vec![(field.to_string(), Js::Obj(scoped).to_json())])
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

    /// The inbox's notes pushed to one connection, a listen on them per
    /// entry of `listens` (the function it fires, the title its WHERE takes).
    fn on_notes(listens: &[(&str, &str)]) -> String {
        let mut movement = "import { inbox } from adapters\nimport { inbox_a } from credentials\n\ni = connect inbox using inbox_a\n".to_string();
        for (function, _) in listens {
            movement.push_str(&format!("\nfunction {function}(n: <i-[:Note]->>) {{\n  return \"{function}\"\n}}\n"));
        }
        for (function, title) in listens {
            movement.push_str(&format!("\nlisten to i-[n:Notes WHERE n.Title == \"{title}\"]-> fire {function}\n"));
        }
        movement
    }

    /// The key of the webhook registered for the listens whose WHERE takes `title`, and its secret.
    fn edge_webhook_of(project: &InboxProject, title: &str) -> (String, String) {
        let made = project.registrations.lock().unwrap();
        let registration = made.iter().find(|r| r.get("filter").and_then(|f| f.get("right")).and_then(|r| r.get("value")).and_then(Js::as_str) == Some(title)).expect("registered");
        let url = registration.get("callbackUrl").and_then(Js::as_str).unwrap();
        let key = url.rsplit('/').next().unwrap().to_string();
        let index = made.iter().position(|r| std::ptr::eq(r, registration)).unwrap();
        (key, format!("secret-wh-{}", index + 1))
    }

    /// A delivery of `arrivals` to `subscription`'s door, signed with
    /// `secret`: its answer's status and the movements it ran.
    async fn arrived(session: &Session, subscription: &str, secret: &str, id: &str, arrivals: &str) -> (u16, Vec<String>) {
        let body = format!(r#"{{"arrivals":{arrivals}}}"#);
        let mut mac = <hmac::Hmac<sha2::Sha256> as hmac::KeyInit>::new_from_slice(secret.as_bytes()).unwrap();
        hmac::Mac::update(&mut mac, body.as_bytes());
        let signature: String = hmac::Mac::finalize(mac).into_bytes().iter().map(|b| format!("{b:02x}")).collect();
        let headers = vec![("x-listen-fire-signature".to_string(), signature), ("x-inbox-delivery".to_string(), id.to_string())];
        let delivery = crate::inbound::Delivery { provider: "inbox", subscription_id: subscription, raw_body: body.as_bytes(), headers: &headers, method: "POST", path: "", query: "", source: crate::store::DeliverySource::Webhook };
        let (answer, fired) = crate::doors::deliver_inline(session, delivery, &|| {}).await;
        let mut movements: Vec<String> = fired.outcomes.into_iter().map(|o| o.movement).collect();
        movements.sort();
        (answer.status, movements)
    }

    /// A note titled `title` landing on `Notes`, the module saying whether it applied the filter.
    fn note(id: &str, title: &str, taken_applied: bool) -> String {
        format!(r#"[{{"edge":"Notes","identity":"{id}","landing":{{"recordId":"{id}","recordType":"Note","fields":{{"Id":"{id}","Title":"{title}"}}}},"takenApplied":{taken_applied}}}]"#)
    }

    #[test]
    fn listens_on_one_pushed_edge_share_a_webhook_per_taken_filter_and_each_door_fires_only_its_own() {
        let project = InboxProject::pushed(&on_notes(&[("a", "x"), ("b", "x"), ("c", "y")]), SCOPED_SECRETS, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            let lines = reconcile(&session).await;
            assert_eq!(lines.len(), 2, "one webhook per taken filter: {lines:?}");
            let made: Vec<Js> = project.registrations.lock().unwrap().clone();
            assert_eq!(made.len(), 2, "{made:?}");
            for registration in &made {
                assert_eq!((registration.get("token"), registration.get("edge")), (Some(&Js::str("a")), Some(&Js::str("Notes"))), "registered as the connection, for its edge");
                assert!(registration.get("events").is_none(), "an edge's webhook names no events");
            }
            let (x, x_secret) = edge_webhook_of(&project, "x");
            let (y, y_secret) = edge_webhook_of(&project, "y");
            assert!(x.starts_with("edge-") && y.starts_with("edge-") && x != y, "{x} {y}");
            let mut expected = vec![
                format!("inbox (Notes, {x}): registered webhook wh-{} for the arrivals on Notes at https://lf.example/api/public/webhook-sync/inbox/inbox_a/{x}", &x_secret["secret-wh-".len()..]),
                format!("inbox (Notes, {y}): registered webhook wh-{} for the arrivals on Notes at https://lf.example/api/public/webhook-sync/inbox/inbox_a/{y}", &y_secret["secret-wh-".len()..]),
            ];
            expected.sort();
            let mut lines = lines;
            lines.sort();
            assert_eq!(lines, expected);

            // Asked again: held, so left as it is.
            let again = reconcile(&session).await;
            assert!(again.iter().all(|line| line.contains(": webhook wh-") && line.contains(" is registered for the arrivals on Notes at ")), "{again:?}");
            assert_eq!(project.registrations.lock().unwrap().len(), 2, "nothing registered anew");

            // Each door takes its own secret and runs only its own key's listens.
            let session = project.session().await;
            assert_eq!(arrived(&session, &format!("inbox_a/{x}"), &x_secret, "d-1", &note("n-1", "x", true)).await, (200, vec!["a".to_string(), "b".to_string()]));
            assert_eq!(arrived(&session, &format!("inbox_a/{y}"), &y_secret, "d-2", &note("n-2", "y", true)).await, (200, vec!["c".to_string()]));
            // A note c's filter takes, delivered through the other key's door
            // and judged there, runs none: c's own webhook was not asked.
            assert_eq!(arrived(&session, &format!("inbox_a/{x}"), &x_secret, "d-3", &note("n-3", "y", false)).await, (200, Vec::new()));
            assert_eq!(arrived(&session, &format!("inbox_a/{x}"), &y_secret, "d-4", &note("n-4", "x", true)).await.0, 401, "another key's secret");
        });

        // c's listen gone: its webhook is removed, naming its edge and filter.
        let before_refresh = project.registrations.lock().unwrap().len();
        let (y, y_secret) = edge_webhook_of(&project, "y");
        in_local(async {
            let session = project.session().await;
            let before = session.file_set();
            std::fs::write(project.root.join("movements/noted.mvt"), on_notes(&[("a", "x"), ("b", "x")])).unwrap();
            let refreshed = project.session().await;
            let lines = follow_refresh(&refreshed, &before, &refreshed.file_set()).await;
            assert_eq!(lines, [format!("inbox (Notes, {y}): no listen needs its webhook any more; removed webhook {}", &y_secret["secret-".len()..])]);
            let made = project.registrations.lock().unwrap();
            assert_eq!(made.len(), before_refresh + 1, "only the removal");
            let removal = made.last().unwrap();
            assert_eq!((removal.get("removed"), removal.get("edge")), (Some(&Js::str(&y_secret["secret-".len()..])), Some(&Js::str("Notes"))));
            assert!(removal.get("filter").is_some(), "its filter too: {removal:?}");
            drop(made);
            assert_eq!(arrived(&refreshed, &format!("inbox_a/{y}"), &y_secret, "d-5", &note("n-5", "y", true)).await.0, 404, "its door is gone with it");
        });
    }

    #[test]
    fn a_listen_in_the_settings_form_keeps_its_webhook_beside_an_edges() {
        let mut movement = on_notes(&[("a", "x")]);
        movement.push_str("\nfunction noted(note: <i-[:Note]->>) {\n  return \"seen\"\n}\n\nlisten to i { events: [\"note.created\"] } fire noted\n");
        let project = InboxProject::pushed(&movement, SCOPED_SECRETS, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            let mut lines = reconcile(&session).await;
            lines.sort();
            let (x, _) = edge_webhook_of(&project, "x");
            assert_eq!(lines.len(), 2, "{lines:?}");
            assert_eq!(lines[0], format!("inbox (Notes, {x}): registered webhook wh-2 for the arrivals on Notes at https://lf.example/api/public/webhook-sync/inbox/inbox_a/{x}"));
            assert_eq!(lines[1], "inbox: registered webhook wh-1 for note.created at https://lf.example/api/public/webhook-sync/inbox/inbox_a");
            let session = project.session().await;
            let credential = session.secrets().credentials().iter().find(|c| c.name == "inbox_a").cloned().unwrap();
            assert!(is_edge_webhook(session.secrets().credentials(), "inbox", &x) && !is_edge_webhook(session.secrets().credentials(), "inbox", ""));
            assert_eq!(Registered::of(&credential, "", "webhook_secret").id.as_deref(), Some("wh-1"), "the settings form's webhook is kept where it always was");
            // An event through the edge's door reaches no listen in the
            // settings form; through the credential's own door it does.
            assert_eq!(delivered(&session, &format!("inbox_a/{x}"), "secret-wh-2", "d-1").await, (200, Vec::new()));
            assert_eq!(delivered(&session, "inbox_a", "secret-a", "d-2").await, (200, vec!["noted".to_string()]));
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
    fn an_edges_webhook_is_refreshed_and_registered_anew_naming_its_edge() {
        let project = InboxProject::pushed_expiring(&on_notes(&[("a", "x")]), SCOPED_SECRETS, "publicUrl: https://lf.example\n", 7 * DAY_MS);
        in_local(async {
            let session = project.session().await;
            assert_eq!(reconcile(&session).await.len(), 1);
            let (x, _) = edge_webhook_of(&project, "x");
            assert_eq!(refresh_rows_due_by(&session, 6 * DAY_MS + 60_000), [format!("refresh_subscription:inbox:inbox_a/{x}")], "its refresh is queued as a scoped one's is");
            let session = project.session().await;
            let kept = |session: &Session| {
                let credential = session.secrets().credentials().iter().find(|c| c.name == "inbox_a").cloned().unwrap();
                Registered::of(&credential, &x, "webhook_secret")
            };
            let expires = ms_of(&kept(&session).expires.unwrap()).unwrap();
            let webhook = Refreshing { credential: "inbox_a", key: &x };
            let (line, _) = refresh_one(&session, "inbox", &webhook, expires - DAY_MS / 2).await;
            assert!(line.is_some_and(|l| l.starts_with(&format!("inbox (Notes, {x}): refreshed webhook wh-1"))));
            assert_eq!(project.registrations.lock().unwrap().last().map(Js::to_json).as_deref(), Some(r#"{"token":"a","refreshed":"wh-1","edge":"Notes"}"#));
            // Lapsed: registered anew for its edge and filter, no events.
            let lapsed = ms_of(&kept(&session).expires.unwrap()).unwrap() + 60_000;
            let (line, _) = refresh_one(&session, "inbox", &webhook, lapsed).await;
            assert!(line.as_deref().is_some_and(|l| l.ends_with(&format!("registered webhook wh-4 for the arrivals on Notes at https://lf.example/api/public/webhook-sync/inbox/inbox_a/{x}"))), "{line:?}");
            let made = project.registrations.lock().unwrap();
            let anew = made.last().unwrap();
            assert_eq!((anew.get("edge"), anew.get("events")), (Some(&Js::str("Notes")), None));
            assert!(anew.get("filter").is_some());
            assert_eq!(made[made.len() - 2].get("edge"), Some(&Js::str("Notes")), "the lapsed one removed naming its edge");
            drop(made);
            let now_kept = kept(&session);
            assert_eq!((now_kept.id.as_deref(), now_kept.secret.as_deref()), (Some("wh-4"), Some("secret-wh-4")));
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

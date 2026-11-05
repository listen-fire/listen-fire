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
//! A refresh of a webhook no listen needs removes it instead. A
//! registration that fails is tried again on the server's tick, after the
//! work queue's backoff, until it is registered.
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
//!
//! Several runners may share one secrets module (`SecretsStore::shared`), and
//! with it each webhook's id and secret. They then follow the rule of
//! docs/contracts/adapter-protocol.md, "A webhook several runners share": each
//! says it holds a webhook in the credential's `webhook_holders` for as long
//! as a lease, renewed on a timer of its own (`hold`); a webhook goes only once no other
//! holder's lease is live. What a runner decides about one webhook it decides
//! under that webhook's own lease in the module, reading the credential as it
//! stands then (`Held`). A store only one runner sees (the secrets file), a
//! read-only one and a credential the environment lies over keep no holders.

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
use crate::secrets_slot::{EntryError, SecretsStore};
use crate::secrets::{Binding, Credential, Credentials, credential_for};
use crate::secrets_family::{Lease, WEBHOOK_HOLDERS_FIELD};
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

/// How long a holder's entry lasts unrenewed, unless `LF_WEBHOOK_LEASE_MS`
/// says otherwise; a runner renews its own three times in that long, so a
/// renewal or two lost to a failing module do not cost it the webhook.
const DEFAULT_HOLDER_LEASE_MS: i64 = 15 * 60_000;
const RENEWALS_PER_LEASE: i64 = 3;
/// How long a webhook's lease lasts when its holder never lets go. Longer
/// than a module's ordinary answer: a call has no timeout of its own. One
/// outliving this can register a second webhook, or remove one another runner
/// has just joined, which that runner registers anew; it never loses a holder.
const WEBHOOK_LEASE_TTL_MS: u64 = 120_000;

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
            let webhook = Webhook { external: name.clone(), credential: credential.clone(), key: key.clone(), subscribed, events: Vec::new(), needed, renewing: false, label };
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
    /// A renewal (`hold`): its holder's entry is kept alive, and the module
    /// is asked only about one that is gone or whose holders all lapsed.
    renewing: bool,
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
            Webhook { external: external.to_string(), credential, key, subscribed, needed: false, renewing: false, events: Vec::new(), label }
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

/// The failures a session's registrations last met, by webhook: a refresh
/// tries each again, and so does the server's tick once its backoff passed
/// (the work queue's: crate::run_host::failed_retry_ms). One is said only
/// when its message is new.
pub struct Registrations {
    failed: RefCell<BTreeMap<String, Failing>>,
    /// This process, as a webhook's holders name it: a restart is a new
    /// holder, and the old one's entry is dropped as it stops, or lapses.
    instance: String,
    holder_lease_ms: i64,
    /// The webhooks the module left unregistered when last asked: it answered
    /// null with nothing held, or issued no secret, so one was withdrawn. A
    /// renewal does not ask it again; a restart or a head moving does.
    declined: RefCell<BTreeSet<String>>,
}

impl Default for Registrations {
    fn default() -> Registrations {
        Registrations::with_holder_lease(DEFAULT_HOLDER_LEASE_MS)
    }
}

struct Failing {
    line: String,
    attempts: i64,
    retry_at_ms: i64,
}

/// `LF_WEBHOOK_LEASE_MS`: how long a holder's entry lasts unrenewed.
pub fn holder_lease_of(raw: Option<&str>) -> Result<i64, String> {
    match raw {
        None | Some("") => Ok(DEFAULT_HOLDER_LEASE_MS),
        Some(raw) => raw.trim().parse::<i64>().ok().filter(|ms| *ms > 0).ok_or_else(|| format!("LF_WEBHOOK_LEASE_MS is \"{raw}\": it must be a positive whole number of milliseconds")),
    }
}

impl Registrations {
    pub fn with_holder_lease(holder_lease_ms: i64) -> Registrations {
        Registrations { failed: RefCell::default(), instance: uuid::Uuid::new_v4().to_string(), holder_lease_ms, declined: RefCell::default() }
    }

    /// This runner's entry in a webhook's holders, as of `now_ms`.
    fn holder_entry(&self, now_ms: i64) -> Js {
        let no_events: [String; 0] = [];
        Js::Obj(crate::obj! { "release" => Js::str(env!("CARGO_PKG_VERSION")), "events" => Js::strings(&no_events), "until" => Js::str(&iso_of(now_ms + self.holder_lease_ms)) })
    }

    /// How often this runner renews what it holds.
    pub fn renewal_every(&self) -> std::time::Duration {
        std::time::Duration::from_millis((self.holder_lease_ms / RENEWALS_PER_LEASE).max(1).unsigned_abs())
    }

    /// What the module's answer about `name` came to: a webhook registered, or none.
    fn answered(&self, name: &str, registered: bool) {
        let mut declined = self.declined.borrow_mut();
        if registered {
            declined.remove(name);
        } else {
            declined.insert(name.to_string());
        }
    }

    /// `line`, unless it is the very failure last said for `name`; tried
    /// again after a backoff that grows with each failure in a row.
    fn failure(&self, name: &str, line: String, now_ms: i64) -> Option<String> {
        let mut failed = self.failed.borrow_mut();
        let attempts = failed.get(name).map_or(1, |f| f.attempts + 1);
        let retry_at_ms = now_ms + crate::run_host::failed_retry_ms(attempts);
        let said = failed.insert(name.to_string(), Failing { line: line.clone(), attempts, retry_at_ms });
        (said.as_ref().map(|f| &f.line) != Some(&line)).then_some(line)
    }

    fn success(&self, name: &str) {
        self.failed.borrow_mut().remove(name);
    }

    fn failing(&self, name: &str) -> bool {
        self.failed.borrow().contains_key(name)
    }

    /// Whether `name` failed and its backoff has passed.
    fn due(&self, name: &str, now_ms: i64) -> bool {
        self.failed.borrow().get(name).is_some_and(|f| f.retry_at_ms <= now_ms)
    }

    fn any_due(&self, now_ms: i64) -> bool {
        self.failed.borrow().values().any(|f| f.retry_at_ms <= now_ms)
    }
}

/// Register or remove each external's webhooks, as its listens need (`listen-fire
/// serve` starting); a line per webhook it touched. One that fails is said
/// and the rest go on: the doors still answer whatever is registered.
pub async fn reconcile(session: &Session) -> Vec<String> {
    let mut lines = read_what_others_wrote(session);
    let secrets = session.secrets();
    let set = session.file_set();
    let mut webhooks = Vec::new();
    for running in registering(&set) {
        webhooks.extend(webhooks_of(&running.external.manifest.name, retired(running, secrets.credentials())));
        webhooks.extend(edge_webhooks(&set, running, secrets.credentials()).into_values());
    }
    lines.extend(register(session, webhooks).await);
    lines.extend(arm_refreshes(session));
    lines
}

/// The credentials read again where other runners write them: a webhook
/// another registered since is seen, and its door answers here. A line when
/// they could not be, the pass going on with what it read last.
fn read_what_others_wrote(session: &Session) -> Vec<String> {
    if !crate::secrets_slot::installed().is_some_and(|store| store.shared()) {
        return Vec::new();
    }
    session.reload_secrets().err().map(|message| format!("the secrets could not be read again: {message}")).into_iter().collect()
}

/// `listen-fire serve`'s renewal, each third of a holder's lease: a
/// runner on a shared secrets module says again that it holds each webhook its
/// listens need, registers one that has gone meanwhile, and removes one no
/// listen of its own needs whose holders have all lapsed. A webhook for events
/// (retired at 0.13) waits for `reconcile`, as it always has: a 0.12 runner
/// beside this one would have it removed again on every tick.
pub async fn hold(session: &Session) -> Vec<String> {
    if !crate::secrets_slot::installed().is_some_and(|store| store.shared()) {
        return Vec::new();
    }
    let mut lines = read_what_others_wrote(session);
    let secrets = session.secrets();
    let set = session.file_set();
    let mut webhooks = Vec::new();
    for running in registering(&set) {
        webhooks.extend(edge_webhooks(&set, running, secrets.credentials()).into_values());
    }
    for webhook in &mut webhooks {
        webhook.renewing = true;
    }
    lines.extend(register(session, webhooks).await);
    // On a store runners also share, another's worker may have finished the
    // row as a webhook its own listens do not need. One kept with no expiry
    // would be refreshed anew each time, so it waits for `reconcile`.
    lines.extend(arm_refreshes_of(session, |registered| registered.expires.is_some()));
    lines
}

/// A runner stopping: it says it holds nothing any more, so another may
/// remove a webhook once its own last listen goes. Each webhook stays where
/// it is, as a lone runner's does across a restart. A failure is only said:
/// the entry lapses on its own.
pub async fn leave(session: &Session) -> Vec<String> {
    let mut lines = read_what_others_wrote(session);
    if !crate::secrets_slot::installed().is_some_and(|store| store.shared()) {
        return lines;
    }
    let (instance, now_ms) = (session.registrations.instance.as_str(), session.now_ms());
    let secrets = session.secrets();
    for credential in secrets.credentials() {
        let holds = records_of(credential_field(credential), WEBHOOK_HOLDERS_FIELD).values().any(|holders| holders.get(instance).is_some());
        if !holds {
            continue;
        }
        let dropped = |stored| {
            with_holders(stored, now_ms, &|all| {
                all.values_mut().for_each(|holders| drop_holder(holders, instance));
            })
        };
        if let Err(message) = replace(credential, &dropped).await {
            lines.push(format!("credential \"{}\" still says this runner holds its webhooks, until that lapses: {message}", credential.name));
        }
    }
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

/// The registrations that failed and whose backoff has passed, tried again
/// (`listen-fire serve`'s tick): a webhook a new head needs is not left
/// unregistered until the next restart or edit.
pub async fn retry_failed(session: &Session) -> Vec<String> {
    let now_ms = session.now_ms();
    if !session.registrations.any_due(now_ms) {
        return Vec::new();
    }
    let secrets = session.secrets();
    let credentials = secrets.credentials();
    let set = session.file_set();
    let mut webhooks = Vec::new();
    for running in registering(&set) {
        webhooks.extend(webhooks_of(&running.external.manifest.name, retired(running, credentials)));
        webhooks.extend(edge_webhooks(&set, running, credentials).into_values());
    }
    webhooks.retain(|w| session.registrations.due(&w.label, now_ms));
    register(session, webhooks).await
}

async fn register(session: &Session, webhooks: Vec<Webhook>) -> Vec<String> {
    let mut lines = Vec::new();
    let mut changed = false;
    for webhook in webhooks {
        let label = &webhook.label;
        match reconcile_one(session, &webhook).await {
            Ok(outcome) => {
                // A renewal that did not ask the module knows nothing of why
                // the module last failed: that retry stays due.
                if !webhook.renewing || outcome.is_some() {
                    session.registrations.success(label);
                }
                if let Some((line, wrote)) = outcome {
                    changed |= wrote;
                    lines.push(format!("{label}: {line}"));
                }
            }
            Err(message) => lines.extend(session.registrations.failure(label, format!("{label}: its webhook is not registered — {message}"), session.now_ms())),
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
        return Ok((webhook.needed && !webhook.renewing).then_some((missing, false)));
    };
    let held = Held::of(credential, &webhook.key).await?;
    // Renewals run beside the drain's passes on this one thread. Under the
    // webhook's lease the second waits and reads afresh. Without one the
    // runner keeps no entries to renew, and behaves as a lone runner does.
    if webhook.renewing && held.is_none() {
        return Ok(None);
    }
    let credential = held.as_ref().map_or(credential, |held| &held.credential);
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
    let (instance, now_ms) = (session.registrations.instance.as_str(), session.now_ms());
    let others_listening = held.as_ref().map_or(0, |_| other_holders(credential, &webhook.key, instance, now_ms));
    let holds_it = held.is_some() && holder_named(credential, &webhook.key, instance);

    if !webhook.needed {
        if let Some(id) = registered.id.as_deref().filter(|_| others_listening > 0) {
            if !holds_it {
                return Ok(None);
            }
            kept.let_go(instance, now_ms).await?;
            return Ok(Some((format!("no listen here needs its webhook any more; webhook {id} stays for the {others_listening} other runner(s) listening"), true)));
        }
        let Some(id) = registered.id else {
            if holds_it {
                kept.let_go(instance, now_ms).await?;
            }
            return Ok(None);
        };
        let url = registered.url.clone().unwrap_or_default();
        call("removeEventSubscription", on(serde_json::json!({ "callbackUrl": url, "externalId": id }))).await?;
        // Its secret too: nothing is delivered to that door now.
        kept.forget(&id, instance, now_ms).await?;
        return Ok(Some((format!("no listen needs its webhook any more; removed webhook {id}"), true)));
    }
    let Some(public) = session.project.public_url.as_deref() else {
        return Ok((!webhook.renewing).then(|| (format!("set publicUrl in lf.yaml to where {name} reaches listen-fire serve; its webhook is not registered"), false)));
    };
    // Said before the module is asked, so that another runner that does not
    // want it never removes it from under this one's registration.
    if held.is_some() {
        kept.hold(session.registrations.holder_entry(now_ms), instance, now_ms).await?;
    }
    // A scoped webhook's door names its subscription after the credential.
    let mut callback = format!("{}/api/public/webhook-sync/{provider}/{}", public.trim_end_matches('/'), credential.name);
    if !webhook.key.is_empty() {
        callback.push_str(&format!("/{}", webhook.key));
    }

    // Another URL: the webhook there is replaced, not moved; unless other
    // runners listen there, whom replacing it would cut off.
    let mut current = registered.id.clone().map(|id| (id, registered.events.clone()));
    if let (Some((id, _)), Some(url)) = (&current, &registered.url)
        && *url != callback
    {
        if others_listening > 0 {
            return Ok((!webhook.renewing).then(|| (format!("webhook {id} stays at {url}, where {others_listening} other runner(s) listen, and does not reach {callback}: runners sharing a webhook share one publicUrl"), true)));
        }
        call("removeEventSubscription", on(serde_json::json!({ "callbackUrl": url, "externalId": id }))).await?;
        current = None;
    }
    // A renewal asks the module nothing about a webhook that is there, nor
    // again about one it declined, which would repeat a call meant to be once.
    if webhook.renewing && (current.is_some() || session.registrations.declined.borrow().contains(&webhook.label)) {
        return Ok(None);
    }
    let params = webhook.subscribed.ensure(wanted, &callback, current.as_ref().map(|(id, events)| (id.as_str(), events.as_slice())));
    let had_webhook = current.is_some();
    let answer = call("ensureEventSubscription", params).await?;
    let described = webhook.subscribed.describe(wanted);
    if answer == Js::Null {
        session.registrations.answered(&webhook.label, current.is_some());
        let id = current.map(|(id, _)| id).unwrap_or_default();
        return Ok(Some((format!("webhook {id} is registered for {described} at {callback}"), held.is_some())));
    }
    let id = answer.get("externalId").and_then(Js::as_str).map(str::to_string).or(current.map(|(id, _)| id)).unwrap_or_default();
    let issued = answer.get("secret").and_then(Js::as_str).filter(|s| !s.is_empty());
    // The provider issues the secret (`secretIssuedBy: provider`) and none is
    // held: nothing could verify a delivery, so the webhook is withdrawn.
    let held = registered.secret.is_some() && had_webhook;
    if issued_by_provider && issued.is_none() && !held {
        call("removeEventSubscription", on(serde_json::json!({ "callbackUrl": callback, "externalId": id }))).await?;
        session.registrations.answered(&webhook.label, false);
        return Ok(Some((format!("registering its webhook returned no secret, and {name} issues the secret deliveries are signed with: withdrawn, as none could be verified"), false)));
    }
    let secret = issued.map(str::to_string).or(registered.secret);
    let expires = answer.get("expiresAt").and_then(Js::as_str);
    kept.keep(Registration { subscribed: &webhook.subscribed, id: &id, events: wanted, url: &callback, secret: secret.as_deref(), expires }).await?;
    session.registrations.answered(&webhook.label, true);
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
    arm_refreshes_of(session, |_| true)
}

/// `arm_refreshes`, for the webhooks `arming` keeps.
fn arm_refreshes_of(session: &Session, arming: impl Fn(&Registered) -> bool) -> Vec<String> {
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
                if !arming(&registered) {
                    continue;
                }
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
    // One no listen needs (a webhook for events, retired at 0.13, or an
    // edge's no listen shares any more, whose removal failed) is removed,
    // never kept alive.
    let channel = (Some(webhook.credential.to_string()), webhook.key.to_string());
    let needed = edge_webhooks(&set, running, credentials).get(&channel).is_some_and(|w| w.needed);
    if !needed {
        let unneeded = edge_webhooks(&set, running, credentials).remove(&channel).into_iter().chain(webhooks_of(external, retired(running, credentials)).into_iter().filter(|w| w.credential.as_deref() == Some(webhook.credential) && w.key == webhook.key));
        let lines = register(session, unneeded.take(1).collect()).await;
        return (Some(lines.join("\n")).filter(|l| !l.is_empty()), None);
    }
    let subscribed = registered_channels(credential).into_iter().find(|(k, _)| k == webhook.key).map(|(_, subscribed)| subscribed).unwrap_or(Subscribed::Events(Scope::new()));
    let several = credentials.iter().filter(|c| c.external == external && c.binding != Binding::Install && !registered_channels(c).is_empty()).count() > 1;
    let label = label_of(external, Some(webhook.credential).filter(|_| several), &subscribed, webhook.key);
    // Its own key in the failures said, apart from its registration's.
    let said_as = format!("{label} refresh");
    // Another runner may have refreshed it, or registered it anew, by now.
    let held = match Held::of(credential, webhook.key).await {
        Ok(held) => held,
        Err(message) => return (session.registrations.failure(&said_as, format!("{label}: refreshing webhook {id} failed — {message}; trying again in 15 minutes"), now_ms), Some(now_ms + REFRESH_RETRY_MS)),
    };
    let credential = held.as_ref().map_or(credential, |held| &held.credential);
    let registered = Registered::of(credential, webhook.key, &setup.secret_field);
    let Some(id) = registered.id.clone() else { return (None, None) };
    let call = |method: &'static str, params: serde_json::Value| {
        let params = subscribed.on(params);
        let position = subscribed.position();
        async move {
            let raw = rpc_in(running, credentials, Some(credential), LOCAL_TENANT, method, params, position).await?;
            module_wire::results::check(method, external, &raw)
        }
    };
    let expires = registered.expires.as_deref().and_then(ms_of);
    let retry = |message: String| (session.registrations.failure(&said_as, message, now_ms), Some(now_ms + REFRESH_RETRY_MS));
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

    /// The registration `removed`, gone at the source, forgotten on behalf of `instance`.
    async fn forget(&self, removed: &str, instance: &str, now_ms: i64) -> Result<(), String> {
        replace(self.credential, &|stored| self.without(stored, removed, instance, now_ms)).await
    }

    /// The stored entry as of now, which is not what was read if the webhook's
    /// lease lapsed during the removal. Another runner may then have registered
    /// a new webhook under this key, which stays. Or it may have joined this
    /// one: the record still goes, being gone at the source, so that runner's
    /// next renewal registers anew. Either way only this runner's entry goes.
    fn without(&self, stored: Vec<(String, String)>, removed: &str, instance: &str, now_ms: i64) -> Vec<(String, String)> {
        let still_removed = stored_id(&stored, self.key).as_deref() == Some(removed);
        let stored = match (still_removed, self.key.is_empty()) {
            (false, _) => stored,
            (true, true) => {
                let names = [WEBHOOK_ID_FIELD, WEBHOOK_EVENTS_FIELD, WEBHOOK_URL_FIELD, WEBHOOK_EXPIRES_FIELD, self.secret_field];
                stored.into_iter().filter(|(k, _)| !names.contains(&k.as_str())).collect()
            }
            (true, false) => KEYED_FIELDS.into_iter().fold(stored, |stored, field| with_scoped(stored, field, self.key, None)),
        };
        with_holders(stored, now_ms, &|all| {
            if let Some(holders) = all.get_mut(self.key) {
                drop_holder(holders, instance);
            }
        })
    }

    /// Say `instance` holds this webhook, as `entry` puts it.
    async fn hold(&self, entry: Js, instance: &str, now_ms: i64) -> Result<(), String> {
        replace(self.credential, &|stored| {
            with_holders(stored, now_ms, &|all| {
                let holders = all.entry(self.key.to_string()).or_insert_with(|| Js::Obj(Obj::new()));
                if let Js::Obj(holders) = holders {
                    holders.insert(instance.to_string(), entry.clone());
                }
            })
        })
        .await
    }

    /// Say `instance` no longer holds this webhook.
    async fn let_go(&self, instance: &str, now_ms: i64) -> Result<(), String> {
        replace(self.credential, &|stored| {
            with_holders(stored, now_ms, &|all| {
                if let Some(holders) = all.get_mut(self.key) {
                    drop_holder(holders, instance);
                }
            })
        })
        .await
    }
}

/// The id of the webhook under `key` ("" the unscoped one) in a stored entry.
fn stored_id(stored: &[(String, String)], key: &str) -> Option<String> {
    let field = |name: &str| stored.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    if key.is_empty() {
        return field(WEBHOOK_ID_FIELD);
    }
    KEYED_FIELDS.into_iter().find_map(|kept_in| records_of(&field, kept_in).get(key)?.get("id")?.as_str().map(str::to_string))
}

/// The entry with its holders changed: every lapsed one gone, and the field
/// itself gone once it names none, so a store nobody holds in stays as it was.
fn with_holders(stored: Vec<(String, String)>, now_ms: i64, change: &dyn Fn(&mut Obj)) -> Vec<(String, String)> {
    let mut all = records_of(|name| stored.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()), WEBHOOK_HOLDERS_FIELD);
    for holders in all.values_mut() {
        if let Js::Obj(holders) = holders {
            holders.retain(|_, holder| until_of(holder).is_some_and(|until| until > now_ms));
        }
    }
    change(&mut all);
    all.retain(|_, holders| matches!(holders, Js::Obj(holders) if !holders.is_empty()));
    let others = stored.into_iter().filter(|(k, _)| k != WEBHOOK_HOLDERS_FIELD).collect();
    if all.is_empty() {
        return others;
    }
    spread(others, vec![(WEBHOOK_HOLDERS_FIELD.to_string(), Js::Obj(all).to_json())])
}

fn drop_holder(holders: &mut Js, instance: &str) {
    if let Js::Obj(holders) = holders {
        holders.shift_remove(instance);
    }
}

fn until_of(holder: &Js) -> Option<i64> {
    holder.get("until").and_then(Js::as_str).and_then(ms_of)
}

/// Whether the credential's entry says `instance` holds the webhook under `key`.
fn holder_named(credential: &Credential, key: &str, instance: &str) -> bool {
    records_of(credential_field(credential), WEBHOOK_HOLDERS_FIELD).get(key).is_some_and(|holders| holders.get(instance).is_some())
}

/// How many holders other than `instance` the webhook under `key` has whose
/// lease is live at `now_ms`.
fn other_holders(credential: &Credential, key: &str, instance: &str, now_ms: i64) -> usize {
    match records_of(credential_field(credential), WEBHOOK_HOLDERS_FIELD).get(key) {
        Some(Js::Obj(holders)) => holders.iter().filter(|(name, holder)| name.as_str() != instance && until_of(holder).is_some_and(|until| until > now_ms)).count(),
        _ => 0,
    }
}

/// A webhook under its lease in a secrets module several runners share, and
/// its credential as stored as that lease was taken. Registering, joining,
/// leaving and removing one all happen under it, so of two runners deciding
/// at once the second sees what the first did. It is apart from the
/// credential's own lease, which a token's refresh takes during the very calls
/// made under this one; the module grants a lease on any `ref`.
struct Held {
    store: std::rc::Rc<dyn SecretsStore>,
    lease_ref: String,
    lease: Option<Lease>,
    credential: Credential,
}

impl Held {
    /// None where the webhook is this runner's alone to decide: a store only
    /// it sees, one it cannot write holders to, a credential the environment
    /// lies over, or an entry deleted since it was read.
    async fn of(credential: &Credential, key: &str) -> Result<Option<Held>, String> {
        let Some(store) = crate::secrets_slot::installed().filter(|store| store.shared()) else { return Ok(None) };
        if credential.origin.slot_ref.is_none() || !credential.origin.env_fields.is_empty() {
            return Ok(None);
        }
        match store.entries_writable(&credential.name) {
            Ok(()) => {}
            Err(EntryError::ReadOnly { .. }) => return Ok(None),
            Err(EntryError::Failed(message)) => return Err(message),
        }
        let lease_ref = format!("{}#webhook:{key}", credential.name);
        let lease = store.lock(&lease_ref, WEBHOOK_LEASE_TTL_MS).await?;
        // Taken: unlocked when it is dropped, whatever becomes of the rest.
        let mut held = Held { store, lease_ref, lease: Some(lease), credential: credential.clone() };
        let Some(record) = held.store.resolve(&credential.name)? else { return Ok(None) };
        held.credential.fields = record.fields;
        Ok(Some(held))
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            self.store.unlock(&self.lease_ref, lease);
        }
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
    use crate::doors::tests::{InboxProject, NOTED, TWO_CONNECTIONS, TWO_CREDENTIALS, in_local};

    #[test]
    fn a_holders_lease_counts_while_it_is_live_and_lapsed_entries_go_with_the_next_write() {
        let at = |ms: i64| Js::Obj(crate::obj! { "until" => Js::str(&iso_of(ms)) });
        let now = 1_800_000_000_000;
        let stored = vec![("module".to_string(), "inbox".to_string())];
        let hold = |stored, instance: &'static str, until: i64, key: &'static str| {
            with_holders(stored, now, &|all| {
                let holders = all.entry(key.to_string()).or_insert_with(|| Js::Obj(Obj::new()));
                if let Js::Obj(holders) = holders {
                    holders.insert(instance.to_string(), at(until));
                }
            })
        };
        assert_eq!(with_holders(stored.clone(), now, &|_| {}), stored, "nobody holding anything writes nothing");

        let two = hold(hold(stored.clone(), "live", now + 1, "edge-a"), "dead", now + 2, "edge-a");
        let credential = Credential { name: "c".into(), external: "inbox".into(), binding: Binding::Legacy, fields: two.iter().cloned().collect(), origin: Default::default() };
        assert_eq!(other_holders(&credential, "edge-a", "me", now), 2);
        assert_eq!(other_holders(&credential, "edge-a", "live", now), 1, "itself is no other");
        assert_eq!(other_holders(&credential, "edge-a", "me", now + 1), 1, "a lease at its end is over");
        assert_eq!(other_holders(&credential, "edge-b", "me", now), 0);
        assert!(holder_named(&credential, "edge-a", "dead") && !holder_named(&credential, "edge-a", "me"));

        let later = with_holders(two, now + 1, &|_| {});
        let all = records_of(|name| later.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()), WEBHOOK_HOLDERS_FIELD);
        assert!(all["edge-a"].get("live").is_none() && all["edge-a"].get("dead").is_some(), "{all:?}");
        let gone = with_holders(later, now + 2, &|_| {});
        assert_eq!(gone, stored, "the field goes once it names none");
    }

    /// A removal that outlived the webhook's lease: another runner has since
    /// joined the webhook, or registered another under the same key.
    #[test]
    fn forgetting_a_webhook_loses_no_other_holder_and_no_newer_registration() {
        let now = 1_800_000_000_000;
        let live = iso_of(now + 60_000);
        let credential = Credential { name: "c".into(), external: "inbox".into(), binding: Binding::Legacy, fields: Default::default(), origin: Default::default() };
        let stored = |id: &str, holders: &str| {
            let record = format!(r#"{{"edge-a":{{"edge":"Notes","id":"{id}","url":"u","secret":"s"}}}}"#);
            vec![(EDGE_SUBSCRIPTIONS_FIELD.to_string(), record), (WEBHOOK_HOLDERS_FIELD.to_string(), holders.to_string())]
        };
        let field = |entry: &[(String, String)], name: &str| entry.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
        let kept = Kept { credential: &credential, key: "edge-a", secret_field: "webhook_secret" };
        let both = format!(r#"{{"edge-a":{{"me":{{"until":"{live}"}},"joined":{{"until":"{live}"}}}}}}"#);

        let after = kept.without(stored("wh-1", &both), "wh-1", "me", now);
        assert_eq!(field(&after, EDGE_SUBSCRIPTIONS_FIELD), None, "it is gone at the source, so its record goes and the one who joined registers anew");
        assert_eq!(field(&after, WEBHOOK_HOLDERS_FIELD), Some(format!(r#"{{"edge-a":{{"joined":{{"until":"{live}"}}}}}}"#)), "and that holder is not lost");

        let after = kept.without(stored("wh-2", &both), "wh-1", "me", now);
        assert!(field(&after, EDGE_SUBSCRIPTIONS_FIELD).is_some_and(|record| record.contains("wh-2")), "another registered since: what it registered stays");
        assert_eq!(field(&after, WEBHOOK_HOLDERS_FIELD), Some(format!(r#"{{"edge-a":{{"joined":{{"until":"{live}"}}}}}}"#)));

        let alone = format!(r#"{{"edge-a":{{"me":{{"until":"{live}"}}}}}}"#);
        assert_eq!(kept.without(stored("wh-1", &alone), "wh-1", "me", now), Vec::<(String, String)>::new(), "alone, both go");

        let unscoped = Kept { credential: &credential, key: "", secret_field: "webhook_secret" };
        let flat = |id: &str| vec![(WEBHOOK_ID_FIELD.to_string(), id.to_string()), ("webhook_secret".to_string(), "s".to_string())];
        assert_eq!(unscoped.without(flat("wh-1"), "wh-1", "me", now), Vec::<(String, String)>::new());
        assert_eq!(unscoped.without(flat("wh-2"), "wh-1", "me", now), flat("wh-2"), "the unscoped webhook's fields, the same");
    }

    #[test]
    fn a_holder_lease_is_a_positive_number_of_milliseconds() {
        assert_eq!(holder_lease_of(None), Ok(DEFAULT_HOLDER_LEASE_MS));
        assert_eq!(holder_lease_of(Some("")), Ok(DEFAULT_HOLDER_LEASE_MS));
        assert_eq!(holder_lease_of(Some("1500")), Ok(1500));
        for raw in ["0", "-1", "soon"] {
            assert_eq!(holder_lease_of(Some(raw)), Err(format!("LF_WEBHOOK_LEASE_MS is \"{raw}\": it must be a positive whole number of milliseconds")));
        }
    }

    #[test]
    fn a_renewal_comes_each_third_of_a_lease() {
        assert_eq!(Registrations::default().renewal_every(), std::time::Duration::from_secs(300));
        assert_eq!(Registrations::with_holder_lease(3_000).renewal_every(), std::time::Duration::from_secs(1));
        assert_eq!(Registrations::with_holder_lease(1).renewal_every(), std::time::Duration::from_millis(1), "a timer needs a period");
    }

    /// The webhook each connection's credential holds for the arrivals on
    /// `Notes`: its key, and the token it was registered as.
    fn notes_webhooks(project: &InboxProject) -> Vec<(String, String)> {
        let made = project.registrations.lock().unwrap();
        let mut webhooks: Vec<(String, String)> = made
            .iter()
            .filter_map(|r| Some((r.get("callbackUrl")?.as_str()?.rsplit('/').next()?.to_string(), r.get("token")?.as_str()?.to_string())))
            .collect();
        webhooks.sort_by(|a, b| a.1.cmp(&b.1));
        webhooks
    }

    #[test]
    fn each_connection_registers_its_own_webhook_for_its_edge_as_itself() {
        let project = InboxProject::with(TWO_CONNECTIONS, TWO_CREDENTIALS, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            let mut lines = reconcile(&session).await;
            lines.sort();
            let webhooks = notes_webhooks(&project);
            let tokens: Vec<&str> = webhooks.iter().map(|(_, token)| token.as_str()).collect();
            assert_eq!(tokens, ["a", "b"], "each webhook is registered as its own connection");
            let [(a, _), (b, _)] = &webhooks[..] else { unreachable!("two") };
            let id = |key: &str| project.registrations.lock().unwrap().iter().position(|r| r.get("callbackUrl").and_then(Js::as_str).is_some_and(|url| url.ends_with(key))).map(|i| i + 1).unwrap();
            assert_eq!(
                lines,
                [
                    format!("inbox as inbox_a (Notes, {a}): registered webhook wh-{} for the arrivals on Notes at https://lf.example/api/public/webhook-sync/inbox/inbox_a/{a}", id(a)),
                    format!("inbox as inbox_b (Notes, {b}): registered webhook wh-{} for the arrivals on Notes at https://lf.example/api/public/webhook-sync/inbox/inbox_b/{b}", id(b)),
                ]
            );
        });
        // b's listen gone: its webhook is removed, as b; a's is left as it is.
        let (b, b_id) = {
            let webhooks = notes_webhooks(&project);
            let b = webhooks[1].0.clone();
            let id = project.registrations.lock().unwrap().iter().position(|r| r.get("token") == Some(&Js::str("b"))).unwrap() + 1;
            (b, format!("wh-{id}"))
        };
        let movement = project.root.join("movements/noted.mvt");
        std::fs::write(&movement, TWO_CONNECTIONS.replace("listen to b-[:Notes]-> fire noted_b\n", "")).unwrap();
        in_local(async {
            let session = project.session().await;
            let lines = reconcile(&session).await;
            assert_eq!(lines.len(), 2, "{lines:?}");
            assert!(lines.iter().any(|l| l.starts_with("inbox as inbox_a (Notes, ") && l.contains(": webhook wh-") && l.contains(" is registered for the arrivals on Notes at ")), "{lines:?}");
            assert!(lines.contains(&format!("inbox as inbox_b (Notes, {b}): no listen needs its webhook any more; removed webhook {b_id}")), "{lines:?}");
            let made = project.registrations.lock().unwrap();
            assert_eq!(made.last().map(Js::to_json), Some(format!(r#"{{"token":"b","removed":"{b_id}","edge":"Notes"}}"#)));
        });
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

    /// The webhook a listen in the settings form registered before 0.13,
    /// kept in its credential's own fields, is removed as listen-fire
    /// starts: no listen hears its events any more.
    #[test]
    fn a_webhook_a_settings_listen_registered_is_removed() {
        let held = "inbox:\n  external: inbox\n  webhook_secret: s\n  token: t\n  webhook_id: wh-0\n  webhook_events: note.created\n  webhook_url: https://lf.example/api/public/webhook-sync/inbox/inbox\n";
        let project = InboxProject::with(NOTED, held, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            let lines = reconcile(&session).await;
            assert!(lines.contains(&"inbox: no listen needs its webhook any more; removed webhook wh-0".to_string()), "{lines:?}");
            assert_eq!(project.registrations.lock().unwrap().iter().filter(|r| r.get("removed").is_some()).map(Js::to_json).collect::<Vec<_>>(), [r#"{"token":"t","removed":"wh-0"}"#]);
            let session = project.session().await;
            let credential = session.secrets().credentials().iter().find(|c| c.name == "inbox").cloned().unwrap();
            assert_eq!(Registered::of(&credential, "", "webhook_secret").id, None, "its registration is forgotten");
            assert!(reconcile(&session).await.iter().all(|line| !line.contains("wh-0")), "and not removed again");
            assert_eq!(delivered(&session, "inbox", "s", "d-1").await.0, 401, "the secret it was issued went with it");
        });
    }

    /// As above, for a webhook kept under a scope (a module that declared
    /// `subscriptionScopeKeys`): removed naming its scope, and its door goes.
    #[test]
    fn a_scoped_webhook_a_settings_listen_registered_is_removed_naming_its_scope() {
        let held = format!("{SCOPED_SECRETS}  webhook_subscriptions: '{{\"red\":{{\"scope\":{{\"shelf\":\"red\"}},\"id\":\"wh-0\",\"events\":[\"note.created\"],\"url\":\"https://lf.example/api/public/webhook-sync/inbox/inbox_a/red\",\"secret\":\"secret-red\"}}}}'\n");
        let project = InboxProject::with(&on_notes(&[("a", "x")]), &held, "publicUrl: https://lf.example\n");
        in_local(async {
            let session = project.session().await;
            assert_eq!(delivered(&session, "inbox_a/red", "secret-red", "d-1").await.0, 200, "its door, while it is held");
            let lines = reconcile(&session).await;
            assert!(lines.contains(&"inbox (shelf red): no listen needs its webhook any more; removed webhook wh-0".to_string()), "{lines:?}");
            assert_eq!(project.registrations.lock().unwrap().iter().filter(|r| r.get("removed").is_some()).map(Js::to_json).collect::<Vec<_>>(), [r#"{"token":"a","removed":"wh-0","scope":{"shelf":"red"}}"#]);
            let session = project.session().await;
            assert_eq!(delivered(&session, "inbox_a/red", "secret-red", "d-2").await.0, 404, "its door is gone with it");
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
        let project = InboxProject::with(&on_notes(&[("a", "x"), ("b", "x"), ("c", "y")]), SCOPED_SECRETS, "publicUrl: https://lf.example\n");
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
    fn a_failure_is_said_once_per_message_and_again_after_a_success() {
        let registrations = Registrations::default();
        assert_eq!(registrations.failure("attio", "down".into(), 0).as_deref(), Some("down"));
        assert!(registrations.failing("attio"), "tried again at the next refresh");
        assert_eq!(registrations.failure("attio", "down".into(), 0), None, "the same failure again is not said");
        assert_eq!(registrations.failure("attio", "refused".into(), 0).as_deref(), Some("refused"), "a new message is");
        assert_eq!(registrations.failure("slack", "down".into(), 0).as_deref(), Some("down"), "each external its own");
        registrations.success("attio");
        assert!(!registrations.failing("attio"));
        assert_eq!(registrations.failure("attio", "refused".into(), 0).as_deref(), Some("refused"), "after a success it is news again");
    }

    #[test]
    fn a_failed_registration_is_due_again_after_a_backoff_that_grows_to_its_cap() {
        let registrations = Registrations::default();
        let now = 1_800_000_000_000;
        registrations.failure("attio", "down".into(), now);
        let first = crate::run_host::failed_retry_ms(1);
        assert!(!registrations.due("attio", now + first - 1) && !registrations.any_due(now + first - 1));
        assert!(registrations.due("attio", now + first) && registrations.any_due(now + first));
        let later = now + first;
        registrations.failure("attio", "down".into(), later);
        assert!(!registrations.due("attio", later + first), "each failure in a row waits longer");
        assert!(registrations.due("attio", later + crate::run_host::failed_retry_ms(2)));
        for _ in 0..40 {
            registrations.failure("attio", "down".into(), later);
        }
        assert!(registrations.due("attio", later + crate::run_host::failed_retry_ms(i64::MAX)), "never longer than the cap");
        assert!(!registrations.due("slack", later), "one never failed is not due");
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
    fn a_registration_that_failed_is_tried_again_on_the_tick_once_its_backoff_passed() {
        let project = InboxProject::with(&on_notes(&[("a", "x")]), SCOPED_SECRETS, "publicUrl: https://lf.example\n");
        project.down.store(true, std::sync::atomic::Ordering::SeqCst);
        in_local(async {
            let mut session = project.session().await;
            let lines = reconcile(&session).await;
            assert!(lines.len() == 1 && lines[0].contains(": its webhook is not registered — "), "{lines:?}");
            assert_eq!(retry_failed(&session).await, Vec::<String>::new(), "not before its backoff");
            project.down.store(false, std::sync::atomic::Ordering::SeqCst);
            session.judge_due_ahead(crate::run_host::failed_retry_ms(1));
            let lines = retry_failed(&session).await;
            assert!(lines.len() == 1 && lines[0].contains(": registered webhook wh-1 for the arrivals on Notes at "), "{lines:?}");
            assert_eq!(retry_failed(&session).await, Vec::<String>::new(), "registered, it is tried no more");
        });
    }

    #[test]
    fn a_webhook_no_listen_shares_is_removed_by_its_refresh_and_a_delivery_to_it_is_said_once() {
        let project = InboxProject::expiring(&on_notes(&[("a", "x")]), SCOPED_SECRETS, "publicUrl: https://lf.example\n", 7 * DAY_MS);
        let x = in_local(async {
            let session = project.session().await;
            assert_eq!(reconcile(&session).await.len(), 1);
            edge_webhook_of(&project, "x").0
        });
        std::fs::write(project.root.join("movements/noted.mvt"), on_notes(&[("a", "y")])).unwrap();
        in_local(async {
            let session = project.session().await;
            let delivered = || crate::runs::Delivered { subscription: Some(&x), ..Default::default() };
            let said = session.fire_arrivals("inbox", &[], delivered()).await.unwrap().redelivered;
            assert_eq!(said, [format!("inbox: a delivery reached webhook {x}, which no listen shares any more: it runs nothing until the webhook is removed")]);
            assert_eq!(session.fire_arrivals("inbox", &[], delivered()).await.unwrap().redelivered, Vec::<String>::new(), "said once");
            let (line, next) = refresh_one(&session, "inbox", &Refreshing { credential: "inbox_a", key: &x }, session.now_ms()).await;
            assert!(line.as_deref().is_some_and(|l| l.ends_with("no listen needs its webhook any more; removed webhook wh-1")), "{line:?}");
            assert_eq!(next, None, "nothing left to refresh");
            let made = project.registrations.lock().unwrap();
            assert!(made.iter().all(|r| r.get("refreshed").is_none()), "never refreshed: {made:?}");
            assert_eq!(made.last().and_then(|r| r.get("removed")), Some(&Js::str("wh-1")));
        });
    }

    #[test]
    fn an_edges_webhook_is_refreshed_and_registered_anew_naming_its_edge() {
        let project = InboxProject::expiring(&on_notes(&[("a", "x")]), SCOPED_SECRETS, "publicUrl: https://lf.example\n", 7 * DAY_MS);
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

            // A failing refresh is said once, and tried again in 15 minutes.
            let now = expires - DAY_MS / 2;
            project.down.store(true, std::sync::atomic::Ordering::SeqCst);
            let (said, again) = refresh_one(&session, "inbox", &webhook, now).await;
            assert!(said.is_some_and(|l| l.starts_with(&format!("inbox (Notes, {x}): refreshing webhook wh-1 failed — ")) && l.ends_with("; trying again in 15 minutes")));
            assert_eq!(again, Some(now + REFRESH_RETRY_MS));
            assert_eq!(refresh_one(&session, "inbox", &webhook, now).await, (None, Some(now + REFRESH_RETRY_MS)), "the same failure is not said again");
            project.down.store(false, std::sync::atomic::Ordering::SeqCst);
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
}

//! lf's inbound doors, on the inbound core (crate::inbound): the core owns
//! verification, the delivery pipeline and the push doors' answers; this file
//! is what lf keeps behind them.
//!
//!   POST /api/public/webhook-sync/<provider>/<install>   a provider's delivery
//!        (`/hooks/<external>/<install>` is the same door under lf's older name)
//!   POST /api/public/adapter/<external>/emit  { events }  an external's new data
//!   POST /api/public/adapter/<external>/wake  { keys }    resume what is parked
//!
//! An install is a credential in the secrets file; its name is the
//! "subscription" in the URL. A delivery's signature is checked by the scheme
//! the external's manifest declares (`inbound`), or, for an external that
//! declares none, by its `lf-external.yaml` `webhook:` block (the protocol's
//! own scheme). A signed delivery with no usable secret is refused, as
//! everywhere. Each delivery, and each emitted batch, is kept as a receipt
//! holding the events it produced; one under a provider's delivery id kept
//! before at its subscription is a duplicate, acked and kept out. Events are
//! queued as `fire_event` work rows naming their delivery, and wakes as
//! `wake_await` rows in lf's state, drained by `lf serve`.

use std::cell::RefCell;

use rusqlite::{OptionalExtension, params};

use crate::check::LOCAL_TENANT;
use crate::credential_calls::{Sending, Target, send};
use crate::externals::RunningExternal;
use crate::inbound::{
    Answer, Declaration, Delivery, Extraction, InboundStore, Intercept, Kept, PushAuth, PushCaller, PushStore, RawRequest, Scheme, Source, Subscription, answer_delivery,
    same_secret,
};
use crate::json::Js;
use crate::obj;
use crate::run_host::{await_wake_work, queue_await_wake};
use crate::runs::{Fired, Session};
use crate::secrets::{Binding, Credential, Credentials, install_of, signer_of};
use crate::backend::RunHostStore;
use crate::store::{DeliverySource, NewDelivery, NewWork, Store, StoreError, iso};

/// The field of an install's credential that holds the webhook secret when
/// the external declares `inbound` and `lf-external.yaml` names none.
pub const DEFAULT_WEBHOOK_SECRET_FIELD: &str = "webhook_secret";

/// How an external's deliveries are verified (`InboundSetup`).
#[derive(Clone)]
pub struct InboundSetup {
    pub declaration: Declaration,
    pub secret_field: String,
}

impl InboundSetup {
    /// The provider segment its door answers to. Doors compare it upper-cased,
    /// so any casing in a URL reaches it.
    fn provider_key(&self) -> String {
        self.declaration.provider_key.to_uppercase()
    }
}

/// An external, as the doors see it: how its deliveries are verified, and
/// which credential field its pushes present.
#[derive(Clone)]
pub struct Served {
    pub external: String,
    pub inbound: Option<InboundSetup>,
    /// The field of an install's credential a push presents as its bearer.
    pub push_field: Option<String>,
}

/// How the external's deliveries are verified, when it takes any.
pub fn inbound_of(running: &RunningExternal) -> Option<InboundSetup> {
    served_of(running).inbound
}

/// `inboundSetupOf`: the manifest's `inbound`, else the `webhook:` block as
/// the protocol's own scheme.
fn served_of(running: &RunningExternal) -> Served {
    let manifest = &running.external.manifest;
    let yaml = manifest.webhook.as_ref();
    let yaml_delivery_id = yaml.and_then(|w| w.delivery_id_header.as_deref()).map(str::to_lowercase);
    let inbound = match &running.inbound {
        Some(declaration) => {
            let mut declaration = declaration.clone();
            // The manifest's own `deliveryId` first; a module that checks its
            // own inbound names the id in its check instead.
            if declaration.delivery_id_header.is_none() && declaration.scheme != Scheme::Module {
                declaration.delivery_id_header = yaml_delivery_id;
            }
            Some(InboundSetup { declaration, secret_field: yaml.map(|w| w.secret_field.clone()).unwrap_or_else(|| DEFAULT_WEBHOOK_SECRET_FIELD.into()) })
        }
        None => yaml.map(|w| InboundSetup {
            declaration: Declaration {
                provider_key: manifest.name.clone(),
                scheme: Scheme::Remote,
                signature_headers: vec![w.header.to_lowercase()],
                intercepts: Vec::new(),
                secret_from_provider: false,
                delivery_id_header: yaml_delivery_id,
            },
            secret_field: w.secret_field.clone(),
        }),
    };
    Served { external: manifest.name.clone(), inbound, push_field: manifest.auth.as_ref().map(|a| a.field.clone()) }
}

/// What reads a delivery for the doors: the external, over the protocol, in
/// lf; the inbound contract suite's adapter in its bridge.
pub trait Reader {
    /// Whether the external reads deliveries (`preprocessInbound`).
    fn reads_deliveries(&self, external: &str) -> bool;
    async fn preprocess(&self, external: &str, install: &Credential, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String>;
    /// The keys a delivery wakes; empty when the external names none.
    async fn wake_keys(&self, external: &str, install: &Credential, raw: &Js) -> Result<Vec<String>, String>;
    /// The external's own check of a raw request (`checkInbound`): `request`
    /// is the wire's `WireInboundRequest`.
    async fn check_inbound(&self, external: &str, install: &Credential, request: &Js, secret: Option<&str>, checkpoint: Option<&Js>) -> Result<Js, String>;
}

/// Where a verified event goes.
pub enum EventSink<'a> {
    /// A `fire_event` work row, for the drain.
    Queue,
    /// The same, each row listed for the answer (`/hooks/…` under `lf serve --doors-only`).
    Listed(&'a RefCell<Vec<Js>>),
    /// Run now, inside the request, once its receipt is kept: its runs, or
    /// the line a duplicate ran nothing with (`/hooks/…`, `lf run --webhook`).
    Inline { session: &'a Session, fired: &'a RefCell<Fired> },
}

/// lf's side of the core's two store interfaces (`createLfInboundStores`).
pub struct LfDoors<'a, R: Reader> {
    pub store: &'a dyn RunHostStore,
    pub served: Vec<Served>,
    pub installs: &'a [Credential],
    pub reader: R,
    pub sink: EventSink<'a>,
    /// Poke the drain: work rows were queued.
    pub notify: &'a dyn Fn(),
}

impl<'a> LfDoors<'a, SessionReader<'a>> {
    /// The doors over a session: its externals, its installs, its state.
    pub fn of_session(session: &'a Session, sink: EventSink<'a>, notify: &'a dyn Fn()) -> LfDoors<'a, SessionReader<'a>> {
        LfDoors {
            store: &*session.store,
            served: session.file_set().running.iter().map(|r| served_of(r)).collect(),
            installs: session.credentials(),
            reader: SessionReader { session },
            sink,
            notify,
        }
    }
}

impl<R: Reader> LfDoors<'_, R> {
    fn install(&self, name: &str) -> Option<&Credential> {
        self.installs.iter().find(|c| c.name == name)
    }

    fn setup_of(&self, external: &str) -> Option<&InboundSetup> {
        self.served.iter().find(|s| s.external == external).and_then(|s| s.inbound.as_ref())
    }

    fn serving(&self, provider_key: &str) -> Option<&InboundSetup> {
        self.served.iter().filter_map(|s| s.inbound.as_ref()).find(|setup| setup.provider_key() == provider_key)
    }

    /// Under the inline sink, a kept delivery's events, each run now under
    /// its receipt. One event's failure never stops the next; any failure is
    /// the delivery's, answered 500 for its sender to send again.
    async fn run_inline(&self, receipt: &NewDelivery) -> Result<(), String> {
        let EventSink::Inline { session, fired } = &self.sink else { return Ok(()) };
        let mut failures = Vec::new();
        for kept in &receipt.events {
            let (external, event) = (kept.get("external").and_then(Js::as_str).unwrap_or_default(), kept.get("event").unwrap_or(&Js::Null));
            match session.fire_event(external, event, false, Some(&receipt.id)).await {
                Ok(one) => {
                    for line in &one.redelivered {
                        eprintln!("lf: {line}");
                    }
                    fired.borrow_mut().outcomes.extend(one.outcomes);
                }
                Err(error) => {
                    eprintln!("Webhook event processing failed: {error}");
                    failures.push(error);
                }
            }
        }
        if failures.is_empty() {
            return Ok(());
        }
        let failed = format!("{} event(s) of the delivery failed: {}", failures.len(), failures.join("; "));
        // The sender's retry comes under the same id: it must be kept, not
        // taken for a duplicate of this one.
        if receipt.external_id.is_some() {
            self.store.forget_delivery_id(&receipt.id).map_err(|e| format!("{failed}; its delivery id was not forgotten: {e}"))?;
        }
        Err(failed)
    }

    /// Under `EventSink::Listed`, the queued events, for the answer.
    fn list(&self, rows: &[NewWork]) {
        let EventSink::Listed(listed) = &self.sink else { return };
        for row in rows.iter().filter(|row| row.kind == "fire_event") {
            let external = row.payload.get("external").cloned().unwrap_or(Js::Null);
            listed.borrow_mut().push(Js::Obj(obj! { "kind" => Js::str(&row.kind), "key" => Js::str(&row.key), "external" => external }));
        }
    }

    fn queue_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String> {
        for key in keys {
            queue_await_wake(self.store, adapter_type, team_id, key)?;
        }
        Ok(())
    }
}

impl<R: Reader> InboundStore for LfDoors<'_, R> {
    async fn find_subscription(&self, id: &str) -> Result<Option<Subscription>, String> {
        let Some(credential) = self.install(id) else { return Ok(None) };
        let Some(setup) = self.setup_of(&credential.external) else { return Ok(None) };
        let own = credential.fields.get(&setup.secret_field);
        // A module that checks its own inbound may be addressed by a user
        // credential (it carries the provider keys the check reads) while the
        // secret `lf connect` set is the install's.
        let secret = match own {
            None if setup.declaration.scheme == Scheme::Module => {
                install_of(self.installs, &credential.external).and_then(|install| install.fields.get(&setup.secret_field))
            }
            own => own,
        };
        Ok(Some(Subscription {
            id: id.to_string(),
            team_id: LOCAL_TENANT.into(),
            provider_key: setup.provider_key(),
            secret: secret.cloned().unwrap_or_default(),
            checkpoint: self.store.inbound_checkpoint(id).map_err(|e| e.to_string())?,
        }))
    }

    fn knows_provider(&self, provider_key: &str) -> bool {
        self.serving(provider_key).is_some()
    }

    fn intercepts(&self, provider_key: &str) -> Vec<Intercept> {
        self.serving(provider_key).map(|setup| setup.declaration.intercepts.clone()).unwrap_or_default()
    }

    async fn source_for(&self, subscription: &Subscription) -> Result<Option<Source>, String> {
        let Some(credential) = self.install(&subscription.id) else { return Ok(None) };
        let Some(setup) = self.setup_of(&credential.external) else { return Ok(None) };
        Ok(Some(Source {
            declaration: setup.declaration.clone(),
            secret: subscription.secret.clone(),
            adapter_type: credential.external.clone(),
            install: credential.name.clone(),
        }))
    }

    fn reads_deliveries(&self, source: &Source) -> bool {
        self.reader.reads_deliveries(&source.adapter_type)
    }

    async fn preprocess(&self, source: &Source, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String> {
        let install = self.install(&source.install).ok_or_else(|| format!("no install {}", source.install))?;
        self.reader.preprocess(&source.adapter_type, install, raw, checkpoint).await
    }

    async fn wake_keys(&self, source: &Source, raw: &Js) -> Result<Vec<String>, String> {
        let install = self.install(&source.install).ok_or_else(|| format!("no install {}", source.install))?;
        self.reader.wake_keys(&source.adapter_type, install, raw).await
    }

    async fn check_inbound(&self, source: &Source, request: &RawRequest<'_>, secret: Option<&str>, checkpoint: Option<&Js>) -> Result<Js, String> {
        let install = self.install(&source.install).ok_or_else(|| format!("no install {}", source.install))?;
        self.reader.check_inbound(&source.adapter_type, install, &request.wire(), secret, checkpoint).await
    }

    // The event itself: the delivery's receipt (`keep`) holds it.
    async fn capture(&self, event: &Js, _source: &Source) -> Result<Js, String> {
        Ok(event.clone())
    }

    /// One store write: the delivery's receipt, the cursor, a `fire_event`
    /// row per event and a `wake_await` row per key. Run inline instead,
    /// the receipt is kept first and its events run after, so a cursor is
    /// never kept past events its receipt does not hold. A duplicate writes
    /// nothing and runs nothing.
    async fn keep(&self, kept: Kept<'_>) -> Result<bool, String> {
        let adapter_type = &kept.source.adapter_type;
        let receipt = NewDelivery {
            id: uuid::Uuid::new_v4().to_string(),
            external_id: kept.external_id.map(str::to_string),
            received_at: iso(0),
            source: kept.door,
            inline: matches!(self.sink, EventSink::Inline { .. }),
            replay_of: None,
            events: kept.receipts.iter().map(|event| kept_event(adapter_type, event.clone())).collect(),
        };
        let mut work: Vec<NewWork> = match &self.sink {
            EventSink::Queue | EventSink::Listed(_) => kept.receipts.iter().map(|event| fire_event_work(adapter_type, event.clone(), &receipt.id)).collect(),
            EventSink::Inline { .. } => Vec::new(),
        };
        work.extend(kept.wake_keys.iter().map(|key| await_wake_work(adapter_type, kept.team_id, key)));
        if !self.store.keep_delivery(kept.subscription_id, kept.checkpoint, &receipt, &work).map_err(|e| e.to_string())? {
            if let EventSink::Inline { fired, .. } = &self.sink {
                fired.borrow_mut().redelivered.push(format!("delivery {} was kept before: it runs nothing", kept.external_id.unwrap_or_default()));
            }
            return Ok(false);
        }
        crate::wake::queued_rows(&work);
        self.list(&work);
        self.run_inline(&receipt).await?;
        Ok(true)
    }

    fn notify(&self) {
        (self.notify)();
    }
}

impl<R: Reader> PushStore for LfDoors<'_, R> {
    /// Which install of the external presented its credential: every install
    /// is compared, with no early exit.
    async fn authenticate(&self, adapter_type: &str, headers: &[(String, String)]) -> Result<PushAuth, String> {
        let Some(field) = self.served.iter().find(|s| s.external == adapter_type).and_then(|s| s.push_field.as_ref()) else {
            return Ok(PushAuth::Unauthorized);
        };
        let presented = crate::http::header(headers, "authorization");
        let mut matches = Vec::new();
        for credential in self.installs.iter().filter(|c| c.external == adapter_type) {
            let Some(secret) = credential.fields.get(field) else { continue };
            if presented.is_some_and(|p| same_secret(p, &format!("Bearer {secret}"))) {
                matches.push(credential.name.as_str());
            }
        }
        Ok(match matches.as_slice() {
            [] => PushAuth::Unauthorized,
            [install] => PushAuth::Authenticated(PushCaller { team_id: LOCAL_TENANT.into(), adapter_type: adapter_type.to_string(), subscription_id: install.to_string() }),
            _ => PushAuth::Ambiguous,
        })
    }

    async fn capture_pushed(&self, caller: &PushCaller, event: &Js) -> Result<Vec<Js>, String> {
        Ok(vec![Js::Obj(obj! { "external" => Js::str(&caller.adapter_type), "event" => event.clone() })])
    }

    /// The batch as one delivery, its receipt and its rows in one write.
    async fn enqueue_pushed(&self, caller: &PushCaller, captured: Vec<Js>, external_id: Option<&str>) -> Result<bool, String> {
        if captured.is_empty() {
            return Ok(true);
        }
        let receipt = NewDelivery {
            id: uuid::Uuid::new_v4().to_string(),
            external_id: external_id.map(str::to_string),
            received_at: iso(0),
            source: DeliverySource::Emit,
            inline: false,
            replay_of: None,
            events: captured,
        };
        let work: Vec<NewWork> = receipt
            .events
            .iter()
            .map(|pushed| {
                let external = pushed.get("external").and_then(Js::as_str).unwrap_or_default();
                fire_event_work(external, pushed.get("event").cloned().unwrap_or(Js::Null), &receipt.id)
            })
            .collect();
        if !self.store.keep_delivery(&caller.subscription_id, None, &receipt, &work).map_err(|e| e.to_string())? {
            return Ok(false);
        }
        crate::wake::queued_rows(&work);
        self.list(&work);
        Ok(true)
    }

    async fn enqueue_pushed_wakes(&self, adapter_type: &str, team_id: &str, keys: &[String]) -> Result<(), String> {
        self.queue_wakes(adapter_type, team_id, keys)
    }

    fn notify_pushed(&self) {
        (self.notify)();
    }
}

// ── The external, as the reader ─────────────────────────────────────────────

/// Deliveries read by the external over the protocol, under the install's
/// credential. No `listEventTypes`: lf routes by the event itself, so a
/// delivery never costs the external a second call.
pub struct SessionReader<'a> {
    session: &'a Session,
}

impl SessionReader<'_> {
    async fn call(&self, external: &str, install: &Credential, method: &str, params: serde_json::Value) -> Result<Js, String> {
        let set = self.session.file_set();
        let running = set.running.iter().find(|r| r.external.manifest.name == external).ok_or_else(|| format!("no external {external}"))?;
        // Signed by the install, carrying no user credential.
        let lease = running.reach.lease().await?;
        let target = Target { external: &running.external, base_url: &lease.address, declarations: &[], methods: &running.methods, settings: &running.settings, limits: &running.limits };
        let sending = Sending { tenant: LOCAL_TENANT, method, cache_scope_id: "<none>", params };
        let raw = send(&target, self.session.credentials(), None, Some(install), sending).await?;
        module_wire::results::check(method, external, &raw)
    }

    fn lists(&self, external: &str, method: &str) -> bool {
        self.session.file_set().running.iter().any(|r| r.external.manifest.name == external && r.methods.iter().any(|m| m == method))
    }
}

impl Reader for SessionReader<'_> {
    fn reads_deliveries(&self, external: &str) -> bool {
        self.lists(external, "preprocessInbound")
    }

    async fn preprocess(&self, external: &str, install: &Credential, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String> {
        let mut params = serde_json::json!({ "raw": crate::wire::json_of_js(raw) });
        if let Some(checkpoint) = checkpoint {
            params["checkpoint"] = crate::wire::json_of_js(checkpoint);
        }
        let read = self.call(external, install, "preprocessInbound", params).await?;
        Ok(Extraction {
            events: read.get("events").and_then(Js::as_array).map(<[Js]>::to_vec).unwrap_or_default(),
            checkpoint: read.get("checkpoint").cloned(),
        })
    }

    async fn wake_keys(&self, external: &str, install: &Credential, raw: &Js) -> Result<Vec<String>, String> {
        if !self.lists(external, "wakeKeys") {
            return Ok(Vec::new());
        }
        let read = self.call(external, install, "wakeKeys", serde_json::json!({ "raw": crate::wire::json_of_js(raw) })).await?;
        Ok(read.as_array().unwrap_or(&[]).iter().filter_map(Js::as_str).map(str::to_string).collect())
    }

    async fn check_inbound(&self, external: &str, install: &Credential, request: &Js, secret: Option<&str>, checkpoint: Option<&Js>) -> Result<Js, String> {
        let set = self.session.file_set();
        let running = set.running.iter().find(|r| r.external.manifest.name == external).ok_or_else(|| format!("no external {external}"))?;
        if !running.methods.iter().any(|m| m == "checkInbound") {
            return Err(format!("external \"{external}\" declares that it checks its own inbound but does not list checkInbound"));
        }
        let mut params = serde_json::json!({ "request": crate::wire::json_of_js(request) });
        if let Some(secret) = secret {
            params["secret"] = serde_json::Value::String(secret.to_string());
        }
        if let Some(checkpoint) = checkpoint {
            params["checkpoint"] = crate::wire::json_of_js(checkpoint);
        }
        // The check reads the provider's keys (a verify token, an API key to
        // fetch the message with), so it carries the user credential.
        let credentials = self.session.credentials();
        let carried = carried_credential(credentials, external, install);
        let lease = running.reach.lease().await?;
        let target = Target {
            external: &running.external,
            base_url: &lease.address,
            declarations: &running.credential_declarations,
            methods: &running.methods,
            settings: &running.settings,
            limits: &running.limits,
        };
        let sending = Sending { tenant: LOCAL_TENANT, method: "checkInbound", cache_scope_id: "<none>", params };
        let raw = send(&target, credentials, carried, signer_of(credentials, external, carried).or(Some(install)), sending).await?;
        module_wire::results::check("checkInbound", external, &raw)
    }
}

/// The user credential a module's own inbound check carries: the one the URL
/// names, else the external's only one; none when it has several.
fn carried_credential<'a>(credentials: &'a Credentials, external: &str, named: &'a Credential) -> Option<&'a Credential> {
    if matches!(named.binding, Binding::Credential(_)) {
        return Some(named);
    }
    let mut users = credentials.iter().filter(|c| c.external == external && matches!(c.binding, Binding::Credential(_)));
    match (users.next(), users.next()) {
        (Some(only), None) => Some(only),
        _ => None,
    }
}

/// One of a delivery's events as its receipt keeps it: the event and the
/// external it came from, all a replay needs to queue it again.
fn kept_event(external: &str, event: Js) -> Js {
    Js::Obj(obj! { "external" => Js::str(external), "event" => event })
}

/// A queued event's `fire_event` row, for the drain: the run it starts
/// names its delivery.
pub fn fire_event_work(external: &str, event: Js, delivery_id: &str) -> NewWork {
    NewWork {
        kind: "fire_event".into(),
        key: format!("fire_event:{}", uuid::Uuid::new_v4()),
        payload: Js::Obj(obj! { "external" => Js::str(external), "event" => event, "deliveryId" => Js::str(delivery_id) }),
        due_at: None,
        team_id: None,
    }
}

// ── The pull cursor ─────────────────────────────────────────────────────────

impl Store {
    /// The install's saved pull cursor, or None.
    pub fn inbound_checkpoint(&self, subscription_id: &str) -> Result<Option<Js>, StoreError> {
        let text: Option<String> =
            self.db.query_row("select checkpoint from inbound_checkpoint where subscription_id = ?", params![subscription_id], |r| r.get(0)).optional()?;
        match text {
            None => Ok(None),
            Some(text) => {
                let value = Js::parse(text.as_bytes()).map_err(|e| StoreError::Invalid(format!("a stored checkpoint is not JSON: {e}")))?;
                Ok((value != Js::Null).then_some(value))
            }
        }
    }

    pub fn save_inbound_checkpoint(&self, subscription_id: &str, checkpoint: &Js) -> Result<(), StoreError> {
        Self::save_checkpoint_in(&self.db, subscription_id, checkpoint)
    }

    fn save_checkpoint_in(db: &rusqlite::Connection, subscription_id: &str, checkpoint: &Js) -> Result<(), StoreError> {
        db.execute(
            "insert into inbound_checkpoint (subscription_id, checkpoint) values (?, ?) on conflict (subscription_id) do update set checkpoint = excluded.checkpoint",
            params![subscription_id, checkpoint.to_json()],
        )?;
        Ok(())
    }

    /// crate::backend::RunHostStore::keep_delivery: one transaction, the
    /// receipt first. A duplicate writes nothing: no cursor, no rows.
    pub fn keep_delivery(&self, subscription_id: &str, checkpoint: Option<&Js>, delivery: &NewDelivery, work: &[NewWork]) -> Result<bool, StoreError> {
        self.transaction(|db| {
            if !Store::insert_delivery_in(db, subscription_id, delivery)? {
                return Ok(false);
            }
            if let Some(checkpoint) = checkpoint {
                Self::save_checkpoint_in(db, subscription_id, checkpoint)?;
            }
            for row in work {
                Store::enqueue_in(db, &row.kind, &row.key, &row.payload, row.due_at.as_deref())?;
            }
            Ok(true)
        })
    }
}

// ── The legacy name: /hooks/<external>/<install> ───────────────────────────

/// The door's provider segment and subscription for lf's older
/// `/hooks/<external>[/<install>]` (`hookTarget`): the install is the
/// external's only credential when the URL names none. None: the external
/// takes no webhooks.
pub fn hook_target(session: &Session, external: &str, install: Option<&str>) -> Option<(String, String)> {
    let set = session.file_set();
    let running = set.running.iter().find(|r| r.external.manifest.name == external)?;
    let setup = served_of(running).inbound?;
    let subscription = install.map(str::to_string).or_else(|| install_of(session.credentials(), external).map(|c| c.name.clone())).unwrap_or_default();
    Some((setup.declaration.provider_key, subscription))
}

/// One delivery through the core with its events run inside the request, as
/// `/hooks/...` and `lf run --webhook` have always answered (`deliverInline`):
/// its runs, or the line a duplicate ran nothing with.
pub async fn deliver_inline(session: &Session, delivery: Delivery<'_>, notify: &dyn Fn()) -> (Answer, Fired) {
    let fired = RefCell::new(Fired::default());
    let doors = LfDoors::of_session(session, EventSink::Inline { session, fired: &fired }, notify);
    let answer = answer_delivery(&doors, delivery).await;
    drop(doors);
    (answer, fired.into_inner())
}

/// A delivery addressed by external, as `lf run --webhook` names it.
pub struct Webhook<'a> {
    pub external: &'a str,
    /// The install it is for; the external's only one when None.
    pub install: Option<&'a str>,
    pub raw_body: &'a [u8],
    pub headers: &'a [(String, String)],
}

/// `lf run --webhook`: a delivery taken as production takes one, its runs
/// returned (a duplicate's: none, and the line saying so); a refusal is an
/// error (`receiveWebhook`).
pub async fn receive_webhook(session: &Session, webhook: Webhook<'_>) -> Result<Fired, String> {
    let Webhook { external, install, raw_body, headers } = webhook;
    let Some((provider, subscription_id)) = hook_target(session, external, install) else {
        return Err(format!("external \"{external}\" takes no webhooks"));
    };
    let delivery = Delivery { provider: &provider, subscription_id: &subscription_id, raw_body, headers, method: "POST", path: "", query: "", source: DeliverySource::Cli };
    let (answer, fired) = deliver_inline(session, delivery, &|| {}).await;
    if answer.status == 200 {
        return Ok(fired);
    }
    let code = answer.body.get("error").and_then(Js::as_str).unwrap_or("unreadable");
    Err(if code == "signature_invalid" {
        format!("signature did not verify for external \"{external}\"")
    } else {
        format!("delivery refused: {code} ({})", answer.status)
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::backend::StoreSpec;
    use crate::store::DeliveryQuery;

    const SECRET: &str = "s3cret";

    /// An adapter whose deliveries are lists of notes, each a `note.created`
    /// event, served by a module host on a thread of the test. While `down`
    /// is set its event types fail, and so does every event fired to it.
    mod inbox {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        use module_kit::*;

        pub struct Inbox {
            pub down: Arc<AtomicBool>,
        }

        impl Adapter for Inbox {
            fn manifest(&self) -> AdapterManifest {
                AdapterManifest::new("inbox").triggers(["webhook"]).optional(["listEventTypes", "preprocessInbound"]).declare("subscribableEvents", Js::strings(["note.created"]))
            }

            async fn list_entry_points(&self, _: &Ctx) -> Answer<Vec<EntryPoint>> {
                Ok(vec![EntryPoint { type_id: "Note".into(), display_name: "Note".into(), writable: false, readable: false, fires: Some(true), description: None, rest: Obj::new() }])
            }

            async fn describe(&self, _: &Ctx, request: Describe) -> Answer<Option<TypeDescriptor>> {
                Ok((request.type_id == "Note").then(|| TypeDescriptor {
                    type_id: "Note".into(),
                    display_name: "Note".into(),
                    fields: vec![Field::new("Title", "string", true, true)],
                    references: vec![],
                    deletable: None,
                    rest: Obj::new(),
                }))
            }

            async fn create_record(&self, _: &Ctx, _: CreateRecord) -> Answer<Written> {
                Err(ModuleError::bad_request("the inbox is read only"))
            }

            async fn update_record(&self, _: &Ctx, _: UpdateRecord) -> Answer<Option<Updated>> {
                Ok(None)
            }

            async fn optional(&self, _: &Ctx, method: &str, params: Js) -> Answer<Js> {
                match method {
                    "listEventTypes" if self.down.load(Ordering::SeqCst) => Err(ModuleError::bad_request("the inbox is down")),
                    "listEventTypes" => Ok(Js::Arr(vec![Js::Obj(obj! { "tag" => Js::str("note.created"), "positionType" => Js::str("Note") })])),
                    "preprocessInbound" => {
                        let notes = params.get("raw").and_then(|raw| raw.get("notes")).and_then(Js::as_array).unwrap_or(&[]).to_vec();
                        let events = notes
                            .iter()
                            .map(|note| {
                                let id = note.get("id").and_then(Js::as_str).unwrap_or_default();
                                Js::Obj(obj! {
                                    "payload" => note.clone(),
                                    "externalId" => Js::str(id),
                                    "eventType" => Js::str("note.created"),
                                    "changeType" => Js::str("create"),
                                    "recordType" => Js::str("Note"),
                                })
                            })
                            .collect();
                        Ok(Js::Obj(obj! { "events" => Js::Arr(events) }))
                    }
                    other => Err(ModuleError::not_implemented(other)),
                }
            }
        }

        /// The inbox at `/inbox`, on a loopback port of its own thread.
        pub fn serve(down: Arc<AtomicBool>) -> u16 {
            let (sent, port) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                tokio::task::LocalSet::new().block_on(&runtime, async move {
                    let listener = Listener::bind(&Address::Tcp(([127, 0, 0, 1], 0).into())).await.unwrap();
                    sent.send(listener.address().parse::<u16>().unwrap()).unwrap();
                    Host::new().adapter(Inbox { down }).serve(listener).await.unwrap();
                });
            });
            port.recv().unwrap()
        }
    }

    /// A project whose `inbox` external takes signed webhooks, each delivery
    /// named by its `x-inbox-delivery` header, and whose one movement takes
    /// its notes; the inbox can be taken down.
    struct InboxProject {
        root: std::path::PathBuf,
        down: Arc<AtomicBool>,
    }

    impl InboxProject {
        fn new() -> InboxProject {
            let down = Arc::new(AtomicBool::new(false));
            let port = inbox::serve(down.clone());
            let root = std::env::temp_dir().join(format!("lf-doors-inline-{}", uuid::Uuid::new_v4()));
            crate::init::run(&root, &mut Vec::new()).unwrap();
            std::fs::create_dir_all(root.join("externals/inbox")).unwrap();
            std::fs::write(
                root.join("externals/inbox/lf-external.yaml"),
                format!(
                    "name: inbox\nkind: adapter\nprotocol: 2\nurl: http://127.0.0.1:{port}/inbox\nwebhook:\n  signature: hmac-sha256\n  secretField: webhook_secret\n  deliveryIdHeader: X-Inbox-Delivery\n"
                ),
            )
            .unwrap();
            std::fs::write(
                root.join("movements/noted.mvt"),
                "import { inbox } from adapters\n\ni = connect inbox\n\nfunction noted(note: <i-[:Note]->>) {\n  return \"seen\"\n}\n\nlisten to i { events: [\"note.created\"] } fire noted\n",
            )
            .unwrap();
            let secrets = root.join(".lf/secrets.yaml");
            std::fs::write(&secrets, format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n")).unwrap();
            std::fs::set_permissions(&secrets, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
            InboxProject { root, down }
        }

        async fn session(&self) -> Session {
            let project = crate::project::load_project(&self.root).unwrap();
            crate::runs::open_session(project, &crate::runs::Opening { ephemeral: false, store: &StoreSpec::Sqlite(self.root.join(".lf/state.db")), role: crate::runs::Role::Serve }).await.unwrap()
        }
    }

    impl Drop for InboxProject {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    /// The signed headers of one delivery to the inbox, under `id`.
    fn signed(body: &[u8], id: &str) -> Vec<(String, String)> {
        let mut mac = <hmac::Hmac<sha2::Sha256> as hmac::KeyInit>::new_from_slice(SECRET.as_bytes()).unwrap();
        hmac::Mac::update(&mut mac, body);
        let signature: String = hmac::Mac::finalize(mac).into_bytes().iter().map(|b| format!("{b:02x}")).collect();
        vec![("x-listen-fire-signature".into(), signature), ("x-inbox-delivery".into(), id.into())]
    }

    /// One delivery through `/hooks/inbox`, its events run inside the request.
    async fn hook(session: &Session, body: &[u8], id: &str) -> (Answer, Fired) {
        let headers = signed(body, id);
        let delivery = Delivery { provider: "inbox", subscription_id: "inbox", raw_body: body, headers: &headers, method: "POST", path: "/hooks/inbox", query: "", source: DeliverySource::Hook };
        deliver_inline(session, delivery, &|| {}).await
    }

    fn kept(session: &Session) -> Vec<crate::store::DeliveryRow> {
        session.store.deliveries(&DeliveryQuery { subscription_id: None, since: None, limit: 10 }).unwrap()
    }

    fn in_local<F: std::future::Future>(future: F) -> F::Output {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        tokio::task::LocalSet::new().block_on(&runtime, future)
    }

    const NOTE: &[u8] = br#"{"notes":[{"id":"n-1","Title":"hello"}]}"#;

    #[test]
    fn an_inline_delivery_keeps_its_receipt_before_it_runs() {
        let project = InboxProject::new();
        in_local(async {
            let session = project.session().await;
            project.down.store(true, Ordering::SeqCst);
            let (answer, fired) = hook(&session, NOTE, "d-1").await;
            assert_eq!((answer.status, answer.body.to_json()), (500, r#"{"error":"internal"}"#.to_string()));
            assert!(fired.outcomes.is_empty());
            let kept = kept(&session);
            assert_eq!(kept.len(), 1, "the receipt was kept before its event ran");
            let receipt = &kept[0];
            assert_eq!((receipt.inline, receipt.source, receipt.event_count, receipt.runs.len()), (true, DeliverySource::Hook, 1, 0));
            let events = session.store.delivery(&receipt.id).unwrap().unwrap().events.unwrap();
            assert_eq!(events[0].get("external"), Some(&Js::str("inbox")), "a kept event names its external, for a replay");
            assert_eq!(events[0].get("event").and_then(|e| e.get("externalId")), Some(&Js::str("n-1")));
        });
    }

    #[test]
    fn a_failed_inline_delivery_lets_the_retry_in() {
        let project = InboxProject::new();
        in_local(async {
            let session = project.session().await;
            project.down.store(true, Ordering::SeqCst);
            assert_eq!(hook(&session, NOTE, "d-1").await.0.status, 500);
            assert_eq!(kept(&session)[0].external_id, None, "the failed delivery's id is forgotten");

            // The sender's retry, under the same id, is a delivery of its own and runs.
            project.down.store(false, Ordering::SeqCst);
            let (answer, fired) = hook(&session, NOTE, "d-1").await;
            assert_eq!((answer.status, answer.body.to_json()), (200, r#"{"ok":true,"eventsProcessed":1}"#.to_string()));
            assert_eq!(fired.outcomes.len(), 1);
            let retry = kept(&session).into_iter().find(|d| d.external_id.is_some()).unwrap();
            assert_eq!(retry.runs.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), [fired.outcomes[0].run_id.as_str()]);
            let run = session.store.run(&fired.outcomes[0].run_id).unwrap().unwrap();
            assert_eq!(run.delivery_id.as_deref(), Some(retry.id.as_str()), "the run names its delivery");

            // A third send is the retry's duplicate: acked, and it runs nothing.
            let (answer, fired) = hook(&session, NOTE, "d-1").await;
            assert_eq!((answer.status, answer.body.to_json()), (200, r#"{"ok":true,"duplicate":true,"eventsProcessed":0}"#.to_string()));
            assert!(fired.outcomes.is_empty());
            assert_eq!(fired.redelivered, ["delivery d-1 was kept before: it runs nothing"]);
            assert_eq!(kept(&session).len(), 2);
        });
    }

    #[test]
    fn a_checkpoint_round_trips_and_null_reads_as_none() {
        let dir = std::env::temp_dir().join(format!("lf-doors-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("state.db")).unwrap();
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), None);
        store.save_inbound_checkpoint("sub", &Js::parse(br#"{"cursor":"c-2"}"#).unwrap()).unwrap();
        assert_eq!(store.inbound_checkpoint("sub").unwrap().map(|c| c.to_json()).as_deref(), Some(r#"{"cursor":"c-2"}"#));
        store.save_inbound_checkpoint("sub", &Js::Null).unwrap();
        assert_eq!(store.inbound_checkpoint("sub").unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

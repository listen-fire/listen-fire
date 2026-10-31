//! listen-fire's inbound doors, on the inbound core (crate::inbound): the core owns
//! verification, the delivery pipeline and the push doors' answers; this file
//! is what listen-fire keeps behind them.
//!
//!   POST /api/public/webhook-sync/<provider>/<install>   a provider's delivery
//!        (`…/<install>/<key>`: one of the install's scoped webhooks, crate::subscriptions)
//!        (`/hooks/<external>/<install>` is the same door under listen-fire's older name)
//!   POST /api/public/adapter/<external>/emit  { events }  an external's new data
//!   POST /api/public/adapter/<external>/wake  { arrivals } what landed; or { keys }, resume what is parked
//!
//! An install is a credential in the secrets file; its name is the
//! "subscription" in the URL. A delivery to a connection's credential runs
//! only the listens whose construction names that credential (or none); one
//! to the module's own install, which serves every connection, reaches every
//! listen. A delivery's signature is checked by the scheme
//! the external's manifest declares (`inbound`), or, for an external that
//! declares none, by its `lf-external.yaml` `webhook:` block (the protocol's
//! own scheme). A signed delivery with no usable secret is refused, as
//! everywhere. Each delivery, and each emitted batch, is kept as a receipt
//! holding the events it produced; one under a provider's delivery id kept
//! before at its subscription is a duplicate, acked and kept out. Events are
//! queued as `fire_event` work rows naming their delivery and the arrival
//! log's mark when it was kept (where a run started by it reads arrivals
//! from), arrivals are logged (crate::arrivals), and wakes are queued as
//! `wake_await` rows in listen-fire's state, drained by `listen-fire serve`.

use std::cell::RefCell;

use rusqlite::{OptionalExtension, params};

use crate::check::LOCAL_TENANT;
use crate::credential_calls::{Sending, Target, send};
use crate::externals::RunningExternal;
use crate::inbound::{
    Answer, Declaration, Delivery, Extraction, InboundStore, Intercept, Kept, PushAuth, PushCaller, PushStore, RawRequest, Scheme, Source, Subscription, answer_delivery,
    same_secret,
};
use crate::arrivals::{ArrivalIn, arrivals_of, log_and_wake, logged};
use crate::json::Js;
use crate::obj;
use crate::routing::{Arrival, Listen, event_matches_trigger_scope};
use crate::runs::{Delivered, Fired, Session};
use crate::secrets::{Binding, Credential, Credentials, install_of, signer_of};
use crate::subscriptions::{has_scoped, scoped_secret};
use crate::backend::RunHostStore;
use crate::store::{DeliverySource, NewDelivery, NewWork, Store, StoreError, iso};
use crate::waits::{DeliveryArrivals, DeliveryWait, KeptDelivery, PreNoted, delivery_rows};

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
    /// How long its provider may re-send an arrival
    /// (crate::externals::resend_window_ms): its arrivals' identities are
    /// kept that long.
    pub resend_window_ms: i64,
}

/// How the external's deliveries are verified, when it takes any.
pub fn inbound_of(running: &RunningExternal) -> Option<InboundSetup> {
    served_of(running).inbound
}

/// `inboundSetupOf`: the manifest's `inbound`, else the `webhook:` block as
/// the protocol's own scheme.
fn served_of(running: &RunningExternal) -> Served {
    served_in(running, crate::externals::DEFAULT_RESEND_WINDOW_MS)
}

/// `served_of`, its re-send window `resend_window_ms`.
fn served_in(running: &RunningExternal, resend_window_ms: i64) -> Served {
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
    Served { external: manifest.name.clone(), inbound, push_field: manifest.auth.as_ref().map(|a| a.field.clone()), resend_window_ms }
}

/// What reads a delivery for the doors: the external, over the protocol, in
/// listen-fire; the inbound contract suite's adapter in its bridge.
pub trait Reader {
    /// Whether the external reads deliveries (`preprocessInbound`).
    fn reads_deliveries(&self, external: &str) -> bool;
    async fn preprocess(&self, external: &str, install: &Credential, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String>;
    /// The external's own check of a raw request (`checkInbound`): `request`
    /// is the wire's `WireInboundRequest`.
    async fn check_inbound(&self, external: &str, install: &Credential, request: &Js, secret: Option<&str>, checkpoint: Option<&Js>) -> Result<Js, String>;
    /// The external's `awaitKeys` of `heads` on `edge`: one `{ key }` or
    /// `{ gone: true }` per head, called as `install` (none for a module
    /// that takes no credential). None when it offers no `awaitKeys`: a run
    /// waiting on it fails as it starts, saying so.
    async fn await_keys(&self, external: &str, install: Option<&Credential>, edge: &str, heads: Js) -> Result<Option<Js>, String>;
}

/// Where a verified event goes.
pub enum EventSink<'a> {
    /// A `fire_event` work row, for the drain.
    Queue,
    /// The same, each row listed for the answer (`/hooks/…` under `listen-fire serve --doors-only`).
    Listed(&'a RefCell<Vec<Js>>),
    /// Run now, inside the request, once its receipt is kept: its runs, or
    /// the line a duplicate ran nothing with (`/hooks/…`, `listen-fire run --webhook`).
    Inline { session: &'a Session, fired: &'a RefCell<Fired> },
}

/// listen-fire's side of the core's two store interfaces (`createLfInboundStores`).
pub struct LfDoors<'a, R: Reader> {
    pub store: &'a dyn RunHostStore,
    pub served: Vec<Served>,
    /// The installs, as read when the doors were opened for one request.
    pub installs: std::borrow::Cow<'a, [Credential]>,
    pub reader: R,
    pub sink: EventSink<'a>,
    /// Poke the drain: work rows were queued.
    pub notify: &'a dyn Fn(),
    /// The listens a delivery's events would reach, as the doors were opened.
    pub listens: Vec<Listen>,
}

impl<'a> LfDoors<'a, SessionReader<'a>> {
    /// The doors over a session: its externals, its installs, its state.
    pub fn of_session(session: &'a Session, sink: EventSink<'a>, notify: &'a dyn Fn()) -> LfDoors<'a, SessionReader<'a>> {
        LfDoors {
            store: &*session.store,
            served: session
                .file_set()
                .running
                .iter()
                .map(|r| served_in(r, crate::externals::resend_window_ms(&session.project, &r.external.manifest.name, &r.manifest_answer)))
                .collect(),
            installs: std::borrow::Cow::Owned(session.secrets().credentials().clone()),
            reader: SessionReader { session },
            sink,
            notify,
            listens: session.file_set().listens.clone(),
        }
    }
}

impl<R: Reader> LfDoors<'_, R> {
    fn install(&self, name: &str) -> Option<&Credential> {
        self.installs.iter().find(|c| c.name == name)
    }

    /// The connection a delivery to `source`'s door came for: the credential
    /// its URL names. None when that is the module's install, whose door
    /// serves every connection.
    fn delivering_credential<'s>(&self, source: &'s Source) -> Option<&'s str> {
        self.install(&source.install).filter(|c| c.binding != Binding::Install).map(|_| source.install.as_str())
    }

    /// How long `external`'s provider may re-send an arrival.
    fn resend_window_ms(&self, external: &str) -> i64 {
        self.served.iter().find(|s| s.external == external).map_or(crate::externals::DEFAULT_RESEND_WINDOW_MS, |s| s.resend_window_ms)
    }

    /// The runs `landed` fires on the connection it came for, each minted
    /// now as `{ pipeline, receipt, runId }`, and the waits each opens on its
    /// trigger as the delivery is kept: one per edge its fired function waits
    /// on off its parameter, keyed by the module's `awaitKeys`. A wait on the
    /// trigger's own edge and record has the trigger noted on it, so the run
    /// is never answered by the arrival that started it; any other arrival of
    /// the delivery may answer it. A run judged here that the drain does not
    /// start has its waits dropped there.
    pub(crate) async fn mint_runs(&self, adapter_type: &str, install: Option<&str>, credential: Option<&str>, landed: &[ArrivalIn]) -> Result<(Js, Vec<DeliveryWait>), String> {
        let (mut minted, mut waits) = (Vec::new(), Vec::new());
        let now_ms = crate::limiter::now_ms() as f64;
        for arrival in landed {
            let identity = arrival.identity.as_deref().unwrap_or_default();
            for listen in self.listens.iter().filter(|l| l.is_on(adapter_type, &arrival.edge) && l.hears(credential)) {
                if !matches!(listen.fires(arrival, credential, now_ms), Some(movement_engine::listen_judge::Verdict::Fires)) {
                    continue;
                }
                let run_id = uuid::Uuid::new_v4().to_string();
                let receipt = crate::arrivals::arrival_receipt_key(&arrival.edge, arrival.key.as_deref(), identity, arrival.version.as_deref());
                minted.push(Js::Obj(obj! { "pipeline" => Js::str(listen.pipeline()), "receipt" => Js::str(receipt), "runId" => Js::str(&run_id) }));
                let Some(head) = trigger_head(arrival) else { continue };
                let caller = listen.credential.as_deref().or(install).map(|name| self.install(name).ok_or_else(|| format!("no install {name}"))).transpose()?;
                for edge in &listen.trigger_awaits {
                    let Some(answer) = self.reader.await_keys(adapter_type, caller, edge, Js::Arr(vec![head.clone()])).await? else { continue };
                    let key = match answer.as_array().and_then(|keys| keys.first()) {
                        Some(one) if one.get("gone") == Some(&Js::Bool(true)) => None,
                        Some(one) => Some(one.get("key").and_then(Js::as_str).filter(|k| !k.is_empty()).ok_or_else(|| format!("{}: awaitKeys answered {}, not {{ key }} or {{ gone: true }}", adapter_type, answer.to_json()))?.to_string()),
                        None => return Err(format!("{}: awaitKeys answered {}, not one key per head", adapter_type, answer.to_json())),
                    };
                    let own = key.is_some() && *edge == arrival.edge && key == arrival.key;
                    let pre_noted = own.then(|| arrival.identity.clone().map(|identity| PreNoted { identity, version: arrival.version.clone() })).flatten();
                    waits.push(DeliveryWait { run_id: run_id.clone(), edge: edge.clone(), key, pre_noted, fire_key: String::new() });
                }
            }
        }
        Ok((Js::Arr(minted), waits))
    }

    fn setup_of(&self, external: &str) -> Option<&InboundSetup> {
        self.served.iter().find(|s| s.external == external).and_then(|s| s.inbound.as_ref())
    }

    fn serving(&self, provider_key: &str) -> Option<&InboundSetup> {
        self.served.iter().filter_map(|s| s.inbound.as_ref()).find(|setup| setup.provider_key() == provider_key)
    }

    /// Under the inline sink, a kept delivery's events, each run now under
    /// its receipt, then what `landed` for its connection's traversal
    /// listens. One event's failure never stops the next; any failure is
    /// the delivery's, answered 500 for its sender to send again.
    async fn run_inline(&self, receipt: &NewDelivery, mark: i64, landed: Option<(&str, Delivered<'_>, &[ArrivalIn])>) -> Result<(), String> {
        let EventSink::Inline { session, fired } = &self.sink else { return Ok(()) };
        // The mark before the delivery's arrivals, as a queued row carries
        // it: a run the delivery starts has its own trigger noted on its
        // waits, and any other arrival of the delivery may answer them.
        let mut failures = Vec::new();
        for kept in &receipt.events {
            let (external, event) = (kept.get("external").and_then(Js::as_str).unwrap_or_default(), kept.get("event").unwrap_or(&Js::Null));
            let delivered = Delivered { arrival_mark: Some(mark), ..Delivered::of_row(kept, Some(&receipt.id)) };
            match session.fire_event(external, event, false, delivered).await {
                Ok(one) => {
                    for line in &one.redelivered {
                        eprintln!("listen-fire: {line}");
                    }
                    fired.borrow_mut().outcomes.extend(one.outcomes);
                }
                Err(error) => {
                    eprintln!("Webhook event processing failed: {error}");
                    failures.push(error);
                }
            }
        }
        // What landed is judged once the events have run, as its row is
        // drained after theirs.
        if let Some((external, came_for, arrivals)) = landed {
            let delivered = Delivered { id: Some(&receipt.id), arrival_mark: Some(mark), ..came_for };
            match session.fire_arrivals(external, arrivals, delivered).await {
                Ok(one) => {
                    for line in &one.redelivered {
                        eprintln!("listen-fire: {line}");
                    }
                    fired.borrow_mut().outcomes.extend(one.outcomes);
                }
                Err(error) => {
                    eprintln!("Webhook arrivals processing failed: {error}");
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

    /// Under `EventSink::Listed`, the queued rows, for the answer: each
    /// event with its external, each wake.
    fn list(&self, rows: &[NewWork]) {
        let EventSink::Listed(listed) = &self.sink else { return };
        for row in rows {
            let mut listing = obj! { "kind" => Js::str(&row.kind), "key" => Js::str(&row.key) };
            if row.kind == "fire_event" {
                listing.insert("external".into(), row.payload.get("external").cloned().unwrap_or(Js::Null));
            }
            listed.borrow_mut().push(Js::Obj(listing));
        }
    }

    /// The arrival log's mark, on each `fire_event` row a delivery keeps: a
    /// run it starts reads its waits' arrivals from there, so one that lands
    /// while the run is starting still counts.
    fn mark_fire_rows(&self, work: &mut [NewWork]) -> Result<(), String> {
        let mark = self.store.arrival_mark().map_err(|e| e.to_string())?;
        for row in work.iter_mut().filter(|row| row.kind == "fire_event") {
            if let Js::Obj(payload) = &mut row.payload {
                payload.insert("arrivalMark".into(), Js::Num(mark.into()));
            }
        }
        Ok(())
    }

    /// A delivery's arrivals, each that names no record it is under taken as
    /// under the head the webhook it came through (`subscription_id`) was
    /// made for, when it is one for an edge's arrivals under one head: the
    /// waits log them, and the listens judge them, under that head.
    fn under_head(&self, subscription_id: &str, arrivals: &[ArrivalIn]) -> Vec<ArrivalIn> {
        let (name, key) = subscription_of(subscription_id);
        let head = key.zip(self.install(name)).and_then(|(key, credential)| crate::subscriptions::edge_webhook_head(credential, key));
        crate::arrivals::under_head(arrivals, head.as_deref())
    }

    /// The arrivals of `arrivals` that landed on an edge a listen of the
    /// connection they came for is on: what is judged against those listens.
    pub(crate) fn landed_for_listens(&self, adapter_type: &str, credential: Option<&str>, arrivals: &[ArrivalIn]) -> Vec<ArrivalIn> {
        arrivals
            .iter()
            .filter(|arrival| !arrival.gone && self.listens.iter().any(|l| l.is_on(adapter_type, &arrival.edge) && l.hears(credential)))
            .cloned()
            .collect()
    }
}

impl<R: Reader> InboundStore for LfDoors<'_, R> {
    /// `id` is a credential's name, or `<credential>/<key>` for one of its
    /// scoped webhooks (crate::subscriptions), whose secret is its own.
    async fn find_subscription(&self, id: &str) -> Result<Option<Subscription>, String> {
        let (name, key) = subscription_of(id);
        let Some(credential) = self.install(name) else { return Ok(None) };
        let Some(setup) = self.setup_of(&credential.external) else { return Ok(None) };
        // A scoped webhook listen-fire holds no record of has no door.
        if let Some(key) = key
            && !has_scoped(credential, key)
        {
            return Ok(None);
        }
        // A scoped webhook's own secret (the source issued it), else the
        // credential's, as for its unscoped webhook.
        let own = key.and_then(|key| scoped_secret(credential, key)).or_else(|| credential.fields.get(&setup.secret_field).cloned());
        // A connection's credential that holds no secret of its own is
        // verified with the install's, the one `listen-fire connect` set:
        // `credential add` asks for the keys a module reads (a module that
        // checks its own inbound reads them off the credential its URL
        // names), not the secret its deliveries are signed with.
        let secret = own.or_else(|| install_of(&self.installs, &credential.external).and_then(|install| install.fields.get(&setup.secret_field)).cloned());
        Ok(Some(Subscription {
            id: id.to_string(),
            team_id: LOCAL_TENANT.into(),
            provider_key: setup.provider_key(),
            secret: secret.unwrap_or_default(),
            checkpoint: self.store.inbound_checkpoint(id).map_err(|e| e.to_string())?,
        }))
    }

    fn knows_provider(&self, provider_key: &str) -> bool {
        self.serving(provider_key).is_some()
    }

    async fn arrivals_unkept(&self) -> Result<Option<String>, String> {
        self.store.arrivals_unkept().map_err(|e| e.to_string())
    }

    fn intercepts(&self, provider_key: &str) -> Vec<Intercept> {
        self.serving(provider_key).map(|setup| setup.declaration.intercepts.clone()).unwrap_or_default()
    }

    async fn source_for(&self, subscription: &Subscription) -> Result<Option<Source>, String> {
        let Some(credential) = self.install(subscription_of(&subscription.id).0) else { return Ok(None) };
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

    async fn check_inbound(&self, source: &Source, request: &RawRequest<'_>, secret: Option<&str>, checkpoint: Option<&Js>) -> Result<Js, String> {
        let install = self.install(&source.install).ok_or_else(|| format!("no install {}", source.install))?;
        self.reader.check_inbound(&source.adapter_type, install, &request.wire(), secret, checkpoint).await
    }

    // The event itself: the delivery's receipt (`keep`) holds it.
    async fn capture(&self, event: &Js, _source: &Source) -> Result<Js, String> {
        Ok(event.clone())
    }

    /// One store write: the delivery's receipt, the cursor, its arrivals, a
    /// `fire_event` row per event and a `wake_await` row per key and per
    /// wait its arrivals answer. Run inline instead, the receipt is kept
    /// first and its events run after, so a cursor is never kept past events
    /// its receipt does not hold. A duplicate writes nothing and runs
    /// nothing: its arrivals were logged with the first.
    ///
    /// A `fire_event` row carries the arrival log's mark after the
    /// delivery's own arrivals, so a run it starts never waits for them.
    async fn keep(&self, kept: Kept<'_>) -> Result<bool, String> {
        let adapter_type = &kept.source.adapter_type;
        let came_for = Delivered { id: None, credential: self.delivering_credential(kept.source), subscription: subscription_of(kept.subscription_id).1, arrival_mark: None, minted: None };
        let receipt = NewDelivery {
            id: uuid::Uuid::new_v4().to_string(),
            external_id: kept.external_id.map(str::to_string),
            received_at: iso(0),
            source: kept.door,
            inline: matches!(self.sink, EventSink::Inline { .. }),
            replay_of: None,
            events: kept.receipts.iter().map(|event| kept_event(adapter_type, event.clone(), came_for)).collect(),
        };
        let arrivals = self.under_head(kept.subscription_id, kept.arrivals);
        let landed = self.landed_for_listens(adapter_type, came_for.credential, &arrivals);
        let (minted, mut waits) = self.mint_runs(adapter_type, Some(&kept.source.install), came_for.credential, &landed).await?;
        let mut work: Vec<NewWork> = match &self.sink {
            EventSink::Queue | EventSink::Listed(_) => {
                let delivered = Delivered { id: Some(&receipt.id), ..came_for };
                let mut rows: Vec<NewWork> = kept.receipts.iter().map(|event| fire_event_work(adapter_type, event.clone(), delivered)).collect();
                if !landed.is_empty() {
                    let row = fire_arrivals_work(adapter_type, &landed, Delivered { minted: Some(&minted), ..delivered });
                    queued_by(&mut waits, &row.key);
                    rows.push(row);
                }
                rows
            }
            // Run inside the request: a run is started before the request
            // is answered, so there is no queue to outlast.
            EventSink::Inline { .. } => {
                queued_by(&mut waits, &format!("inline:{}", receipt.id));
                Vec::new()
            }
        };
        let logged_at = iso(0);
        let logged = logged(&arrivals);
        // A delivery without arrivals for the waits, or runs to open them
        // for, asks nothing of a store module written before them; its rows
        // carry the mark taken here.
        let arrivals = match (logged.as_slice(), waits.is_empty()) {
            ([], true) => {
                self.mark_fire_rows(&mut work)?;
                None
            }
            (arrivals, _) => Some(DeliveryArrivals { team_id: kept.team_id, adapter_type, arrivals, at: &logged_at, resend_window_ms: self.resend_window_ms(adapter_type) }),
        };
        let Some(written) = self.store.keep_delivery(kept.subscription_id, kept.checkpoint, &receipt, &work, arrivals.as_ref(), &waits).map_err(|e| e.to_string())? else {
            if let EventSink::Inline { fired, .. } = &self.sink {
                fired.borrow_mut().redelivered.push(format!("delivery {} was kept before: it runs nothing", kept.external_id.unwrap_or_default()));
            }
            return Ok(false);
        };
        work.extend(written.wakes);
        crate::wake::queued_rows(&work);
        self.list(&work);
        let landed = (!landed.is_empty()).then_some((adapter_type.as_str(), Delivered { minted: Some(&minted), ..came_for }, landed.as_slice()));
        self.run_inline(&receipt, written.arrival_mark, landed).await?;
        Ok(true)
    }

    /// A delivery none of whose events fits the payload every listen it
    /// would reach declares (`payload: <Payment>`) is refused, naming the
    /// fields. A listen that declares none takes any event.
    fn refuse_events(&self, source: &Source, events: &[Js]) -> Option<String> {
        let credential = self.delivering_credential(source);
        let mut lines = Vec::new();
        for event in events {
            let reached: Vec<&Listen> =
                self.listens.iter().filter(|l| l.plan.is_none() && l.adapter == source.adapter_type && l.hears(credential) && event_matches_trigger_scope(event, &l.config, Arrival::Pushed)).collect();
            if reached.is_empty() || reached.iter().any(|l| l.takes(event)) {
                continue;
            }
            let payload = event.get("payload").unwrap_or(&Js::Null);
            for listen in reached {
                let Some(declared) = &listen.payload else { continue };
                lines.push(format!("{}, as the listen firing {}:{} declares it: {}", declared.name, listen.file, listen.movement_name, declared.misfits(payload).join("; ")));
            }
        }
        (!lines.is_empty()).then(|| format!("the body does not fit what the listens on {} declare — {}", source.install, lines.join(" | ")))
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
        let mut work: Vec<NewWork> = receipt
            .events
            .iter()
            .map(|pushed| {
                let external = pushed.get("external").and_then(Js::as_str).unwrap_or_default();
                fire_event_work(external, pushed.get("event").cloned().unwrap_or(Js::Null), Delivered { id: Some(&receipt.id), ..Delivered::default() })
            })
            .collect();
        self.mark_fire_rows(&mut work)?;
        if self.store.keep_delivery(&caller.subscription_id, None, &receipt, &work, None, &[]).map_err(|e| e.to_string())?.is_none() {
            return Ok(false);
        }
        crate::wake::queued_rows(&work);
        self.list(&work);
        Ok(true)
    }

    /// What landed for a listen is judged by a `fire_event` row of its own,
    /// kept with a receipt of the push, its arrivals and the waits of the
    /// runs it fires in one write (as a delivery is): the row carries the
    /// mark before the arrivals, and each run's trigger is noted on its
    /// waits. What landed for none is logged alone.
    async fn log_pushed_arrivals(&self, caller: &PushCaller, arrivals: &[ArrivalIn]) -> Result<(), String> {
        let (logged, at) = (logged(arrivals), iso(0));
        let log = DeliveryArrivals { team_id: &caller.team_id, adapter_type: &caller.adapter_type, arrivals: &logged, at: &at, resend_window_ms: self.resend_window_ms(&caller.adapter_type) };
        let credential = self.install(&caller.subscription_id).filter(|c| c.binding != Binding::Install).map(|c| c.name.as_str());
        let landed = self.landed_for_listens(&caller.adapter_type, credential, arrivals);
        if landed.is_empty() {
            log_and_wake(self.store, &log)?;
            return Ok(());
        }
        let (minted, mut waits) = self.mint_runs(&caller.adapter_type, Some(&caller.subscription_id), credential, &landed).await?;
        let receipt = NewDelivery { id: uuid::Uuid::new_v4().to_string(), external_id: None, received_at: at.clone(), source: DeliverySource::Emit, inline: false, replay_of: None, events: Vec::new() };
        let row = fire_arrivals_work(&caller.adapter_type, &landed, Delivered { id: Some(&receipt.id), credential, minted: Some(&minted), ..Delivered::default() });
        queued_by(&mut waits, &row.key);
        let mut rows = vec![row];
        let logged = (!logged.is_empty() || !waits.is_empty()).then_some(&log);
        if logged.is_none() {
            self.mark_fire_rows(&mut rows)?;
        }
        let written = self.store.keep_delivery(&caller.subscription_id, None, &receipt, &rows, logged, &waits).map_err(|e| e.to_string())?.ok_or("a push without an id was taken for a duplicate")?;
        rows.extend(written.wakes);
        crate::wake::queued_rows(&rows);
        self.list(&rows);
        Ok(())
    }

    fn notify_pushed(&self) {
        (self.notify)();
    }
}

// ── The external, as the reader ─────────────────────────────────────────────

/// Deliveries read by the external over the protocol, under the install's
/// credential. No `listEventTypes`: listen-fire routes by the event itself, so a
/// delivery never costs the external a second call.
pub struct SessionReader<'a> {
    session: &'a Session,
}

impl SessionReader<'_> {
    async fn call(&self, external: &str, install: Option<&Credential>, method: &str, params: serde_json::Value) -> Result<Js, String> {
        let set = self.session.file_set();
        let running = set.running.iter().find(|r| r.external.manifest.name == external).ok_or_else(|| format!("no external {external}"))?;
        // As the user credential the door names, as the platform reads a
        // delivery as its subscription's credential: a source that is pulled
        // on a ping (Airtable's payload feed) reads with it. A door that names
        // the install carries no user credential, and the install signs.
        let secrets = self.session.secrets();
        let credentials = secrets.credentials();
        let carried = install.filter(|install| matches!(install.binding, Binding::Credential(_)));
        let lease = running.reach.lease().await?;
        let target = Target {
            external: &running.external,
            base_url: &lease.address,
            declarations: &running.credential_declarations,
            methods: &running.methods,
            settings: &running.settings,
            limits: &running.limits,
            inbound_url: running.inbound_url.as_deref(),
        };
        let sending = Sending { tenant: LOCAL_TENANT, method, cache_scope_id: "<none>", params, settings: None };
        let raw = send(&target, credentials, carried, signer_of(credentials, external, carried).or(install), sending).await?;
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

    async fn await_keys(&self, external: &str, install: Option<&Credential>, edge: &str, heads: Js) -> Result<Option<Js>, String> {
        if !self.lists(external, "awaitKeys") {
            return Ok(None);
        }
        let params = serde_json::json!({ "edge": edge, "heads": crate::wire::json_of_js(&heads) });
        self.call(external, install, "awaitKeys", params).await.map(Some)
    }

    async fn preprocess(&self, external: &str, install: &Credential, raw: &Js, checkpoint: Option<&Js>) -> Result<Extraction, String> {
        let mut params = serde_json::json!({ "raw": crate::wire::json_of_js(raw) });
        if let Some(checkpoint) = checkpoint {
            params["checkpoint"] = crate::wire::json_of_js(checkpoint);
        }
        let read = self.call(external, Some(install), "preprocessInbound", params).await?;
        Ok(Extraction {
            events: read.get("events").and_then(Js::as_array).map(<[Js]>::to_vec).unwrap_or_default(),
            arrivals: arrivals_of(&read).map_err(|e| format!("preprocessInbound for adapter {external}: {e}"))?,
            checkpoint: read.get("checkpoint").cloned(),
        })
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
        let secrets = self.session.secrets();
        let credentials = secrets.credentials();
        let carried = carried_credential(credentials, external, install);
        let lease = running.reach.lease().await?;
        let target = Target {
            external: &running.external,
            base_url: &lease.address,
            declarations: &running.credential_declarations,
            methods: &running.methods,
            settings: &running.settings,
            limits: &running.limits,
            inbound_url: running.inbound_url.as_deref(),
        };
        let sending = Sending { tenant: LOCAL_TENANT, method: "checkInbound", cache_scope_id: "<none>", params, settings: None };
        let raw = send(&target, credentials, carried, signer_of(credentials, external, carried).or(Some(install)), sending).await?;
        module_wire::results::check("checkInbound", external, &raw)
    }
}

/// A subscription id's credential, and its scoped webhook's key when it
/// names one (`<credential>/<key>`). A credential's name never holds a `/`.
pub fn subscription_of(id: &str) -> (&str, Option<&str>) {
    match id.split_once('/') {
        Some((credential, key)) => (credential, Some(key)),
        None => (id, None),
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

/// One of a delivery's events as its receipt keeps it: the event, the
/// external it came from and the connection and subscription it came for
/// (when its door named them), all a replay needs to queue it again.
fn kept_event(external: &str, event: Js, came_for: Delivered<'_>) -> Js {
    let mut kept = obj! { "external" => Js::str(external), "event" => event };
    came_for.write_into(&mut kept);
    Js::Obj(kept)
}

/// A queued event's `fire_event` row, for the drain: the run it starts
/// names its delivery (`delivered.id`), and only the listens of the
/// connection and subscription it came for take it (a row with neither, as
/// every row queued before rows named them, reaches every listen).
pub fn fire_event_work(external: &str, event: Js, delivered: Delivered<'_>) -> NewWork {
    fire_work(obj! { "external" => Js::str(external), "event" => event }, delivered)
}

/// A delivery's arrivals' `fire_event` row, for the drain: each judged then
/// against the listens on its edge (Session::fire_arrivals), as the event
/// rows of the same delivery are routed to the listens they reach. The runs
/// minted as it was kept ride on it (`runs`): the drain starts each under
/// the id its waits were opened for.
pub fn fire_arrivals_work(external: &str, arrivals: &[ArrivalIn], delivered: Delivered<'_>) -> NewWork {
    let mut payload = obj! { "external" => Js::str(external), "arrivals" => Js::Arr(arrivals.iter().map(ArrivalIn::to_js).collect()) };
    if let Some(minted) = delivered.minted.filter(|minted| minted.as_array().is_some_and(|runs| !runs.is_empty())) {
        payload.insert("runs".into(), minted.clone());
    }
    fire_work(payload, delivered)
}

fn fire_work(mut payload: crate::json::Obj, delivered: Delivered<'_>) -> NewWork {
    if let Some(id) = delivered.id {
        payload.insert("deliveryId".into(), Js::str(id));
    }
    delivered.write_into(&mut payload);
    if let Some(mark) = delivered.arrival_mark {
        payload.insert("arrivalMark".into(), Js::Num(mark.into()));
    }
    NewWork { kind: "fire_event".into(), key: format!("fire_event:{}", uuid::Uuid::new_v4()), payload: Js::Obj(payload), due_at: None, team_id: None }
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

    /// What each listen named was last resolved to (crate::resolve), by its
    /// pipeline.
    pub fn listen_states(&self, pipelines: &[String]) -> Result<std::collections::BTreeMap<String, crate::resolve::ListenState>, StoreError> {
        let mut states = std::collections::BTreeMap::new();
        let mut read = self.db.prepare("select state from listen_state where pipeline = ?")?;
        for pipeline in pipelines {
            let Some(text) = read.query_row(params![pipeline], |r| r.get::<_, String>(0)).optional()? else { continue };
            states.insert(pipeline.clone(), Self::listen_state_of(&text)?);
        }
        Ok(states)
    }

    /// Hold the listen's resolve: a listen never resolved is kept from now,
    /// with nothing resolved.
    pub fn claim_listen_resolve(&self, pipeline: &str, ttl_ms: i64) -> Result<Option<String>, StoreError> {
        let token = crate::store::uuid();
        let claimed = self.db.execute(
            "insert into listen_state (pipeline, state, lease_token, lease_until) values (?1, ?2, ?3, ?4)
             on conflict (pipeline) do update set lease_token = excluded.lease_token, lease_until = excluded.lease_until
             where listen_state.lease_until is null or listen_state.lease_until < ?5",
            params![pipeline, crate::resolve::ListenState::default().to_js().to_json(), token, iso(ttl_ms), iso(0)],
        )?;
        Ok((claimed > 0).then_some(token))
    }

    pub fn save_listen_resolution(&self, pipeline: &str, token: &str, resolution: &crate::resolve::Resolution) -> Result<bool, StoreError> {
        self.transaction(|db| {
            let Some(text) = db.query_row("select state from listen_state where pipeline = ? and lease_token = ?", params![pipeline, token], |r| r.get::<_, String>(0)).optional()? else {
                return Ok(false);
            };
            let state = crate::resolve::ListenState { resolution: resolution.clone(), ..Self::listen_state_of(&text)? };
            db.execute("update listen_state set state = ?, lease_token = null, lease_until = null where pipeline = ?", params![state.to_js().to_json(), pipeline])?;
            Ok(true)
        })
    }

    /// A stored listen's state, read back.
    fn listen_state_of(text: &str) -> Result<crate::resolve::ListenState, StoreError> {
        Js::parse(text.as_bytes()).ok().as_ref().and_then(crate::resolve::ListenState::from_js).ok_or_else(|| StoreError::Invalid(format!("a stored listen's state is not one: {text}")))
    }

    pub fn set_listen_paused(&self, pipeline: &str, paused: Option<&str>) -> Result<(), StoreError> {
        self.transaction(|db| {
            let text: Option<String> = db.query_row("select state from listen_state where pipeline = ?", params![pipeline], |r| r.get(0)).optional()?;
            let kept = text.as_deref().map(Self::listen_state_of).transpose()?.unwrap_or_default();
            let state = crate::resolve::ListenState { paused: paused.map(str::to_string), ..kept };
            db.execute(
                "insert into listen_state (pipeline, state) values (?, ?) on conflict (pipeline) do update set state = excluded.state",
                params![pipeline, state.to_js().to_json()],
            )?;
            Ok(())
        })
    }

    fn save_checkpoint_in(db: &rusqlite::Connection, subscription_id: &str, checkpoint: &Js) -> Result<(), StoreError> {
        db.execute(
            "insert into inbound_checkpoint (subscription_id, checkpoint) values (?, ?) on conflict (subscription_id) do update set checkpoint = excluded.checkpoint",
            params![subscription_id, checkpoint.to_json()],
        )?;
        Ok(())
    }

    /// crate::backend::RunHostStore::keep_delivery: one transaction, the
    /// receipt first. A duplicate writes nothing: no cursor, no arrivals, no
    /// rows.
    pub fn keep_delivery(
        &self,
        subscription_id: &str,
        checkpoint: Option<&Js>,
        delivery: &NewDelivery,
        work: &[NewWork],
        arrivals: Option<&DeliveryArrivals<'_>>,
        waits: &[DeliveryWait],
    ) -> Result<Option<KeptDelivery>, StoreError> {
        self.transaction(|db| {
            if !Store::insert_delivery_in(db, subscription_id, delivery)? {
                return Ok(None);
            }
            if let Some(checkpoint) = checkpoint {
                Self::save_checkpoint_in(db, subscription_id, checkpoint)?;
            }
            let mark = Store::arrival_mark_in(db)?;
            let (work, wakes) = match arrivals {
                None => (work.to_vec(), Vec::new()),
                Some(a) => {
                    Store::open_delivery_waits_in(db, a.team_id, a.adapter_type, waits, mark)?;
                    let logged = Store::log_arrivals_in(db, a)?;
                    delivery_rows(work, mark, a.team_id, &logged.wakes)
                }
            };
            for row in work.iter().chain(&wakes) {
                Store::enqueue_in(db, &row.kind, &row.key, &row.payload, row.due_at.as_deref())?;
            }
            Ok(Some(KeptDelivery { wakes, arrival_mark: mark }))
        })
    }
}

/// Each wait as opened for the run the `fire_event` row `fire_key` queues.
pub(crate) fn queued_by(waits: &mut [DeliveryWait], fire_key: &str) {
    for wait in waits {
        wait.fire_key = fire_key.to_string();
    }
}

/// The record an arrival lands, as `awaitKeys` takes a head: `{ recordId,
/// headData? }`, as a run waiting on it from its trigger names it. None for
/// a landing that names no record: nothing can be waited on off it.
fn trigger_head(arrival: &ArrivalIn) -> Option<Js> {
    let landing = arrival.landing.as_ref()?;
    let record_id = landing.get("recordId").and_then(Js::as_str).filter(|id| !id.is_empty())?;
    let mut head = obj! { "recordId" => Js::str(record_id) };
    if let Some(fields) = landing.get("fields").filter(|f| **f != Js::Null) {
        head.insert("headData".into(), fields.clone());
    }
    Some(Js::Obj(head))
}

// ── The legacy name: /hooks/<external>/<install> ───────────────────────────

/// The door's provider segment and subscription for listen-fire's older
/// `/hooks/<external>[/<install>]` (`hookTarget`): the install is the
/// external's only credential when the URL names none. None: the external
/// takes no webhooks.
pub fn hook_target(session: &Session, external: &str, install: Option<&str>) -> Option<(String, String)> {
    let set = session.file_set();
    let running = set.running.iter().find(|r| r.external.manifest.name == external)?;
    let setup = served_of(running).inbound?;
    let subscription = install.map(str::to_string).or_else(|| install_of(session.secrets().credentials(), external).map(|c| c.name.clone())).unwrap_or_default();
    Some((setup.declaration.provider_key, subscription))
}

/// One delivery through the core with its events run inside the request, as
/// `/hooks/...` and `listen-fire run --webhook` have always answered (`deliverInline`):
/// its runs, or the line a duplicate ran nothing with.
pub async fn deliver_inline(session: &Session, delivery: Delivery<'_>, notify: &dyn Fn()) -> (Answer, Fired) {
    let fired = RefCell::new(Fired::default());
    let doors = LfDoors::of_session(session, EventSink::Inline { session, fired: &fired }, notify);
    let answer = answer_delivery(&doors, delivery).await;
    drop(doors);
    (answer, fired.into_inner())
}

/// A delivery addressed by external, as `listen-fire run --webhook` names it.
pub struct Webhook<'a> {
    pub external: &'a str,
    /// The install it is for; the external's only one when None.
    pub install: Option<&'a str>,
    pub raw_body: &'a [u8],
    pub headers: &'a [(String, String)],
}

/// `listen-fire run --webhook`: a delivery taken as production takes one, its runs
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
    } else if let Some(message) = answer.body.get("message").and_then(Js::as_str) {
        format!("delivery refused: {message} ({})", answer.status)
    } else {
        format!("delivery refused: {code} ({})", answer.status)
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::backend::StoreSpec;
    use crate::store::DeliveryQuery;
    use crate::waits::NewArrival;

    const SECRET: &str = "s3cret";

    /// An adapter whose deliveries are lists of notes, each a `note.created`
    /// event, served by a module host on a thread of the test. While `down`
    /// is set its event types fail, and so does every event fired to it.
    /// It registers webhooks, each call noted in `registrations` with the
    /// token of the credential it was made as. A note's comments are a
    /// listenable edge (`Comments`, keyed `thread:<note>`): a delivery's
    /// `comments` are its arrivals.
    pub(crate) mod inbox {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::{Arc, Mutex};

        use module_kit::*;

        /// What lands as the inbox is next asked `awaitKeys`, run once.
        pub type OnAwaitKeys = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

        pub struct Inbox {
            pub down: Arc<AtomicBool>,
            pub registrations: Arc<Mutex<Vec<Js>>>,
            /// Polled too: each poll noted in `registrations`, and one note returned.
            pub polled: bool,
            /// A webhook per shelf (`subscriptionScopeKeys: [shelf]`), each
            /// with a secret of its own, `secret-<shelf>`.
            pub scoped: bool,
            /// Its webhooks lapse this long after they are registered or
            /// refreshed (`expiresAt`, `refreshEventSubscription`); each
            /// refresh noted in `registrations`, and refused while `down`.
            pub expiring: Option<i64>,
            /// Run once, as the next `awaitKeys` is asked: what lands while a
            /// run's wait opens.
            pub on_await_keys: OnAwaitKeys,
            /// Its notes are a listenable root `Notes` pushed to the
            /// connection (adapter protocol 2.6), taking `Title ==`: a webhook
            /// asked for with an `edge` is noted with its edge and filter,
            /// and its secret is `secret-<its id>`; a delivery's `arrivals`
            /// are passed on as they are.
            pub pushed: bool,
        }

        impl Adapter for Inbox {
            fn manifest(&self) -> AdapterManifest {
                let credential = Js::parse(br#"[{"name":"inbox","kind":"static","fields":[{"name":"token","optional":true}]}]"#).unwrap();
                let mut methods = vec!["listEventTypes", "preprocessInbound", "ensureEventSubscription", "removeEventSubscription", "awaitKeys"];
                methods.extend(self.polled.then_some("poll"));
                methods.extend(self.expiring.is_some().then_some("refreshEventSubscription"));
                let manifest = AdapterManifest::new("inbox")
                    .triggers(["webhook"])
                    .optional(methods)
                    .declare("subscribableEvents", Js::strings(["note.created"]))
                    .declare("credentials", credential);
                let manifest = match self.scoped {
                    true => manifest
                        .declare("subscriptionScopeKeys", Js::strings(["shelf"]))
                        .declare("listenConfig", Js::parse(br#"[{"key":"shelf"}]"#).unwrap()),
                    false => manifest,
                };
                let manifest = match self.pushed {
                    true => manifest.declare("protocolMinor", Js::Num(6.into())),
                    false => manifest,
                };
                match self.polled {
                    true => manifest.declare("poll", Js::parse(br#"{"intervalSeconds":60}"#).unwrap()),
                    false => manifest,
                }
            }

            async fn list_entry_points(&self, _: &Ctx) -> Answer<Vec<EntryPoint>> {
                let listenable = match self.pushed {
                    true => Js::parse(br#"{"collectionName":"Notes","listenable":true,"delivery":"connection","identity":"Id","capability":{"filter":"native","supportsLimit":false}}"#).unwrap(),
                    false => Js::Obj(Obj::new()),
                };
                let Js::Obj(listenable) = listenable else { unreachable!("an object") };
                Ok(vec![
                    EntryPoint { type_id: "Note".into(), display_name: "Note".into(), writable: false, readable: false, fires: Some(true), description: None, rest: listenable },
                    EntryPoint { type_id: "Comment".into(), display_name: "Comment".into(), writable: false, readable: false, fires: None, description: None, rest: Obj::new() },
                ])
            }

            async fn describe(&self, _: &Ctx, request: Describe) -> Answer<Option<TypeDescriptor>> {
                let comments = Reference {
                    field_id: "Comments".into(),
                    name: "Comments".into(),
                    target_type_id: "Comment".into(),
                    cardinality: "many".into(),
                    direction: "outgoing".into(),
                    writable: false,
                    rest: obj! { "listenable" => Js::Bool(true), "readable" => Js::Bool(false), "identity" => Js::str("Id") },
                };
                let mut title = Field::new("Title", "string", true, true);
                if self.pushed {
                    title.rest.insert("capability".into(), Js::parse(br#"{"filterOperators":["eq"]}"#).unwrap());
                }
                let (fields, references) = match request.type_id.as_str() {
                    "Note" if self.pushed => (vec![Field::new("Id", "string", false, false), title], vec![comments]),
                    "Note" => (vec![title], vec![comments]),
                    "Comment" => (vec![Field::new("Id", "string", false, false), Field::new("Text", "string", false, false)], vec![]),
                    _ => return Ok(None),
                };
                Ok(Some(TypeDescriptor { type_id: request.type_id.clone(), display_name: request.type_id.clone(), fields, references, deletable: None, rest: Obj::new() }))
            }

            async fn create_record(&self, _: &Ctx, _: CreateRecord) -> Answer<Written> {
                Err(ModuleError::bad_request("the inbox is read only"))
            }

            async fn update_record(&self, _: &Ctx, _: UpdateRecord) -> Answer<Option<Updated>> {
                Ok(None)
            }

            async fn optional(&self, ctx: &Ctx, method: &str, params: Js) -> Answer<Js> {
                let token = ctx.credential.as_ref().and_then(|c| c.get("fields")).and_then(|f| f.get("token")).cloned().unwrap_or(Js::Null);
                match method {
                    "ensureEventSubscription" if params.get("edge").is_some() => {
                        // Held already: left as it is.
                        if params.get("current").is_some() {
                            return Ok(Js::Null);
                        }
                        let mut registrations = self.registrations.lock().unwrap();
                        let id = format!("wh-{}", registrations.len() + 1);
                        let mut made = obj! { "token" => token, "callbackUrl" => params.get("callbackUrl").cloned().unwrap_or(Js::Null), "edge" => params.get("edge").cloned().unwrap_or(Js::Null) };
                        for named in ["filter", "scope"] {
                            if let Some(value) = params.get(named) {
                                made.insert(named.into(), value.clone());
                            }
                        }
                        registrations.push(Js::Obj(made));
                        let mut answer = obj! { "externalId" => Js::str(&id), "secret" => Js::str(format!("secret-{id}")) };
                        if let Some(lifetime) = self.expiring {
                            answer.insert("expiresAt".into(), Js::str(crate::store::iso(lifetime)));
                        }
                        Ok(Js::Obj(answer))
                    }
                    "ensureEventSubscription" => {
                        // As registered: the webhook is left as it is.
                        if params.get("current").and_then(|c| c.get("events")).is_some_and(|e| Some(e) == params.get("events")) {
                            return Ok(Js::Null);
                        }
                        let mut registrations = self.registrations.lock().unwrap();
                        let id = format!("wh-{}", registrations.len() + 1);
                        let mut made = obj! { "token" => token, "callbackUrl" => params.get("callbackUrl").cloned().unwrap_or(Js::Null), "events" => params.get("events").cloned().unwrap_or(Js::Null) };
                        let mut answer = obj! { "externalId" => Js::str(&id) };
                        if let Some(scope) = params.get("scope") {
                            made.insert("scope".into(), scope.clone());
                            let shelf = scope.get("shelf").and_then(Js::as_str).unwrap_or_default();
                            answer.insert("secret".into(), Js::str(format!("secret-{shelf}")));
                        }
                        registrations.push(Js::Obj(made));
                        if let Some(lifetime) = self.expiring {
                            answer.insert("expiresAt".into(), Js::str(crate::store::iso(lifetime)));
                        }
                        Ok(Js::Obj(answer))
                    }
                    "refreshEventSubscription" if self.down.load(Ordering::SeqCst) => Err(ModuleError::bad_request("the inbox is down")),
                    "refreshEventSubscription" => {
                        let mut refreshed = obj! { "token" => token, "refreshed" => params.get("externalId").cloned().unwrap_or(Js::Null) };
                        if let Some(edge) = params.get("edge") {
                            refreshed.insert("edge".into(), edge.clone());
                        }
                        self.registrations.lock().unwrap().push(Js::Obj(refreshed));
                        Ok(Js::Obj(obj! { "expiresAt" => Js::str(crate::store::iso(self.expiring.unwrap_or_default())) }))
                    }
                    "poll" => {
                        self.registrations.lock().unwrap().push(Js::Obj(obj! { "token" => token, "polled" => Js::Bool(true) }));
                        let note = Js::parse(br#"{"payload":{"id":"p-1"},"externalId":"p-1","eventType":"note.created","recordType":"Note"}"#).unwrap();
                        Ok(Js::Obj(obj! { "events" => Js::Arr(vec![note]) }))
                    }
                    "removeEventSubscription" => {
                        let mut removed = obj! { "token" => token, "removed" => params.get("externalId").cloned().unwrap_or(Js::Null) };
                        for named in ["edge", "filter", "scope"] {
                            if let Some(value) = params.get(named) {
                                removed.insert(named.into(), value.clone());
                            }
                        }
                        self.registrations.lock().unwrap().push(Js::Obj(removed));
                        Ok(Js::Null)
                    }
                    "awaitKeys" => {
                        if let Some(landing) = self.on_await_keys.lock().unwrap().take() {
                            landing();
                        }
                        // A note whose id starts `gone-` was deleted before its wait opened.
                        let heads = params.get("heads").and_then(Js::as_array).unwrap_or(&[]).to_vec();
                        let keys = heads.iter().map(|head| match head.get("recordId").and_then(Js::as_str).unwrap_or_default() {
                            id if id.starts_with("gone-") => Js::Obj(obj! { "gone" => Js::Bool(true) }),
                            id => Js::Obj(obj! { "key" => Js::str(format!("thread:{id}")) }),
                        });
                        Ok(Js::Arr(keys.collect()))
                    }
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
                                    "tag" => Js::str("note.created"),
                                    "eventType" => Js::str("note.created"),
                                    "changeType" => Js::str("create"),
                                    "recordType" => Js::str("Note"),
                                })
                            })
                            .collect();
                        // A comment on a note is an arrival on its `Comments`.
                        let comments = params.get("raw").and_then(|raw| raw.get("comments")).and_then(Js::as_array).unwrap_or(&[]).to_vec();
                        let passed = params.get("raw").and_then(|raw| raw.get("arrivals")).and_then(Js::as_array).unwrap_or(&[]).to_vec();
                        let arrivals = passed.into_iter().chain(comments
                            .iter()
                            .map(|comment| {
                                let text = |key: &str| comment.get(key).cloned().unwrap_or(Js::Null);
                                let note = comment.get("note").and_then(Js::as_str).unwrap_or_default();
                                Js::Obj(obj! {
                                    "edge" => Js::str("Comments"),
                                    "key" => Js::str(format!("thread:{note}")),
                                    "identity" => text("id"),
                                    "landing" => Js::Obj(obj! { "recordType" => Js::str("Comment"), "fields" => Js::Obj(obj! { "Text" => text("Text") }) }),
                                })
                            }))
                            .collect();
                        Ok(Js::Obj(obj! { "events" => Js::Arr(events), "arrivals" => Js::Arr(arrivals) }))
                    }
                    other => Err(ModuleError::not_implemented(other)),
                }
            }
        }

        /// The inbox at `/inbox`, on a loopback port of its own thread.
        pub fn serve(inbox: Inbox) -> u16 {
            let (sent, port) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                tokio::task::LocalSet::new().block_on(&runtime, async move {
                    let listener = Listener::bind(&Address::Tcp(([127, 0, 0, 1], 0).into())).await.unwrap();
                    sent.send(listener.address().parse::<u16>().unwrap()).unwrap();
                    Host::new().adapter(inbox).serve(listener).await.unwrap();
                });
            });
            port.recv().unwrap()
        }
    }

    /// A project whose `inbox` external takes signed webhooks, each delivery
    /// named by its `x-inbox-delivery` header, and whose one movement takes
    /// its notes; the inbox can be taken down.
    pub(crate) struct InboxProject {
        pub root: std::path::PathBuf,
        pub down: Arc<AtomicBool>,
        pub registrations: Arc<std::sync::Mutex<Vec<Js>>>,
        /// Run once, as the inbox is next asked `awaitKeys`.
        pub on_await_keys: inbox::OnAwaitKeys,
    }

    /// Two connections of the inbox, each under a credential of its own, and
    /// a movement on each; the install `inbox` serves both.
    pub(crate) const TWO_CONNECTIONS: &str = "import { inbox } from adapters\nimport { inbox_a, inbox_b } from credentials\n\na = connect inbox using inbox_a\nb = connect inbox using inbox_b\n\nfunction noted_a(note: <a-[:Note]->>) {\n  return \"a\"\n}\n\nfunction noted_b(note: <b-[:Note]->>) {\n  return \"b\"\n}\n\nlisten to a { events: [\"note.created\"] } fire noted_a\nlisten to b { events: [\"note.created\", \"note.updated\"] } fire noted_b\n";

    /// Their secrets: each connection's own webhook secret and token, and the install's.
    pub(crate) const TWO_CREDENTIALS: &str = "inbox:\n  module: inbox\n  webhook_secret: shared\ninbox_a:\n  external: inbox\n  webhook_secret: secret-a\n  token: a\ninbox_b:\n  external: inbox\n  webhook_secret: secret-b\n  token: b\n";

    /// Which inbox a project's external is.
    #[derive(Default)]
    struct Flavour {
        polled: bool,
        scoped: bool,
        expiring: Option<i64>,
        pushed: bool,
    }

    impl InboxProject {
        fn new() -> InboxProject {
            InboxProject::with(
                "import { inbox } from adapters\n\ni = connect inbox\n\nfunction noted(note: <i-[:Note]->>) {\n  return \"seen\"\n}\n\nlisten to i { events: [\"note.created\"] } fire noted\n",
                &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"),
                "",
            )
        }

        /// The project with `movement` as its one movement file, `secrets`
        /// its secrets and `lf_yaml` appended to its lf.yaml.
        pub(crate) fn with(movement: &str, secrets: &str, lf_yaml: &str) -> InboxProject {
            InboxProject::made(movement, secrets, lf_yaml, Flavour::default())
        }

        /// As `with`, the inbox polled as well.
        pub(crate) fn polled(movement: &str, secrets: &str) -> InboxProject {
            InboxProject::made(movement, secrets, "", Flavour { polled: true, ..Flavour::default() })
        }

        /// As `with`, the inbox's webhooks scoped by shelf.
        pub(crate) fn scoped(movement: &str, secrets: &str, lf_yaml: &str) -> InboxProject {
            InboxProject::made(movement, secrets, lf_yaml, Flavour { scoped: true, ..Flavour::default() })
        }

        /// As `with`, its notes a listenable root `Notes` pushed to the
        /// connection, each listen on it subscribed for by the key it shares.
        pub(crate) fn pushed(movement: &str, secrets: &str, lf_yaml: &str) -> InboxProject {
            InboxProject::made(movement, secrets, lf_yaml, Flavour { pushed: true, ..Flavour::default() })
        }

        /// As `pushed`, its webhooks lapsing `lifetime_ms` after each
        /// registration or refresh.
        pub(crate) fn pushed_expiring(movement: &str, secrets: &str, lf_yaml: &str, lifetime_ms: i64) -> InboxProject {
            InboxProject::made(movement, secrets, lf_yaml, Flavour { pushed: true, expiring: Some(lifetime_ms), ..Flavour::default() })
        }

        /// As `scoped`, its webhooks lapsing `lifetime_ms` after each
        /// registration or refresh.
        pub(crate) fn expiring(movement: &str, secrets: &str, lf_yaml: &str, lifetime_ms: i64) -> InboxProject {
            InboxProject::made(movement, secrets, lf_yaml, Flavour { scoped: true, expiring: Some(lifetime_ms), ..Flavour::default() })
        }

        fn made(movement: &str, secrets: &str, lf_yaml: &str, flavour: Flavour) -> InboxProject {
            let down = Arc::new(AtomicBool::new(false));
            let registrations = Arc::new(std::sync::Mutex::new(Vec::new()));
            let on_await_keys = Arc::new(std::sync::Mutex::new(None));
            let port = inbox::serve(inbox::Inbox {
                down: down.clone(),
                registrations: registrations.clone(),
                polled: flavour.polled,
                scoped: flavour.scoped,
                expiring: flavour.expiring,
                on_await_keys: on_await_keys.clone(),
                pushed: flavour.pushed,
            });
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
            std::fs::write(root.join("movements/noted.mvt"), movement).unwrap();
            let lf = root.join("lf.yaml");
            std::fs::write(&lf, format!("{}{lf_yaml}", std::fs::read_to_string(&lf).unwrap())).unwrap();
            let secrets_file = root.join(".lf/secrets.yaml");
            std::fs::write(&secrets_file, secrets).unwrap();
            std::fs::set_permissions(&secrets_file, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
            InboxProject { root, down, registrations, on_await_keys }
        }

        pub(crate) async fn session(&self) -> Session {
            let project = crate::project::load_project(&self.root).unwrap();
            crate::runs::open_session(project, &crate::runs::Opening { ephemeral: false, store: &StoreSpec::Sqlite(self.root.join(".lf/state.db")), role: crate::runs::Role::Serve, routes_listens: false }).await.unwrap()
        }
    }

    impl Drop for InboxProject {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    /// The signed headers of one delivery to the inbox, under `id`.
    fn signed(body: &[u8], id: &str) -> Vec<(String, String)> {
        signed_with(SECRET, body, id)
    }

    fn signed_with(secret: &str, body: &[u8], id: &str) -> Vec<(String, String)> {
        let mut mac = <hmac::Hmac<sha2::Sha256> as hmac::KeyInit>::new_from_slice(secret.as_bytes()).unwrap();
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

    pub(crate) fn in_local<F: std::future::Future>(future: F) -> F::Output {
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

    /// One delivery of `body` to `subscription`'s door, signed with
    /// `secret`, its events run inside the request: the movements it ran.
    async fn movements_run_by(session: &Session, subscription: &str, secret: &str, id: &str) -> Vec<String> {
        let headers = signed_with(secret, NOTE, id);
        let delivery = Delivery { provider: "inbox", subscription_id: subscription, raw_body: NOTE, headers: &headers, method: "POST", path: "", query: "", source: DeliverySource::Hook };
        let (answer, fired) = deliver_inline(session, delivery, &|| {}).await;
        assert_eq!(answer.status, 200, "{}", answer.body.to_json());
        let mut movements: Vec<String> = fired.outcomes.into_iter().map(|o| o.movement).collect();
        movements.sort();
        movements
    }

    #[test]
    fn a_delivery_fires_only_the_listens_of_the_connection_it_came_for() {
        let project = InboxProject::with(TWO_CONNECTIONS, TWO_CREDENTIALS, "");
        in_local(async {
            let session = project.session().await;
            assert_eq!(movements_run_by(&session, "inbox_a", "secret-a", "d-1").await, ["noted_a"]);
            assert_eq!(movements_run_by(&session, "inbox_b", "secret-b", "d-2").await, ["noted_b"]);
            // The install serves every connection: its door's delivery names
            // none, and reaches each (the platform's shared bot).
            assert_eq!(movements_run_by(&session, "inbox", "shared", "d-3").await, ["noted_a", "noted_b"]);

            let receipts = kept(&session);
            let of = |id: &str| receipts.iter().find(|r| r.external_id.as_deref() == Some(id)).map(|r| session.store.delivery(&r.id).unwrap().unwrap().events.unwrap()).unwrap();
            assert_eq!(of("d-2")[0].get("credential"), Some(&Js::str("inbox_b")), "a kept event names the connection it came for, for a replay");
            assert_eq!(of("d-3")[0].get("credential"), None);
        });
    }

    #[test]
    fn a_connection_s_door_without_a_secret_of_its_own_verifies_with_the_install_s() {
        let secrets = "inbox:\n  module: inbox\n  webhook_secret: shared\ninbox_a:\n  external: inbox\n  token: a\ninbox_b:\n  external: inbox\n  webhook_secret: secret-b\n  token: b\n";
        let project = InboxProject::with(TWO_CONNECTIONS, secrets, "");
        in_local(async {
            let session = project.session().await;
            let status = |subscription: &'static str, secret: &'static str, id: &'static str| {
                let session = &session;
                async move {
                    let headers = signed_with(secret, NOTE, id);
                    let delivery = Delivery { provider: "inbox", subscription_id: subscription, raw_body: NOTE, headers: &headers, method: "POST", path: "", query: "", source: DeliverySource::Hook };
                    deliver_inline(session, delivery, &|| {}).await.0.status
                }
            };
            assert_eq!(status("inbox_a", "secret-a", "d-1").await, 401, "a secret the credential never held");
            assert_eq!(movements_run_by(&session, "inbox_a", "shared", "d-2").await, ["noted_a"]);
            // A credential's own secret is still the one its door verifies with.
            assert_eq!(status("inbox_b", "shared", "d-3").await, 401);
            assert_eq!(movements_run_by(&session, "inbox_b", "secret-b", "d-4").await, ["noted_b"]);
        });
    }

    #[test]
    fn a_queued_delivery_runs_its_connections_listens_and_an_older_row_every_listen() {
        let project = InboxProject::with(TWO_CONNECTIONS, TWO_CREDENTIALS, "");
        in_local(async {
            let session = project.session().await;
            let headers = signed_with("secret-b", NOTE, "d-1");
            let delivery = Delivery { provider: "inbox", subscription_id: "inbox_b", raw_body: NOTE, headers: &headers, method: "POST", path: "", query: "", source: DeliverySource::Webhook };
            let doors = LfDoors::of_session(&session, EventSink::Queue, &|| {});
            assert_eq!(answer_delivery(&doors, delivery).await.status, 200);
            drop(doors);
            let drained = || async {
                crate::drain::drain(&session, &crate::drain::DrainOptions { until_idle: true, max_seconds: None }, &mut Vec::new()).await.unwrap();
                let mut movements: Vec<String> = session.store.runs(10).unwrap().into_iter().map(|r| r.movement).collect();
                movements.sort();
                movements
            };
            assert_eq!(drained().await, ["noted_b"]);

            // A row queued before rows named their connection reaches every listen, as it did.
            let event = Js::parse(br#"{"payload":{"id":"n-2"},"externalId":"n-2","eventType":"note.created","recordType":"Note"}"#).unwrap();
            let older = Js::Obj(obj! { "external" => Js::str("inbox"), "event" => event });
            session.store.enqueue("fire_event", "fire_event:older", &older, None, None).unwrap();
            assert_eq!(drained().await, ["noted_a", "noted_b", "noted_b"]);
        });
    }

    #[test]
    fn a_polled_listen_polls_as_its_own_connection() {
        let project = InboxProject::polled(TWO_CONNECTIONS, TWO_CREDENTIALS);
        in_local(async {
            let session = project.session().await;
            for movement in ["noted_b", "noted_a"] {
                let fired = session.run_poll(movement).await.unwrap();
                assert_eq!(fired.outcomes.iter().map(|o| o.movement.as_str()).collect::<Vec<_>>(), [movement]);
            }
            let polled: Vec<String> = project.registrations.lock().unwrap().iter().map(Js::to_json).collect();
            assert_eq!(polled, [r#"{"token":"b","polled":true}"#, r#"{"token":"a","polled":true}"#]);
        });
    }

    /// The doors over `store` for one push external, `acme`, whose install
    /// presents `Bearer t0k`, its deliveries queued.
    fn push_doors(store: &Store) -> LfDoors<'_, NoReader> {
        let fields = std::collections::BTreeMap::from([("token".to_string(), "t0k".to_string())]);
        let install = Credential { name: "acme".into(), external: "acme".into(), binding: Binding::Install, fields, origin: Default::default() };
        LfDoors {
            store,
            served: vec![Served { external: "acme".into(), inbound: None, push_field: Some("token".into()), resend_window_ms: crate::externals::DEFAULT_RESEND_WINDOW_MS }],
            installs: std::borrow::Cow::Owned(vec![install]),
            reader: NoReader,
            sink: EventSink::Queue,
            notify: &|| {},
            listens: Vec::new(),
        }
    }

    /// A push external reads no deliveries.
    pub(crate) struct NoReader;

    impl Reader for NoReader {
        async fn await_keys(&self, _: &str, _: Option<&Credential>, _: &str, _: Js) -> Result<Option<Js>, String> {
            Ok(None)
        }
        fn reads_deliveries(&self, _external: &str) -> bool {
            false
        }
        async fn preprocess(&self, _: &str, _: &Credential, _: &Js, _: Option<&Js>) -> Result<Extraction, String> {
            Err("no deliveries".into())
        }
        async fn check_inbound(&self, _: &str, _: &Credential, _: &Js, _: Option<&str>, _: Option<&Js>) -> Result<Js, String> {
            Err("no deliveries".into())
        }
    }

    fn state_file() -> (std::path::PathBuf, Store) {
        let dir = std::env::temp_dir().join(format!("lf-doors-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("state.db")).unwrap();
        (dir, store)
    }

    /// A run `run-1` parked on its wait for `key`'s `Comments`: the wait's id.
    fn parked_on(store: &Store, key: &str) -> String {
        use crate::store::{Park, ParkKind, RunStart};
        store.start_run(&RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None }).unwrap();
        let since = store.arrival_mark().unwrap();
        let open = crate::waits::OpenWait { run_id: "run-1", team_id: LOCAL_TENANT, adapter_type: "acme", edge: "Comments", key: Some(key), since };
        let wait = store.open_wait(&open).unwrap();
        store.commit_park(&Park { run_id: "run-1", address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &wait } }).unwrap();
        wait
    }

    fn queued(store: &Store) -> Vec<(String, String)> {
        let due = crate::store::ClaimDue { limit: 100, lease_ms: 60_000, due_by: None, kinds: None };
        store.claim_due(&due).unwrap().into_iter().map(|row| (row.kind, row.payload.to_json())).collect()
    }

    async fn wake(doors: &LfDoors<'_, NoReader>, body: &str) -> Answer {
        let headers = vec![("authorization".to_string(), "Bearer t0k".to_string())];
        crate::inbound::answer_push(doors, crate::inbound::Push::Wake, "acme", &headers, body.as_bytes()).await
    }

    #[test]
    fn the_wake_door_logs_arrivals_and_queues_a_wake_per_parked_wait() {
        let (dir, store) = state_file();
        let wait = parked_on(&store, "thread:c1");
        in_local(async {
            let doors = push_doors(&store);
            let answer = wake(&doors, r#"{"arrivals":[{"edge":"Comments","key":"thread:c1","identity":"k1","landing":{"fields":{"Text":"hi"}}},{"edge":"Comments","key":"thread:c9","identity":"k2","landing":{"fields":{}}}]}"#).await;
            assert_eq!((answer.status, answer.body.to_json()), (202, r#"{"accepted":2}"#.to_string()));
        });
        assert_eq!(queued(&store), [("wake_await".to_string(), format!(r#"{{"waitId":"{wait}","runId":"run-1","address":"s1"}}"#))]);
        let landed = store.wait_arrivals(&wait).unwrap().arrivals;
        assert_eq!(landed.iter().map(|a| (a.identity.as_str(), a.landing.to_json())).collect::<Vec<_>>(), [("k1", r#"{"fields":{"Text":"hi"}}"#.to_string())]);
        std::fs::remove_dir_all(dir).ok();
    }

    /// A module that reads every delivery as the arrivals it holds.
    struct ArrivalsReader(Vec<ArrivalIn>);

    impl Reader for ArrivalsReader {
        async fn await_keys(&self, _: &str, _: Option<&Credential>, _: &str, _: Js) -> Result<Option<Js>, String> {
            Ok(None)
        }
        fn reads_deliveries(&self, _external: &str) -> bool {
            true
        }
        async fn preprocess(&self, _: &str, _: &Credential, _: &Js, _: Option<&Js>) -> Result<Extraction, String> {
            Ok(Extraction { events: Vec::new(), arrivals: self.0.clone(), checkpoint: None })
        }
        async fn check_inbound(&self, _: &str, _: &Credential, _: &Js, _: Option<&str>, _: Option<&Js>) -> Result<Js, String> {
            Err("checks no inbound".into())
        }
    }

    /// A note that names no board, delivered through the webhook listen-fire
    /// holds for one board's notes, is logged for the waits under that board,
    /// as a poll made for the board logs it; one naming its board keeps it.
    #[test]
    fn an_arrival_through_a_webhook_for_one_head_that_names_none_is_logged_under_that_head() {
        let (dir, store) = state_file();
        let wait = parked_on(&store, "b1");
        let note = |id: &str, key: Option<&str>| ArrivalIn {
            edge: "Comments".into(),
            key: key.map(str::to_string),
            identity: Some(id.into()),
            version: None,
            landing: Some(Js::parse(br#"{"fields":{"Text":"hi"}}"#).unwrap()),
            gone: false,
            parents: Vec::new(),
            about: None,
            not_for: None,
            taken_applied: false,
        };
        let webhooks = r#"{"edge-b1":{"edge":"Comments","scope":"b1","secret":"s3cret"},"edge-b9":{"edge":"Comments","scope":"b9","secret":"s3cret"}}"#;
        let fields = std::collections::BTreeMap::from([("edge_subscriptions".to_string(), webhooks.to_string())]);
        let credential = Credential { name: "acme_a".into(), external: "acme".into(), binding: Binding::Credential("acme".into()), fields, origin: Default::default() };
        let declaration = Declaration { provider_key: "acme".into(), scheme: Scheme::Remote, signature_headers: Vec::new(), intercepts: Vec::new(), secret_from_provider: false, delivery_id_header: None };
        let doors = LfDoors {
            store: &store,
            served: vec![Served { external: "acme".into(), inbound: Some(InboundSetup { declaration, secret_field: DEFAULT_WEBHOOK_SECRET_FIELD.into() }), push_field: None, resend_window_ms: crate::externals::DEFAULT_RESEND_WINDOW_MS }],
            installs: std::borrow::Cow::Owned(vec![credential]),
            reader: ArrivalsReader(vec![note("k1", None), note("k2", Some("b9"))]),
            sink: EventSink::Queue,
            notify: &|| {},
            listens: Vec::new(),
        };
        in_local(async {
            let body = br#"{}"#;
            let headers = signed_with("s3cret", body, "d-1");
            let delivery = Delivery { provider: "acme", subscription_id: "acme_a/edge-b1", raw_body: body, headers: &headers, method: "POST", path: "", query: "", source: DeliverySource::Webhook };
            let answer = answer_delivery(&doors, delivery).await;
            assert_eq!(answer.status, 200, "{}", answer.body.to_json());
        });
        let landed = store.wait_arrivals(&wait).unwrap().arrivals;
        assert_eq!(landed.iter().map(|a| a.identity.as_str()).collect::<Vec<_>>(), ["k1"], "the note naming no board is the board's; the one naming b9 is b9's");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn an_arrival_without_identity_is_refused_by_name() {
        let (dir, store) = state_file();
        in_local(async {
            let doors = push_doors(&store);
            let answer = wake(&doors, r#"{"arrivals":[{"edge":"Comments","key":"thread:c1","landing":{"fields":{}}}]}"#).await;
            assert_eq!(
                (answer.status, answer.body.to_json()),
                (400, r#"{"error":"bad_request","issues":[{"path":"arrivals","message":"arrival 0 on 'Comments' has no identity"}]}"#.to_string())
            );
            assert_eq!(wake(&doors, r#"{"arrivals":[]}"#).await.status, 400);
        });
        assert_eq!(store.arrival_mark().unwrap(), 0, "nothing was logged");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_wake_door_refuses_keys_naming_adapter_protocol_2_5() {
        let (dir, store) = state_file();
        let wait = parked_on(&store, "thread:c1");
        in_local(async {
            let doors = push_doors(&store);
            for body in [r#"{"keys":["thread:c1"]}"#, r#"{"keys":["thread:c1"],"arrivals":[{"edge":"Comments","key":"thread:c1","identity":"k1","landing":{"fields":{}}}]}"#] {
                let answer = wake(&doors, body).await;
                assert_eq!(answer.status, 400);
                let issue = answer.body.get("issues").and_then(Js::as_array).and_then(|issues| issues.first()).cloned().unwrap_or(Js::Null);
                assert_eq!(issue.get("path").and_then(Js::as_str), Some("keys"));
                assert!(issue.get("message").and_then(Js::as_str).is_some_and(|m| m.contains("adapter protocol 2.5") && m.contains("`arrivals`")), "{issue:?}");
            }
        });
        // Refused whole: nothing logged, nothing woken.
        assert_eq!(store.wait_arrivals(&wait).unwrap().arrivals.len(), 0);
        assert!(queued(&store).is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    const NOTE_AND_COMMENT: &[u8] = br#"{"notes":[{"id":"n-1","Title":"hello"}],"comments":[{"note":"n-0","id":"k1","Text":"hi"}]}"#;

    /// One delivery of `body` to the inbox's door, its events queued.
    async fn queue_delivery(session: &Session, body: &[u8], id: &str) -> Answer {
        let headers = signed(body, id);
        let delivery = Delivery { provider: "inbox", subscription_id: "inbox", raw_body: body, headers: &headers, method: "POST", path: "", query: "", source: DeliverySource::Webhook };
        let doors = LfDoors::of_session(session, EventSink::Queue, &|| {});
        answer_delivery(&doors, delivery).await
    }

    #[test]
    fn a_delivery_asks_arrivals_and_logs_them() {
        let project = InboxProject::new();
        in_local(async {
            let session = project.session().await;
            use crate::store::RunStart;
            session.store.start_run(&RunStart { id: "run-1", file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None }).unwrap();
            let open = crate::waits::OpenWait { run_id: "run-1", team_id: LOCAL_TENANT, adapter_type: "inbox", edge: "Comments", key: Some("thread:n-0"), since: 0 };
            let wait = session.store.open_wait(&open).unwrap();
            assert_eq!(queue_delivery(&session, br#"{"notes":[],"comments":[{"note":"n-0","id":"k1","Text":"hi"}]}"#, "d-1").await.status, 200);
            let landed = session.store.wait_arrivals(&wait).unwrap().arrivals;
            assert_eq!(
                landed.iter().map(|a| (a.identity.as_str(), a.landing.to_json())).collect::<Vec<_>>(),
                [("k1", r#"{"recordType":"Comment","fields":{"Text":"hi"}}"#.to_string())],
                "a delivery with no events is kept for its arrivals"
            );
        });
    }

    #[test]
    fn a_delivery_keeps_the_arrival_mark_on_its_fire_row() {
        let project = InboxProject::new();
        in_local(async {
            let session = project.session().await;
            let earlier = NewArrival { edge: "Comments".into(), key: "thread:n-9".into(), identity: Some("k0".into()), version: None, landing: None, gone: false };
            session.store.log_now(LOCAL_TENANT, "inbox", &[earlier]).unwrap();
            let before = session.store.arrival_mark().unwrap();
            assert_eq!(queue_delivery(&session, NOTE_AND_COMMENT, "d-1").await.status, 200);
            let mark = session.store.arrival_mark().unwrap();
            assert_eq!(mark, before + 1, "the delivery's comment was logged");
            let due = crate::store::ClaimDue { limit: 10, lease_ms: 60_000, due_by: None, kinds: None };
            let rows = session.store.claim_due(&due).unwrap();
            let fired: Vec<Option<&Js>> = rows.iter().filter(|r| r.kind == "fire_event").map(|r| r.payload.get("arrivalMark")).collect();
            // The run reads the delivery's other arrivals: one of them may
            // answer it (its trigger's own is noted on its waits).
            assert_eq!(fired, [Some(&Js::Num(before.into()))], "the mark is taken before the delivery's own arrivals are logged");
        });
    }

    /// A note's movement that waits for the next comment on it.
    const AWAITS_A_COMMENT: &str = "import { inbox } from adapters\n\ni = connect inbox\n\nfunction noted(note: <i-[:Note]->>) {\n  c = await new note-[:Comments]->\n  return c.Text\n}\n\nlisten to i { events: [\"note.created\"] } fire noted\n";

    /// An inline delivery's runs read their trigger's waits from the mark
    /// taken before its arrivals are kept: the delivery's comment on n-1, an
    /// item of the same batch and not n-1's run's trigger, answers it; and a
    /// comment on n-2 that lands while n-1's run is going answers n-2's,
    /// though n-2's run starts after it.
    #[test]
    fn an_inline_delivery_s_runs_wait_from_the_mark_taken_before_its_own_arrivals() {
        let project = InboxProject::with(AWAITS_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        let state = project.root.join(".lf/state.db");
        *project.on_await_keys.lock().unwrap() = Some(Box::new(move || {
            let landed = NewArrival { edge: "Comments".into(), key: "thread:n-2".into(), identity: Some("k2".into()), version: None, landing: Some(Js::parse(br#"{"fields":{"Text":"meanwhile"}}"#).unwrap()), gone: false };
            Store::open(&state).unwrap().log_now(LOCAL_TENANT, "inbox", &[landed]).unwrap();
        }));
        in_local(async {
            let session = project.session().await;
            let body = br#"{"notes":[{"id":"n-1","Title":"one"},{"id":"n-2","Title":"two"}],"comments":[{"note":"n-1","id":"k1","Text":"own"}]}"#;
            let (answer, fired) = hook(&session, body, "d-1").await;
            assert_eq!(answer.status, 200, "{}", answer.body.to_json());
            let statuses: Vec<&str> = fired.outcomes.iter().map(|o| o.status.as_str()).collect();
            assert_eq!(statuses, ["completed", "completed"], "{:?}", fired.outcomes.iter().map(|o| &o.error).collect::<Vec<_>>());
        });
    }

    /// A note deleted before its run's wait opens (`awaitKeys` answers
    /// `gone`): the wait opens without a key, the run parks on it, and the
    /// store says it is stranded there.
    #[test]
    fn a_wait_on_a_record_already_gone_parks_its_run_stranded() {
        let project = InboxProject::with(AWAITS_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let session = project.session().await;
            let (answer, fired) = hook(&session, br#"{"notes":[{"id":"gone-1","Title":"one"}]}"#, "d-1").await;
            assert_eq!(answer.status, 200, "{}", answer.body.to_json());
            let [outcome] = fired.outcomes.as_slice() else { panic!("{:?}", fired.outcomes.len()) };
            assert_eq!(outcome.status, "parked", "{:?}", outcome.error);
            let stranded = session.store.stranded_waits(&crate::waits::StrandedOf::Run(&outcome.run_id)).unwrap();
            let shown: Vec<(&str, &str, Option<&str>, bool)> = stranded.iter().map(|w| (w.adapter_type.as_str(), w.edge.as_str(), w.key.as_deref(), w.parked)).collect();
            assert_eq!(shown, [("inbox", "Comments", None, true)]);
            let run = session.store.run(&outcome.run_id).unwrap().unwrap();
            assert!(crate::lfjson::is_stranded(&*session.store, &run).unwrap());
            let shown = crate::lfjson::run_show_doc(&*session.store, &outcome.run_id).unwrap();
            let says: Vec<&str> = shown.get("run").and_then(|r| r.get("stranded")).and_then(Js::as_array).unwrap().iter().filter_map(|w| w.get("says").and_then(Js::as_str)).collect();
            assert_eq!(says, ["waiting on Comments of inbox — its record was deleted before the wait opened, so nothing will arrive; a race with a sleep is the way out"]);
        });
    }

    /// Run `run`'s wait on `key`'s `Comments` from `since`, parked at `s1`.
    fn park_wait(store: &dyn RunHostStore, run: &str, key: &str, since: i64) -> String {
        use crate::store::{Park, ParkKind, RunStart};
        store.start_run(&RunStart { id: run, file: "f", movement: "m", started_at: &iso(0), input: "{}", delivery_id: None }).unwrap();
        let wait = store.open_wait(&crate::waits::OpenWait { run_id: run, team_id: LOCAL_TENANT, adapter_type: "inbox", edge: "Comments", key: Some(key), since }).unwrap();
        store.commit_park(&Park { run_id: run, address: "s1", state: &Js::Null, fence: None, kind: ParkKind::Wait { wait_id: &wait } }).unwrap();
        wait
    }

    #[test]
    fn a_redelivery_logs_nothing_again_and_wakes_nothing() {
        let project = InboxProject::new();
        in_local(async {
            let session = project.session().await;
            let first = park_wait(&*session.store, "run-1", "thread:n-0", 0);

            // The first delivery logs its comment and wakes the parked wait;
            // the wake is listed with the events.
            let listed = RefCell::new(Vec::new());
            let headers = signed(NOTE_AND_COMMENT, "d-1");
            let delivery = Delivery { provider: "inbox", subscription_id: "inbox", raw_body: NOTE_AND_COMMENT, headers: &headers, method: "POST", path: "", query: "", source: DeliverySource::Webhook };
            let doors = LfDoors::of_session(&session, EventSink::Listed(&listed), &|| {});
            assert_eq!(answer_delivery(&doors, delivery).await.status, 200);
            drop(doors);
            let kinds: Vec<String> = listed.borrow().iter().map(|row| row.get("kind").and_then(Js::as_str).unwrap_or_default().to_string()).collect();
            assert_eq!(kinds, ["fire_event", "wake_await"]);
            let due = crate::store::ClaimDue { limit: 10, lease_ms: 60_000, due_by: None, kinds: None };
            let woken: Vec<String> = session.store.claim_due(&due).unwrap().into_iter().filter(|r| r.kind == "wake_await").map(|r| r.payload.to_json()).collect();
            assert_eq!(woken, [format!(r#"{{"waitId":"{first}","runId":"run-1","address":"s1"}}"#)]);

            // A wait opened after it, then the same delivery again: a duplicate.
            let mark = session.store.arrival_mark().unwrap();
            let later = park_wait(&*session.store, "run-2", "thread:n-0", mark);
            let again = queue_delivery(&session, NOTE_AND_COMMENT, "d-1").await;
            assert_eq!((again.status, again.body.to_json()), (200, r#"{"ok":true,"duplicate":true,"eventsProcessed":0}"#.to_string()));
            assert_eq!(session.store.arrival_mark().unwrap(), mark, "nothing logged again");
            assert!(session.store.wait_arrivals(&later).unwrap().arrivals.is_empty(), "the re-sent comment is not the later wait's");
            assert!(session.store.claim_due(&due).unwrap().is_empty(), "nothing woken, nothing queued");
        });
    }

    /// A note's run races a comment on the note against an hour's sleep,
    /// and returns what each arm settled with.
    const RACES_A_COMMENT: &str = "import { inbox } from adapters\n\ni = connect inbox\n\nfunction noted(note: <i-[:Note]->>) {\n  r = race(\n    () => {\n      c = await new note-[:Comments]->\n      return c.Text\n    },\n    () => {\n      await sleep(1h)\n      return \"slept\"\n    },\n  )\n  return \"${coalesce(r[0], \"-\")}/${coalesce(r[1], \"-\")}\"\n}\n\nlisten to i { events: [\"note.created\"] } fire noted\n";

    /// The one run's id, and its leaves as `(address, reason, status)`.
    fn the_run(session: &Session) -> (String, Vec<(String, String, String)>) {
        let runs = session.store.runs(10).unwrap();
        assert_eq!(runs.len(), 1);
        let leaves = session.store.leaves(&runs[0].id, false, None, None).unwrap().into_iter().map(|l| (l.address, l.reason, l.status)).collect();
        (runs[0].id.clone(), leaves)
    }

    /// A `wake_await` row for the run's wait on n-1's comments: a retry of
    /// a wake whose worker died (logging the comment queued the first).
    fn wake_the_comment_wait(session: &Session, run: &str, address: &str) {
        let wait = session
            .store
            .open_wait(&crate::waits::OpenWait { run_id: run, team_id: LOCAL_TENANT, adapter_type: "inbox", edge: "Comments", key: Some("thread:n-1"), since: 0 })
            .unwrap();
        let row = crate::waits::wake_row(LOCAL_TENANT, &crate::waits::WaitWake { run_id: run.into(), wait_id: wait, address: address.into() });
        session.store.enqueue(&row.kind, &row.key, &row.payload, None, row.team_id.as_deref()).unwrap();
    }

    async fn drained(session: &Session) {
        crate::drain::drain(session, &crate::drain::DrainOptions { until_idle: true, max_seconds: None }, &mut Vec::new()).await.unwrap();
    }

    /// A note's run off the inbox's pushed `Notes`, waiting for the next
    /// comment on its note.
    const NOTES_AWAIT_A_COMMENT: &str = "import { inbox } from adapters\n\ni = connect inbox\n\nfunction noted(note: <i-[:Note]->>) {\n  c = await new note-[:Comments]->\n  return c.Text\n}\n\nlisten to i-[:Notes]-> fire noted\n";

    /// One note landing on the pushed `Notes`, as a delivery's body.
    fn landed_note(id: &str) -> String {
        format!(r#"{{"arrivals":[{{"edge":"Notes","identity":"{id}","landing":{{"recordId":"{id}","recordType":"Note","fields":{{"Id":"{id}","Title":"x"}}}}}}]}}"#)
    }

    /// The queued `fire_event` rows, claimed: what a worker would take.
    fn claimed_fire_rows(session: &Session) -> Vec<Js> {
        let due = crate::store::ClaimDue { limit: 10, lease_ms: 60_000, due_by: None, kinds: None };
        session.store.claim_due(&due).unwrap().into_iter().filter(|r| r.kind == "fire_event").map(|r| r.payload).collect()
    }

    /// A worker ran a delivery's arrivals row, its run parked, and the
    /// worker died before the row was done: the row's retry finds the run
    /// it minted started, leaves it as it is, and the run's comment wakes
    /// it.
    #[test]
    fn a_retried_arrivals_row_leaves_the_run_its_earlier_attempt_started_to_its_wait() {
        let project = InboxProject::pushed(NOTES_AWAIT_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let session = project.session().await;
            assert_eq!(queue_delivery(&session, landed_note("n-1").as_bytes(), "d-1").await.status, 200);
            let [row] = claimed_fire_rows(&session).try_into().unwrap();
            let first = session.work_row("fire_event", &row).await.unwrap();
            assert_eq!(first.iter().map(|o| o.status.as_str()).collect::<Vec<_>>(), ["parked"]);
            let (run, leaves) = the_run(&session);

            let retried = session.work_row("fire_event", &row).await.unwrap();
            assert!(retried.is_empty(), "the retry starts nothing again");
            assert_eq!(session.store.run(&run).unwrap().unwrap().status, "parked");
            assert_eq!(the_run(&session).1, leaves, "the run keeps its leaf");

            let comment = NewArrival { edge: "Comments".into(), key: "thread:n-1".into(), identity: Some("k1".into()), version: None, landing: Some(Js::parse(br#"{"fields":{"Text":"hi"}}"#).unwrap()), gone: false };
            assert_eq!(session.store.log_now(LOCAL_TENANT, "inbox", &[comment]).unwrap().wakes.len(), 1, "its wait is still open");
            drained(&session).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "completed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains(r#""hi""#), "{:?}", row.outcome);
        });
    }

    /// The segment that resumes the comment's arm settles the race, then
    /// dies before its commit: the run stays parked on that arm, resumed
    /// again by the retried wake, and finishes as though it never died.
    #[test]
    fn a_resumed_race_whose_segment_dies_before_its_commit_is_resumed_again_and_finishes() {
        let project = InboxProject::with(RACES_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let session = project.session().await;
            let (_, fired) = hook(&session, NOTE, "d-1").await;
            assert_eq!(fired.outcomes.iter().map(|o| o.status.as_str()).collect::<Vec<_>>(), ["parked"]);
            let (run, leaves) = the_run(&session);
            let reasons: Vec<&str> = leaves.iter().map(|(_, reason, _)| reason.as_str()).collect();
            assert_eq!(reasons, ["await", "timer"], "{leaves:?}");
            let arm = leaves[0].0.clone();

            let comment = NewArrival { edge: "Comments".into(), key: "thread:n-1".into(), identity: Some("k1".into()), version: None, landing: Some(Js::parse(br#"{"fields":{"Text":"hi"}}"#).unwrap()), gone: false };
            let wakes = session.store.log_now(LOCAL_TENANT, "inbox", &[comment]).unwrap().wakes;
            assert_eq!(wakes.len(), 1);
            crate::segment::DIES_BEFORE_COMMIT.with(|dies| dies.set(true));
            drained(&session).await;
            let (_, leaves) = the_run(&session);
            assert_eq!(session.store.run(&run).unwrap().unwrap().status, "parked");
            assert!(leaves.iter().any(|(address, _, status)| *address == arm && status == "resuming"), "the arm is still the run's to resume: {leaves:?}");

            // The worker that died held the wake: it is tried again once its lease lapses.
            wake_the_comment_wait(&session, &run, &arm);
            drained(&session).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "completed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains("hi/-"), "{:?}", row.outcome);
            assert_eq!(the_run(&session).1, []);
        });
    }

    /// The run parked on its comment wait at its one leaf, a comment logged
    /// for it and its wake queued: the run's id and the leaf's address.
    async fn parked_with_a_comment(session: &Session) -> (String, String) {
        let (_, fired) = hook(session, NOTE, "d-1").await;
        assert_eq!(fired.outcomes.iter().map(|o| o.status.as_str()).collect::<Vec<_>>(), ["parked"]);
        let (run, leaves) = the_run(session);
        assert_eq!(leaves.len(), 1, "{leaves:?}");
        let leaf = leaves[0].0.clone();
        let comment = NewArrival { edge: "Comments".into(), key: "thread:n-1".into(), identity: Some("k1".into()), version: None, landing: Some(Js::parse(br#"{"fields":{"Text":"hi"}}"#).unwrap()), gone: false };
        assert_eq!(session.store.log_now(LOCAL_TENANT, "inbox", &[comment]).unwrap().wakes.len(), 1);
        (run, leaf)
    }

    /// The segment that resumes the run's one leaf completes the run, and
    /// dies before its commit: the run is still parked on that leaf, which
    /// the retried wake resumes again, and the run completes.
    #[test]
    fn a_resumed_segment_that_completes_the_run_and_dies_before_its_commit_leaves_its_leaf_to_be_resumed_again() {
        let project = InboxProject::with(AWAITS_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let session = project.session().await;
            let (run, leaf) = parked_with_a_comment(&session).await;
            crate::segment::DIES_BEFORE_COMMIT.with(|dies| dies.set(true));
            drained(&session).await;
            assert_eq!(session.store.run(&run).unwrap().unwrap().status, "parked");
            assert_eq!(the_run(&session).1, [(leaf.clone(), "await".to_string(), "resuming".to_string())]);

            wake_the_comment_wait(&session, &run, &leaf);
            drained(&session).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "completed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains(r#""hi""#), "{:?}", row.outcome);
            assert_eq!(the_run(&session).1, []);
        });
    }

    /// The segment that resumes the run's one leaf completes the run, and
    /// dies right after its commit: the commit that finished the leaf also
    /// settled the run, so it is never left parked with nothing to wake it.
    #[test]
    fn a_resumed_segment_that_completes_the_run_settles_it_in_the_write_that_finishes_its_leaf() {
        let project = InboxProject::with(AWAITS_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let session = project.session().await;
            let (run, _) = parked_with_a_comment(&session).await;
            crate::segment::DIES_AFTER_COMMIT.with(|dies| dies.set(1));
            drained(&session).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "completed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains(r#""hi""#), "{:?}", row.outcome);
            assert_eq!(the_run(&session).1, []);
        });
    }

    /// As above, for a resumed segment that fails the run: the failure is
    /// kept in the write that finishes the leaf.
    #[test]
    fn a_resumed_segment_that_fails_the_run_settles_it_in_the_write_that_finishes_its_leaf() {
        let movement = AWAITS_A_COMMENT.replace("return c.Text", "write note { Title: c.Text }\n  return c.Text");
        let project = InboxProject::with(&movement, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let session = project.session().await;
            let (run, _) = parked_with_a_comment(&session).await;
            crate::segment::DIES_AFTER_COMMIT.with(|dies| dies.set(1));
            drained(&session).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "failed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains("no longer exists"), "{:?}", row.outcome);
            assert_eq!(the_run(&session).1, []);
        });
    }

    /// An attempt at the comment's arm finished it (its exports kept, its
    /// join decremented) and died before its commit; the retry parks in the
    /// arm instead (no comment counts this time). The run fails, naming where.
    #[test]
    fn a_retry_that_parks_inside_a_branch_its_dead_attempt_finished_fails_the_run_naming_where() {
        let project = InboxProject::with(RACES_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let session = project.session().await;
            hook(&session, NOTE, "d-1").await;
            let (run, leaves) = the_run(&session);
            let arm = leaves[0].0.clone();
            let frames = session.store.frames(&run).unwrap();
            assert_eq!(frames.len(), 1, "the race's frame");
            let frame = &frames[0];
            let depth = frame.split('.').count();
            let branch = arm.split('.').take(depth + 1).collect::<Vec<_>>().join(".");
            let index: i64 = branch.rsplit('.').next().and_then(|step| step.strip_prefix('b')).and_then(|n| n.parse().ok()).unwrap_or_else(|| panic!("{branch}"));
            let exports = Js::parse(br##"{"#return":null}"##).unwrap();
            session.store.persist_branch_export(&run, frame, &branch, index, &exports).unwrap();
            assert!(session.store.decrement_join(&run, frame, &branch, &arm).unwrap());

            wake_the_comment_wait(&session, &run, &arm);
            drained(&session).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "failed", "{:?}", row.outcome);
            let outcome = row.outcome.unwrap_or_default();
            assert!(outcome.contains(&format!("the run's replay diverged from its first attempt at {arm}")), "{outcome}");
            assert!(outcome.contains(&branch), "{outcome}");
        });
    }

    /// A race whose other arm settles at once withdraws the arm that parked
    /// in the same segment: its held park is never written, so the run
    /// completes with nothing left to wake.
    #[test]
    fn a_park_a_race_withdraws_in_the_segment_that_made_it_is_never_written() {
        let movement = RACES_A_COMMENT.replace("await sleep(1h)\n      return \"slept\"", "return \"now\"");
        let project = InboxProject::with(&movement, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let session = project.session().await;
            let (_, fired) = hook(&session, NOTE, "d-1").await;
            assert_eq!(fired.outcomes.iter().map(|o| o.status.as_str()).collect::<Vec<_>>(), ["completed"], "{:?}", fired.outcomes.iter().map(|o| &o.error).collect::<Vec<_>>());
            let (run, leaves) = the_run(&session);
            assert_eq!(leaves, []);
            assert!(session.store.run(&run).unwrap().unwrap().outcome.unwrap_or_default().contains("-/now"));
        });
    }

    /// Drain only the arrivals' wakes: a `settle_race` row its winning arm
    /// owed is left queued.
    async fn drained_wakes_only(session: &mut Session) {
        session.pool = crate::drain::Pool::of("wake_await").unwrap();
        drained(session).await;
        session.pool = crate::drain::Pool::default();
    }

    /// The frames of the races the run owes.
    fn owed(session: &Session, run: &str) -> Vec<String> {
        session.store.owed_races(run).unwrap().into_iter().map(|race| race.frame_address).collect()
    }

    /// The comment's arm wins the race, and its segment dies right after its
    /// commit, before the race is settled: the commit owed the race, so the
    /// run is still parked, and the row it owed settles the race and runs
    /// the code after it.
    #[test]
    fn a_race_whose_winning_arm_dies_after_its_commit_is_settled_by_the_row_it_owes() {
        let project = InboxProject::with(RACES_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let mut session = project.session().await;
            hook(&session, NOTE, "d-1").await;
            let (run, leaves) = the_run(&session);
            let (arm, timer) = (leaves[0].0.clone(), leaves[1].0.clone());
            let comment = NewArrival { edge: "Comments".into(), key: "thread:n-1".into(), identity: Some("k1".into()), version: None, landing: Some(Js::parse(br#"{"fields":{"Text":"hi"}}"#).unwrap()), gone: false };
            session.store.log_now(LOCAL_TENANT, "inbox", &[comment]).unwrap();
            crate::segment::DIES_AFTER_COMMIT.with(|dies| dies.set(1));
            drained_wakes_only(&mut session).await;
            assert_eq!(session.store.run(&run).unwrap().unwrap().status, "parked");
            assert_eq!(the_run(&session).1, [(timer, "timer".to_string(), "parked".to_string())], "the arm's leaf is finished");
            assert_eq!(owed(&session, &run), session.store.frames(&run).unwrap(), "the race is owed");

            drained(&session).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "completed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains("hi/-"), "{:?}", row.outcome);
            assert_eq!(the_run(&session).1, []);
            assert_eq!(owed(&session, &run), Vec::<String>::new());
        });
    }

    /// Both arms resume in one pass, and the pass dies right after the
    /// second arm's commit: that commit owed the race, so it did not settle
    /// the run completed. The race is settled, and the code after it runs,
    /// before the run completes.
    #[test]
    fn a_race_whose_arms_all_resume_in_one_pass_completes_only_after_the_code_after_it_ran() {
        let movement = RACES_A_COMMENT.replace("c = await new note-[:Comments]->\n      return c.Text", "await sleep(1h)\n      return \"a\"");
        let project = InboxProject::with(&movement, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let session = project.session().await;
            hook(&session, NOTE, "d-1").await;
            let (run, leaves) = the_run(&session);
            assert_eq!(leaves.iter().map(|(_, reason, _)| reason.as_str()).collect::<Vec<_>>(), ["timer", "timer"]);
            crate::segment::DIES_AFTER_COMMIT.with(|dies| dies.set(2));
            session.resume_run(&run).await.unwrap();
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "parked", "{:?}", row.outcome);
            assert_eq!(the_run(&session).1, [], "both arms' leaves are finished");
            assert_eq!(owed(&session, &run).len(), 1, "the race is owed once");

            drained(&session).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "completed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains("a/slept"), "{:?}", row.outcome);
            assert_eq!(owed(&session, &run), Vec::<String>::new());
        });
    }

    /// The race is settled by a drain of its run that is not the row it
    /// owed (a retried wake): that settlement's commit deletes the row, so
    /// the row never settles the race a second time, and a worker that had
    /// already claimed it finds the race owed no more and steps nothing.
    #[test]
    fn a_race_settled_once_is_never_settled_again_by_the_row_it_owed() {
        let movement = RACES_A_COMMENT.replace("  return \"${coalesce", "  await sleep(2h)\n  return \"${coalesce");
        let project = InboxProject::with(&movement, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let mut session = project.session().await;
            hook(&session, NOTE, "d-1").await;
            let (run, leaves) = the_run(&session);
            let arm = leaves[0].0.clone();
            let comment = NewArrival { edge: "Comments".into(), key: "thread:n-1".into(), identity: Some("k1".into()), version: None, landing: Some(Js::parse(br#"{"fields":{"Text":"hi"}}"#).unwrap()), gone: false };
            session.store.log_now(LOCAL_TENANT, "inbox", &[comment]).unwrap();
            crate::segment::DIES_AFTER_COMMIT.with(|dies| dies.set(1));
            drained_wakes_only(&mut session).await;
            let owed_race = session.store.owed_races(&run).unwrap().pop().expect("the race is owed");
            let row = crate::store::HeldRace { frame_address: &owed_race.frame_address, state: &owed_race.state };
            let payload = crate::store::settle_race_work_payload(&run, &row);

            // The wake is retried; its arm's leaf is gone, so its drain
            // only settles the race the run owes.
            wake_the_comment_wait(&session, &run, &arm);
            drained_wakes_only(&mut session).await;
            let (_, leaves) = the_run(&session);
            assert_eq!(leaves.iter().map(|(_, reason, status)| (reason.as_str(), status.as_str())).collect::<Vec<_>>(), [("timer", "parked")], "parked after the race");
            assert!(!leaves[0].0.starts_with(&owed_race.frame_address), "{leaves:?}");
            assert_eq!(owed(&session, &run), Vec::<String>::new());
            let trace = session.store.trace_len(&run).unwrap();

            drained(&session).await;
            assert!(session.work_row(crate::store::SETTLE_RACE_WORK_KIND, &payload).await.unwrap().is_empty(), "nothing stepped");
            assert_eq!(session.store.trace_len(&run).unwrap(), trace, "the code after the race did not run again");
            assert_eq!(the_run(&session).1, leaves);
            assert_eq!(session.store.run(&run).unwrap().unwrap().status, "parked");
        });
    }

    /// The next segment to reach its commit is taken over by another
    /// process just before it (crate::segment::TAKEN_OVER_BEFORE_COMMIT).
    fn take_over_the_next_commit() {
        crate::segment::TAKEN_OVER_BEFORE_COMMIT.with(|taken| *taken.borrow_mut() = crate::segment::TakeOver::Armed);
    }

    /// The other process's lease token, once a segment was taken over.
    fn taken_over() -> String {
        crate::segment::TAKEN_OVER_BEFORE_COMMIT.with(|taken| match taken.replace(crate::segment::TakeOver::No) {
            crate::segment::TakeOver::Took(token) => token,
            other => panic!("no segment was taken over: {other:?}"),
        })
    }

    /// One drain pass: how many rows it claimed, and the statuses of the
    /// runs they stepped.
    async fn one_pass(session: &Session) -> (usize, Vec<String>) {
        let (claimed, outcomes) = session.drain_work(10, &mut Vec::new()).await.unwrap();
        (claimed, outcomes.into_iter().map(|o| o.status).collect())
    }

    /// Every work row queued, however far off it is due (each one claimed).
    fn every_queued_kind(session: &Session) -> Vec<String> {
        let far = iso(30 * 86_400_000);
        let all = crate::store::ClaimDue { limit: 100, lease_ms: 60_000, due_by: Some(&far), kinds: None };
        session.store.claim_due(&all).unwrap().into_iter().map(|row| row.kind).collect()
    }

    /// After a drain lost the run's lease to `theirs`: while that holder
    /// keeps the run, the run's `rows` are busy (claimed, nothing stepped);
    /// once it lets go, their retry drains the run.
    async fn retried_after(session: &mut Session, run: &str, theirs: &str, ahead_ms: i64, rows: usize) {
        session.judge_due_ahead(ahead_ms);
        assert_eq!(one_pass(session).await, (rows, Vec::new()), "the rows were kept, and are busy while the other process holds the run");
        session.store.release_lease(run, theirs).unwrap();
        drained(session).await;
    }

    /// The step a comment's wake runs is taken over just before its commit,
    /// which writes nothing: the wake is released, not completed. The other
    /// holder's lease claim parked the leaf again, and the wake's retry
    /// steps it on once that holder lets go.
    #[test]
    fn a_wake_whose_step_lost_the_runs_lease_is_kept_and_its_retry_completes_the_run() {
        let project = InboxProject::with(AWAITS_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let mut session = project.session().await;
            let (run, leaf) = parked_with_a_comment(&session).await;
            take_over_the_next_commit();
            assert_eq!(one_pass(&session).await, (1, vec!["leaseLost".to_string()]));
            let theirs = taken_over();
            assert_eq!(session.store.run(&run).unwrap().unwrap().status, "parked");
            assert_eq!(the_run(&session).1, [(leaf.clone(), "await".to_string(), "parked".to_string())], "the other holder's claim parked the leaf again");

            retried_after(&mut session, &run, &theirs, 2 * crate::run_host::BUSY_RETRY_MS, 1).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "completed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains(r#""hi""#), "{:?}", row.outcome);
            assert_eq!(the_run(&session).1, []);
            assert_eq!(every_queued_kind(&session), Vec::<String>::new());
        });
    }

    /// As above, for a run's timer row: the slept leaf's step is taken over,
    /// and the row is kept for its retry.
    #[test]
    fn a_timer_whose_step_lost_the_runs_lease_is_kept_and_its_retry_completes_the_run() {
        let movement = AWAITS_A_COMMENT.replace("c = await new note-[:Comments]->\n  return c.Text", "await sleep(1h)\n  return \"woke\"");
        let project = InboxProject::with(&movement, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let mut session = project.session().await;
            hook(&session, NOTE, "d-1").await;
            let (run, leaves) = the_run(&session);
            assert_eq!(leaves.iter().map(|(_, reason, _)| reason.as_str()).collect::<Vec<_>>(), ["timer"]);
            session.judge_due_ahead(2 * 3_600_000);
            take_over_the_next_commit();
            assert_eq!(one_pass(&session).await, (1, vec!["leaseLost".to_string()]));
            let theirs = taken_over();
            assert_eq!(session.store.run(&run).unwrap().unwrap().status, "parked");
            assert_eq!(the_run(&session).1, leaves, "the other holder's claim parked the leaf again");

            retried_after(&mut session, &run, &theirs, 2 * 3_600_000, 1).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "completed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains("woke"), "{:?}", row.outcome);
            assert_eq!(the_run(&session).1, []);
            assert_eq!(every_queued_kind(&session), Vec::<String>::new());
        });
    }

    /// As above, for a race the run owes: the step that settles it is taken
    /// over, and its `settle_race` row (the race itself) is kept, still owed.
    #[test]
    fn an_owed_race_whose_settling_step_lost_the_runs_lease_stays_owed_and_its_retry_settles_it() {
        let project = InboxProject::with(RACES_A_COMMENT, &format!("inbox:\n  external: inbox\n  webhook_secret: {SECRET}\n"), "");
        in_local(async {
            let mut session = project.session().await;
            hook(&session, NOTE, "d-1").await;
            let (run, _) = the_run(&session);
            let comment = NewArrival { edge: "Comments".into(), key: "thread:n-1".into(), identity: Some("k1".into()), version: None, landing: Some(Js::parse(br#"{"fields":{"Text":"hi"}}"#).unwrap()), gone: false };
            session.store.log_now(LOCAL_TENANT, "inbox", &[comment]).unwrap();
            crate::segment::DIES_AFTER_COMMIT.with(|dies| dies.set(1));
            drained_wakes_only(&mut session).await;
            let frames = session.store.frames(&run).unwrap();
            assert_eq!(owed(&session, &run), frames, "the race is owed");

            take_over_the_next_commit();
            assert_eq!(one_pass(&session).await, (1, vec!["leaseLost".to_string()]));
            let theirs = taken_over();
            assert_eq!(session.store.run(&run).unwrap().unwrap().status, "parked");
            assert_eq!(owed(&session, &run), frames, "the race is still owed");

            // The race's row, and the comment's wake: its step died after its
            // commit, so its row was kept too.
            retried_after(&mut session, &run, &theirs, 2 * crate::run_host::BUSY_RETRY_MS, 2).await;
            let row = session.store.run(&run).unwrap().unwrap();
            assert_eq!(row.status, "completed", "{:?}", row.outcome);
            assert!(row.outcome.as_deref().unwrap_or_default().contains("hi/-"), "{:?}", row.outcome);
            assert_eq!(owed(&session, &run), Vec::<String>::new());
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

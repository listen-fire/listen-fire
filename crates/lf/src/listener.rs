//! The listening half of `listen-fire serve` (the `serve` cargo feature): the hyper
//! listener, the inbound doors, the models door and the work queue's drain. A
//! light build leaves it out; `listen-fire cancel` and `listen-fire run --webhook`
//! (src/serve.rs) need no listener. The callback door retired at 0.13: its
//! path answers that it is gone.
//!
//! `--doors-only` (or `LF_DOORS_ONLY=1`) is serve for compute billed by the
//! request, which is frozen or stopped once a response is sent: nothing
//! drains in this process, and `/hooks/…` queues its events instead of
//! running them inside the request. Workers (`listen-fire drain`) run the work, started
//! by the wake slot's module (crate::wake) or a schedule.


use std::cell::RefCell;
use std::io::Write;
use std::rc::Rc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::{Notify, watch};

use crate::backend::StoreSpec;
use crate::doors::{EventSink, LfDoors, deliver_inline, hook_target};
use crate::http::{Request, Response, decode_component};
use crate::inbound::{Answer, Delivery, DeliverySource, InboundStore, Push, PushStore, TextBody, answer_delivery, answer_push};
use crate::json::{Js, Obj};
#[cfg(feature = "oauth")]
use crate::oauth_signin::deliver_public_redirect;
#[cfg(not(feature = "oauth"))]
fn deliver_public_redirect(_: &std::path::Path, _: &str) -> (u16, String) {
    (404, "this listen-fire was built without the `oauth` feature, so it takes no sign-in redirect".into())
}
use crate::obj;
use crate::project::Project;
use crate::runs::{DEFAULT_PORT, Opening, Role, RunOutcome, Session, WORK_ROWS_PER_DRAIN, open_session};
use crate::serve::{HOST_TOKEN, HOST_URL, MODELS_DOOR_URL, externals_host_url, host_token};

pub const MAX_BODY_BYTES: usize = 1024 * 1024;
/// The OCR door's limit: a module's file, base64 (a 64 MB PDF, the
/// platform's own ceiling for reading one, and the JSON around it).
const MAX_OCR_BODY_BYTES: usize = 96 * 1024 * 1024;

/// What a request's body may hold: a file to read at the OCR door, else the
/// doors' megabyte. Only a module listen-fire started holds the door's token, but the
/// body is read before the token is checked, so the larger limit is the
/// door's alone.
fn body_limit(path: &str) -> usize {
    match segments(path, "/api/public/adapter/").as_deref() {
        Some([_, "ocr"]) => MAX_OCR_BODY_BYTES,
        _ => MAX_BODY_BYTES,
    }
}
/// The webhook door's own limit, the hosted door's: a delivery is a
/// notification, and a provider's bigger one carries ids to pull.
const MAX_DELIVERY_BYTES: usize = 100 * 1024;
/// How often due work is drained when nothing pokes it.
const TICK: Duration = Duration::from_millis(1000);
/// Where a provider's OAuth redirect for `listen-fire credential add --public` lands.
const PUBLIC_CALLBACK_PATH: &str = "/oauth/callback";

/// Open the models door alone, unless this process already serves its doors.
pub async fn open_models_door(credentials: &crate::secrets::Credentials) -> Result<(), String> {
    if externals_host_url().is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| format!("the models door: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let _ = HOST_TOKEN.set(crate::http_out::hex(&crate::http_out::random_bytes(24)?));
    let _ = MODELS_DOOR_URL.set(format!("http://127.0.0.1:{port}"));
    let credentials = Rc::new(credentials.clone());
    tokio::task::spawn_local(crate::http::serve(listener, body_limit, move |request| {
        let credentials = credentials.clone();
        async move {
            if request.method == "POST" {
                match segments(&request.path, "/api/public/adapter/").as_deref() {
                    Some([_, "models"]) => return models_door(&credentials, &request).await,
                    Some([_, "ocr"]) => return ocr_door(&request).await,
                    Some([_, crate::records_door::DOOR_VERB]) => return records_door(&request),
                    Some([module, crate::limits_door::DOOR_VERB]) => return limits_door(module, &request),
                    _ => {}
                }
            }
            Response::json(404, &Js::Obj(obj! { "error" => Js::str("not_found"), "message" => Js::str("outside listen-fire serve, listen-fire serves only the models, OCR and limits doors") }))
        }
    }));
    Ok(())
}

/// How `listen-fire serve` runs.
pub struct Serving<'a> {
    pub ephemeral: bool,
    pub store: &'a StoreSpec,
    pub port: Option<&'a str>,
    /// Only the doors: no drain in this process, `/hooks/…` queues.
    pub doors_only: bool,
}

/// `--doors-only`, or `LF_DOORS_ONLY` (`1`/`true`; empty, `0` or `false` is off).
pub fn doors_only(flag: bool, env: Option<&str>) -> Result<bool, String> {
    match env.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        _ if flag => Ok(true),
        None | Some("" | "0" | "false") => Ok(false),
        Some("1" | "true") => Ok(true),
        Some(other) => Err(format!("LF_DOORS_ONLY is \"{other}\": set it to 1 (or true) for doors only, or leave it empty")),
    }
}

/// What every request the listener answers shares.
struct Listening {
    session: Rc<Session>,
    /// Wakes this process's drain; nothing waits on it under `--doors-only`.
    poke: Rc<Notify>,
    doors_only: bool,
}

/// `listen-fire serve [--port N] [--doors-only]`: until SIGINT or SIGTERM.
pub async fn run(project: Project, serving: Serving<'_>) -> Result<i32, String> {
    let Serving { ephemeral, store, port, doors_only } = serving;
    let port = match port {
        None => DEFAULT_PORT,
        Some(text) => text.trim().parse::<u16>().map_err(|_| format!("--port {text}: expected a port number"))?,
    };
    // Loopback unless LF_BIND says otherwise: a container must listen on 0.0.0.0
    // for its platform's router to reach it.
    let bind = std::env::var("LF_BIND").ok().filter(|v| !v.trim().is_empty()).unwrap_or_else(|| "127.0.0.1".into());
    let listener = TcpListener::bind((bind.as_str(), port)).await.map_err(|e| format!("{bind}:{port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let _ = HOST_URL.set(format!("http://127.0.0.1:{port}"));
    let _ = HOST_TOKEN.set(crate::http_out::hex(&crate::http_out::random_bytes(24)?));
    let env: Vec<(String, String)> = std::env::vars().collect();
    crate::movements_slot::require_watch(&project, &env, "listen-fire serve")?;
    let role = if doors_only { Role::Doors } else { Role::Serve };
    // Accepting before the session opens: opening it calls modules (each
    // connection's describe), and a module that declares `hostLimits` asks
    // the limits door, on this listener, before its provider request. The
    // door needs no session, so it answers at once; every other request
    // waits until the session is open and its subscriptions reconciled.
    let (opened, listening) = watch::channel::<Option<Rc<Listening>>>(None);
    let doors = tokio::task::spawn_local(crate::http::serve(listener, body_limit, move |request| {
        let mut listening = listening.clone();
        async move {
            if let Some(response) = limits_door_request(&request) {
                return response;
            }
            let opened = listening.wait_for(Option::is_some).await.ok().and_then(|opened| opened.clone());
            let Some(listening) = opened else {
                return Response::json(503, &Js::Obj(obj! { "error" => Js::str("unavailable"), "message" => Js::str("listen-fire serve stopped before it opened") }));
            };
            route(&listening, request).await.unwrap_or_else(|message| Response::json(500, &Js::Obj(obj! { "error" => Js::Str(message) })))
        }
    }));
    let session = open_session(project, &Opening { ephemeral, store, role, routes_listens: true }).await?;
    // Before the doors answer, so a delivery is verified by the secret the
    // source issued. A refresh registers again what its listens move.
    for line in crate::subscriptions::reconcile(&session).await {
        println!("{line}");
    }
    let session = Rc::new(session);
    // A file exposed to an external is fetched from this listener.
    session.documents.serve_at(port);
    let poke = Rc::new(Notify::new());
    opened.send_replace(Some(Rc::new(Listening { session: session.clone(), poke: poke.clone(), doors_only })));
    // In both modes: a doors-only process takes a changed set too, so a
    // newly imported external's door answers.
    let watching = tokio::task::spawn_local({
        let session = session.clone();
        async move { match session.watch_movements(&mut std::io::stdout()).await {} }
    });
    // Doors only, nothing drains here: the webhooks still follow the heads
    // the workers resolve (a drain follows them as it drains).
    let drain = if doors_only { tokio::task::spawn_local(follow_heads_forever(session.clone())) } else { tokio::task::spawn_local(drain_forever(session.clone(), poke.clone())) };
    let renewing = tokio::task::spawn_local(renew_forever(session.clone()));
    let stop = stopped();
    println!("listen-fire serving on http://127.0.0.1:{port}/hooks/<external>/<install>");
    for line in hook_urls(&session, &format!("http://127.0.0.1:{port}")) {
        println!("{line}");
    }
    if doors_only {
        println!("doors only: nothing drains in this process; workers (`listen-fire drain`) run what the doors queue");
    }

    stop.await;
    for task in [doors, watching, drain, renewing] {
        task.abort();
        let _ = task.await;
    }
    for line in crate::subscriptions::leave(&session).await {
        println!("{line}");
    }
    // The last holder: the session goes; its module processes stop as listen-fire exits (crate::module_hosts::stop_all).
    drop(session);
    Ok(0)
}

/// Each connection whose sender posts to this listener, with the URL it
/// posts to: under lf.yaml's `publicUrl` when it names one, else this
/// listener's own. That is each connection a listen hears deliveries for,
/// and each connection a program makes to a module that announces arrivals
/// (`awaitKeys`): a run's `await` on a record of that module, or a press on
/// the buttons it wrote, is answered through that door, whether or not a
/// listen names the connection.
fn hook_urls(session: &Session, local: &str) -> Vec<String> {
    let set = session.file_set();
    let base = session.project.public_url.as_deref().unwrap_or(local);
    let takes_hooks = |external: &str, announcing: bool| {
        set.running.iter().any(|r| r.external.manifest.name == external && crate::doors::inbound_of(r).is_some() && (!announcing || r.methods.iter().any(|m| m == "awaitKeys")))
    };
    let mut seen = std::collections::BTreeSet::new();
    for listen in &set.listens {
        let Some(credential) = &listen.credential else { continue };
        if takes_hooks(&listen.adapter, false) {
            seen.insert((listen.adapter.clone(), credential.clone()));
        }
    }
    for (written, credential) in connections(set.parsed()) {
        let external = crate::catalog::adapter_named(&set.catalog, &written);
        if takes_hooks(&external, true) {
            seen.insert((external, credential));
        }
    }
    seen.into_iter().filter_map(|(external, credential)| Some(format!("{external} {credential}: {}", hook_url(base, &external, &credential)?))).collect()
}

/// Every `connect … using <credential>` the files write, at any depth, as
/// (module, credential), each named as imported (an alias read back).
fn connections(files: &[Rc<crate::sources::Parsed>]) -> std::collections::BTreeSet<(String, String)> {
    use movement_parser::ast::{RValue, Statement};
    fn walk(statements: &[Statement], originals: &std::collections::BTreeMap<String, String>, out: &mut std::collections::BTreeSet<(String, String)>) {
        for statement in statements {
            let construct = match statement {
                Statement::Assign(assign) => match &assign.value {
                    RValue::Construct { construct } => Some(construct),
                    _ => None,
                },
                Statement::Listen(listen) => listen.construct.as_ref(),
                Statement::Movement(movement) => {
                    walk(&movement.body, originals, out);
                    None
                }
                _ => None,
            };
            let Some(construct) = construct else { continue };
            let construction = crate::secrets::construction_of(construct, originals);
            if let Some(credential) = construction.credential {
                out.insert((construction.adapter, credential));
            }
        }
    }
    let mut out = std::collections::BTreeSet::new();
    for file in files {
        let Ok(program) = &file.program else { continue };
        let mut originals = std::collections::BTreeMap::new();
        for statement in &program.statements {
            if let movement_parser::ast::Statement::Import(import) = statement {
                for name in &import.names {
                    if let Some(alias) = &name.alias {
                        originals.insert(alias.clone(), name.name.clone());
                    }
                }
            }
        }
        walk(&program.statements, &originals, &mut out);
    }
    out
}

/// `<base>/hooks/<external>/<credential>`, each segment percent-encoded.
fn hook_url(base: &str, external: &str, credential: &str) -> Option<String> {
    let mut url = url::Url::parse(base).ok()?;
    url.path_segments_mut().ok()?.pop_if_empty().extend(["hooks", external, credential]);
    Some(url.to_string())
}

/// What `listen-fire serve` waits on. SIGTERM's handler is in place from this
/// call, not from the first await: one sent the moment the serving line is
/// printed stops the process in order, not by the signal's default action.
#[cfg(unix)]
fn stopped() -> impl std::future::Future<Output = ()> {
    use tokio::signal::unix::{SignalKind, signal};
    let term = signal(SignalKind::terminate());
    async move {
        match term {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
}

#[cfg(not(unix))]
fn stopped() -> impl std::future::Future<Output = ()> {
    async {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// The drain: one pass at a time in this process (the run lease keeps any
/// other listen-fire process from stepping the same run meanwhile); a poke while a
/// pass runs is one more pass after it.
async fn drain_forever(session: Rc<Session>, poke: Rc<Notify>) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            () = poke.notified() => {}
        }
        match session.drain_work(WORK_ROWS_PER_DRAIN, &mut std::io::stdout()).await {
            Ok((_, outcomes)) => log_runs(&outcomes),
            Err(message) => println!("drain failed: {message}"),
        }
    }
}

/// A doors-only server's webhooks moved with the heads its listens are
/// resolved to elsewhere (crate::resolve::watch_kept), every TICK.
async fn follow_heads_forever(session: Rc<Session>) {
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        if let Err(message) = session.follow_kept_heads(&session.file_set()).await {
            println!("following the listens' heads failed: {message}");
        }
    }
}

/// What this runner holds, said again on a timer of its own. A long pass of the
/// drain or a store that errors must not stop it: the entries would lapse while
/// the runner still listens, and another runner would remove its webhooks.
async fn renew_forever(session: Rc<Session>) {
    let every = session.registrations.renewal_every();
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        for line in crate::subscriptions::hold(&session).await {
            eprintln!("listen-fire: {line}");
        }
    }
}

/// Each run an entry stepped, as `listen-fire serve` logs it.
fn log_runs(outcomes: &[RunOutcome]) {
    let mut out = std::io::stdout();
    for o in outcomes {
        let verb = if o.entry == "fired" { "run" } else { o.entry };
        let error = o.error.as_ref().map(|e| format!(" — {e}")).unwrap_or_default();
        let _ = writeln!(out, "{verb} {} {}:{} {}{error}", o.run_id, o.file, o.movement, o.status);
    }
}

/// An outcome as the `/hooks` answer lists it.
fn outcome_js(o: &RunOutcome) -> Js {
    let mut out = obj! {
        "runId" => Js::str(&o.run_id),
        "file" => Js::str(&o.file),
        "movement" => Js::str(&o.movement),
        "entry" => Js::str(o.entry),
        "status" => Js::str(&o.status),
        "writes" => Js::Num((o.writes.len() as u64).into()),
    };
    if let Some(captured) = &o.captured {
        out.insert("captured".into(), Js::Arr(captured.clone()));
    }
    out.insert("traceEntries".into(), Js::Num(o.trace_entries.into()));
    if let Some(error) = &o.error {
        out.insert("error".into(), Js::str(error));
    }
    Js::Obj(out)
}

fn not_found() -> Response {
    Response::json(404, &Js::Obj(obj! { "error" => Js::str("not found") }))
}

/// The path's segments after `prefix` (an optional trailing `/`), each
/// non-empty; None when the path is not under it.
fn segments<'p>(path: &'p str, prefix: &str) -> Option<Vec<&'p str>> {
    let rest = path.strip_prefix(prefix)?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let parts: Vec<&str> = rest.split('/').collect();
    parts.iter().all(|p| !p.is_empty()).then_some(parts)
}

fn decoded(segment: &str) -> Result<String, String> {
    decode_component(segment).ok_or_else(|| "URI malformed".to_string())
}

/// The answer, with the drain poked once it is composed when it asks.
fn send(answer: Answer, notify: impl FnOnce()) -> Response {
    let response = match &answer.text {
        Some(TextBody::Plain(text)) => Response::plain(answer.status, text),
        Some(TextBody::Html(html)) => Response::html(answer.status, html),
        None => Response::json(answer.status, &answer.body),
    };
    if answer.notify_after {
        notify();
    }
    response
}

async fn route(listening: &Listening, request: Request) -> Result<Response, String> {
    let (session, poke) = (&*listening.session, &*listening.poke);
    if request.too_large {
        return Ok(Response::json(413, &Js::Obj(obj! { "error" => Js::str("payload_too_large") })));
    }
    if segments(&request.path, "/api/cb/").is_some() {
        return Ok(callback_retired());
    }
    if request.method == "GET" {
        if request.path == PUBLIC_CALLBACK_PATH {
            let (status, text) = deliver_public_redirect(&session.project.lf_dir, &request.query);
            return Ok(Response::text(status, &text));
        }
        if let Some([id]) = segments(&request.path, "/files/").as_deref() {
            return Ok(match session.documents.exposed(id) {
                Some(bytes) => Response::bytes(200, bytes),
                None => Response::bytes(404, Vec::new()),
            });
        }
        // A provider's handshake at a module's door (Meta's verify GET).
        if segments(&request.path, "/api/public/webhook-sync/").is_some() {
            let notify = || poke.notify_one();
            let doors = LfDoors::of_session(session, EventSink::Queue, &notify);
            return Ok(doors_route(&doors, &request).await?.unwrap_or_else(not_found));
        }
        return Ok(not_found());
    }
    if request.method != "POST" {
        return Ok(not_found());
    }

    match segments(&request.path, "/api/public/adapter/").as_deref() {
        Some([_, "models"]) => return Ok(models_door(session.secrets().credentials(), &request).await),
        Some([_, "ocr"]) => return Ok(ocr_door(&request).await),
        Some([_, crate::records_door::DOOR_VERB]) => return Ok(records_door(&request)),
        _ => {}
    }

    let notify = || poke.notify_one();
    let doors = LfDoors::of_session(session, EventSink::Queue, &notify);
    if let Some(response) = doors_route(&doors, &request).await? {
        return Ok(response);
    }

    // listen-fire's older name for the delivery door. Its events run inside the
    // request and the answer lists the runs, as it always has.
    let Some(hook) = segments(&request.path, "/hooks/").filter(|s| s.len() <= 2) else { return Ok(not_found()) };
    let external = decoded(hook[0])?;
    let install = hook.get(1).map(|i| decoded(i)).transpose()?;
    let Some((provider, subscription_id)) = hook_target(session, &external, install.as_deref()) else {
        return Ok(Response::json(404, &Js::Obj(obj! { "error" => Js::str("unknown_provider") })));
    };
    let delivery = Delivery {
        provider: &provider,
        subscription_id: &subscription_id,
        raw_body: &request.body,
        headers: &request.headers,
        method: "POST",
        path: &request.path,
        query: &request.query,
        source: DeliverySource::Hook,
    };
    if listening.doors_only {
        return Ok(hook_queued(session, delivery, &notify).await);
    }
    let (answer, fired) = deliver_inline(session, delivery, &notify).await;
    log_runs(&fired.outcomes);
    if answer.status != 200 {
        return Ok(send(answer, notify));
    }
    let mut body = obj! { "runs" => Js::Arr(fired.outcomes.iter().map(outcome_js).collect()) };
    if Js::is_true(answer.body.get("duplicate")) {
        // Kept before: nothing ran, nothing was queued.
        body.insert("duplicate".into(), Js::Bool(true));
        return Ok(Response::json(202, &Js::Obj(body)));
    }
    // A delivery may have queued wakes.
    poke.notify_one();
    Ok(Response::json(202, &Js::Obj(body)))
}

/// `/hooks/…` under `--doors-only`: the delivery's events queued for a
/// worker, the answer listing each row (`queued`).
async fn hook_queued(session: &Session, delivery: Delivery<'_>, notify: &dyn Fn()) -> Response {
    let listed = RefCell::new(Vec::new());
    let doors = LfDoors::of_session(session, EventSink::Listed(&listed), notify);
    let answer = answer_delivery(&doors, delivery).await;
    drop(doors);
    if answer.status != 200 {
        return send(answer, notify);
    }
    let mut body = match answer.body {
        Js::Obj(body) => body,
        _ => Obj::new(),
    };
    body.insert("queued".into(), Js::Arr(listed.into_inner()));
    Response::json(202, &Js::Obj(body))
}

/// The models door: a model call by the models slot's module, for an
/// external this process started (it holds LF_HOST_TOKEN). Served by `listen-fire
/// serve`'s listener, and alone outside it (`open_models_door`).
async fn models_door(credentials: &crate::secrets::Credentials, request: &Request) -> Response {
    let presented = request.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.as_str());
    let expected = host_token().map(|t| format!("Bearer {t}"));
    let held = matches!((presented, &expected), (Some(presented), Some(expected)) if crate::inbound::same_secret(presented, expected));
    if !held {
        return Response::json(401, &Js::Obj(obj! { "error" => Js::str("unauthorized") }));
    }
    let body = match Js::parse(&request.body) {
        Ok(body) => body,
        Err(e) => return Response::json(400, &Js::Obj(obj! { "error" => Js::str("bad_request"), "message" => Js::Str(e) })),
    };
    #[cfg(not(feature = "anthropic"))]
    let _ = (&body, credentials);
    #[cfg(not(feature = "anthropic"))]
    return Response::json(502, &Js::Obj(obj! { "error" => Js::str("model_call_failed"), "message" => Js::str("this listen-fire was built without the `anthropic` feature, so its models slot is empty") }));
    #[cfg(feature = "anthropic")]
    match crate::llm_calls::host_model_call(&body, credentials).await {
        Ok(answer) => Response::json(200, &answer),
        Err(message) => Response::json(502, &Js::Obj(obj! { "error" => Js::str("model_call_failed"), "message" => Js::Str(message) })),
    }
}

/// The OCR door: a read by the ocr slot's module, for an external this
/// process started (it holds LF_HOST_TOKEN): its `ctx.ocr` (crate::ocr).
async fn ocr_door(request: &Request) -> Response {
    let presented = request.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.as_str());
    let expected = host_token().map(|t| format!("Bearer {t}"));
    if expected.is_none() || presented != expected.as_deref() {
        return Response::json(401, &Js::Obj(obj! { "error" => Js::str("unauthorized") }));
    }
    if request.too_large {
        return Response::json(413, &Js::Obj(obj! { "error" => Js::str("payload_too_large"), "message" => Js::Str(format!("the OCR door reads files up to {MAX_OCR_BODY_BYTES} bytes of request")) }));
    }
    let body = match Js::parse(&request.body) {
        Ok(body) => body,
        Err(e) => return Response::json(400, &Js::Obj(obj! { "error" => Js::str("bad_request"), "message" => Js::Str(e) })),
    };
    let (status, answer) = crate::ocr::door(crate::ocr::module().as_deref(), &body).await;
    Response::json(status, &answer)
}

/// The records door: facts about this host's runs and waits, read by a
/// module this process started (it holds LF_HOST_TOKEN): crate::records_door.
fn records_door(request: &Request) -> Response {
    let presented = request.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.as_str());
    let expected = host_token().map(|t| format!("Bearer {t}"));
    if expected.is_none() || presented != expected.as_deref() {
        return Response::json(401, &Js::Obj(obj! { "error" => Js::str("unauthorized") }));
    }
    let body = match Js::parse(&request.body) {
        Ok(body) => body,
        Err(e) => return Response::json(400, &Js::Obj(obj! { "error" => Js::str("bad_request"), "message" => Js::Str(e) })),
    };
    let (status, answer) = crate::records_door::answer(&body);
    Response::json(status, &answer)
}

/// The limits door's answer when `request` is for it; None for any other.
/// `listen-fire serve` answers it ahead of its session (`run`).
fn limits_door_request(request: &Request) -> Option<Response> {
    if request.method != "POST" || request.too_large {
        return None;
    }
    match segments(&request.path, "/api/public/adapter/").as_deref() {
        Some([module, crate::limits_door::DOOR_VERB]) => Some(limits_door(module, request)),
        _ => None,
    }
}

/// The limits door: a module asking before a request to its provider, under
/// the ticket of the call listen-fire is making to it (crate::limits_door).
fn limits_door(module: &str, request: &Request) -> Response {
    let bad = |message: String| Response::json(400, &Js::Obj(obj! { "error" => Js::str("bad_request"), "message" => Js::Str(message) }));
    let module = match decoded(module) {
        Ok(module) => module,
        Err(message) => return bad(message),
    };
    let body = match Js::parse(&request.body) {
        Ok(body) => body,
        Err(message) => return bad(message),
    };
    let bearer = request.headers.iter().find(|(k, _)| k == "authorization").map(|(_, v)| v.as_str());
    let (status, answer) = crate::limits_door::answer(&module, bearer, &body);
    Response::json(status, &answer)
}

/// The webhook door and the push doors, over any host's stores: `listen-fire serve`'s,
/// and the inbound contract suite's bridge (crate::contract_doors). None for
/// a path that is neither.
pub async fn doors_route<S: InboundStore + PushStore>(stores: &S, request: &Request) -> Result<Option<Response>, String> {
    if let Some([external, verb]) = segments(&request.path, "/api/public/adapter/").as_deref() {
        let push = match *verb {
            "emit" => Push::Emit,
            "wake" => Push::Wake,
            _ => return Ok(None),
        };
        let answer = answer_push(stores, push, &decoded(external)?, &request.headers, &request.body).await;
        return Ok(Some(Response::json(answer.status, &answer.body)));
    }
    // `<provider>/<credential>`, or `<provider>/<credential>/<key>` for one
    // of the credential's scoped webhooks (crate::subscriptions): its
    // subscription id is `<credential>/<key>`.
    let door = segments(&request.path, "/api/public/webhook-sync/");
    if let Some((provider, subscription)) = match door.as_deref() {
        Some([provider, install]) => Some((decoded(provider)?, decoded(install)?)),
        Some([provider, install, key]) => Some((decoded(provider)?, format!("{}/{}", decoded(install)?, decoded(key)?))),
        _ => None,
    } {
        if request.body.len() > MAX_DELIVERY_BYTES {
            return Ok(Some(send(Answer::payload_too_large(), || {})));
        }
        let delivery = Delivery {
            provider: &provider,
            subscription_id: &subscription,
            raw_body: &request.body,
            headers: &request.headers,
            method: &request.method,
            path: &request.path,
            query: &request.query,
            source: DeliverySource::Webhook,
        };
        return Ok(Some(send(answer_delivery(stores, delivery).await, || InboundStore::notify(stores))));
    }
    Ok(None)
}

/// A listener that has only the doors (the inbound contract suite's bridge):
/// the body limits, the two doors, and 404 for anything else.
pub async fn only_doors<S: InboundStore + PushStore>(stores: &S, request: Request) -> Response {
    if request.too_large {
        return Response::json(413, &Js::Obj(obj! { "error" => Js::str("payload_too_large") }));
    }
    if request.method != "POST" && !(request.method == "GET" && segments(&request.path, "/api/public/webhook-sync/").is_some()) {
        return not_found();
    }
    match doors_route(stores, &request).await {
        Ok(Some(response)) => response,
        Ok(None) => not_found(),
        Err(message) => Response::json(500, &Js::Obj(obj! { "error" => Js::Str(message) })),
    }
}

// ── The callback door, retired ──────────────────────────────────────────────

/// `/api/cb/<id>`, whatever the method: callbacks retired at 0.13, so a link
/// minted before is gone for good.
fn callback_retired() -> Response {
    Response::json(
        410,
        &Js::Obj(obj! {
            "outcome" => Js::str("retired"),
            "message" => Js::str("callbacks are retired in listen-fire 0.13; this link belonged to a run on an earlier release"),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_matches_its_door_with_an_optional_trailing_slash() {
        assert_eq!(segments("/api/cb/cb_1", "/api/cb/"), Some(vec!["cb_1"]));
        assert_eq!(segments("/api/cb/cb_1/", "/api/cb/"), Some(vec!["cb_1"]));
        assert_eq!(segments("/api/cb/", "/api/cb/"), None);
        assert_eq!(segments("/hooks/acme//x", "/hooks/"), None);
        assert_eq!(segments("/hooks/acme/x", "/hooks/"), Some(vec!["acme", "x"]));
    }

    #[test]
    fn doors_only_is_the_flag_or_the_environment() {
        assert_eq!(doors_only(false, None), Ok(false));
        assert_eq!(doors_only(true, None), Ok(true));
        assert_eq!(doors_only(false, Some("1")), Ok(true));
        assert_eq!(doors_only(false, Some(" TRUE ")), Ok(true));
        assert_eq!(doors_only(false, Some("0")), Ok(false));
        assert_eq!(doors_only(false, Some("")), Ok(false));
        assert!(doors_only(false, Some("yes")).unwrap_err().contains("LF_DOORS_ONLY"));
        assert_eq!(doors_only(true, Some("0")), Ok(true), "the flag wins");
    }

    /// What a run returned is never a door's answer: a webhook's sender hears
    /// which runs it started, never their values (and under `--doors-only`
    /// it is answered before any run).
    #[test]
    fn a_connections_hook_url_encodes_its_credential() {
        assert_eq!(hook_url("http://127.0.0.1:8977", "webhook", "Stripe Hook").as_deref(), Some("http://127.0.0.1:8977/hooks/webhook/Stripe%20Hook"));
        assert_eq!(hook_url("https://lf.example/base/", "webhook", "StripeHook").as_deref(), Some("https://lf.example/base/hooks/webhook/StripeHook"));
    }

    #[test]
    fn the_hooks_answer_never_carries_what_a_run_returned() {
        let outcome = RunOutcome {
            run_id: "r1".into(),
            file: "notes.mvt".into(),
            movement: "note".into(),
            entry: "fired",
            status: "completed".into(),
            writes: Vec::new(),
            captured: None,
            trace_entries: 0,
            error: None,
            returned: Some(Js::Obj(obj! { "value" => Js::str("secret summary") })),
        };
        assert_eq!(
            outcome_js(&outcome).to_json(),
            r#"{"runId":"r1","file":"notes.mvt","movement":"note","entry":"fired","status":"completed","writes":0,"traceEntries":0}"#
        );
    }
}

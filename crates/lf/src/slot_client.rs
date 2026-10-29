//! A core module filling a slot from outside listen-fire, spoken to over adapter
//! protocol 2's HTTP (crate::module_transport): one POST per method, the
//! envelope `{ ok, result }` or `{ ok: false, error }`, the install's
//! declared settings carried on every request. The slots' families are
//! called synchronously (the run host's store, the limiter, the loop guard
//! all answer before the caller goes on), so the calls are made on a thread
//! of their own with its own runtime and the caller waits for the answer, as
//! it waited on a database.
//!
//! The module is either reached at its `url` (a remote module: only a
//! manifest on this box), or a process listen-fire starts from its `command` the way
//! it starts every module (crate::module_hosts): on its first call, stopped
//! when idle, started again after a crash, listed for the next listen-fire to reap.
//! It is told where to listen (`MODULE_SOCKET`, else `PORT=0`) and which
//! token to require (`MODULE_TOKEN`), and read off the `listening …` line it
//! prints.
//!
//! Its manifest is read once, before any other method it is asked, and
//! checked against the adapter protocol range listen-fire speaks
//! (crate::protocol::protocol_standing): a module outside it is refused by
//! name at the first call, or as a session opens for one the session starts.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, mpsc};
use std::time::Duration;

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::module_hosts::{Launch, Lease, ModuleProcess};
use crate::obj;
use crate::outgoing_auth::OutgoingAuth;
use crate::protocol::PROTOCOL_VERSION;

/// How long a started module has to say where it listens.
const START_TIMEOUT: Duration = Duration::from_secs(30);

/// Why a call failed: the module's own `{ code, message, data? }`, or a
/// transport fault (`code` `transport`).
#[derive(Debug, Clone, PartialEq)]
pub struct SlotError {
    pub code: String,
    pub message: String,
    pub data: Option<Js>,
}

/// The code of a module refused for the adapter protocol it speaks: its
/// message names the module itself, so it is passed on as it is.
pub const PROTOCOL_REFUSED_CODE: &str = "protocol_refused";

impl SlotError {
    fn transport(message: String) -> SlotError {
        SlotError { code: "transport".into(), message, data: None }
    }

    /// An error whose message stands alone (it names the module already):
    /// the module unreachable, or refused for its protocol.
    pub fn stands_alone(&self) -> bool {
        self.code == "transport" || self.code == PROTOCOL_REFUSED_CODE
    }
}

/// A method and its request body, and where its answer goes.
type Job = (String, String, mpsc::Sender<Result<Js, SlotError>>);

/// One slot module process reached from this thread: its slot (`kind`: the
/// slot's name, `loop guard` for the loop guard's), its process, and the
/// module as its client reaches it, so a session can read its manifest.
#[derive(Clone)]
pub struct SlotProcess {
    pub kind: String,
    pub process: ModuleProcess,
    pub reached: Reached,
}

thread_local! {
    /// The slots' module processes reached from this thread, one per
    /// process: a session opened here starts the ones its role needs.
    static SLOT_PROCESSES: std::cell::RefCell<Vec<SlotProcess>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn started_on_this_thread(slot: SlotProcess) {
    SLOT_PROCESSES.with(|all| {
        let mut all = all.borrow_mut();
        all.retain(|known| !known.process.is_same_process(&slot.process));
        all.push(slot);
    });
}

/// The slots' module processes reached from this thread so far.
pub fn slot_processes() -> Vec<SlotProcess> {
    SLOT_PROCESSES.with(|all| all.borrow().clone())
}

/// A slot module as its client reaches it: where, under what auth, and its
/// manifest, read once and checked against the protocol range listen-fire speaks.
#[derive(Clone)]
pub struct Reached {
    label: String,
    target: Target,
    auth: Option<OutgoingAuth>,
    standing: Arc<Standing>,
}

/// What a refusal names, the manifest request, and the manifest once read
/// and accepted. A failed read is not kept: the next call reads again.
struct Standing {
    name: String,
    slot: String,
    dir: PathBuf,
    manifest_body: String,
    manifest: tokio::sync::OnceCell<Js>,
}

impl Reached {
    /// The module's manifest, checked: a module outside the protocol range
    /// listen-fire speaks is refused by name (`core module "<name>" (<slot> slot) …`).
    pub async fn manifest(&self) -> Result<Js, SlotError> {
        let standing = &self.standing;
        let read = standing.manifest.get_or_try_init(|| async {
            let manifest = post_to(&self.label, &self.target, self.auth.as_ref(), standing.manifest_body.clone()).await?;
            let package = crate::protocol::Package::in_dir(&standing.dir);
            let speaker = crate::protocol::Speaker { name: &standing.name, slot: Some(&standing.slot), package };
            crate::protocol::protocol_standing(&manifest, &speaker).map_err(|message| SlotError { code: PROTOCOL_REFUSED_CODE.into(), message, data: None })?;
            Ok::<Js, SlotError>(manifest)
        });
        read.await.cloned()
    }

    /// `manifest`, its failure as one message.
    pub async fn checked(&self) -> Result<(), String> {
        match self.manifest().await {
            Ok(_) => Ok(()),
            Err(error) if error.code == PROTOCOL_REFUSED_CODE => Err(error.message),
            Err(error) => Err(format!("{}: manifest: {}", self.label, error.message)),
        }
    }

    /// One method: the manifest first if it is not yet read, so no other
    /// method reaches a module listen-fire does not speak to.
    async fn send(&self, method: &str, body: String) -> Result<Js, SlotError> {
        let manifest = self.manifest().await.map_err(|mut error| {
            if !error.stands_alone() && method != "manifest" {
                error.message = format!("its manifest: {}", error.message);
            }
            error
        })?;
        if method == "manifest" {
            return Ok(manifest);
        }
        post_to(&self.label, &self.target, self.auth.as_ref(), body).await
    }
}

pub struct SlotClient {
    /// The module, as messages name it ("the store module acme_store").
    pub label: String,
    reached: Reached,
    jobs: Option<mpsc::Sender<Job>>,
    worker: Option<std::thread::JoinHandle<()>>,
    settings: Obj,
}

/// Where the module answers, and the secret it requires.
#[derive(Clone)]
enum Target {
    Url { base_url: String, bearer: Option<String> },
    Process { process: ModuleProcess, token: String },
}

impl Target {
    /// The module's address for one call (a process started first if it is
    /// not running), and what the call carries to it.
    async fn lease(&self) -> Result<(Lease, Option<&str>), SlotError> {
        match self {
            Target::Url { base_url, bearer } => Ok((Lease::remote(base_url), bearer.as_deref())),
            Target::Process { process, token } => Ok((process.lease().await.map_err(SlotError::transport)?, Some(token.as_str()))),
        }
    }
}

impl SlotClient {
    /// Reach `module` (its url, or a process started from its command),
    /// under its install's `fields` (its settings, its secret, its outgoing auth).
    pub fn start(kind: &str, name: &str, process: &ProcessModule, fields: &BTreeMap<String, String>) -> Result<SlotClient, String> {
        let label = format!("the {kind} module {name}");
        // Its settings: every field but what proves listen-fire to it and to its platform.
        let declared: Obj = fields
            .iter()
            .filter(|(k, _)| !k.starts_with("outgoing_") && Some(k.as_str()) != process.auth_field.as_deref())
            .map(|(k, v)| (k.clone(), Js::str(v)))
            .collect();
        let (target, auth) = match &process.url {
            Some(url) => {
                let auth = OutgoingAuth::of_fields(fields, url).map_err(|e| format!("{label}: {e}"))?;
                (Target::Url { base_url: url.clone(), bearer: process.auth_field.as_ref().and_then(|f| fields.get(f)).cloned() }, auth)
            }
            None => {
                let token = crate::http_out::hex(&crate::http_out::random_bytes(24)?);
                let (program, args) = process.command.split_first().ok_or_else(|| format!("{label} has neither a command nor a url"))?;
                // The host's models door too, as the externals listen-fire starts are
                // told it: a judge module asks its model calls there.
                let env = [("PATH".to_string(), std::env::var("PATH").unwrap_or_default()), ("MODULE_TOKEN".to_string(), token.clone())]
                    .into_iter()
                    .chain(crate::serve::externals_host_url().map(|url| ("LF_HOST_URL".to_string(), url.to_string())))
                    .chain(crate::serve::host_token().map(|token| ("LF_HOST_TOKEN".to_string(), token.to_string())))
                    .chain(process.env.iter().map(|(k, v)| (k.clone(), v.clone())))
                    .collect();
                let launch = Launch { program: program.clone(), args: args.to_vec(), dir: process.dir.clone(), env, start_timeout: START_TIMEOUT };
                let process = ModuleProcess::own(&format!("{kind}:{name}"), &label, launch);
                (Target::Process { process, token }, None)
            }
        };
        // The loop guard's kind reads as words in messages; its slot is `loopGuard`.
        let slot = if kind == "loop guard" { "loopGuard" } else { kind };
        let standing = Standing {
            name: name.to_string(),
            slot: slot.to_string(),
            dir: process.dir.clone(),
            manifest_body: request_body("manifest", Obj::new(), &declared),
            manifest: tokio::sync::OnceCell::new(),
        };
        let reached = Reached { label: label.clone(), target, auth, standing: Arc::new(standing) };
        if let Target::Process { process, .. } = &reached.target {
            started_on_this_thread(SlotProcess { kind: kind.to_string(), process: process.clone(), reached: reached.clone() });
        }
        let (jobs, received) = mpsc::channel::<Job>();
        let worker_reached = reached.clone();
        let worker = std::thread::Builder::new()
            .name(format!("listen-fire {name}"))
            .spawn(move || {
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
                while let Ok((method, body, reply)) = received.recv() {
                    let answered = runtime.block_on(worker_reached.send(&method, body));
                    let _ = reply.send(answered);
                }
            })
            .map_err(|e| format!("{label}: no thread to call it from: {e}"))?;
        Ok(SlotClient { label, reached, jobs: Some(jobs), worker: Some(worker), settings: declared })
    }

    /// The module's address, its process started if it is not running, kept
    /// from an idle stop while the lease is held; and the secret it requires
    /// (`Authorization: Bearer …`). For a module listen-fire hands on to others (the
    /// browser slot's), which listen-fire cannot start again on their behalf.
    pub async fn hold(&self) -> Result<(Lease, Option<String>), String> {
        let (lease, bearer) = self.reached.target.lease().await.map_err(|e| self.text("start", e))?;
        Ok((lease, bearer.map(str::to_string)))
    }

    /// The settings the install gives the module's declared settings.
    pub fn settings(&self) -> Obj {
        self.settings.clone()
    }

    fn body(&self, method: &str, params: Obj) -> String {
        request_body(method, params, &self.settings)
    }

    fn named(&self, method: &str, mut error: SlotError) -> SlotError {
        if error.code == "transport" {
            error.message = format!("{}: {method}: {}", self.label, error.message);
        }
        error
    }

    /// One method, the caller waiting; its result, or the module's error.
    pub fn call(&self, method: &str, params: Obj) -> Result<Js, SlotError> {
        let (reply, answer) = mpsc::channel();
        let jobs = self.jobs.as_ref().ok_or_else(|| SlotError::transport(format!("{} is closed", self.label)))?;
        jobs.send((method.to_string(), self.body(method, params), reply)).map_err(|_| SlotError::transport(format!("{} is closed", self.label)))?;
        answer.recv().unwrap_or_else(|_| Err(SlotError::transport("no answer".into()))).map_err(|e| self.named(method, e))
    }

    /// One method awaited on the caller's runtime: for a slot whose calls
    /// are long (a model's answer), so the run's other requests go on meanwhile.
    pub async fn call_async(&self, method: &str, params: Obj) -> Result<Js, String> {
        self.call_async_coded(method, params).await.map_err(|e| self.text(method, e))
    }

    /// `call_async`, the module's error kept whole: for a caller that
    /// passes its code on (the OCR door, `unsupported_type`).
    pub async fn call_async_coded(&self, method: &str, params: Obj) -> Result<Js, SlotError> {
        self.reached.send(method, self.body(method, params)).await.map_err(|e| self.named(method, e))
    }

    fn text(&self, method: &str, error: SlotError) -> String {
        if error.stands_alone() { error.message } else { format!("{}: {method}: {}", self.label, error.message) }
    }

    /// `call`, a failure as one message.
    pub fn call_text(&self, method: &str, params: Obj) -> Result<Js, String> {
        self.call(method, params).map_err(|e| self.text(method, e))
    }
}

impl Drop for SlotClient {
    fn drop(&mut self) {
        self.jobs.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn request_body(method: &str, params: Obj, settings: &Obj) -> String {
    Js::from(obj! {
        "protocolVersion" => Js::str(PROTOCOL_VERSION),
        "method" => Js::str(method),
        "cacheScopeId" => Js::str("<slot>"),
        "params" => Js::from(params),
        "settings" => Js::from(settings.clone()),
    })
    .to_json()
}

async fn post_to(label: &str, target: &Target, auth: Option<&OutgoingAuth>, body: String) -> Result<Js, SlotError> {
    let (lease, bearer) = target.lease().await?;
    post(label, &lease.address, bearer, auth, body).await
}

async fn post(label: &str, base_url: &str, bearer: Option<&str>, auth: Option<&OutgoingAuth>, body: String) -> Result<Js, SlotError> {
    let headers = crate::protocol::envelope_headers(crate::check::LOCAL_TENANT, bearer, auth).await.map_err(SlotError::transport)?;
    let answer = crate::module_transport::post(base_url, &headers, body.into_bytes()).await.map_err(|e| SlotError::transport(format!("could not be reached at {base_url}: {e}")))?;
    if !(200..300).contains(&answer.status) {
        return Err(SlotError::transport(format!("answered HTTP {}", answer.status)));
    }
    let envelope = Js::parse(&answer.body).map_err(|e| SlotError::transport(format!("its answer is not JSON: {e}")))?;
    match envelope.get("ok") {
        Some(Js::Bool(true)) => Ok(envelope.get("result").cloned().unwrap_or(Js::Null)),
        Some(Js::Bool(false)) => {
            let error = envelope.get("error");
            let field = |k: &str| error.and_then(|e| e.get(k)).and_then(Js::as_str).map(str::to_string);
            Err(SlotError {
                code: field("code").unwrap_or_else(|| "module_error".into()),
                message: field("message").unwrap_or_else(|| "no message".into()),
                data: error.and_then(|e| e.get("data")).cloned(),
            })
        }
        _ => Err(SlotError::transport(format!("{label} answered {}, not the protocol's envelope", envelope.to_json()))),
    }
}

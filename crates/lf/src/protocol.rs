//! Adapter protocol 2's transport: one POST per call
//! (docs/contracts/adapter-protocol.md), the envelope `{ ok, result }` or
//! `{ ok: false, error }`, both over HTTP 200. The same request the TypeScript
//! client writes (movement-engine `protocol/client.ts` `postRpc`), failing
//! with the same errors: a transport error for a non-2xx answer, a protocol
//! error carrying the server's `{code, message}`, a shape error for an
//! envelope that is neither.
//!
//! Over a Unix socket, plain HTTP or HTTPS (crate::module_transport), with
//! the install's outgoing auth (crate::outgoing_auth) for a module behind a
//! platform's own sign-in; no retry: the TypeScript client retries nothing
//! either.

use serde_json::json;

use crate::json::Js;
use crate::outgoing_auth::OutgoingAuth;

pub use module_wire::envelope::{ADAPTER_TEAM_HEADER, CREDENTIAL_REFUSED_CODE, PROTOCOL_VERSION, shape_error};

/// The highest minor of adapter protocol 2 this lf speaks: it reads a module
/// stating 2.0 to 2.`SPEAKS_MINOR` (`PROTOCOL_MINOR`).
pub const SPEAKS_MINOR: u64 = 2;

/// The module a refusal names: an external, or a core module of a slot, with
/// its package and version when lf found its `package.json`.
pub struct Speaker<'a> {
    pub name: &'a str,
    pub slot: Option<&'a str>,
    pub package: Option<Package>,
}

/// A module's `package.json` name and version.
pub struct Package {
    pub name: String,
    pub version: String,
}

impl Package {
    /// The package in `dir`, when it has a `package.json` naming both.
    pub fn in_dir(dir: &std::path::Path) -> Option<Package> {
        let text = std::fs::read(dir.join("package.json")).ok()?;
        let json = Js::parse(&text).ok()?;
        let field = |key: &str| json.get(key).and_then(Js::as_str).map(str::to_string);
        Some(Package { name: field("name")?, version: field("version")? })
    }
}

/// Whether this lf reads a module whose manifest is `raw`, and if not, why,
/// naming both sides (`protocolStanding`, in the same words). An unstated
/// minor is 2.0 and always passes.
pub fn protocol_standing(raw: &Js, speaker: &Speaker) -> Result<(), String> {
    const MAJOR: u64 = 2;
    let named = match speaker.slot {
        None => format!("external \"{}\"", speaker.name),
        Some(slot) => format!("core module \"{}\" ({slot} slot)", speaker.name),
    };
    let subject = match &speaker.package {
        None => named,
        Some(package) => format!("{named} ({} {})", package.name, package.version),
    };
    let host = format!("this lf ({}) speaks {MAJOR}.0–{MAJOR}.{SPEAKS_MINOR}", env!("CARGO_PKG_VERSION"));
    let version = raw.get("protocolVersion");
    let major = match version {
        Some(Js::Num(n)) => n.as_f64(),
        _ => None,
    };
    if let Some(version) = version.filter(|_| major.is_some_and(|m| m > MAJOR as f64)) {
        return Err(format!("{subject}: speaks adapter protocol {}; {host}. Upgrade lf.", version.to_json()));
    }
    if major != Some(MAJOR as f64) {
        let got = version.map(Js::to_json).unwrap_or_else(|| "nothing".into());
        let module = if speaker.slot.is_some() { "module" } else { "adapter" };
        return Err(format!(
            "{subject}: protocolVersion: expected {MAJOR}, got {got} — this {module} targets an older adapter protocol; update it to protocol version {MAJOR}."
        ));
    }
    let minor = match raw.get("protocolMinor") {
        None => return Ok(()),
        Some(Js::Num(n)) => n.as_f64().filter(|m| m.fract() == 0.0 && *m >= 0.0),
        Some(_) => None,
    };
    let Some(minor) = minor else {
        let got = raw.get("protocolMinor").map(Js::to_json).unwrap_or_default();
        return Err(format!("{subject}: protocolMinor: expected a whole number, got {got}."));
    };
    if minor <= SPEAKS_MINOR as f64 {
        return Ok(());
    }
    let stated = format!("{MAJOR}.{minor}");
    let older = speaker.package.as_ref().map_or("a version of it".to_string(), |p| format!("a {}", p.name));
    Err(format!(
        "{subject} speaks adapter protocol {stated}; {host}. Upgrade lf to a release that speaks {stated} (the protocol's Changes list names it), or use {older} that speaks {MAJOR}.{SPEAKS_MINOR} or lower."
    ))
}

/// What a method a slot gained within version 2 is called in a refusal:
/// `work.enqueueIfAbsent (adapter protocol 2.2)`.
pub fn method_with_minor(method: &str) -> String {
    let listing = Js::Obj([("methods".to_string(), Js::strings([method]))].into_iter().collect());
    format!("{method} (adapter protocol 2.{})", module_wire::envelope::protocol_minor_of(&listing))
}

/// What a request carries beside its params: the one credential the
/// connection names, the install's settings, and the limits door the
/// module asks before each request to its provider (crate::limits_door).
#[derive(Default)]
pub struct Carried {
    pub credential: Option<serde_json::Value>,
    pub settings: Option<serde_json::Value>,
    pub host_limits: Option<serde_json::Value>,
}

tokio::task_local! {
    /// Where the `cost` lines of answers are collected, while a run's call
    /// is served (`spending`).
    static SPEND: std::rc::Rc<std::cell::RefCell<Vec<(String, f64)>>>;
}

/// Run `call`, collecting what the answers it receives say they spent (an
/// answer's `cost`: label and microdollars). Outside this, a cost is dropped:
/// nothing runs on a run's behalf there.
pub async fn spending<T>(call: impl std::future::Future<Output = T>) -> (T, Vec<(String, f64)>) {
    let lines = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let out = SPEND.scope(lines.clone(), call).await;
    let spent = lines.borrow().clone();
    (out, spent)
}

fn record_cost(envelope: &Js) {
    let lines: Vec<(String, f64)> = envelope
        .get("cost")
        .and_then(Js::as_array)
        .into_iter()
        .flatten()
        .filter_map(|line| Some((line.get("label")?.as_str()?.to_string(), match line.get("microdollars")? { Js::Num(n) => n.as_f64()?, _ => return None })))
        .filter(|(_, micro)| micro.is_finite() && *micro >= 0.0)
        .collect();
    if lines.is_empty() {
        return;
    }
    let _ = SPEND.try_with(|spend| spend.borrow_mut().extend(lines));
}

pub struct Call<'a> {
    pub base_url: &'a str,
    /// The `Authorization` header's value, when the external authenticates.
    pub bearer: Option<&'a str>,
    pub team_id: &'a str,
    pub method: &'a str,
    /// The caller's cache scope (`cacheScopeId`): one per adapter instance.
    pub cache_scope_id: &'a str,
    pub params: serde_json::Value,
    /// How the call proves itself to the platform in front of the module.
    pub auth: Option<OutgoingAuth>,
}

/// Why a protocol call failed, by the TypeScript error it stands for.
#[derive(Debug, Clone, PartialEq)]
pub enum RpcError {
    /// `fetch` itself failed: nothing answered.
    Unreachable(String),
    /// `RemoteTransportError`: a non-2xx answer.
    Transport { status: u16, method: String },
    /// `RemoteProtocolError`: the server's `{ ok: false, error }`.
    Protocol { code: String, message: String, method: String },
    /// `RemoteResponseShapeError`: an answer that is not the protocol's.
    Shape(String),
}

impl RpcError {
    pub fn message(&self) -> String {
        match self {
            RpcError::Unreachable(message) | RpcError::Shape(message) => message.clone(),
            RpcError::Transport { status, method } => format!("Remote adapter transport error (HTTP {status}) for method \"{method}\""),
            RpcError::Protocol { code, message, method } => format!("Remote adapter error for method \"{method}\": {code} — {message}"),
        }
    }

    /// The TypeScript error's `name`.
    pub fn name(&self) -> &'static str {
        match self {
            RpcError::Unreachable(_) => "TypeError",
            RpcError::Transport { .. } => "RemoteTransportError",
            RpcError::Protocol { .. } => "RemoteProtocolError",
            RpcError::Shape(_) => "RemoteResponseShapeError",
        }
    }

    /// The HTTP status a transport error carries.
    pub fn status(&self) -> Option<u16> {
        match self {
            RpcError::Transport { status, .. } => Some(*status),
            _ => None,
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl From<RpcError> for String {
    fn from(error: RpcError) -> String {
        error.message()
    }
}

/// One protocol call: its `result`, or why it failed. With a module's
/// declared credential it carries it (the request's `credential`), and the
/// answer's `credentialUpdate` comes back beside the result — read on a
/// failed answer too, since a rotated refresh token must be stored either way.
/// A call's answer, and what rode beside it: a `credentialUpdate`, and the
/// provider's throttle (`retryAfter`, here in milliseconds).
pub struct Answered {
    pub answer: Result<Js, RpcError>,
    pub update: Option<Js>,
    pub retry_after_ms: Option<u64>,
}

pub async fn post_rpc_carrying(call: Call<'_>, carried: Carried) -> Answered {
    let mut beside = Beside::default();
    let (method, base_url, limit) = (call.method.to_string(), call.base_url.to_string(), crate::module_hosts::call_timeout());
    // A call that outlasts the limit fails as an unreachable one does: the
    // run's own retry and failure path takes it from there.
    let answer = tokio::time::timeout(limit, post(call, carried, &mut beside)).await.unwrap_or_else(|_| {
        Err(RpcError::Unreachable(format!(
            "Remote adapter at {base_url} did not answer \"{method}\" within {}s (lf.yaml's `callTimeout` allows longer)",
            limit.as_secs()
        )))
    });
    Answered { answer, update: beside.update, retry_after_ms: beside.retry_after_ms }
}

#[derive(Default)]
struct Beside {
    update: Option<Js>,
    retry_after_ms: Option<u64>,
}

/// The request envelope's headers: the content type, the calling team, the
/// module's own secret, and the install's outgoing auth.
pub async fn envelope_headers(team_id: &str, bearer: Option<&str>, auth: Option<&OutgoingAuth>) -> Result<Vec<(String, String)>, String> {
    let mut headers = vec![("content-type".to_string(), "application/json".to_string()), (ADAPTER_TEAM_HEADER.to_string(), team_id.to_string())];
    if let Some(secret) = bearer {
        headers.push(("authorization".into(), format!("Bearer {secret}")));
    }
    if let Some(auth) = auth {
        let header = auth.header(&headers).await?;
        headers.push(header);
    }
    Ok(headers)
}

async fn post(call: Call<'_>, carried: Carried, beside: &mut Beside) -> Result<Js, RpcError> {
    let unreachable = |e: &dyn std::fmt::Display| {
        RpcError::Unreachable(format!("Remote adapter at {} could not be reached for method \"{}\": {e}", call.base_url, call.method))
    };
    let mut body = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "method": call.method,
        "cacheScopeId": call.cache_scope_id,
        "params": call.params,
    });
    for (key, value) in [("credential", carried.credential), ("settings", carried.settings), ("hostLimits", carried.host_limits)] {
        if let Some(value) = value {
            body[key] = value;
        }
    }
    let headers = envelope_headers(call.team_id, call.bearer, call.auth.as_ref()).await.map_err(|e| unreachable(&e))?;
    let answer = crate::module_transport::post(call.base_url, &headers, body.to_string().into_bytes()).await.map_err(|e| unreachable(&e))?;
    if !(200..300).contains(&answer.status) {
        return Err(RpcError::Transport { status: answer.status, method: call.method.to_string() });
    }
    let bytes = answer.body;
    let envelope = Js::parse(&bytes).map_err(|e| {
        RpcError::Shape(format!("Remote adapter \"{}\" answered \"{}\" with a body that is not JSON: {e}", call.base_url, call.method))
    })?;
    beside.update = envelope.get("credentialUpdate").cloned();
    beside.retry_after_ms = match envelope.get("retryAfter") {
        Some(Js::Num(seconds)) => seconds.as_f64().filter(|s| s.is_finite() && *s >= 0.0).map(|s| (s * 1000.0).ceil() as u64),
        _ => None,
    };
    record_cost(&envelope);
    match envelope.get("ok") {
        Some(Js::Bool(true)) => Ok(envelope.get("result").cloned().unwrap_or(Js::Null)),
        Some(Js::Bool(false)) => {
            let error = envelope.get("error");
            let field = |k: &str| error.and_then(|e| e.get(k)).and_then(Js::as_str);
            match (field("code"), field("message")) {
                (Some(code), Some(message)) => {
                    Err(RpcError::Protocol { code: code.to_string(), message: message.to_string(), method: call.method.to_string() })
                }
                _ => Err(RpcError::Shape(shape_error(call.method, call.base_url, &envelope, "error: expected { code, message }"))),
            }
        }
        _ => Err(RpcError::Shape(shape_error(call.method, call.base_url, &envelope, "ok: expected true or false"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LF: &str = env!("CARGO_PKG_VERSION");

    fn manifest(json: &str) -> Js {
        Js::parse(json.as_bytes()).unwrap()
    }

    fn slack(package: bool) -> Speaker<'static> {
        Speaker {
            name: "slack",
            slot: None,
            package: package.then(|| Package { name: "@listen-fire/slack".into(), version: "0.13.1".into() }),
        }
    }

    #[test]
    fn an_unstated_minor_and_every_minor_up_to_this_lfs_pass() {
        for raw in [r#"{"protocolVersion":2}"#, r#"{"protocolVersion":2,"protocolMinor":0}"#, r#"{"protocolVersion":2,"protocolMinor":1}"#, r#"{"protocolVersion":2,"protocolMinor":2}"#] {
            assert_eq!(protocol_standing(&manifest(raw), &slack(true)), Ok(()), "{raw}");
        }
    }

    #[test]
    fn a_newer_minor_is_refused_naming_the_package_and_the_range() {
        assert_eq!(
            protocol_standing(&manifest(r#"{"protocolVersion":2,"protocolMinor":3}"#), &slack(true)).unwrap_err(),
            format!(
                "external \"slack\" (@listen-fire/slack 0.13.1) speaks adapter protocol 2.3; this lf ({LF}) speaks 2.0–2.2. Upgrade lf to a release that speaks 2.3 (the protocol's Changes list names it), or use a @listen-fire/slack that speaks 2.2 or lower."
            )
        );
        assert_eq!(
            protocol_standing(&manifest(r#"{"protocolVersion":2,"protocolMinor":3}"#), &slack(false)).unwrap_err(),
            format!(
                "external \"slack\" speaks adapter protocol 2.3; this lf ({LF}) speaks 2.0–2.2. Upgrade lf to a release that speaks 2.3 (the protocol's Changes list names it), or use a version of it that speaks 2.2 or lower."
            )
        );
    }

    #[test]
    fn a_newer_major_is_refused() {
        assert_eq!(
            protocol_standing(&manifest(r#"{"protocolVersion":3}"#), &slack(false)).unwrap_err(),
            format!("external \"slack\": speaks adapter protocol 3; this lf ({LF}) speaks 2.0–2.2. Upgrade lf.")
        );
    }

    #[test]
    fn an_older_major_is_refused_in_the_words_it_always_was() {
        assert_eq!(
            protocol_standing(&manifest(r#"{"protocolVersion":1}"#), &slack(false)).unwrap_err(),
            "external \"slack\": protocolVersion: expected 2, got 1 — this adapter targets an older adapter protocol; update it to protocol version 2."
        );
        assert!(protocol_standing(&manifest("{}"), &slack(false)).unwrap_err().contains("got nothing"));
    }

    #[test]
    fn a_minor_that_is_not_a_whole_number_is_refused() {
        assert_eq!(
            protocol_standing(&manifest(r#"{"protocolVersion":2,"protocolMinor":1.5}"#), &slack(false)).unwrap_err(),
            "external \"slack\": protocolMinor: expected a whole number, got 1.5."
        );
    }

    #[test]
    fn a_slot_modules_refusal_names_its_slot() {
        let acme = Speaker { name: "acme_store", slot: Some("store"), package: None };
        assert!(
            protocol_standing(&manifest(r#"{"protocolVersion":2,"protocolMinor":9}"#), &acme)
                .unwrap_err()
                .starts_with(&format!("core module \"acme_store\" (store slot) speaks adapter protocol 2.9; this lf ({LF}) speaks 2.0–2.2."))
        );
        assert_eq!(
            protocol_standing(&manifest(r#"{"protocolVersion":3}"#), &acme).unwrap_err(),
            format!("core module \"acme_store\" (store slot): speaks adapter protocol 3; this lf ({LF}) speaks 2.0–2.2. Upgrade lf.")
        );
        assert_eq!(
            protocol_standing(&manifest(r#"{"protocolVersion":1}"#), &acme).unwrap_err(),
            "core module \"acme_store\" (store slot): protocolVersion: expected 2, got 1 — this module targets an older adapter protocol; update it to protocol version 2."
        );
    }

    #[test]
    fn a_method_a_slot_gained_is_named_with_its_minor() {
        assert_eq!(method_with_minor("movements.watch"), "movements.watch (adapter protocol 2.1)");
        assert_eq!(method_with_minor("work.enqueueIfAbsent"), "work.enqueueIfAbsent (adapter protocol 2.2)");
    }

    /// lf speaks what the kit's wire knows, and both are the TypeScript's:
    /// `PROTOCOL_MINOR` and every row of `PROTOCOL_MINORS` in protocol.ts.
    #[test]
    fn the_minors_are_the_typescript_protocols() {
        use module_wire::envelope::{MinorUse, PROTOCOL_MINOR, PROTOCOL_MINORS};
        assert_eq!(SPEAKS_MINOR, PROTOCOL_MINOR);
        let protocol = include_str!("../../../packages/engine-contracts/protocol.ts");
        assert!(protocol.contains(&format!("export const PROTOCOL_MINOR = {SPEAKS_MINOR};")), "protocol.ts states another PROTOCOL_MINOR");
        let start = protocol.find("export const PROTOCOL_MINORS").expect("protocol.ts has PROTOCOL_MINORS");
        let end = start + protocol[start..].find("];").expect("the table ends");
        let rows: Vec<&str> = protocol[start..end].lines().map(str::trim).filter(|l| l.starts_with("{ minor: ")).collect();
        let ours: Vec<String> = PROTOCOL_MINORS
            .iter()
            .map(|e| {
                let uses = match e.uses {
                    MinorUse::Method(name) => format!("{{ method: '{name}' }}"),
                    MinorUse::MethodEndingWith(ending) => format!("{{ methodEndingWith: '{ending}' }}"),
                };
                format!("{{ minor: {}, feature: '{}', uses: {uses} }},", e.minor, e.feature)
            })
            .collect();
        assert_eq!(rows, ours);
    }

    #[test]
    fn each_failure_carries_the_typescript_errors_words() {
        let protocol = RpcError::Protocol { code: "internal".into(), message: "boom".into(), method: "describe".into() };
        assert_eq!(protocol.message(), "Remote adapter error for method \"describe\": internal — boom");
        assert_eq!(protocol.name(), "RemoteProtocolError");
        let transport = RpcError::Transport { status: 502, method: "getRelated".into() };
        assert_eq!(transport.message(), "Remote adapter transport error (HTTP 502) for method \"getRelated\"");
        assert_eq!(transport.status(), Some(502));
    }
}

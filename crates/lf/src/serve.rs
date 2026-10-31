//! The shared half of `listen-fire serve` (the listening half is src/listener.rs, behind
//! the `serve` cargo feature): `listen-fire serve`: the inbound doors and the work queue. A provider's delivery at
//! `/api/public/webhook-sync/<provider>/<install>` is verified and read by
//! its external and its events queued, `/hooks/<external>/<install>` being
//! listen-fire's older name for the same door; an external's pushes arrive at
//! `/api/public/adapter/<external>/{emit,wake}` and are queued; a provider's
//! OAuth redirect for `listen-fire credential add --public` arrives at GET
//! `/oauth/callback`; an exposed file is fetched at GET `/files/<id>`. Due
//! work — an emitted event, a parked run's timer, a queued await wake — is
//! drained on a tick, and at once when a door queues some.
//!
//! The server listens before the session opens, so the externals the session
//! starts are told where to push (LF_HOST_URL). Also here: `listen-fire cancel`
//! and `listen-fire run --webhook`, the other ways in, and the word
//! `listen-fire call` is retired with.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::backend::{StoreSpec, open_store};
use crate::doors::Webhook;
use crate::runs::{Cancelled, Fired, Session, cancel_run};


/// Where this process serves, once `serve` listens: every external started
/// after it is told (LF_HOST_URL).
pub(crate) static HOST_URL: OnceLock<String> = OnceLock::new();

pub fn host_url() -> Option<&'static str> {
    HOST_URL.get().map(String::as_str)
}

/// The token this process's doors take from the externals it starts
/// (LF_HOST_TOKEN), for the models door.
pub(crate) static HOST_TOKEN: OnceLock<String> = OnceLock::new();

pub fn host_token() -> Option<&'static str> {
    HOST_TOKEN.get().map(String::as_str)
}

/// Outside `listen-fire serve` (a plain `listen-fire run`, `resume`, `drain`, …): a loopback
/// listener with the models door alone, so a module can still ask the
/// host for a model call.
pub(crate) static MODELS_DOOR_URL: OnceLock<String> = OnceLock::new();

/// Where the externals this process starts reach its doors (LF_HOST_URL).
pub fn externals_host_url() -> Option<&'static str> {
    host_url().or_else(|| MODELS_DOOR_URL.get().map(String::as_str))
}

/// `listen-fire call`, retired with callbacks at 0.13.
pub const CALL_RETIRED: &str = "listen-fire call is retired in 0.13: a run waits on a form from the @lf/forms adapter, answered by opening or posting to its Url";

// ── The other ways in: listen-fire cancel, listen-fire run --webhook ─────────────────

/// `listen-fire cancel <run-id> [--reason <text>]`. Settling a run starts no segment:
/// no externals, just the store.
pub async fn cancel_command(store: &StoreSpec, run_id: Option<&str>, reason: Option<&str>, json: bool, out: &mut impl Write) -> Result<i32, String> {
    let Some(run_id) = run_id else {
        eprintln!("listen-fire cancel needs a run id");
        return Ok(2);
    };
    let store = open_store(store)?;
    let cancelled = cancel_run(&*store, run_id, reason).await?;
    if json {
        let result = match cancelled {
            Cancelled::Now => "cancelled",
            Cancelled::Requested => "cancelRequested",
        };
        return crate::lfjson::emit(out, &crate::lfjson::cancel_doc(run_id, result), 0);
    }
    let line = match cancelled {
        Cancelled::Now => format!("run {run_id} cancelled"),
        Cancelled::Requested => format!("run {run_id}: cancel requested; another listen-fire process is stepping it, and it stops at its next statement"),
    };
    writeln!(out, "{line}").map_err(|e| e.to_string())?;
    Ok(0)
}

/// `listen-fire run --webhook <external> --body <file> [--install <credential>] [--header k:v]…`.
pub struct WebhookFile<'a> {
    pub external: &'a str,
    pub install: Option<&'a str>,
    pub body: &'a PathBuf,
    /// `name:value` each.
    pub headers: &'a [String],
}

pub async fn receive_webhook(session: &Session, file: WebhookFile<'_>) -> Result<Fired, String> {
    let raw_body = std::fs::read(file.body).map_err(|e| format!("{}: {e}", file.body.display()))?;
    let headers = file
        .headers
        .iter()
        .map(|pair| match pair.find(':').filter(|at| *at > 0) {
            Some(at) => Ok((pair[..at].trim().to_lowercase(), pair[at + 1..].trim().to_string())),
            None => Err(format!("--header {pair}: expected name:value")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    crate::doors::receive_webhook(session, Webhook { external: file.external, install: file.install, raw_body: &raw_body, headers: &headers }).await
}

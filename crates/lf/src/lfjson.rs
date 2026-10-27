//! `--json`: the machine-readable form of the commands an agent inspects or
//! drives. One document per command, in the shapes docs/lf-json.md fixes;
//! the human output is untouched. A failure is `{"error": "…"}` (main.rs).

use std::io::Write;
use std::path::PathBuf;

use crate::backend::RunHostStore;
use crate::check::FileDiagnostic;
use crate::json::{Js, Obj};
use crate::obj;
use crate::runs::{Fired, RerunRefused, RunOutcome};
use crate::secrets::MissingCredential;
use crate::store::{DeliveryRow, RunRow};
use crate::store_wire::Wire;

/// Write the document as one line, and pass the exit code through.
pub fn emit(out: &mut impl Write, doc: &Js, code: i32) -> Result<i32, String> {
    writeln!(out, "{}", doc.to_json()).map_err(|e| e.to_string())?;
    Ok(code)
}

fn num(n: impl Into<serde_json::Number>) -> Js {
    Js::Num(n.into())
}

fn opt(text: Option<&str>) -> Js {
    text.map_or(Js::Null, Js::str)
}

// ── check ───────────────────────────────────────────────────────────────────

fn diagnostic(file: &str, d: &FileDiagnostic) -> Js {
    let span = obj! { "line" => num(d.line as u64), "column" => num(d.column as u64), "endLine" => num(d.end_line as u64), "endColumn" => num(d.end_column as u64) };
    Js::Obj(obj! {
        "code" => Js::str(&d.code),
        "severity" => Js::str(d.severity),
        "file" => Js::str(file),
        "span" => Js::Obj(span),
        "message" => Js::str(&d.message),
        "fixes" => Js::Arr(d.fix.iter().cloned().collect()),
    })
}

fn missing_diagnostic(m: &MissingCredential) -> Js {
    let span = obj! { "line" => num(m.line as u64), "column" => num(m.column as u64), "endLine" => num(m.line as u64), "endColumn" => num(m.column as u64) };
    Js::Obj(obj! {
        "code" => Js::str("MISSING_CREDENTIAL"),
        "severity" => Js::str("error"),
        "file" => Js::str(m.file.display().to_string()),
        "span" => Js::Obj(span),
        "message" => Js::str(&m.message),
        "fixes" => Js::Arr(Vec::new()),
    })
}

pub fn check_doc(files: &[(PathBuf, Vec<FileDiagnostic>)], missing: &[MissingCredential]) -> Js {
    let mut diagnostics: Vec<Js> = missing.iter().map(missing_diagnostic).collect();
    for (path, found) in files {
        diagnostics.extend(found.iter().map(|d| diagnostic(&path.display().to_string(), d)));
    }
    let errors = diagnostics.iter().filter(|d| d.get("severity").and_then(Js::as_str) == Some("error")).count();
    Js::Obj(obj! {
        "ok" => Js::Bool(errors == 0),
        "files" => num(files.len() as u64),
        "errors" => num(errors as u64),
        "diagnostics" => Js::Arr(diagnostics),
    })
}

/// `catalog` when the project's files name credentials the secrets lack.
pub fn missing_doc(missing: &[MissingCredential]) -> Js {
    Js::Obj(obj! { "error" => Js::str("credentials the movement files name are missing"), "missingCredentials" => Js::Arr(missing.iter().map(missing_diagnostic).collect()) })
}

// ── run, resume, call, cancel ───────────────────────────────────────────────

pub fn outcome(o: &RunOutcome) -> Js {
    Js::Obj(obj! {
        "runId" => Js::str(&o.run_id),
        "file" => Js::str(&o.file),
        "movement" => Js::str(&o.movement),
        "entry" => Js::str(o.entry),
        "status" => Js::str(&o.status),
        "writes" => num(o.writes as u64),
        "dryRunWrites" => o.captured.as_ref().map_or(Js::Null, |writes| Js::Arr(writes.clone())),
        "traceEntries" => num(o.trace_entries),
        "error" => opt(o.error.as_deref()),
        "returned" => o.returned.clone().unwrap_or(Js::Null),
    })
}

fn ok_of(outcomes: &[RunOutcome]) -> bool {
    !outcomes.iter().any(|o| o.status == "failed")
}

/// The runs a `run`, `resume` or `call` came to; `redelivered` the events seen before.
pub fn runs_doc(outcomes: &[RunOutcome], redelivered: &[String]) -> Js {
    Js::Obj(obj! {
        "ok" => Js::Bool(ok_of(outcomes)),
        "runs" => Js::Arr(outcomes.iter().map(outcome).collect()),
        "redelivered" => Js::strings(redelivered),
    })
}

pub fn fired_doc(fired: &Fired) -> Js {
    runs_doc(&fired.outcomes, &fired.redelivered)
}

pub fn exit_of(outcomes: &[RunOutcome]) -> i32 {
    if ok_of(outcomes) { 0 } else { 1 }
}

/// `call`: `result` is recorded, refused, notFound, closed or expired.
pub fn call_doc(callback: &str, result: &str, message: Option<&str>, queued: bool, outcomes: &[RunOutcome]) -> Js {
    Js::Obj(obj! {
        "ok" => Js::Bool(result == "recorded" && ok_of(outcomes)),
        "callback" => Js::str(callback),
        "result" => Js::str(result),
        "message" => opt(message),
        "queued" => Js::Bool(queued),
        "runs" => Js::Arr(outcomes.iter().map(outcome).collect()),
    })
}

/// `runs rerun`: the attempt the run ran as, and what it came to.
pub fn rerun_doc(attempt: i64, outcome: &RunOutcome) -> Js {
    let mut doc = match runs_doc(std::slice::from_ref(outcome), &[]) {
        Js::Obj(doc) => doc,
        _ => unreachable!("runs_doc is an object"),
    };
    doc.insert("attempt".into(), num(attempt));
    Js::Obj(doc)
}

/// `runs rerun` refused: why (`notFailed`, `busy` or `committedWrites`),
/// the latest attempt's status and number, and the writes it committed.
pub fn rerun_refused_doc(run_id: &str, refused: &RerunRefused) -> Js {
    let (status, attempt, writes) = match refused {
        RerunRefused::NotFailed { status, attempt } => (Js::str(status), num(*attempt), Js::Null),
        RerunRefused::Busy => (Js::Null, Js::Null, Js::Null),
        RerunRefused::CommittedWrites { attempt, writes } => (Js::str("failed"), num(*attempt), Js::Arr(writes.clone())),
    };
    Js::Obj(obj! {
        "ok" => Js::Bool(false),
        "runId" => Js::str(run_id),
        "refused" => Js::str(refused.kind()),
        "error" => Js::str(refused.message(run_id)),
        "status" => status,
        "attempt" => attempt,
        "committedWrites" => writes,
    })
}

/// `cancel`: `result` is cancelled or cancelRequested.
pub fn cancel_doc(run_id: &str, result: &str) -> Js {
    Js::Obj(obj! { "ok" => Js::Bool(true), "runId" => Js::str(run_id), "result" => Js::str(result) })
}

// ── runs, runs show ─────────────────────────────────────────────────────────

fn parsed(text: Option<&str>) -> Js {
    text.and_then(|t| Js::parse(t.as_bytes()).ok()).unwrap_or(Js::Null)
}

fn row_summary(run: &RunRow) -> Obj {
    obj! {
        "runId" => Js::str(&run.id),
        "file" => Js::str(&run.file),
        "movement" => Js::str(&run.movement),
        "status" => Js::str(&run.status),
        "startedAt" => Js::str(&run.started_at),
        "finishedAt" => opt(run.finished_at.as_deref()),
        "attempt" => num(run.attempt),
    }
}

/// Every attempt of the run, the latest (the run's own row) last.
fn attempts(run: &RunRow) -> Js {
    let shown = |attempt: &Js| {
        let outcome = attempt.get("outcome").cloned().unwrap_or(Js::Null);
        let field = |key: &str| outcome.get(key).cloned().unwrap_or(Js::Null);
        Js::Obj(obj! {
            "attempt" => attempt.get("attempt").cloned().unwrap_or(Js::Null),
            "status" => attempt.get("status").cloned().unwrap_or(Js::Null),
            "startedAt" => attempt.get("startedAt").cloned().unwrap_or(Js::Null),
            "finishedAt" => attempt.get("finishedAt").cloned().unwrap_or(Js::Null),
            "writes" => field("writes"),
            "writeRecords" => field("writeRecords"),
            "error" => field("error"),
        })
    };
    let latest = crate::store::kept_attempt(run);
    Js::Arr(run.attempts.iter().chain(std::iter::once(&latest)).map(shown).collect())
}

pub fn runs_list_doc(rows: &[RunRow]) -> Js {
    Js::Obj(obj! { "runs" => Js::Arr(rows.iter().map(|r| Js::Obj(row_summary(r))).collect()) })
}

/// One run: its status, event, trace, write count, cost and what it is parked on.
pub fn run_show_doc(store: &dyn RunHostStore, run_id: &str) -> Result<Js, String> {
    let io = |e: crate::store::StoreError| e.to_string();
    let run = store.run(run_id).map_err(io)?.ok_or_else(|| format!("no run {run_id}"))?;
    let facts = parsed(Some(&run.input));
    let outcome = parsed(run.outcome.as_deref());
    let trace = store.trace_entries(run_id).map_err(io)?;
    let parked = store.leaves(run_id, true, None, None).map_err(io)?;
    let cancel = store.cancel_request(run_id).map_err(io)?;
    let mut shown = row_summary(&run);
    shown.insert("deliveryId".into(), opt(run.delivery_id.as_deref()));
    shown.insert("firedAt".into(), facts.get("firedAt").cloned().unwrap_or(Js::Null));
    shown.insert("languageVersion".into(), facts.get("languageVersion").cloned().unwrap_or(Js::Null));
    shown.insert("event".into(), facts.get("event").cloned().unwrap_or(Js::Null));
    shown.insert("writes".into(), outcome.get("writes").cloned().unwrap_or(Js::Null));
    shown.insert("writeRecords".into(), outcome.get("writeRecords").cloned().unwrap_or(Js::Null));
    shown.insert("error".into(), outcome.get("error").cloned().unwrap_or(Js::Null));
    shown.insert("returned".into(), outcome.get("returned").cloned().unwrap_or(Js::Null));
    shown.insert("outcome".into(), outcome);
    shown.insert("costMicrodollars".into(), serde_json::Number::from_f64(store.run_spent(run_id).map_err(io)?).map_or(Js::Null, Js::Num));
    shown.insert("traceEntries".into(), num(store.trace_len(run_id).map_err(io)?));
    shown.insert("trace".into(), trace.map_or(Js::Null, Js::Arr));
    shown.insert(
        "parked".into(),
        Js::Arr(
            parked
                .iter()
                .map(|leaf| Js::Obj(obj! { "address" => Js::str(&leaf.address), "reason" => Js::str(&leaf.reason), "wakeAt" => opt(leaf.wake_at.as_deref()) }))
                .collect(),
        ),
    );
    shown.insert("attempts".into(), attempts(&run));
    shown.insert("cancelRequested".into(), Js::Bool(cancel.is_some()));
    shown.insert("cancelReason".into(), cancel.flatten().map_or(Js::Null, Js::Str));
    Ok(Js::Obj(obj! { "run" => Js::Obj(shown) }))
}

// ── deliveries ──────────────────────────────────────────────────────────────

/// `deliveries`: each kept delivery with its run ids and statuses, no events.
pub fn deliveries_list_doc(rows: &[DeliveryRow]) -> Js {
    Js::Obj(obj! { "deliveries" => Js::Arr(rows.iter().map(Wire::to_wire).collect()) })
}

/// `deliveries show`: one delivery, with the events it holds and the runs they started.
pub fn delivery_show_doc(row: &DeliveryRow) -> Js {
    Js::Obj(obj! { "delivery" => row.to_wire() })
}

/// `deliveries replay`: the new delivery, the one it replays and the events queued.
pub fn delivery_replay_doc(new_id: &str, replay_of: &str, queued: usize) -> Js {
    Js::Obj(obj! { "ok" => Js::Bool(true), "deliveryId" => Js::str(new_id), "replayOf" => Js::str(replay_of), "queued" => num(queued as u64) })
}

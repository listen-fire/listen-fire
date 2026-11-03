//! `listen-fire drain`: a worker over the work queue, the scale-from-zero shape
//! of the run host (plans/cloud-native-2026-10-06/10_run_host.md): start,
//! claim due work rows one at a time under their lease, run what each one
//! asks (a timer's resume, an await's wake, a queued event), and exit.
//!
//!   --until-idle      exit once no row is due for this worker
//!   --max-seconds N   claim nothing new once N seconds have passed
//!
//!   --kinds k1,k2     a pool: claim only work rows of these kinds
//!                     (crate::store::WORK_KINDS); a cron listen's ticks are
//!                     its shared poll's `poll_edge` rows
//!
//! Every module the movements import is started as the worker opens,
//! together, and kept up until it exits (crate::runs::Role::Drain): a run
//! never waits on a module's start.
//!
//! With neither it polls forever, once a second while nothing is due. Any
//! number of workers can drain one Postgres store at once: a row is claimed
//! by one of them (SKIP LOCKED), and a run is stepped by whoever holds its
//! lease, so every run's work is done once.

use std::io::Write;
use std::time::{Duration, Instant};

use crate::runs::{Results, Session, report};
use crate::store::WORK_KINDS;

/// One row per claim, so workers draining one queue share it row by row.
const ROWS_PER_CLAIM: i64 = 1;
const IDLE_POLL: Duration = Duration::from_secs(1);

/// What `--kinds cron` named until 0.13: the cron ticks are polled now.
const RETIRED_CRON: &str = "cron";

/// Which work one worker takes: every kind, or a pool's (`--kinds`), so
/// polls and run steps can be drained by separately sized fleets.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Pool {
    /// The work rows' kinds; None: every kind.
    rows: Option<Vec<String>>,
}

impl Pool {
    /// `--kinds poll_edge,resolve_listen`: each a work kind.
    pub fn of(list: &str) -> Result<Pool, String> {
        let kinds: Vec<&str> = list.split(',').map(str::trim).filter(|k| !k.is_empty()).collect();
        if kinds.is_empty() {
            return Err("--kinds names no kind".into());
        }
        if kinds.contains(&RETIRED_CRON) {
            return Err("--kinds cron: a cron listen's ticks are polled from 0.13, as `poll_edge` rows: name poll_edge".into());
        }
        if let Some(other) = kinds.iter().find(|k| !WORK_KINDS.contains(k)) {
            return Err(format!("--kinds {other}: not a kind of work (the kinds: {})", WORK_KINDS.join(", ")));
        }
        Ok(Pool { rows: Some(kinds.iter().map(|k| k.to_string()).collect()) })
    }

    pub fn takes(&self, kind: &str) -> bool {
        self.rows.as_ref().is_none_or(|k| k.iter().any(|k| k == kind))
    }

    /// The work rows' kinds the store is asked for; None for every kind.
    pub fn work_kinds(&self) -> Option<&[String]> {
        self.rows.as_deref()
    }
}

pub struct DrainOptions {
    pub until_idle: bool,
    pub max_seconds: Option<u64>,
}

/// Each run a row stepped is reported as `listen-fire resume` reports it, as it
/// ends. The exit code is 1 when any of them failed. A worker that runs
/// until stopped follows the movements module's changes meanwhile; one run
/// `--until-idle` keeps the files it opened with.
pub async fn drain(session: &Session, options: &DrainOptions, out: &mut impl Write) -> Result<i32, String> {
    if options.until_idle {
        return passes(session, options, out).await;
    }
    // The deadline ends both, a watch in flight with them.
    let mut log = std::io::stderr();
    tokio::select! {
        drained = passes(session, options, out) => drained,
        never = session.watch_movements(&mut log) => match never {},
    }
}

async fn passes(session: &Session, options: &DrainOptions, out: &mut impl Write) -> Result<i32, String> {
    let deadline = options.max_seconds.map(|s| Instant::now() + Duration::from_secs(s));
    let past_deadline = || deadline.is_some_and(|d| Instant::now() >= d);
    let mut code = 0;
    while !past_deadline() {
        // As `listen-fire resume`: a row that fails is retried later, its reason on stderr.
        let (claimed, outcomes) = session.drain_work(ROWS_PER_CLAIM, &mut std::io::stderr()).await?;
        if !outcomes.is_empty() {
            code = code.max(report(&outcomes, Results::Withheld, out)?);
            out.flush().map_err(|e| e.to_string())?;
        }
        if claimed > 0 {
            continue;
        }
        if options.until_idle {
            break;
        }
        let wait = deadline.map_or(IDLE_POLL, |d| IDLE_POLL.min(d.saturating_duration_since(Instant::now())));
        tokio::time::sleep(wait).await;
    }
    Ok(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pool_names_work_kinds() {
        let pool = Pool::of("poll_edge, resolve_listen").unwrap();
        assert!(pool.takes("poll_edge") && pool.takes("resolve_listen") && !pool.takes("resume_timer"));
        assert_eq!(pool.work_kinds(), Some(&["poll_edge".to_string(), "resolve_listen".to_string()][..]));
        let runs = Pool::of("fire_event,resume_timer").unwrap();
        assert!(!runs.takes("poll_edge"));
        assert!(Pool::of("poll").unwrap_err().contains("not a kind of work"));
        assert!(Pool::of(",").is_err());
        let all = Pool::default();
        assert!(all.takes("wake_await") && all.work_kinds().is_none());
        assert!(Pool::of("fire_callback").unwrap_err().contains("not a kind of work"), "callbacks retired at 0.13");
        assert!(Pool::of("poll_listen").unwrap_err().contains("not a kind of work"), "a settings listen's poll retired at 0.13");
        assert_eq!(Pool::of("poll_edge,cron").unwrap_err(), "--kinds cron: a cron listen's ticks are polled from 0.13, as `poll_edge` rows: name poll_edge");
    }
}

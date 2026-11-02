//! `listen-fire listens replay <file>:<movement> --delivery <id> [--force]`
//! (or `--event <id>`, an `Arrival Not Judged` event's): put one kept
//! delivery through one listen again, the way out of `Arrival Not Judged`
//! once the provider whose lookup failed answers again.
//!
//! The delivery's kept request is read again by its module's inbound
//! handling (crate::inbound::reread_delivery: its lookups made afresh, its
//! signature not verified, since the request is listen-fire's own capture;
//! a module that checks its own requests is told it is a replay and skips
//! its check), and what it reports landed is judged against the named listen
//! alone: the delivery's other listens are left as they are. A poll's page
//! made no request: it kept the arrivals it read, and those are judged again,
//! the module asked nothing. A run it fires goes the
//! way a delivery's does, in one write (a replay delivery of its own, the
//! run's waits opened with its trigger noted on them, the records the
//! arrival carries handed to it), and runs here. The listen's receipt holds:
//! one that ran the arrival before runs nothing, unless `--force`, which runs
//! it again under a receipt of its own. A listen that still cannot judge the
//! arrival is reported again, as the next attempt, and the command exits 1:
//! the way back is not yet open.

use std::io::Write;

use crate::arrivals::{ArrivalIn, arrival_receipt_key};
use crate::check::LOCAL_TENANT;
use crate::doors::{EventSink, LfDoors, SessionReader, fire_arrivals_work, queued_by, subscription_of};
use crate::inbound::{Captured, Page};
use crate::json::Js;
use crate::records_door::{UnjudgedAfter, UnjudgedArrival, UnjudgedPage};
use crate::routing::Listen;
use crate::runs::{Delivered, FileSet, Replay, Session};
use crate::store::{DeliveryRow, DeliverySource, NewDelivery, iso};
use crate::waits::DeliveryArrivals;

/// What `listens replay` was asked.
pub struct Asked<'a> {
    /// `<file>:<movement>`.
    pub named: &'a str,
    pub delivery: Option<&'a str>,
    /// An `Arrival Not Judged` event's `Event Id`: its listen and its delivery.
    pub event: Option<&'a str>,
    /// Run the listen again though it ran the arrival before.
    pub force: bool,
}

/// What a delivery kept of how it came in (NewDelivery::request).
enum Capture {
    /// A request a door received.
    Request(Captured),
    /// The arrivals a poll read.
    Page(Page),
}

/// What a kept delivery reads as now, for the listens it reaches.
struct Reread {
    adapter: String,
    /// The install it came in under, which the module's calls are made as.
    install: Option<String>,
    /// The connection it came for (crate::routing::Listen::hears).
    credential: Option<String>,
    arrivals: Vec<ArrivalIn>,
}

pub async fn command(session: &Session, asked: &Asked<'_>, out: &mut impl Write) -> Result<i32, String> {
    let set = session.file_set();
    let named_by = |l: &&Listen| format!("{}:{}", l.file, l.movement_name) == asked.named;
    let mut listens: Vec<&Listen> = set.listens.iter().filter(named_by).collect();
    if listens.is_empty() {
        eprintln!("listen-fire: no listen on a traversal fires {}: `listen-fire listens` names each as <file>:<movement>", asked.named);
        return Ok(2);
    }
    let delivery_id = match (asked.delivery, asked.event) {
        (Some(id), None) => id.to_string(),
        (None, Some(event)) => {
            let fact = reported(session, &listens, event)?;
            listens.retain(|l| l.pipeline() == fact.pipeline);
            fact.delivery_id.ok_or_else(|| format!("{event} names no kept delivery: there is nothing to replay"))?
        }
        _ => {
            eprintln!("listen-fire listens replay names the delivery to replay: --delivery <id>, or --event <the Arrival Not Judged event's Event Id>");
            return Ok(2);
        }
    };
    let row = session.store.delivery(&delivery_id).map_err(|e| e.to_string())?.ok_or_else(|| {
        format!("no delivery {delivery_id}: deliveries are kept {} days (deliveries.retainDays), and one older is forgotten", session.project.delivery_retain_days)
    })?;
    let capture = capture_of(session, &row)?;
    if let Capture::Page(_) = capture {
        sharing_the_poll(&set, &mut listens, &row)?;
    }
    let doors = LfDoors::of_session(session, EventSink::Queue, &|| {});
    let reread = reread(&doors, &row, capture).await?;
    let mut code = 0;
    for listen in listens {
        code = code.max(replay_through(session, &set, listen, &row, &reread, asked.force, out).await?);
    }
    Ok(code)
}

/// The fact an `Arrival Not Judged` event reports, as its `Event Id` names
/// it: one of `listens`'.
/// A listen edited since keeps its facts under the pipeline it had: one of
/// those is refused by name, pointing at its delivery.
fn reported(session: &Session, listens: &[&Listen], event: &str) -> Result<UnjudgedArrival, String> {
    let named = format!("{}:{}", listens[0].file, listens[0].movement_name);
    for listen in listens {
        if let Some(fact) = facts_of(session, Some(&listen.pipeline()))?.into_iter().find(|fact| fact.event_id() == event) {
            return Ok(fact);
        }
    }
    let file = session.file_set().file(&listens[0].file).name.clone();
    if let Some(earlier) = facts_of(session, None)?.into_iter().find(|fact| fact.event_id() == event && fact.file == file && fact.movement == listens[0].movement_name) {
        return Err(match earlier.delivery_id {
            Some(delivery) => format!("{event} is of an earlier version of {named}, which has been edited since: `--delivery {delivery}` puts its delivery through {named} as it is written now"),
            None => format!("{event} is of an earlier version of {named}, which has been edited since, and names no kept delivery: there is nothing to replay"),
        });
    }
    Err(format!("no Arrival Not Judged {event} of {named} is kept: facts are kept {} days (deliveries.retainDays)", session.project.delivery_retain_days))
}

/// Every unjudged arrival kept, for the listen `pipeline` when it names one,
/// oldest first.
fn facts_of(session: &Session, pipeline: Option<&str>) -> Result<Vec<UnjudgedArrival>, String> {
    const PAGE: i64 = 500;
    let mut facts: Vec<UnjudgedArrival> = Vec::new();
    loop {
        let after = facts.last().map(|last| UnjudgedAfter { at: &last.at, pipeline: &last.pipeline, arrival: &last.arrival, attempt: last.attempt });
        let page = session.store.unjudged_arrivals(&UnjudgedPage { after, pipeline, limit: PAGE }).map_err(|e| e.to_string())?;
        let done = page.len() < usize::try_from(PAGE).unwrap_or(usize::MAX);
        facts.extend(page);
        if done {
            return Ok(facts);
        }
    }
}

/// A poll's page is replayed through the listens that shared the poll: its
/// module was asked for what the listens sharing it take, so a listen that did
/// not share it would judge arrivals read for another's filter.
fn sharing_the_poll(set: &FileSet, listens: &mut Vec<&Listen>, row: &DeliveryRow) -> Result<(), String> {
    let sharing: Vec<String> = crate::edge_polls::sharing_poll(set, &row.subscription_id).map(|(_, shared)| shared.fires.iter().map(|i| set.listens[*i].pipeline()).collect()).unwrap_or_default();
    listens.retain(|listen| sharing.contains(&listen.pipeline()));
    if listens.is_empty() {
        return Err(format!(
            "delivery {} is a poll's page, read for the listens that shared that poll: the listen named is not one of them (it may have been edited since, or its connection changed)",
            row.id
        ));
    }
    Ok(())
}

/// The delivery's kept request (or, for a poll, the page it read), while it
/// is kept: a delivery received longer ago than `deliveries.retainDays` is
/// refused, whatever it holds.
fn capture_of(session: &Session, row: &DeliveryRow) -> Result<Capture, String> {
    let days = session.project.delivery_retain_days;
    if row.received_at < iso(-i64::from(days) * 86_400_000) {
        return Err(format!(
            "delivery {} was received {}, more than {days} days ago (deliveries.retainDays): its request is no longer kept, and it cannot be replayed",
            row.id, row.received_at
        ));
    }
    let Some(request) = &row.request else {
        return Err(match row.replay_of.as_deref() {
            Some(of) => format!("delivery {} is a replay of {of}: replay {of} itself", row.id),
            None => format!("delivery {} kept no request (it was kept by a listen-fire before deliveries kept theirs): it cannot be replayed", row.id),
        });
    };
    let unreadable = || format!("delivery {}'s kept request is not one listen-fire can read", row.id);
    match row.source {
        DeliverySource::Poll => Page::read(request).map(Capture::Page).ok_or_else(unreadable),
        _ => Captured::read(request).map(Capture::Request).ok_or_else(unreadable),
    }
}

/// The delivery's capture read again: a poll's page is the arrivals it read,
/// judged again with no call to its module; a push to the `wake` door reports
/// the arrivals it pushed; any other delivery is its module's inbound
/// handling run again.
async fn reread(doors: &LfDoors<'_, SessionReader<'_>>, row: &DeliveryRow, capture: Capture) -> Result<Reread, String> {
    let captured = match capture {
        Capture::Page(page) => return Ok(Reread { adapter: page.adapter, install: page.install, credential: page.credential, arrivals: page.arrivals }),
        Capture::Request(captured) => captured,
    };
    let captured = &captured;
    if row.source == DeliverySource::Emit {
        let install = doors.install(&row.subscription_id).ok_or_else(|| format!("delivery {} was pushed as {}, which is no longer a credential here", row.id, row.subscription_id))?;
        let credential = (install.binding != crate::secrets::Binding::Install).then(|| install.name.clone());
        return Ok(Reread { adapter: install.external.clone(), install: Some(install.name.clone()), credential, arrivals: crate::inbound::reread_push(captured)? });
    }
    let (source, extraction) = crate::inbound::reread_delivery(doors, &row.subscription_id, captured).await?;
    Ok(Reread {
        credential: doors.delivering_credential(&source).map(str::to_string),
        arrivals: doors.under_head(&row.subscription_id, &extraction.arrivals),
        install: Some(source.install.clone()),
        adapter: source.adapter_type,
    })
}

/// Put what the delivery reads as now through `listen` alone: the exit
/// code, non-zero when a run it started failed or the listen still cannot
/// judge an arrival.
async fn replay_through(session: &Session, set: &FileSet, listen: &Listen, row: &DeliveryRow, reread: &Reread, force: bool, out: &mut impl Write) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    let named = format!("{}:{}", listen.file, listen.movement_name);
    let adapter = reread.adapter.as_str();
    let credential = reread.credential.as_deref();
    let mut doors = LfDoors::of_session(session, EventSink::Queue, &|| {});
    doors.listens = vec![listen.clone()];
    let landed: Vec<ArrivalIn> = doors.landed_for_listens(adapter, credential, &reread.arrivals).into_iter().filter(|arrival| listen.is_on(adapter, &arrival.edge)).collect();
    if landed.is_empty() {
        writeln!(out, "{named}: delivery {} brought nothing it hears: nothing to replay", row.id).map_err(io)?;
        return Ok(0);
    }
    // A listen whose earlier hops the host resolves runs only what lands
    // under the records it watches now: --force cannot run the rest.
    if landed.iter().all(|arrival| !set.watches_under(listen, &arrival.key)) {
        writeln!(out, "{named}: delivery {} brought nothing under a record it watches now: nothing to replay", row.id).map_err(io)?;
        return Ok(0);
    }
    let replay = Replay { of: &row.id, attempt: next_attempt(session, listen, &landed)?, again: force };
    let minted = doors.mint_runs(adapter, reread.install.as_deref(), credential, &landed).await?;
    let unjudged_in = Delivered { id: Some(&row.id), credential, replay: Some(replay), ..Delivered::default() };
    for one in &minted.unjudged {
        let arrival = &landed[one.arrival];
        session.note_unjudged(set, adapter, listen, arrival, &unjudged_in, &one.reason)?;
        let identity = arrival.identity.as_deref().unwrap_or_default();
        writeln!(out, "{named}: the arrival {identity} on {} still cannot be judged ({}): reported again, attempt {}", arrival.edge, one.reason, replay.attempt).map_err(io)?;
    }
    let undecided = i32::from(!minted.unjudged.is_empty());
    if minted.runs.as_array().is_none_or(<[Js]>::is_empty) {
        if minted.unjudged.is_empty() {
            writeln!(out, "{named}: its filter does not take what delivery {} brought: nothing to run", row.id).map_err(io)?;
        }
        return Ok(undecided);
    }
    let came_for = Delivered { credential, minted: Some(&minted.runs), replay: Some(replay), ..Delivered::default() };
    let fired = fire_replay(session, &doors, ReplayRun { adapter, row, landed: &landed, came_for, waits: minted.waits }).await?;
    if fired.outcomes.is_empty() && !force {
        for line in &fired.redelivered {
            writeln!(out, "{line}").map_err(io)?;
        }
        writeln!(out, "{named}: nothing replayed (--force runs it again)").map_err(io)?;
        return Ok(undecided);
    }
    Ok(fired.report(out)?.max(undecided))
}

/// The attempt a replay of `landed` through `listen` is: one more than the
/// latest kept for any of its arrivals, the first replay 1 (the delivery's
/// own judging is 0).
fn next_attempt(session: &Session, listen: &Listen, landed: &[ArrivalIn]) -> Result<u32, String> {
    let receipts: Vec<String> = landed.iter().map(|a| arrival_receipt_key(&a.edge, a.key.as_deref(), a.identity.as_deref().unwrap_or_default(), a.version.as_deref())).collect();
    let latest = facts_of(session, Some(&listen.pipeline()))?.into_iter().filter(|fact| receipts.contains(&fact.arrival)).map(|fact| fact.attempt).max();
    Ok(latest.map_or(1, |attempt| attempt.saturating_add(1).max(1)))
}

/// A replay's run, as `fire_replay` keeps and runs it.
struct ReplayRun<'r> {
    adapter: &'r str,
    /// The delivery replayed.
    row: &'r DeliveryRow,
    landed: &'r [ArrivalIn],
    /// What the run came for: its connection, its minted run, the replay.
    came_for: Delivered<'r>,
    waits: Vec<crate::waits::DeliveryWait>,
}

/// The run a replay minted, kept as a delivery's is, in one write: a replay
/// delivery of its own (no request: the one it replays keeps that), the
/// `fire_event` row that runs it, due a run lease out (so a drain takes it
/// only if this process dies), and its waits, its trigger noted on them;
/// then it runs here and the row is done.
async fn fire_replay(session: &Session, doors: &LfDoors<'_, SessionReader<'_>>, run: ReplayRun<'_>) -> Result<crate::runs::Fired, String> {
    let ReplayRun { adapter, row, landed, came_for, mut waits } = run;
    let receipt = NewDelivery {
        id: uuid::Uuid::new_v4().to_string(),
        external_id: None,
        received_at: iso(0),
        source: DeliverySource::Cli,
        inline: true,
        replay_of: Some(row.id.clone()),
        events: Vec::new(),
        request: None,
    };
    let delivered = Delivered { id: Some(&receipt.id), subscription: subscription_of(&row.subscription_id).1, ..came_for };
    let mut work = fire_arrivals_work(adapter, landed, delivered);
    work.due_at = Some(iso(crate::run_host::RUN_LEASE_TTL_MS));
    queued_by(&mut waits, &work.key);
    let key = work.key.clone();
    let mut rows = vec![work];
    // Its arrivals were logged with the delivery it replays; its waits are
    // opened from now, under the arrivals' team and module.
    let at = iso(0);
    let log = DeliveryArrivals { team_id: LOCAL_TENANT, adapter_type: adapter, arrivals: &[], at: &at, resend_window_ms: doors.resend_window_ms(adapter) };
    let logged = (!waits.is_empty()).then_some(&log);
    if logged.is_none() {
        let mark = session.store.arrival_mark().map_err(|e| e.to_string())?;
        for row in &mut rows {
            if let Js::Obj(payload) = &mut row.payload {
                payload.insert("arrivalMark".into(), Js::Num(mark.into()));
            }
        }
    }
    let written = session
        .store
        .keep_delivery(&row.subscription_id, None, &receipt, &rows, logged, &waits, &[])
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("the replay of delivery {} was not kept: the store took it for a duplicate", row.id))?;
    crate::wake::queued_rows(&rows);
    let fired = session.fire_arrivals(adapter, landed, Delivered { arrival_mark: Some(written.arrival_mark), ..delivered }).await?;
    if let Err(error) = session.store.complete_key(&key) {
        eprintln!("listen-fire: the row of the replay {} was not completed ({error}): a drain runs it again a run lease from now, and it starts no run twice", receipt.id);
    }
    Ok(fired)
}

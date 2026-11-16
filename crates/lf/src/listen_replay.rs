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
//!
//! An arrival a listen could not judge because the host could not answer a
//! function its filter calls waits, and so does every later arrival of that
//! listen (`WaitingLines`): a work row of the listen's own (`judge_waiting`)
//! judges them again in the order they came, a retry apart, until its host
//! answers, in whichever process drains (`listen-fire serve`, or a
//! `listen-fire drain` behind `serve --doors-only`).

use std::collections::HashMap;
use std::io::Write;

use crate::arrivals::{ArrivalIn, arrival_receipt_key};
use crate::check::LOCAL_TENANT;
use crate::doors::{EventSink, LfDoors, SessionReader, fire_arrivals_work, queued_by, subscription_of};
use crate::externals::Unanswered;
use crate::inbound::{Captured, Page};
use crate::json::Js;
use crate::records_door::{UnjudgedAfter, UnjudgedArrival, UnjudgedPage};
use movement_engine::listen_judge::{UndecidedReason, Verdict};
use crate::backend::RunHostStore;
use crate::plugin_answers::AnswersHost;
use crate::routing::{Asking, Listen};
use crate::runs::{Delivered, FileSet, Replay, RunOutcome, Session};
use crate::store::{DeliveryRow, DeliverySource, NewDelivery, NewWork, iso};
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
        let page = session.store.unjudged_arrivals(&UnjudgedPage { after, pipeline, waiting: false, limit: PAGE }).map_err(|e| e.to_string())?;
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
/// handling run again. A failure says whether its module was reached.
async fn reread(doors: &LfDoors<'_, SessionReader<'_>>, row: &DeliveryRow, capture: Capture) -> Result<Reread, Unanswered> {
    let captured = match capture {
        Capture::Page(page) => return Ok(Reread { adapter: page.adapter, install: page.install, credential: page.credential, arrivals: page.arrivals }),
        Capture::Request(captured) => captured,
    };
    let captured = &captured;
    if row.source == DeliverySource::Emit {
        let install = doors.install(&row.subscription_id).ok_or_else(|| Unanswered::Refused(format!("delivery {} was pushed as {}, which is no longer a credential here", row.id, row.subscription_id)))?;
        let credential = (install.binding != crate::secrets::Binding::Install).then(|| install.name.clone());
        let arrivals = doors.with_actors(&install.external, Some(install), crate::inbound::reread_push(captured).map_err(Unanswered::Refused)?).await;
        return Ok(Reread { adapter: install.external.clone(), install: Some(install.name.clone()), credential, arrivals });
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
    doors.replaying = true;
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
    let replay = Replay { of: &row.id, attempt: next_attempt(session, listen, &landed.iter().map(receipt_of).collect::<Vec<_>>())?, again: force };
    let minted = doors.mint_runs(adapter, reread.install.as_deref(), credential, &landed).await?;
    let unjudged_in = Delivered { id: Some(&row.id), credential, replay: Some(replay), ..Delivered::default() };
    for one in &minted.unjudged {
        let arrival = &landed[one.arrival];
        session.note_unjudged(set, adapter, listen, arrival, &unjudged_in, &one.why)?;
        let identity = arrival.identity.as_deref().unwrap_or_default();
        writeln!(out, "{named}: the arrival {identity} on {} still cannot be judged ({}): reported again, attempt {}", arrival.edge, one.why.reason, replay.attempt).map_err(io)?;
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

/// An arrival as its listens' receipts name it.
fn receipt_of(arrival: &ArrivalIn) -> String {
    arrival_receipt_key(&arrival.edge, arrival.key.as_deref(), arrival.identity.as_deref().unwrap_or_default(), arrival.version.as_deref())
}

/// The attempt a replay through `listen` of the arrivals `receipts` names
/// is: one more than the latest kept for any of them, the first replay 1
/// (the delivery's own judging is 0).
fn next_attempt(session: &Session, listen: &Listen, receipts: &[String]) -> Result<u32, String> {
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

/// What a listen made of an arrival.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Judgement {
    Fires,
    /// It fails the filter of hop `hop`, or (with a reason) is of another record type there.
    Skips { hop: usize, reason: Option<String> },
    Unjudged(Unjudgement),
}

/// Why a listen could not judge an arrival, and whether it waits on it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Unjudgement {
    pub reason: String,
    /// The host could not answer a function its filter calls, or an earlier
    /// arrival waits so: it is judged again once the host answers.
    pub waiting: bool,
}

/// The reason an arrival gives that waits behind one its host could not answer.
pub(crate) const WAITING_BEHIND: &str = "waiting behind an earlier arrival";

impl Judgement {
    fn of(verdict: Verdict) -> Judgement {
        match verdict {
            Verdict::Fires => Judgement::Fires,
            Verdict::Skips { hop, reason } => Judgement::Skips { hop, reason },
            Verdict::Undecided { reason: UndecidedReason::HostUnreachable { message, .. } } => Judgement::Unjudged(Unjudgement { reason: message, waiting: true }),
            Verdict::Undecided { reason: UndecidedReason::Unjudgeable(reason) } => Judgement::Unjudged(Unjudgement { reason, waiting: false }),
            // Only a judgement no host answers ends asking.
            Verdict::Asks(questions) => {
                let asked: Vec<&str> = questions.iter().map(|question| question.plugin.as_str()).collect();
                Judgement::Unjudged(Unjudgement { reason: format!("this listen's filter calls {}, which no host answered", asked.join(", ")), waiting: false })
            }
        }
    }
}

/// The arrivals each listen that calls a host function waits on, oldest
/// first, as the store keeps them (read once per listen) and as this
/// judging adds to them and takes from them.
pub(crate) struct WaitingLines<'s> {
    store: &'s dyn RunHostStore,
    /// By pipeline, each arrival by its receipt key.
    lines: HashMap<String, Vec<String>>,
    /// An arrival waits behind the first in line. False for a kept one put
    /// through its listen again: the retry takes them in order itself, and a
    /// replay is its operator's to order.
    in_turn: bool,
}

impl<'s> WaitingLines<'s> {
    pub fn new(store: &'s dyn RunHostStore, in_turn: bool) -> WaitingLines<'s> {
        WaitingLines { store, lines: HashMap::new(), in_turn }
    }

    /// What `listen` makes of `arrival`, delivered for `credential`; None
    /// when it is not the listen's to judge. A listen that calls a host
    /// function takes an arrival in its turn: one that would fire, or that
    /// asks the host, waits while an earlier arrival does; the arrival first
    /// in line is judged, and leaves the line once it is.
    pub async fn judge(&mut self, listen: &Listen, arrival: &ArrivalIn, credential: Option<&str>, asking: Asking<'_, impl AnswersHost>) -> Result<Option<Judgement>, String> {
        let Some(first) = listen.verdict(arrival, credential, asking.now_ms) else { return Ok(None) };
        if !listen.asks_host() {
            return Ok(Some(Judgement::of(first)));
        }
        let pipeline = listen.pipeline();
        let receipt = receipt_of(arrival);
        // One that skips or cannot be judged before anything is asked runs
        // nothing, so there is no order for it to keep.
        let in_turn = self.in_turn && matches!(first, Verdict::Fires | Verdict::Asks(_));
        let line = self.line(&pipeline)?;
        if in_turn && line.first().is_some_and(|head| *head != receipt) {
            if !line.contains(&receipt) {
                line.push(receipt);
            }
            return Ok(Some(Judgement::Unjudged(Unjudgement { reason: WAITING_BEHIND.into(), waiting: true })));
        }
        let judgement = match first {
            Verdict::Asks(_) => Judgement::of(listen.fires(arrival, credential, asking).await.unwrap_or(first)),
            decided => Judgement::of(decided),
        };
        let line = self.line(&pipeline)?;
        match &judgement {
            Judgement::Unjudged(Unjudgement { waiting: true, .. }) => {
                if !line.contains(&receipt) {
                    line.push(receipt);
                }
            }
            _ => {
                if let Some(at) = line.iter().position(|kept| *kept == receipt) {
                    line.remove(at);
                    self.store.judged_unjudged(&pipeline, &receipt).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(Some(judgement))
    }

    fn line(&mut self, pipeline: &str) -> Result<&mut Vec<String>, String> {
        if !self.lines.contains_key(pipeline) {
            let line = waiting_of(self.store, Some(pipeline))?.remove(pipeline).unwrap_or_default().into_iter().map(|fact| fact.arrival).collect();
            self.lines.insert(pipeline.to_string(), line);
        }
        Ok(self.lines.get_mut(pipeline).expect("read just now"))
    }
}

/// The arrivals each listen waits on (for `pipeline` alone when it names
/// one), oldest first, each once, as its earliest fact keeps it.
fn waiting_of(store: &dyn RunHostStore, pipeline: Option<&str>) -> Result<HashMap<String, Vec<UnjudgedArrival>>, String> {
    const PAGE: i64 = 500;
    let mut lines: HashMap<String, Vec<UnjudgedArrival>> = HashMap::new();
    let mut last: Option<UnjudgedArrival> = None;
    loop {
        let after = last.as_ref().map(|last| UnjudgedAfter { at: &last.at, pipeline: &last.pipeline, arrival: &last.arrival, attempt: last.attempt });
        let page = store.unjudged_arrivals(&UnjudgedPage { after, pipeline, waiting: true, limit: PAGE }).map_err(|e| e.to_string())?;
        let done = page.len() < usize::try_from(PAGE).unwrap_or(usize::MAX);
        for fact in &page {
            let line = lines.entry(fact.pipeline.clone()).or_default();
            if !line.iter().any(|kept| kept.arrival == fact.arrival) {
                line.push(fact.clone());
            }
        }
        last = page.into_iter().last();
        if done {
            return Ok(lines);
        }
    }
}

/// How long a listen waits before judging again what it waits on
/// (`LF_UNJUDGED_RETRY_MS`, else 30 seconds).
pub fn retry_every() -> std::time::Duration {
    let ms = std::env::var("LF_UNJUDGED_RETRY_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|ms| *ms > 0).unwrap_or(30_000);
    std::time::Duration::from_millis(ms)
}

/// The work row that judges again what one listen waits on.
pub const JUDGE_WAITING_WORK_KIND: &str = "judge_waiting";

/// The listen `pipeline`'s `judge_waiting` row, due a retry from now: one
/// per listen (a later one keeps the earlier due time), so one listen's
/// trouble holds no other's line.
pub fn judging_row(pipeline: &str) -> NewWork {
    NewWork {
        kind: JUDGE_WAITING_WORK_KIND.into(),
        key: format!("{JUDGE_WAITING_WORK_KIND}:{pipeline}"),
        payload: Js::Obj(crate::obj! { "pipeline" => Js::str(pipeline) }),
        due_at: Some(iso(i64::try_from(retry_every().as_millis()).unwrap_or(i64::MAX))),
        team_id: None,
    }
}

/// What judging a listen's line again came to.
pub struct Rejudged {
    /// A line for each arrival judged, let go, or still waiting.
    pub said: Vec<String>,
    /// The runs the arrivals judged now fired, run here.
    pub outcomes: Vec<RunOutcome>,
    /// Its first arrival still waits: its row is due again a retry later.
    pub waits: bool,
}

/// Judge again what the listen `pipeline` waits on, oldest first: each
/// arrival its host now answers is judged (a run it fires runs here, as a
/// replay's does), and the next is judged after it; the first its host
/// still cannot answer, or whose delivery its module cannot be reached to
/// read again, ends the turn, the rest waiting behind it. One that can
/// never be judged again (its delivery forgotten, or refused by its module)
/// is let go, said as unjudged with the reason, so the arrivals behind it
/// are not held for ever. A listen edited since keeps its facts under the
/// pipeline it had: they are left to be forgotten with their deliveries.
pub async fn judge_waiting(session: &Session, pipeline: &str) -> Result<Rejudged, String> {
    let set = session.file_set();
    let mut rejudged = Rejudged { said: Vec::new(), outcomes: Vec::new(), waits: false };
    let Some(listen) = set.listens.iter().find(|listen| listen.pipeline() == pipeline) else { return Ok(rejudged) };
    for fact in waiting_of(&*session.store, Some(pipeline))?.remove(pipeline).unwrap_or_default() {
        match retry_one(session, Retrying { set: &set, listen, fact: &fact }).await? {
            Retried::Waiting(said) => {
                rejudged.said.push(said);
                rejudged.waits = true;
                break;
            }
            Retried::Judged { said, outcomes } => {
                rejudged.said.push(said);
                rejudged.outcomes.extend(outcomes);
            }
        }
    }
    Ok(rejudged)
}

/// What judging one waiting arrival again came to.
enum Retried {
    /// It still waits, and so does what is behind it: why.
    Waiting(String),
    /// Judged, or let go: what is said of it, and the runs it fired.
    Judged { said: String, outcomes: Vec<RunOutcome> },
}

/// One arrival a listen waits on, judged again.
struct Retrying<'r> {
    set: &'r FileSet,
    listen: &'r Listen,
    /// Its earliest fact: the arrival, its delivery and what landed.
    fact: &'r UnjudgedArrival,
}

async fn retry_one(session: &Session, retrying: Retrying<'_>) -> Result<Retried, String> {
    let Retrying { set, listen, fact } = retrying;
    let named = format!("{}:{}", listen.file, listen.movement_name);
    let arrival = fact.arrival.as_str();
    // Never judged now, it is said as unjudged once more, with the reason,
    // and waits no more.
    let let_go = |why: String| -> Result<Retried, String> {
        let attempt = next_attempt(session, listen, std::slice::from_ref(&fact.arrival))?;
        let again = UnjudgedArrival { reason: why.clone(), at: iso(0), attempt, waiting: false, ..fact.clone() };
        session.keep_unjudged(&again)?;
        session.store.judged_unjudged(&listen.pipeline(), arrival).map_err(|e| e.to_string())?;
        Ok(Retried::Judged { said: format!("{named}: the arrival {arrival} waited for its host and {why}: it is let go, and runs nothing"), outcomes: Vec::new() })
    };
    let Some(delivery_id) = fact.delivery_id.as_deref() else { return let_go("names no kept delivery".into()) };
    let Some(row) = session.store.delivery(delivery_id).map_err(|e| e.to_string())? else { return let_go(format!("its delivery {delivery_id} is no longer kept")) };
    let capture = match capture_of(session, &row) {
        Ok(capture) => capture,
        Err(why) => return let_go(why),
    };
    let doors = LfDoors::of_session(session, EventSink::Queue, &|| {});
    let reread = match reread(&doors, &row, capture).await {
        Ok(reread) => reread,
        Err(Unanswered::Unreachable(why)) => {
            let module = fact.adapter.as_deref().unwrap_or("its module");
            return Ok(Retried::Waiting(format!("{named}: the arrival {arrival} still waits: {module} could not be reached to read delivery {delivery_id} again ({why})")));
        }
        Err(Unanswered::Refused(why)) => return let_go(format!("its module could not read delivery {delivery_id} again ({why})")),
    };
    let mut doors = LfDoors::of_session(session, EventSink::Queue, &|| {});
    doors.listens = vec![listen.clone()];
    doors.replaying = true;
    let landed: Vec<ArrivalIn> = doors.landed_for_listens(&reread.adapter, reread.credential.as_deref(), &reread.arrivals).into_iter().filter(|a| listen.is_on(&reread.adapter, &a.edge) && receipt_of(a) == arrival).collect();
    if landed.is_empty() {
        return let_go(format!("delivery {delivery_id} no longer brings it"));
    }
    let replay = Replay { of: &row.id, attempt: next_attempt(session, listen, std::slice::from_ref(&fact.arrival))?, again: false };
    let minted = doors.mint_runs(&reread.adapter, reread.install.as_deref(), reread.credential.as_deref(), &landed).await?;
    if let Some(one) = minted.unjudged.iter().find(|one| one.why.waiting) {
        return Ok(Retried::Waiting(format!("{named}: the arrival {arrival} still waits for its host ({})", one.why.reason)));
    }
    let delivered = Delivered { id: Some(&row.id), credential: reread.credential.as_deref(), replay: Some(replay), ..Delivered::default() };
    if let Some(one) = minted.unjudged.first() {
        session.note_unjudged(set, &reread.adapter, listen, &landed[one.arrival], &delivered, &one.why)?;
        let said = format!("{named}: the arrival {arrival} waited for its host, and still cannot be judged ({}): reported again, attempt {}", one.why.reason, replay.attempt);
        return Ok(Retried::Judged { said, outcomes: Vec::new() });
    }
    if minted.runs.as_array().is_none_or(<[Js]>::is_empty) {
        return Ok(Retried::Judged { said: format!("{named}: the arrival {arrival} waited for its host, and its filter does not take it: it runs nothing"), outcomes: Vec::new() });
    }
    let came_for = Delivered { minted: Some(&minted.runs), ..delivered };
    let fired = fire_replay(session, &doors, ReplayRun { adapter: &reread.adapter, row: &row, landed: &landed, came_for, waits: minted.waits }).await?;
    let ran: Vec<String> = fired.outcomes.iter().map(|o| format!("run {} {}", o.run_id, o.status)).collect();
    let said = match ran.is_empty() {
        true => format!("{named}: the arrival {arrival} waited for its host, and had run before: nothing ran again"),
        false => format!("{named}: the arrival {arrival} waited for its host, and is judged now: {}", ran.join(", ")),
    };
    Ok(Retried::Judged { said, outcomes: fired.outcomes })
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use super::*;
    use crate::routing::tests::{Team, said_as, team_listen};

    fn judged(lines: &mut WaitingLines<'_>, listen: &Listen, arrival: &ArrivalIn, team: &Team) -> Judgement {
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        runtime.block_on(lines.judge(listen, arrival, None, Asking { now_ms: 0.0, host: team })).unwrap().unwrap()
    }

    /// Kept as a delivery's judging keeps what it could not judge.
    fn noted(store: &dyn RunHostStore, listen: &Listen, arrival: &ArrivalIn, why: &Unjudgement, at: i64) {
        let fact = UnjudgedArrival {
            pipeline: listen.pipeline(),
            arrival: arrival_receipt_key(&arrival.edge, arrival.key.as_deref(), arrival.identity.as_deref().unwrap_or_default(), arrival.version.as_deref()),
            file: listen.file.clone(),
            movement: listen.movement_name.clone(),
            delivery_id: Some(format!("delivery-{at}")),
            edge: arrival.edge.clone(),
            adapter: Some("talk".into()),
            record_id: None,
            landing: arrival.landing.clone(),
            reason: why.reason.clone(),
            cause: None,
            at: crate::store::iso_at(at),
            attempt: 0,
            waiting: why.waiting,
        };
        assert!(store.note_unjudged(&fact, "2026-01-01T00:00:00.000Z").unwrap());
    }

    fn waiting(why: Judgement) -> Unjudgement {
        match why {
            Judgement::Unjudged(why @ Unjudgement { waiting: true, .. }) => why,
            other => panic!("expected it to wait, got {other:?}"),
        }
    }

    #[test]
    fn later_arrivals_wait_behind_an_unjudged_one() {
        let dir = std::env::temp_dir().join(format!("lf-waiting-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store: Rc<dyn RunHostStore> = Rc::new(crate::store::Store::open(&dir.join("state.db")).unwrap());
        let listen = team_listen();
        // As text, m10 sorts before m8 and m9.
        let (first, second, third) = (said_as("m8", "ann", "ann@acme.com"), said_as("m9", "bob", "bob@acme.com"), said_as("m10", "ann", "ann@acme.com"));
        let t0 = crate::limiter::now_ms();

        // The host is out of reach: the first waits for it, and the two
        // after it wait behind it, asking nothing, so in the same instant.
        let down = Team { down: true, ..Team::default() };
        let mut lines = WaitingLines::new(&*store, true);
        let why = waiting(judged(&mut lines, &listen, &first, &down));
        assert_ne!(why.reason, WAITING_BEHIND);
        noted(&*store, &listen, &first, &why, t0);
        for arrival in [&second, &third] {
            let why = waiting(judged(&mut lines, &listen, arrival, &down));
            assert_eq!(why.reason, WAITING_BEHIND);
            noted(&*store, &listen, arrival, &why, t0);
        }
        assert_eq!(down.asked.borrow().len(), 1, "only the first asked its host");
        // One its local terms skip runs nothing, so it keeps no order.
        assert_eq!(judged(&mut lines, &listen, &said_as("m4", "bot", "ann@acme.com"), &down), Judgement::Skips { hop: 0, reason: None });

        // Another process, the host back: still in their turn.
        let up = Team { members: vec!["ann@acme.com", "bob@acme.com"], ..Team::default() };
        let mut lines = WaitingLines::new(&*store, true);
        assert_eq!(waiting(judged(&mut lines, &listen, &second, &up)).reason, WAITING_BEHIND, "the second is not judged before the first");
        assert_eq!(waiting(judged(&mut lines, &listen, &said_as("m5", "ann", "ann@acme.com"), &up)).reason, WAITING_BEHIND, "nor is a new one");
        let order: Vec<String> = waiting_of(&*store, None).unwrap().remove(&listen.pipeline()).unwrap().into_iter().map(|fact| fact.arrival).collect();
        assert_eq!(order, ["Messages::m8:", "Messages::m9:", "Messages::m10:"], "kept in the order they came");
        for arrival in [&first, &second, &third] {
            assert_eq!(judged(&mut lines, &listen, arrival, &up), Judgement::Fires);
        }
        let left = waiting_of(&*store, None).unwrap();
        assert!(left.get(&listen.pipeline()).is_none(), "judged, none waits: {left:?}");
        let _ = std::fs::remove_dir_all(dir);
    }
}

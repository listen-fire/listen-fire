//! What a flow waits on (run.ts `interpretAwait`).
//!
//! - **`sleep`**: a timer park (crate::park).
//! - **`until(condition, every)`**: the condition tested now; met, its value
//!   is bound and the run goes on; else a timer park the timer resume
//!   re-enters to test it again (`until: true`).
//! - **A combinator**: crate::combinator.
//! - **An edge of a record**: read off the wait the record opened when it
//!   entered the run (crate::waits), in this order:
//!   1. the record's wait on the edge. A record deleted while the run waits
//!      leaves its wait waiting: nothing arrives on it, so the `await`
//!      parks for good unless a `race` arm beside it settles (a `sleep`).
//!      One the adapter already called gone when its wait opened has no
//!      wait to park on: the `await` parks with nothing that can wake it;
//!   2. the WHERE's parts that read only the run captured, once, when the
//!      await is first reached (re-entered, the values it parked with);
//!   3. a plain `await` on an edge that can be listed takes the first match
//!      the listing holds (`listsFirst`), on its first reach only. Two such
//!      awaits on one record's edge share its wait and both take that first
//!      match: "the existing match, or else the first to arrive";
//!   4. else the wait's arrivals, in log order, each judged and noted: the
//!      first that counts is bound;
//!   5. else the run parks on the wait (`commitAwaitPark`), reads the
//!      arrivals once more, and is woken (`park.wake`) when one landed while
//!      it parked. The resume re-enters the await, which judges again.

use std::rc::Rc;

use movement_parser::ast::{self, AwaitSource, PathHead, PathRoot, UntilCondition};
use movement_parser::lowering::captures::{Scoped as Held, capture, captured_name};
use movement_parser::lowering::expression::{Expression, TraversalStep};
use serde_json::Value as Json;

use crate::bindings::{Binding, Closure, Scope};
use crate::env::{self, Trail, ValueBinding};
use crate::eval::ErrorClass;
use crate::flow::Code;
use crate::host;
use crate::js::{Js, JsObject};
use crate::park::Leaf;
use crate::program::Stamp;
use crate::run::{Address, Failure, Flow, Run, Stop};
use crate::trace::TraceEntry;
use crate::waits::Unwaitable;

/// `UNTIL_DEFAULT_EVERY_MS`: an `until`'s cadence when none is written.
const UNTIL_EVERY_MS: f64 = 3_600_000.0;

/// An await over a list of records: it parks on one record's edge, under
/// one key, and a list has as many as it holds records.
fn over_a_list(root: &str, edge: &str) -> Stop {
    Stop::Thrown(Failure::unsupported(
        &format!("await '{root}-[:{edge}]->' over a list of records"),
        "an await waits on one record's edge; await each record's edge in a flow of its own",
    ))
}

impl Run<'_> {
    /// `interpretAwait`. `path` is the await source's AST path.
    pub(crate) async fn awaiting(&self, source: &AwaitSource, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(), Stop> {
        match source {
            AwaitSource::Until { condition, every, .. } => self.until(condition, every.as_ref(), binding_name, scope, at, &format!("{path}/condition")).await,
            AwaitSource::Sleep { duration, .. } => {
                self.sleep(duration, at, scope, binding_name).await?;
                if let Some(name) = binding_name {
                    scope.declare(name, Binding::Value(ValueBinding { value: Js::Bool(true), trail: Some(Trail::default()), many: false }));
                }
                Ok(())
            }
            AwaitSource::Combinator { combinator, .. } => self.combinator(combinator, binding_name, scope, at, &format!("{path}/combinator")).await,
            AwaitSource::Traversal { head, .. } => self.await_edge(head, binding_name, scope, at, path).await,
        }
    }

    // ── until ──

    /// `interpretUntil`: check now, else re-park on the clock.
    async fn until(&self, condition: &UntilCondition, every: Option<&ast::DurationLiteral>, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(), Stop> {
        let (value, binding) = self.until_condition(condition, scope, at, path).await?;
        if until_met(&value) || self.input.dry_run {
            if let Some(name) = binding_name {
                scope.declare(name, binding);
            }
            return Ok(());
        }
        let address = at.encode();
        if !self.serves("park.sink.commitTimerPark") {
            return Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("await until reached at '{address}' with no park sink — a recurring wait needs the durable trigger-run substrate"),
            )));
        }
        let every_ms = match every {
            Some(every) => crate::park::duration_ms(&every.raw).ok_or_else(|| invalid_duration(&every.raw))?,
            None => UNTIL_EVERY_MS,
        };
        let state = crate::park::park_state(self, &address, None, Leaf::Until, scope).await.map_err(Stop::Thrown)?;
        let now = self.clock_now().await.map_err(Stop::Thrown)?;
        let wake_at = crate::js_date::to_iso_string(now + every_ms);
        let request = host::park::commit_timer_park(self.segment(), &address, self.encode(&state).map_err(Stop::Thrown)?, &wake_at);
        self.ask(request).await.map_err(Stop::Thrown)?;
        self.trace(TraceEntry::Gate { outcome: false });
        Err(Stop::Parked(address))
    }

    /// `evaluateUntilCondition`: a closure (written in place, or a name bound
    /// to one) called once per tick and what it returned; else the
    /// expression's value.
    async fn until_condition(&self, condition: &UntilCondition, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(Js, Binding), Stop> {
        match condition {
            UntilCondition::Closure { closure } => {
                let closure = Rc::new(Closure { code: Code { ast: Rc::new(closure.clone()), path: format!("{path}/closure") }, captured: scope.capture(), self_name: None, file_name: None, by_reference: false });
                self.tick(&closure, at).await
            }
            UntilCondition::Expr { expr } => {
                let trimmed = crate::js::trim(&expr.raw);
                if is_bare_ident(trimmed)
                    && let Some(Binding::Closure(closure)) = scope.resolve(trimmed)
                {
                    return self.tick(&closure, at).await;
                }
                let evaluated = self.evaluate_slot(expr, scope).await?;
                let trail = self.trail_or_none(&evaluated.prov, scope);
                let value = evaluated.value;
                Ok((value.clone(), Binding::Value(ValueBinding { value, trail: Some(trail), many: false })))
            }
        }
    }

    /// `tickClosure`: the condition called, and what it returned.
    async fn tick(&self, closure: &Rc<Closure>, at: &Address) -> Result<(Js, Binding), Stop> {
        let (flow, child) = self.invoke_closure(closure, &[], at).await?;
        let returned = match flow {
            Flow::Returned => child.resolve_own(crate::run::RETURN_SLOT),
            Flow::FellThrough => None,
        };
        let Some(bound) = returned else {
            return Err(Stop::Thrown(Failure::engine("MOVENG_RUNTIME", "an 'until' condition returned nothing — the checker should have caught this".into())));
        };
        let value = match &bound {
            Binding::Value(value) => value.value.clone(),
            other => crate::record::held(other.clone()),
        };
        Ok((value, bound))
    }

    // ── An edge awaited ──

    /// The await on a record's edge (written or read), off the wait it
    /// opened. `path` is the await source's AST path.
    async fn await_edge(&self, head: &PathHead, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(), Stop> {
        let edge = await_edge_name(&head.hops_raw);
        let root = match &head.root {
            Some(PathRoot::Name { name }) => name.clone(),
            _ => String::new(),
        };
        let bound = scope.resolve(&root);
        match bound {
            Some(record @ (Binding::Handle(_) | Binding::Event | Binding::Landed(_))) => self.await_wait(head, &root, &record, &edge, binding_name, scope, at, path).await,
            // `c = only(e-[k:Checks]->)`: the one record a value holds is
            // awaited on as that record.
            Some(Binding::Value(value)) if let Some(record) = crate::record::binding_of(&value.value) => match record {
                Binding::Positions(_) => Err(over_a_list(&root, &edge)),
                record @ (Binding::Handle(_) | Binding::Event | Binding::Landed(_)) => self.await_wait(head, &root, &record, &edge, binding_name, scope, at, path).await,
                other => Err(Stop::Thrown(Failure::unsupported(
                    &format!("await '{root}-[:{edge}]->'"),
                    &format!("'{root}' holds {}, which has no awaitable edges", crate::record::describe(&other)),
                ))),
            },
            // `x = e-[a:Attachments]-> { return a }`, then an await on `x`.
            Some(Binding::Positions(_)) => Err(over_a_list(&root, &edge)),
            Some(Binding::Value(value)) if matches!(value.value, Js::Array(_)) => Err(over_a_list(&root, &edge)),
            // A pick that found nothing (`c = first(…)`, null): what the
            // graph answered, not a form the check could refuse.
            Some(Binding::Value(value)) if value.value.is_nullish() => Err(Stop::Thrown(Failure::engine(
                "MOVENG_RUNTIME",
                format!("await '{root}-[:{edge}]->': '{root}' holds no record (it is null), so there is no record to await an edge of"),
            ))),
            _ => Err(Stop::Thrown(Failure::unsupported(
                &format!("await '{root}-[:{edge}]->'"),
                "await needs a written record handle as its head (e.g. an ask written with `write asks-[:Check]->`)",
            ))),
        }
    }

    /// The await on a record's edge, off the wait the record opened when it
    /// entered the run (crate::waits); the order is the module doc's.
    #[allow(clippy::too_many_arguments)] // the await's head, its record and edge, then where it binds and runs
    async fn await_wait(&self, head: &PathHead, root: &str, record: &Binding, edge: &str, binding_name: Option<&str>, scope: &Rc<Scope>, at: &Address, path: &str) -> Result<(), Stop> {
        let waited = match self.waited(record).await.map_err(Stop::Thrown)? {
            Ok(waited) => waited,
            // A rehearsed write: no real record to await; it settles empty.
            Err(Unwaitable::Rehearsed) => {
                if let Some(name) = binding_name {
                    scope.declare(name, null_value());
                }
                return Ok(());
            }
            Err(Unwaitable::NoId { adapter_type }) => {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("await '{root}-[:{edge}]->': the '{adapter_type}' adapter answered '{root}' with no record id, so there is no record to await an edge of"),
                )));
            }
        };
        // An arrival's landing is read through the adapter itself.
        let raw = Rc::new(crate::traverse::Read { raw: true, ..(*waited.read).clone() });
        // A rehearsal opens no wait: its await binds the empty landing at once.
        if self.input.dry_run {
            if let Some(name) = binding_name {
                scope.declare(name, awaited_landing(&waited.adapter_type, &raw, &Js::object(JsObject::new()), None));
            }
            return Ok(());
        }
        let address = at.encode();
        let reentered = self.reentered_at(&address);
        let wait_id = match self.waits_of(&waited.holder).get(edge).cloned() {
            Some(id) => id,
            None if !self.serves("park.waits.open") => {
                return Err(Stop::Thrown(Failure::unsupported("await (a wait)", "this run has no wait sink — an await needs the durable trigger-run substrate")));
            }
            None => {
                return Err(Stop::Thrown(Failure::engine(
                    "MOVENG_RUNTIME",
                    format!("no wait was registered when '{root}' entered the run — the checker should have stamped it"),
                )));
            }
        };
        let step = crate::traverse::head_step(head).map_err(|why| Stop::Thrown(Failure::engine("MOVENG_RUNTIME", format!("await '{root}{}': {why}", head.hops_raw))))?;
        let alias = step.alias.clone();
        let written = if has_where(&head.hops_raw) { step.expression_filter.as_deref().cloned() } else { None };
        // What the WHERE reads of the run, captured once: on re-entry, the
        // values it parked with, whatever the records hold now.
        let (filter, captured) = match written {
            None => (None, reentered.clone().unwrap_or_default()),
            Some(written) => {
                let captured = capture(&written, alias.as_deref(), &|name| held_as(scope, name));
                let values = match &reentered {
                    Some(values) => values.clone(),
                    None => {
                        let mut values = Vec::with_capacity(captured.holes.len());
                        for hole in &captured.holes {
                            values.push(self.evaluate_scoped(&hole.expression, scope, None, None).await?.value);
                        }
                        values
                    }
                };
                (Some(captured.filter), values)
            }
        };
        let judging = scope.child();
        for (index, value) in captured.iter().enumerate() {
            judging.declare(captured_name(index), Binding::Value(ValueBinding { value: value.clone(), trail: Some(Trail::default()), many: false }));
        }
        let judge = Judge { wait_id: &wait_id, filter: filter.as_ref(), alias: alias.as_deref(), scope: &judging, adapter_type: &waited.adapter_type, read: &waited.read, raw: &raw };
        if reentered.is_none() && self.checked.stamp(path) == Some(Stamp::ListsFirst) {
            let mut listing = step.clone();
            listing.expression_filter = filter.clone().map(Box::new);
            let span = crate::env::js_of_serialized(&head.span);
            let listed = self.walk_adapter(&waited.position, &waited.read, &[TraversalStep::Edge(listing)], root, &judging, &span).await.map_err(Stop::Thrown)?;
            if let Some(first) = listed.into_iter().next() {
                if let Some((identity, version)) = listed_identity(&waited, &first, edge) {
                    self.note_arrival(&wait_id, &identity, version.as_deref(), true).await.map_err(Stop::Thrown)?;
                }
                if let Some(name) = binding_name {
                    scope.declare(name, Binding::Landed(first));
                }
                return Ok(());
            }
        }
        if let Some(landing) = self.judge_arrivals(&judge).await? {
            if let Some(name) = binding_name {
                scope.declare(name, landing);
            }
            return Ok(());
        }
        if !self.serves("park.sink.commitAwaitPark") {
            return Err(Stop::Thrown(Failure::unsupported("await (a durable park)", "this run has no park sink — an await needs the durable trigger-run substrate")));
        }
        let state = crate::park::park_state(self, &address, None, Leaf::Await { captured: &captured }, scope).await.map_err(Stop::Thrown)?;
        let request = host::park::commit_await_park(self.segment(), &address, self.encode(&state).map_err(Stop::Thrown)?, &wait_id);
        self.ask(request).await.map_err(Stop::Thrown)?;
        // What landed while the run parked: the park and the log never
        // interleave, so either the log woke the park or this read sees it.
        let again = self.arrived_while_parking(&judge).await;
        self.wake_if_arrived(&wait_id, again).await?;
        self.trace(TraceEntry::Gate { outcome: false });
        Err(Stop::Parked(address))
    }

    /// The captured values of the await a resume re-enters at `address`,
    /// taken once.
    fn reentered_at(&self, address: &str) -> Option<Vec<Js>> {
        let mut reentered = self.reentered_await.borrow_mut();
        match reentered.as_ref() {
            Some((at, _)) if at == address => reentered.take().map(|(_, values)| values),
            _ => None,
        }
    }

    /// The wait's arrivals in log order, each judged and noted: the first
    /// that counts.
    async fn judge_arrivals(&self, judge: &Judge<'_>) -> Result<Option<Binding>, Stop> {
        let logged = self.wait_arrivals(judge.wait_id).await.map_err(Stop::Thrown)?;
        for arrival in &logged.arrivals {
            let landing = arrival_landing(judge, &arrival.landing);
            let matched = self.arrival_matches(judge, &landing).await?;
            if self.note_arrival(judge.wait_id, &arrival.identity, arrival.version.as_deref(), matched).await.map_err(Stop::Thrown)? {
                return Ok(Some(landing));
            }
        }
        Ok(None)
    }

    /// Whether an arrival the WHERE takes landed. Noted by the resume, not
    /// here.
    async fn arrived_while_parking(&self, judge: &Judge<'_>) -> Result<bool, Stop> {
        let logged = self.wait_arrivals(judge.wait_id).await.map_err(Stop::Thrown)?;
        for arrival in &logged.arrivals {
            if self.arrival_matches(judge, &arrival_landing(judge, &arrival.landing)).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The WHERE, its captured parts read from their names, over one
    /// arrival's landing.
    async fn arrival_matches(&self, judge: &Judge<'_>, landing: &Binding) -> Result<bool, Stop> {
        let (Some(filter), Binding::Landed(landed)) = (judge.filter, landing) else { return Ok(true) };
        let at = judge.scope.child();
        if let Some(alias) = judge.alias {
            at.declare(alias, landing.clone());
        }
        let value = self.evaluate_scoped(filter, &at, None, Some(crate::run::Scoped::Landed(landed.clone()))).await?.value;
        Ok(value.truthy())
    }

    /// A wait's run woken when something landed while it parked. A re-read
    /// that cannot answer leaves the run parked, and a wake that cannot be
    /// queued leaves the park as durable as before: both logged. A re-read
    /// that met a limit ends the segment, as a limit anywhere does.
    async fn wake_if_arrived(&self, wait_id: &str, arrived: Result<bool, Stop>) -> Result<(), Stop> {
        let fields = |error: String| {
            let mut fields = serde_json::Map::new();
            fields.insert("waitId".into(), Json::String(wait_id.into()));
            fields.insert("error".into(), Json::String(error));
            fields
        };
        match arrived {
            Err(stop @ Stop::Thrown(Failure::Limit(_))) => return Err(stop),
            Err(stop) => self.log_with_team("error", "[MovementEngine] await re-read after parking failed; the run stays parked without a wake", fields(stop_message(&stop)), "waitId"),
            Ok(false) => {}
            Ok(true) => {
                if let Err(failure) = self.ask(host::park::wake(self.segment(), wait_id)).await {
                    self.log_with_team("error", "[MovementEngine] await wake after parking could not be queued", fields(failure_message(&failure)), "waitId");
                }
            }
        }
        Ok(())
    }
}

/// `declareAwaitResult`'s position: the landing's fields inline, read
/// through the awaitable adapter itself (no read wrapper).
fn awaited_landing(adapter_type: &str, read: &Rc<crate::traverse::Read>, fields: &Js, record_type: Option<Js>) -> Binding {
    let position = env::object_of(vec![
        ("adapterType", Js::str(adapter_type)),
        ("recordType", record_type.unwrap_or_else(|| Js::str("Response"))),
        ("identity", env::object_of(vec![("kind", Js::str("unstable")), ("data", fields.clone())])),
    ]);
    Binding::Landed(Rc::new(crate::bindings::Landed::new(position, None, read.clone())))
}

/// What an await on a wait judges arrivals with.
struct Judge<'j> {
    wait_id: &'j str,
    /// The WHERE, its captured parts read from their names in `scope`.
    filter: Option<&'j Expression>,
    alias: Option<&'j str>,
    scope: &'j Rc<Scope>,
    adapter_type: &'j str,
    /// The graph the awaited record was written or read in: an arrival
    /// naming its record is read through it, as a listed member is.
    read: &'j Rc<crate::traverse::Read>,
    /// The adapter itself: an arrival naming no record is read through it.
    raw: &'j Rc<crate::traverse::Read>,
}

/// A logged arrival's landing (`{recordId?, recordType?, fields}`) as the
/// record an await binds. One naming its record is that record, as the
/// listing would have landed it, so a walk, a write or an `await` off it
/// reaches it whichever way it was bound.
fn arrival_landing(judge: &Judge<'_>, landing: &Js) -> Binding {
    landing_binding(judge.adapter_type, landing, judge.read, judge.raw)
}

/// A landing (`{recordId?, recordType?, fields}`) as the record it binds: one
/// naming its record read through `read`, the graph it lands in; one naming
/// none read through `raw`, the adapter itself. A wait binds what lands on
/// its edge so, and a run fired by an arrival its parameter.
pub(crate) fn landing_binding(adapter_type: &str, landing: &Js, read: &Rc<crate::traverse::Read>, raw: &Rc<crate::traverse::Read>) -> Binding {
    let fields = match crate::unique::get(landing, "fields") {
        fields @ Js::Object(_) => fields,
        _ => Js::object(JsObject::new()),
    };
    let record_type = match crate::unique::get(landing, "recordType") {
        record_type @ Js::String(_) => Some(record_type),
        _ => None,
    };
    match crate::unique::get(landing, "recordId") {
        Js::String(record_id) if !record_id.is_empty() => {
            let position = crate::traverse::stable_position(Js::str(adapter_type), record_type.unwrap_or_else(|| Js::str("Response")), Js::String(record_id), fields);
            Binding::Landed(Rc::new(crate::bindings::Landed::new(position, None, read.clone())))
        }
        _ => awaited_landing(adapter_type, raw, &fields, record_type),
    }
}

/// A listed member's identity and version, as the edge declares them (its
/// record id where it declares no identity): what a later arrival of the same
/// member is noted under.
fn listed_identity(waited: &crate::waits::Waited, member: &crate::bindings::Landed, edge: &str) -> Option<(String, Option<String>)> {
    let position = member.position();
    let data = crate::traverse::position_data(&position);
    let declared = match crate::waits::edge_schema(&waited.read, waited.record_type.as_deref(), edge) {
        crate::waits::Lookup::Found(schema) => Some(schema),
        _ => None,
    };
    let field = |name: Option<&String>| match name.map(|name| crate::unique::get(&data, name)) {
        Some(Js::Undefined | Js::Null) | None => None,
        Some(value) => Some(value.to_js_string()),
    };
    let identity = field(declared.and_then(|d| d.identity.as_ref())).or_else(|| match crate::traverse::record_id(&position) {
        Js::Undefined => None,
        id => Some(id.to_js_string()),
    })?;
    Some((identity, field(declared.and_then(|d| d.version.as_ref()))))
}

/// What a name read in a wait's WHERE is, where the wait is reached.
fn held_as(scope: &Scope, name: &str) -> Held {
    match scope.resolve(name) {
        None => Held::Free,
        Some(Binding::Instance(_)) => Held::Connection,
        Some(_) => Held::Run,
    }
}

fn null_value() -> Binding {
    Binding::Value(ValueBinding { value: Js::Null, trail: Some(Trail::default()), many: false })
}

/// `untilConditionMet`: identity against true, with a stringified fallback
/// for sources that hand booleans back as `"true"`, never against a node.
fn until_met(value: &Js) -> bool {
    match value {
        Js::Bool(true) => true,
        Js::Undefined | Js::Null | Js::Object(_) | Js::Array(_) | Js::Record(_) => false,
        other => other.to_js_string() == "true",
    }
}

/// `BARE_IDENT`.
fn is_bare_ident(text: &str) -> bool {
    let mut chars = text.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `awaitEdgeName`: the edge name of an awaited hop, `-[:Response]->` and
/// `-[got:Response]->` alike, a backtick-quoted name unwrapped.
pub(crate) fn await_edge_name(hops_raw: &str) -> String {
    let inner = hops_raw.strip_prefix("-[").unwrap_or(hops_raw);
    let inner = match inner.trim_end().strip_suffix("]->") {
        Some(stripped) => stripped,
        None => inner,
    };
    let after = match inner.find(':') {
        Some(colon) => &inner[colon + 1..],
        None => inner,
    };
    let after = crate::js::trim(after);
    let name = if let Some(rest) = after.strip_prefix('`')
        && let Some(end) = rest.find('`')
        && end > 0
    {
        &rest[..end]
    } else {
        let end = after.find(|c: char| c.is_whitespace() || c == ']').unwrap_or(after.len());
        if end == 0 { after } else { &after[..end] }
    };
    crate::js::trim(name).to_string()
}

/// `/\bWHERE\b/i`.
fn has_where(hops_raw: &str) -> bool {
    let upper = hops_raw.to_ascii_uppercase();
    let bytes = upper.as_bytes();
    let word = |i: usize| bytes.get(i).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
    upper.match_indices("WHERE").any(|(i, _)| (i == 0 || !word(i - 1)) && !word(i + 5))
}

fn invalid_duration(raw: &str) -> Stop {
    Stop::Thrown(Failure::Engine {
        class: ErrorClass::Error,
        message: format!("invalid duration literal '{raw}' — use unit-suffixed literals like 4h, 2d, 90m, 1h30m"),
    })
}

fn failure_message(failure: &Failure) -> String {
    match failure {
        Failure::Engine { message, .. } => message.clone(),
        Failure::Host(error) => error.message().to_string(),
        other => format!("{other:?}"),
    }
}

fn stop_message(stop: &Stop) -> String {
    match stop {
        Stop::Thrown(failure) => failure_message(failure),
        _ => "the re-check did not end".into(),
    }
}


//! A run's waits on listenable edges, held on the host as rows
//! (`park.waits`, docs/contracts/host-families.md).
//!
//! - **Opened where a record enters.** The checker stamps every place a
//!   record of an awaited type enters the run (`opensWaits`, crate::program):
//!   a write's result just before the write, a read's result as it is read,
//!   a block head's landings, a function's or a closure's parameter, the
//!   trigger's record when the run starts. There the run takes the arrival
//!   log's mark (before the write or the read), asks the record's adapter
//!   which key names each record's edge (`awaitKeys`, one call per adapter
//!   and edge), and opens one wait per key reading the arrivals logged after
//!   the mark. So an arrival that lands while the record enters (a press
//!   during the write) still counts. A record that already waits on an edge
//!   keeps that wait: an entry opens a wait once, at its first mark.
//! - **A wait is kept on the record** (`Handle.waits`, `Landed.waits`, the
//!   run's for its trigger), by edge, and parks with it.
//! - **Read at the `await`** (crate::awaits): the arrivals after the mark not
//!   yet judged, in log order, each judged by the WHERE and noted; the first
//!   that counts is bound.
//! - **A lazy binding opens nothing where it is assigned:** its records
//!   enter where a stamped entry reads them (an `await` only takes a name
//!   holding one record, so they always reach one).

use std::collections::BTreeMap;
use std::rc::Rc;

use movement_parser::ast::MovementParam;
use serde_json::Value as Json;

use crate::bindings::{Binding, Handle, Landed, Scope};
use crate::host;
use crate::js::{Js, JsObject};
use crate::program::Stamp;
use crate::run::{Failure, Run, Stop};
use crate::traverse::Read;
use crate::unique::get;

/// A record's waits, by edge: the host's wait row for each. A record the
/// adapter said was gone when its wait opened has a wait all the same, one
/// opened without a key: nothing arrives on it, and an `await` on it parks
/// where nothing can wake it (the host strands it).
pub(crate) type Waits = BTreeMap<String, String>;

/// Where an entry's waits open from: the edges stamped there, and the mark
/// taken before the record entered.
#[derive(Debug, Clone)]
pub(crate) struct Entry {
    edges: Vec<String>,
    since: i64,
}

/// Where each parameter of a call enters, by index (none where no wait opens).
#[derive(Debug, Clone, Default)]
pub(crate) struct ParamEntries(Vec<Option<Entry>>);

impl ParamEntries {
    fn of(stamped: Vec<Option<Vec<String>>>, since: i64) -> ParamEntries {
        ParamEntries(stamped.into_iter().map(|edges| edges.map(|edges| Entry { edges, since })).collect())
    }

    /// The mark its parameters entered at, where any opens a wait.
    pub(crate) fn since(&self) -> Option<i64> {
        self.0.iter().flatten().map(|entry| entry.since).next()
    }
}

/// One record the waits of an entry, or an `await`, are about.
pub(crate) struct Waited {
    pub(crate) adapter_type: String,
    pub(crate) record_id: String,
    /// The data its write answered, or its read landed with.
    pub(crate) head_data: Js,
    /// Its type, as its system names it.
    pub(crate) record_type: Option<String>,
    /// Where a walk off it starts.
    pub(crate) position: Js,
    /// The graph it was written or read in.
    pub(crate) read: Rc<Read>,
    pub(crate) holder: Holder,
}

/// Where a record's waits are kept.
#[derive(Clone)]
pub(crate) enum Holder {
    Handle(Rc<Handle>),
    Landed(Rc<Landed>),
    /// The trigger's record: one per run, its waits the run's.
    Event,
}

impl Holder {
    fn same(&self, other: &Holder) -> bool {
        match (self, other) {
            (Holder::Handle(a), Holder::Handle(b)) => Rc::ptr_eq(a, b),
            (Holder::Landed(a), Holder::Landed(b)) => Rc::ptr_eq(a, b),
            (Holder::Event, Holder::Event) => true,
            _ => false,
        }
    }
}

/// A record the run holds that is no record to wait on: a rehearsed write,
/// or a read the adapter answered with no id.
pub(crate) enum Unwaitable {
    Rehearsed,
    NoId { adapter_type: String },
}

impl Run<'_> {
    /// The waits a record holds.
    pub(crate) fn waits_of(&self, holder: &Holder) -> Waits {
        match holder {
            Holder::Handle(handle) => handle.waits.borrow().clone(),
            Holder::Landed(landed) => landed.waits.borrow().clone(),
            Holder::Event => self.event_waits.borrow().clone(),
        }
    }

    fn keep_wait(&self, holder: &Holder, edge: &str, wait: String) {
        let mut waits = match holder {
            Holder::Handle(handle) => handle.waits.borrow_mut(),
            Holder::Landed(landed) => landed.waits.borrow_mut(),
            Holder::Event => self.event_waits.borrow_mut(),
        };
        waits.entry(edge.to_string()).or_insert(wait);
    }

    /// Whether this run opens waits: its host keeps them, and it is no
    /// rehearsal (a rehearsal opens none, and its `await` binds empty).
    fn opens_waits(&self) -> bool {
        !self.input.dry_run && self.serves("park.waits.open")
    }

    /// The arrival log's mark now (`park.waits.mark`).
    pub(crate) async fn mark(&self) -> Result<i64, Failure> {
        let answer = self.ask(host::park::wait_mark(self.segment())).await?;
        answer
            .as_ref()
            .and_then(|a| a.get("mark"))
            .and_then(Json::as_i64)
            .ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("park.waits.mark answered {}, which is not {{ mark: <an integer> }}", shown(answer.as_ref()))))
    }

    /// The edges stamped at `path` as opening waits, and the mark taken now,
    /// before the record enters; none where no wait opens.
    pub(crate) async fn entry_at(&self, path: &str) -> Result<Option<Entry>, Stop> {
        let Some(Stamp::OpensWaits(edges)) = self.checked.stamp(path) else { return Ok(None) };
        if !self.opens_waits() {
            return Ok(None);
        }
        let since = self.mark().await.map_err(Stop::Thrown)?;
        Ok(Some(Entry { edges, since }))
    }

    /// The records `entered` entered at `entry`: their waits open.
    pub(crate) async fn enter(&self, entry: Option<Entry>, entered: &[Binding]) -> Result<(), Stop> {
        let Some(Entry { edges, since }) = entry else { return Ok(()) };
        self.open_waits(entered, &edges, since).await.map_err(Stop::Thrown)
    }

    /// Where a function's or a closure's parameters enter, by index: the
    /// edges stamped on each, and one mark taken now, before the call reads
    /// its arguments, so an arrival between that read and the bind counts.
    /// `declaration` is the path of the movement or the closure declaring them.
    pub(crate) async fn parameter_entries(&self, declaration: &str, count: usize) -> Result<ParamEntries, Stop> {
        let stamped = self.stamped_parameters(declaration, count);
        if stamped.iter().all(Option::is_none) || !self.opens_waits() {
            return Ok(ParamEntries::default());
        }
        let since = self.mark().await.map_err(Stop::Thrown)?;
        Ok(ParamEntries::of(stamped, since))
    }

    /// `parameter_entries` under a mark taken before: a parked collection
    /// op's, for the members its resume starts.
    pub(crate) fn parameter_entries_since(&self, declaration: &str, count: usize, since: i64) -> ParamEntries {
        if !self.opens_waits() {
            return ParamEntries::default();
        }
        ParamEntries::of(self.stamped_parameters(declaration, count), since)
    }

    /// The edges stamped on each parameter as opening waits.
    fn stamped_parameters(&self, declaration: &str, count: usize) -> Vec<Option<Vec<String>>> {
        (0..count)
            .map(|index| match self.checked.stamp(&format!("{declaration}/params/{index}")) {
                Some(Stamp::OpensWaits(edges)) => Some(edges),
                _ => None,
            })
            .collect()
    }

    /// A function's or a closure's parameters, bound in `scope`, entered
    /// where `parameter_entries` took their mark.
    pub(crate) async fn enter_parameters(&self, entries: ParamEntries, params: &[MovementParam], scope: &Rc<Scope>) -> Result<(), Stop> {
        for (param, entry) in params.iter().zip(entries.0) {
            if entry.is_some()
                && let Some(bound) = scope.resolve_own(&param.name)
            {
                self.enter(entry, &[bound]).await?;
            }
        }
        Ok(())
    }

    /// The dispatched movement's parameter: the trigger's record entered
    /// where the delivery that started the run was kept (`triggerMark`), or
    /// else now.
    pub(crate) async fn enter_trigger(&self, declaration: &str, param: &MovementParam, scope: &Rc<Scope>) -> Result<(), Stop> {
        let Some(Stamp::OpensWaits(edges)) = self.checked.stamp(&format!("{declaration}/params/0")) else { return Ok(()) };
        if !self.opens_waits() {
            return Ok(());
        }
        let since = match self.input.trigger_mark {
            Some(mark) => mark,
            None => self.mark().await.map_err(Stop::Thrown)?,
        };
        let Some(bound) = scope.resolve_own(&param.name) else { return Ok(()) };
        self.enter(Some(Entry { edges, since }), &[bound]).await
    }

    /// `open_waits`: for each record, a wait on each of `edges` its type
    /// listens on, reading what arrived after `since`. One `awaitKeys` per
    /// adapter and edge names every record's key; a record that waits on an
    /// edge already keeps its wait.
    pub(crate) async fn open_waits(&self, records: &[Binding], edges: &[String], since: i64) -> Result<(), Failure> {
        let mut waited: Vec<Waited> = Vec::new();
        for record in records {
            self.collect_waited(record, &mut waited).await?;
        }
        // One call per adapter instance and edge, its heads in entry order.
        let mut groups: Vec<(String, String, Vec<&Waited>)> = Vec::new();
        for record in &waited {
            for edge in edges {
                if !listens_on(&record.read, record.record_type.as_deref(), edge) || self.waits_of(&record.holder).contains_key(edge) {
                    continue;
                }
                match groups.iter_mut().find(|(instance, e, _)| *instance == record.read.instance.id && e == edge) {
                    Some((_, _, heads)) => heads.push(record),
                    None => groups.push((record.read.instance.id.clone(), edge.clone(), vec![record])),
                }
            }
        }
        for (_, edge, heads) in groups {
            let keys = self.await_keys(&edge, &heads).await?;
            for (head, key) in heads.into_iter().zip(keys) {
                let wait = self.open_wait(&head.adapter_type, &edge, key.as_deref(), &head.record_id, since).await?;
                self.keep_wait(&head.holder, &edge, wait);
            }
        }
        Ok(())
    }

    /// The records a binding holds to wait on, each once.
    fn collect_waited<'s>(&'s self, binding: &'s Binding, into: &'s mut Vec<Waited>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Failure>> + 's>> {
        Box::pin(async move {
            match binding {
                Binding::Handle(_) | Binding::Landed(_) | Binding::Event => {
                    if let Ok(record) = self.waited(binding).await?
                        && !into.iter().any(|known| known.holder.same(&record.holder))
                    {
                        into.push(record);
                    }
                }
                Binding::Positions(landings) => {
                    for landing in landings {
                        self.collect_waited(landing, into).await?;
                    }
                }
                Binding::Value(value) => {
                    let members = match &value.value {
                        Js::Array(items) => items.items().clone(),
                        other => vec![other.clone()],
                    };
                    for member in members {
                        if let Some(record) = crate::record::binding_of(&member) {
                            self.collect_waited(&record, into).await?;
                        }
                    }
                }
                _ => {}
            }
            Ok(())
        })
    }

    /// A record to wait on: its adapter, id and graph; or why it is none.
    pub(crate) async fn waited(&self, record: &Binding) -> Result<Result<Waited, Unwaitable>, Failure> {
        Ok(match record {
            Binding::Handle(handle) => {
                let written = handle.record();
                let Js::String(record_id) = written.get("externalId") else { return Ok(Err(Unwaitable::Rehearsed)) };
                let adapter_type = written.get("adapterType").to_js_string();
                // The instance the write went through, by its own adapter type.
                let mut instance = (*handle.graph).clone();
                instance.adapter_slug = adapter_type.clone();
                let read = self.instance_read(&Rc::new(instance)).await?;
                let head_data = written.get("resultData");
                let record_type = Some(handle.target_type.clone());
                let position = crate::traverse::stable_position(Js::str(adapter_type.clone()), Js::str(handle.target_type.clone()), Js::String(record_id.clone()), head_data.clone());
                Ok(Waited { adapter_type, record_id: record_id.into_string(), head_data, record_type, position, read, holder: Holder::Handle(handle.clone()) })
            }
            Binding::Landed(landed) => {
                let position = landed.position();
                waited_at(position, landed.read.clone(), Holder::Landed(landed.clone()))
            }
            Binding::Event => {
                let source = self.source.borrow().clone().expect("the event is seeded before the body runs");
                waited_at(source.position.to_js(), source.read.clone(), Holder::Event)
            }
            _ => unreachable!("only a handle, a landed record and the event are waited on"),
        })
    }

    /// `awaitKeys`: the key each head's `edge` waits under, in the heads'
    /// order; None for a head whose record is gone.
    async fn await_keys(&self, edge: &str, heads: &[&Waited]) -> Result<Vec<Option<String>>, Failure> {
        let read = &heads[0].read;
        let adapter_type = &heads[0].adapter_type;
        if !read.instance.has("awaitKeys") {
            return Err(Failure::engine(
                "MOVENG_RUNTIME",
                format!("await '-[:{edge}]->' on '{adapter_type}': the '{adapter_type}' adapter cannot be awaited (it does not offer awaitKeys)"),
            ));
        }
        let listed = heads
            .iter()
            .map(|head| {
                let mut members = vec![("recordId", Js::str(head.record_id.clone()))];
                if !head.head_data.is_nullish() {
                    members.push(("headData", head.head_data.clone()));
                }
                crate::env::object_of(members)
            })
            .collect();
        let args = crate::env::object_of(vec![("edge", Js::str(edge)), ("heads", Js::array(listed))]);
        const CALL: &str = "adapters.call awaitKeys";
        let answer = self.call_adapter(&read.instance, "awaitKeys", args).await?;
        let Js::Array(keys) = &answer else { return Err(Failure::host_answer(CALL, "a list of { key } or { gone: true }, one per head", &answer)) };
        let keys = keys.items().clone();
        if keys.len() != heads.len() {
            return Err(Failure::host_answer(CALL, &format!("{} keys, one per head", heads.len()), &answer));
        }
        keys.iter()
            .map(|key| match (get(key, "key"), get(key, "gone")) {
                (Js::String(key), _) if !key.is_empty() => Ok(Some(key.into_string())),
                (_, Js::Bool(true)) => Ok(None),
                _ => Err(Failure::host_answer(CALL, "{ key } or { gone: true } for each head", key)),
            })
            .collect()
    }

    /// The wait's id; `key` None for a record already gone. `record_id` is
    /// kept with the wait so a host can say which record a stranded wait lost.
    async fn open_wait(&self, adapter_type: &str, edge: &str, key: Option<&str>, record_id: &str, since: i64) -> Result<String, Failure> {
        let answer = self.ask(host::park::open_wait(self.segment(), adapter_type, edge, key, record_id, since)).await?;
        answer
            .as_ref()
            .and_then(|a| a.get("waitId"))
            .and_then(Json::as_str)
            .map(str::to_string)
            .ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("park.waits.open answered {}, which is not {{ waitId }}", shown(answer.as_ref()))))
    }

    /// What a wait has yet to judge, in log order.
    pub(crate) async fn wait_arrivals(&self, wait_id: &str) -> Result<Logged, Failure> {
        const CALL: &str = "park.waits.arrivals";
        let answer = self.ask(host::park::wait_arrivals(self.segment(), wait_id)).await?;
        let answer = match answer {
            Some(answer) => self.wire.decode(&answer).map_err(|e| Failure::engine("MOVENG_RUNTIME", format!("{CALL} answered what does not read: {e}")))?,
            None => Js::Undefined,
        };
        let Js::Array(listed) = get(&answer, "arrivals") else { return Err(Failure::host_answer(CALL, "{ arrivals: [...] }", &answer)) };
        let arrivals = listed
            .items()
            .iter()
            .map(|arrival| {
                let Js::String(identity) = get(arrival, "identity") else { return Err(Failure::host_answer(CALL, "an arrival naming its identity", arrival)) };
                let version = match get(arrival, "version") {
                    Js::String(version) => Some(version.into_string()),
                    _ => None,
                };
                Ok(Arrival { identity: identity.into_string(), version, landing: get(arrival, "landing") })
            })
            .collect::<Result<_, _>>()?;
        Ok(Logged { arrivals })
    }

    /// The wait judged an arrival: whether it counts.
    pub(crate) async fn note_arrival(&self, wait_id: &str, identity: &str, version: Option<&str>, matched: bool) -> Result<bool, Failure> {
        let answer = self.ask(host::park::note_arrival(self.segment(), wait_id, identity, version, matched)).await?;
        answer
            .as_ref()
            .and_then(|a| a.get("counts"))
            .and_then(Json::as_bool)
            .ok_or_else(|| Failure::engine("MOVENG_RUNTIME", format!("park.waits.note answered {}, which is not {{ counts }}", shown(answer.as_ref()))))
    }

    /// The waits a park writes beside a record (and the run's for its
    /// trigger): by edge, its wait's id.
    pub(crate) fn waits_js(waits: &Waits) -> Js {
        let mut object = JsObject::new();
        for (edge, wait) in waits {
            object.set(edge.clone(), Js::str(wait.clone()));
        }
        Js::object(object)
    }
}

/// The waits a park wrote (`waits_js`), read back; None where it wrote
/// something else.
pub(crate) fn waits_of_js(written: &Js) -> Option<Waits> {
    let Js::Object(object) = written else { return None };
    object
        .entries()
        .iter()
        .map(|(edge, wait)| match wait {
            Js::String(id) => Some((edge.clone(), id.to_string())),
            _ => None,
        })
        .collect()
}

/// A logged arrival, as a wait reads it.
pub(crate) struct Arrival {
    pub(crate) identity: String,
    pub(crate) version: Option<String>,
    /// `{recordId?, recordType?, fields}`, or null.
    pub(crate) landing: Js,
}

/// What a wait has yet to judge. A record deleted meanwhile is not among
/// it: its wait keeps waiting.
pub(crate) struct Logged {
    pub(crate) arrivals: Vec<Arrival>,
}

/// A read record to wait on, when its adapter named its id.
fn waited_at(position: Js, read: Rc<Read>, holder: Holder) -> Result<Waited, Unwaitable> {
    let Js::String(record_id) = crate::traverse::record_id(&position) else { return Err(Unwaitable::NoId { adapter_type: read.adapter_type.clone() }) };
    let head_data = crate::traverse::position_data(&position);
    let record_type = crate::traverse::record_type(&position);
    Ok(Waited { adapter_type: read.adapter_type.clone(), record_id: record_id.into_string(), head_data, record_type, position, read, holder })
}

/// Whether a record of `record_type` in `read`'s system listens on `edge`.
/// A record its schema does not describe is taken at its word: the check
/// stamped it.
fn listens_on(read: &Read, record_type: Option<&str>, edge: &str) -> bool {
    match edge_schema(read, record_type, edge) {
        Lookup::Found(schema) => schema.listenable == Some(true),
        Lookup::Undescribed => true,
        Lookup::Missing => false,
    }
}

/// What a system's schema says of an edge off a record type.
pub(crate) enum Lookup<'r> {
    Found(&'r movement_parser::catalog::types::EdgeSchema),
    /// The schema does not describe the record's type.
    Undescribed,
    /// It describes the type, and the type has no such edge.
    Missing,
}

pub(crate) fn edge_schema<'r>(read: &'r Read, record_type: Option<&str>, edge: &str) -> Lookup<'r> {
    let Some(schema) = read.graph.schema.as_ref() else { return Lookup::Undescribed };
    let Some(position) = record_type.and_then(|t| schema.positions.get(t)) else { return Lookup::Undescribed };
    match position.edges.get(edge) {
        Some(found) => Lookup::Found(found),
        None => Lookup::Missing,
    }
}

fn shown(answer: Option<&Json>) -> String {
    answer.map_or_else(|| "nothing".to_string(), Json::to_string)
}

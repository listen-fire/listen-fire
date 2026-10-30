//! Real current-spelling movements run end to end through the typed interface, host family
//! by host family, each compared with the same run through the JSON boundary
//! (crate::begin, answered with the wire a TypeScript or listen-fire host writes by
//! hand), so the typed mapping is held to the JSON route's behaviour rather
//! than to itself.

use std::collections::VecDeque;

use serde_json::{Value as Json, json};

use super::test_time::{Time, block_on};
use super::*;
use crate::executor::{Answer, PendingRequest, Step};

/// One adapter, `world`, with everything the families below need: a monster
/// the event is about, notes that are written under a fuzzy identity, a
/// document holding a file, and tickets whose `Reply` edge is listenable
/// (as are a monster's taunts, a note's comments and a reply's reactions).
const CATALOG: &str = r#"{
  "adapters": { "world": { "constructionArgs": [], "canFire": true, "triggerConfig": ["events"], "schemas": { "": {
    "positions": {
      "Monster": { "properties": { "Name": "text", "Slayer": "text", "Scroll": "file" }, "edges": { "Lair": { "target": "Note" }, "Taunts": { "target": "Reply", "listenable": true, "sequenced": "chronological" } } },
      "Note": { "properties": { "Title": "text", "Attachment": "file" }, "edges": { "Comments": { "target": "Reply", "listenable": true, "sequenced": "chronological" } } },
      "Ticket": { "properties": { "Subject": "text" }, "edges": { "Reply": { "target": "Reply", "listenable": true, "sequenced": "chronological" } } },
      "Reply": { "properties": { "Body": "text" }, "edges": { "Reactions": { "target": "Reply", "listenable": true, "sequenced": "chronological" } } }
    },
    "collections": { "notes": { "target": "Note" }, "tickets": { "target": "Ticket" } },
    "eventPosition": "Monster",
    "supportsInPlaceUpdate": true,
    "writableRoots": {
      "Note": { "fields": { "Title": "text", "Attachment": "file" }, "resultShape": { "externalId": "text", "Title": "text" }, "fuzzyResolution": true },
      "Ticket": { "fields": { "Subject": "text" }, "resultShape": { "externalId": "text" } },
      "Monster": { "fields": { "Slayer": "text" }, "resultShape": { "externalId": "text" } }
    }
  } } } },
  "credentials": {},
  "plugins": {
    "lookup": { "args": ["q"], "requiredArgs": ["q"], "priced": false, "output": { "kind": "value", "type": "text" } },
    "weigh": { "args": ["q"], "requiredArgs": ["q"], "argTypes": { "q": "text" }, "priced": false, "output": { "kind": "value", "type": "number" } },
    "tags": { "args": ["q"], "requiredArgs": ["q"], "argTypes": { "q": "text" }, "priced": false, "output": { "kind": "value", "type": { "kind": "list", "of": "text" } } }
  },
  "models": ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5"]
}"#;

const NOW: &str = "2026-03-12T12:00:00.000Z";

fn input(source: &str) -> RunInput {
    let event = Event::new("world", Data::map([("Name", Data::text("Dragon")), ("Slayer", Data::text("Ada"))]))
        .of_type("monster.slain")
        .about("Monster", "m1");
    RunInput::new(source, event, NOW).function("m").catalog(Catalog::from_json(CATALOG).unwrap())
}

/// The movement's source with `body` as its one function.
fn movement(imports: &str, body: &str) -> String {
    format!("import {{ world }} from adapters\n{imports}game = connect world\nfunction m(monster: <game-[:Monster]->>) {{\n{body}}}\nlisten to game {{ events: [\"monster.slain\"] }} fire m\n")
}

fn errors(source: &str) -> Vec<Problem> {
    check(source, &Catalog::from_json(CATALOG).unwrap(), LANGUAGE_VERSION).into_iter().filter(|p| p.severity == Severity::Error).collect()
}

fn finished(outcome: Result<Outcome, EmbedError>) -> RunResult {
    match outcome.unwrap() {
        Outcome::Finished(ran) => ran,
        other => panic!("not finished: {other:?}"),
    }
}

// ── the world adapter, typed ──

/// The world as a typed host: every call it answers is also recorded.
#[derive(Default)]
struct World {
    calls: Vec<(String, Data)>,
    notes: Vec<(String, String)>,
    /// Replies on each ticket (by id, or `*` on every one) the listing
    /// holds, oldest first.
    replies: Vec<(String, String)>,
    /// Records gone from the world: their waits settle empty.
    gone: Vec<String>,
    /// Fields that read otherwise now than the record held them (a record
    /// changed since the run read it).
    fields_now: Vec<(String, String)>,
    /// Existing notes `resolveEntity` offers as candidates.
    candidates: Vec<(String, String)>,
    updated: Vec<(String, String)>,
}

impl World {
    fn record(id: &str, record_type: &str, fields: Data) -> Data {
        Data::map([("adapterType", Data::text("world")), ("externalId", Data::text(id)), ("recordType", Data::text(record_type)), ("data", fields)])
    }
}

impl Adapters for World {
    fn resolve(&mut self, request: AdapterRequest) -> HostFuture<AdapterInstance> {
        assert_eq!(request.adapter_type, "world");
        ready(Ok(AdapterInstance {
            id: "w".into(),
            methods: ["createRecord", "updateRecord", "resolveEntity", "getFieldValue", "getRelated", "awaitKeys", "describe"].map(String::from).to_vec(),
        }))
    }

    fn call(&mut self, call: AdapterCall) -> HostFuture<AdapterReply> {
        self.calls.push((call.method.clone(), call.args.clone()));
        ready(Ok(match call.method.as_str() {
            "getFieldValue" if call.args.get("fieldId").and_then(Data::as_text) == Some("Scroll") => AdapterReply::ok(Data::File(FileRef::made(
                1,
                FileDescriptor { name: Some("scroll.txt".into()), content_type: Some("text/plain".into()), size: Some(12.0), handle: Some("blob-1".into()) },
            ))),
            "getFieldValue" => {
                let field = call.args.get("fieldId").and_then(Data::as_text).unwrap_or_default().to_string();
                if let Some((_, value)) = self.fields_now.iter().find(|(f, _)| *f == field) {
                    return ready(Ok(AdapterReply::ok(Data::text(value))));
                }
                let data = call.args.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("data")).cloned();
                AdapterReply::ok(data.and_then(|d| d.get(&field).cloned()).unwrap_or(Data::Null))
            }
            // A ticket's replies so far, oldest first.
            "getRelated" if call.args.get("fieldId").and_then(Data::as_text) == Some("Reply") => {
                let ticket = call.args.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("recordId")).and_then(Data::as_text).unwrap_or_default().to_string();
                AdapterReply::ok(Data::List(
                    self.replies
                        .iter()
                        .filter(|(on, _)| *on == ticket || on == "*")
                        .enumerate()
                        .map(|(i, (_, body))| {
                            Data::map([(
                                "position",
                                Data::map([
                                    ("recordType", Data::text("Reply")),
                                    ("identity", Data::map([("kind", Data::text("stable")), ("recordId", Data::text(format!("reply-{i}"))), ("data", Data::map([("Body", Data::text(body))]))])),
                                ]),
                            )])
                        })
                        .collect(),
                ))
            }
            // A ticket's replies wait under its id.
            "awaitKeys" => {
                let heads = match call.args.get("heads") {
                    Some(Data::List(heads)) => heads.clone(),
                    _ => Vec::new(),
                };
                AdapterReply::ok(Data::List(
                    heads
                        .iter()
                        .map(|head| {
                            let id = head.get("recordId").and_then(Data::as_text).unwrap_or_default().to_string();
                            if self.gone.iter().any(|gone| *gone == id || gone == "*") { Data::map([("gone", Data::Bool(true))]) } else { Data::map([("key", Data::text(format!("ticket:{id}")))]) }
                        })
                        .collect(),
                ))
            }
            "describe" => AdapterReply::ok(Data::Null),
            // The monster's lair: one note, its fields on the landing.
            "getRelated" => AdapterReply::ok(Data::List(vec![Data::map([(
                "position",
                Data::map([
                    ("recordType", Data::text("Note")),
                    ("identity", Data::map([("kind", Data::text("stable")), ("recordId", Data::text("note-lair")), ("data", Data::map([("Title", Data::text("Cave"))]))])),
                ]),
            )])])),
            "createRecord" => {
                let record_type = call.args.get("recordType").and_then(Data::as_text).unwrap_or_default().to_string();
                let fields = call.args.get("fields").cloned().unwrap_or(Data::Null);
                let id = format!("{}-{}", record_type.to_lowercase(), self.calls.len());
                if record_type == "Note" {
                    self.notes.push((id.clone(), fields.get("Title").and_then(Data::as_text).unwrap_or_default().to_string()));
                }
                AdapterReply::ok(World::record(&id, &record_type, fields))
            }
            "updateRecord" => {
                let id = call.args.get("externalId").and_then(Data::as_text).unwrap_or_default().to_string();
                let fields = call.args.get("fields").cloned().unwrap_or(Data::Null);
                self.updated.push((id.clone(), fields.get("Title").and_then(Data::as_text).unwrap_or_default().to_string()));
                AdapterReply::ok(World::record(&id, "Note", fields))
            }
            "resolveEntity" => AdapterReply::ok(Data::map([(
                "candidates",
                Data::List(self.candidates.iter().map(|(id, title)| World::record(id, "Note", Data::map([("Title", Data::text(title))]))).collect()),
            )])),
            other => AdapterReply::error("adapter_error", format!("the world does not answer {other}")),
        }))
    }
}

// ── the JSON route ──

fn o(entries: Vec<(&str, Json)>) -> Json {
    json!(["o", entries.into_iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()])
}

fn l(items: Vec<Json>) -> Json {
    json!(["l", items])
}

fn wire_cost(source: &str, microdollars: f64) -> Json {
    l(vec![o(vec![("source", json!(source)), ("microdollars", json!(microdollars))])])
}

type Scripted<'a> = Box<dyn FnMut(&str, &Json) -> Option<Json> + 'a>;

/// The JSON boundary: the segment input the typed route builds, driven by a
/// host that answers each request in the wire's own words.
struct Wire<'a> {
    seen: Vec<(String, Json)>,
    answer: Scripted<'a>,
}

impl<'a> Wire<'a> {
    /// `answer` serves what the test scripts; the world and the plain
    /// families (locks, clock, ids…) are served by `wire_world` after it.
    fn new(mut world: WireWorld, mut answer: impl FnMut(&str, &Json) -> Option<Json> + 'a) -> Wire<'a> {
        Wire { seen: Vec::new(), answer: Box::new(move |label, args| answer(label, args).or_else(|| world.answer(label, args))) }
    }

    /// The outcome of running `input` through the JSON boundary, its segment
    /// entered as `entry` says.
    fn drive(&mut self, input: &RunInput, entry: Entry<'_>, served: &mut Hosts<'_>) -> Outcome {
        let credential_ids = input.catalog.snapshot.credential_names().into_iter().map(|name| (name.to_string(), json!(name))).collect();
        let mut segment = crate::begin(&input_text(&served.serves(), input, &entry, credential_ids, "segment")).unwrap();
        let mut queue = VecDeque::new();
        let mut step = segment.start().unwrap();
        let done = loop {
            match step {
                Step::Done(done) => break done,
                Step::Pending(pending) => {
                    queue.extend(pending);
                    let request: PendingRequest = queue.pop_front().unwrap();
                    let label = format!("{}.{}", request.family, request.method);
                    self.seen.push((label.clone(), request.args.clone()));
                    let answer: Answer = Ok((self.answer)(&label, &request.args));
                    step = segment.answer(request.id, answer).unwrap();
                }
            }
        };
        outcome(&done, &[])
    }

    fn args_of(&self, label: &str) -> Vec<&Json> {
        self.seen.iter().filter(|(seen, _)| seen == label).map(|(_, args)| args).collect()
    }
}

/// The world, answered as a JSON host answers it.
#[derive(Default)]
struct WireWorld {
    candidates: Vec<(String, String)>,
    calls: usize,
    ids: usize,
    /// The positions a call registered, which later calls name by handle.
    positions: std::collections::BTreeMap<u64, Data>,
}

impl WireWorld {
    fn record(id: &str, record_type: &str, fields: Json) -> Json {
        o(vec![("adapterType", json!("world")), ("externalId", json!(id)), ("recordType", json!(record_type)), ("data", fields)])
    }

    fn answer(&mut self, label: &str, args: &Json) -> Option<Json> {
        match label {
            "adapters.resolve" => Some(json!({ "instance": "w", "methods": ["createRecord", "updateRecord", "resolveEntity", "getFieldValue", "getRelated", "awaitKeys", "describe"] })),
            "adapters.call" => {
                self.calls += 1;
                let mut call = Data::from_wire(&args["args"]).unwrap();
                if let Some(handle) = args.get("positionRef").and_then(Json::as_u64) {
                    if let Some(position) = args.get("position") {
                        self.positions.insert(handle, Data::from_wire(position).unwrap());
                    }
                    let rest = match call {
                        Data::Map(entries) => entries,
                        _ => Vec::new(),
                    };
                    call = Data::Map(std::iter::once(("position".to_string(), self.positions[&handle].clone())).chain(rest).collect());
                }
                let method = args["method"].as_str().unwrap();
                let result = match method {
                    "getFieldValue" => {
                        let field = call.get("fieldId").and_then(Data::as_text).unwrap_or_default();
                        if field == "Scroll" {
                            json!(["F", 1, { "name": "scroll.txt", "contentType": "text/plain", "size": 12.0, "handle": "blob-1" }])
                        } else {
                            let position = call.get("position").and_then(|p| p.get("identity")).and_then(|i| i.get("data")).cloned();
                            position.and_then(|d| d.get(field).cloned()).unwrap_or(Data::Null).to_wire()
                        }
                    }
                    "describe" => Json::Null,
                    "createRecord" => {
                        let record_type = call.get("recordType").and_then(Data::as_text).unwrap_or_default().to_string();
                        let fields = call.get("fields").cloned().unwrap_or(Data::Null).to_wire();
                        Self::record(&format!("{}-{}", record_type.to_lowercase(), self.calls), &record_type, fields)
                    }
                    "updateRecord" => {
                        let id = call.get("externalId").and_then(Data::as_text).unwrap_or_default().to_string();
                        let fields = call.get("fields").cloned().unwrap_or(Data::Null).to_wire();
                        Self::record(&id, "Note", fields)
                    }
                    "resolveEntity" => o(vec![(
                        "candidates",
                        l(self.candidates.iter().map(|(id, title)| Self::record(id, "Note", o(vec![("Title", json!(title))]))).collect()),
                    )]),
                    "getRelated" => l(vec![]),
                    "awaitKeys" => {
                        let heads = match call.get("heads") {
                            Some(Data::List(heads)) => heads.clone(),
                            _ => Vec::new(),
                        };
                        l(heads.iter().map(|head| o(vec![("key", json!(format!("ticket:{}", head.get("recordId").and_then(Data::as_text).unwrap_or_default())))])).collect())
                    }
                    other => return Some(json!({ "error": { "kind": "adapter_error", "message": format!("the world does not answer {other}") } })),
                };
                Some(json!({ "result": result }))
            }
            "locks.acquire" => Some(json!({ "token": args["names"].as_array().unwrap().iter().filter_map(Json::as_str).collect::<Vec<_>>().join(",") })),
            "control.cancel.cancelled" | "control.cancel.cancelledNow" => Some(json!(false)),
            "clock.now" => Some(json!({ "nowIso": NOW })),
            "ids.mint" => {
                let count = args["count"].as_u64().unwrap();
                Some(json!((0..count).map(|_| { self.ids += 1; format!("id-{}", self.ids) }).collect::<Vec<_>>()))
            }
            _ => None,
        }
    }
}

// ── the stores ──

/// Parks, joins and callbacks in memory.
#[derive(Default)]
pub(super) struct Parks {
    pub(super) timers: Vec<TimerPark>,
    awaits: Vec<AwaitPark>,
    mints: Vec<CallbackMint>,
    /// Each callback's ledger of calls, as `{at, values}`.
    calls: Vec<Data>,
    joins: Vec<(String, i64)>,
    exports: Vec<(String, BranchExport)>,
    wakes: Vec<(String, serde_json::Value)>,
    /// Library texts a park names by hash, the hash being the index.
    sources: Vec<String>,
    /// The arrival log, its seq the index plus one.
    log: Vec<Logged>,
    waits: Vec<Wait>,
    wait_parks: Vec<WaitPark>,
    wait_wakes: Vec<String>,
    /// Replies `(identity, body)` that land on the next record a wait opens
    /// on, as the wait opens: after the mark, before anything reads them.
    landing_as_it_opens: Vec<(String, String)>,
}

/// One arrival on a record's edge.
struct Logged {
    edge: String,
    key: String,
    identity: String,
    landing: Data,
    gone: bool,
}

/// A wait, and what it has noted: (identity, matched).
struct Wait {
    id: String,
    edge: String,
    key: String,
    since: i64,
    noted: Vec<(String, bool)>,
}

impl Parks {
    /// An arrival on the record `key` names: a reply.
    fn reply_arrives(&mut self, key: &str, identity: &str, body: &str) {
        self.arrives("Reply", key, identity, body);
    }

    /// An arrival on `edge` of the record `key` names: a reply, its record
    /// id its identity.
    fn arrives(&mut self, edge: &str, key: &str, identity: &str, body: &str) {
        let landing = Data::map([("recordId", Data::text(identity)), ("recordType", Data::text("Reply")), ("fields", Data::map([("Body", Data::text(body))]))]);
        self.log.push(Logged { edge: edge.into(), key: key.into(), identity: identity.into(), landing, gone: false });
    }

    /// The wait open on `edge`, as `(id, key)`.
    fn wait_on(&self, edge: &str) -> (String, String) {
        let wait = self.waits.iter().find(|w| w.edge == edge).unwrap_or_else(|| panic!("no wait on {edge}: {:?}", self.waits.iter().map(|w| (&w.edge, &w.key)).collect::<Vec<_>>()));
        (wait.id.clone(), wait.key.clone())
    }

    fn the_wait(&self, wait_id: &str) -> HostResult<&Wait> {
        self.waits.iter().find(|w| w.id == wait_id).ok_or_else(|| HostFailure::new(format!("no wait {wait_id}")))
    }
}

impl Store for Parks {
    fn keeps_parks(&self) -> bool {
        true
    }
    fn commit_timer_park(&mut self, park: TimerPark) -> HostFuture<()> {
        self.timers.push(park);
        ready(Ok(()))
    }
    fn commit_await_park(&mut self, park: AwaitPark) -> HostFuture<()> {
        self.awaits.push(park);
        ready(Ok(()))
    }
    fn record_join(&mut self, frame: &str, parked_children: i64) -> HostFuture<()> {
        self.joins.push((frame.into(), parked_children));
        ready(Ok(()))
    }
    fn decrement_join(&mut self, frame: &str, _branch: &str, _leaf: &str) -> HostFuture<bool> {
        ready(match self.joins.iter_mut().find(|(f, _)| f == frame) {
            Some(join) => {
                join.1 -= 1;
                Ok(join.1 == 0)
            }
            None => Err("no such join".into()),
        })
    }
    fn persist_branch_export(&mut self, frame: &str, export: BranchExport) -> HostFuture<()> {
        self.exports.push((frame.into(), export));
        ready(Ok(()))
    }
    fn collect_branch_exports(&mut self, frame: &str) -> HostFuture<Vec<BranchExport>> {
        ready(Ok(self.exports.iter().filter(|(f, _)| f == frame).map(|(_, e)| e.clone()).collect()))
    }
    fn cancel_subtrees(&mut self, prefixes: &[String], exclude: Option<&str>) -> HostFuture<()> {
        self.awaits.retain(|a| Some(a.address.as_str()) == exclude || !prefixes.iter().any(|p| a.address.starts_with(p.as_str())));
        self.wait_parks.retain(|a| Some(a.address.as_str()) == exclude || !prefixes.iter().any(|p| a.address.starts_with(p.as_str())));
        ready(Ok(()))
    }
    fn wake(&mut self, adapter_type: &str, key: &serde_json::Value) -> HostFuture<()> {
        self.wakes.push((adapter_type.into(), key.clone()));
        ready(Ok(()))
    }
    fn mint_callback(&mut self, mint: CallbackMint) -> HostFuture<MintedCallback> {
        self.mints.push(mint);
        ready(Ok(MintedCallback { id: "cb1".into(), url: "https://example.test/cb/cb1".into() }))
    }
    fn callback_calls(&mut self, _callback_id: &serde_json::Value) -> HostFuture<Data> {
        ready(Ok(Data::List(self.calls.clone())))
    }
    fn wait_mark(&mut self) -> HostFuture<i64> {
        ready(Ok(self.log.len() as i64))
    }
    fn open_wait(&mut self, wait: OpenWait) -> HostFuture<String> {
        assert_eq!(wait.adapter_type, "world");
        if let Some(open) = self.waits.iter().find(|w| w.edge == wait.edge && w.key == wait.key) {
            return ready(Ok(open.id.clone()));
        }
        let id = format!("w{}", self.waits.len() + 1);
        for (identity, body) in std::mem::take(&mut self.landing_as_it_opens) {
            self.arrives(&wait.edge, &wait.key, &identity, &body);
        }
        self.waits.push(Wait { id: id.clone(), edge: wait.edge, key: wait.key, since: wait.since, noted: Vec::new() });
        ready(Ok(id))
    }
    fn wait_arrivals(&mut self, wait_id: &str) -> HostFuture<WaitArrivals> {
        ready(self.the_wait(wait_id).map(|wait| {
            let after = self.log.iter().enumerate().skip(wait.since as usize).filter(|(_, a)| a.edge == wait.edge && a.key == wait.key);
            let mut read = WaitArrivals::default();
            for (index, arrival) in after {
                if arrival.gone {
                    read.gone = true;
                } else if !wait.noted.iter().any(|(identity, _)| *identity == arrival.identity) && !read.arrivals.iter().any(|a| a.identity == arrival.identity) {
                    read.arrivals.push(LoggedArrival { seq: index as i64 + 1, identity: arrival.identity.clone(), version: None, landing: arrival.landing.clone() });
                }
            }
            read
        }))
    }
    fn note_arrival(&mut self, wait_id: &str, identity: &str, _version: Option<&str>, matched: bool) -> HostFuture<bool> {
        let Some(wait) = self.waits.iter_mut().find(|w| w.id == wait_id) else { return ready(Err(HostFailure::new(format!("no wait {wait_id}")))) };
        if wait.noted.iter().any(|(noted, _)| noted == identity) {
            return ready(Ok(false));
        }
        wait.noted.push((identity.into(), matched));
        ready(Ok(matched))
    }
    fn commit_wait_park(&mut self, park: WaitPark) -> HostFuture<()> {
        self.wait_parks.push(park);
        ready(Ok(()))
    }
    fn wake_wait(&mut self, wait_id: &str) -> HostFuture<()> {
        self.wait_wakes.push(wait_id.into());
        ready(Ok(()))
    }
    fn save_source(&mut self, source: &str) -> HostFuture<String> {
        self.sources.push(source.to_string());
        ready(Ok((self.sources.len() - 1).to_string()))
    }
    fn load_source(&mut self, hash: &str) -> HostFuture<Option<String>> {
        ready(Ok(hash.parse::<usize>().ok().and_then(|i| self.sources.get(i).cloned())))
    }
}

// ── the families ──

/// A model that answers each call with `reply` and charges for it.
struct Model {
    reply: Data,
    calls: Vec<ModelCall>,
}

impl Models for Model {
    fn call(&mut self, call: ModelCall) -> HostFuture<ModelReply> {
        self.calls.push(call);
        ready(Ok(ModelReply { parsed_json: self.reply.clone(), raw_text: None, cost: vec![Cost { source: "model:test".into(), microdollars: 7.0 }] }))
    }
}

fn titles(world: &World) -> Vec<&str> {
    world.notes.iter().map(|(_, title)| title.as_str()).collect()
}

#[test]
fn an_ai_call_runs_the_same_through_the_typed_and_the_json_route() {
    let source = movement("", "  line = ai(\"Describe ${monster.Name}\")\n  write game-[:notes]-> { Title: line }\n");
    assert_eq!(errors(&source), vec![]);
    let reply = Data::map([("value", Data::text("A fine line.")), ("has_value", Data::Bool(true))]);
    let (mut world, mut model) = (World::default(), Model { reply, calls: Vec::new() });
    let typed = block_on(run(&mut Hosts::new().adapters(&mut world).models(&mut model), &input(&source))).unwrap();
    assert_eq!(titles(&world), vec!["A fine line."]);
    assert_eq!(model.calls.len(), 1);
    assert_eq!((model.calls[0].label.as_str(), model.calls[0].prompt.clone()), ("movement-ai-expression", Prompt::Message("Describe Dragon".into())));
    let ran = finished(Ok(typed.clone()));
    assert_eq!(ran.cost, vec![Cost { source: "model:test".into(), microdollars: 7.0 }]);

    let mut wire = Wire::new(WireWorld::default(), |label, _| {
        (label == "llm.client.call").then(|| o(vec![("parsedJson", o(vec![("value", json!("A fine line.")), ("has_value", json!(true))])), ("cost", wire_cost("model:test", 7.0))]))
    });
    let (mut served, mut model) = (World::default(), Model { reply: Data::Null, calls: Vec::new() });
    let json = wire.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).models(&mut model));
    assert_eq!(typed, json);
}

/// Plain JSON as the eval wire writes it, for scripting a JSON host.
fn wire(value: Json) -> Json {
    match value {
        Json::Array(items) => l(items.into_iter().map(wire).collect()),
        Json::Object(map) => json!(["o", map.into_iter().map(|(k, v)| json!([k, wire(v)])).collect::<Vec<_>>()]),
        scalar => scalar,
    }
}

fn model_reply(parsed: Json, microdollars: f64) -> Json {
    o(vec![("parsedJson", wire(parsed)), ("cost", wire_cost("model:test", microdollars))])
}

#[test]
fn an_extraction_runs_the_same_through_the_typed_and_the_json_route() {
    let shape = "node Person: \"each person named\" { name: <text> \"their name\" }";
    let source = movement("", &format!("  people = extract([monster.Name, monster.Slayer], {shape})\n  map(people, (p) => {{ write game-[:notes]-> {{ Title: p.name }} }})\n"));
    assert_eq!(errors(&source), vec![]);
    let field = |value: &str| json!({ "value": value, "evidence": { "item": 0, "quote": value } });
    let reply = json!({ "records": [{ "name": field("Dragon") }, { "name": field("Ada") }] });
    let (mut world, mut model) = (World::default(), Model { reply: Data::from(reply.clone()), calls: Vec::new() });
    let typed = block_on(run(&mut Hosts::new().adapters(&mut world).models(&mut model), &input(&source))).unwrap();
    assert_eq!(titles(&world), vec!["Dragon", "Ada"]);
    assert_eq!(model.calls.len(), 1);
    assert_eq!(model.calls[0].label, "movement_extract_call");
    let Prompt::Blocks(blocks) = &model.calls[0].prompt else { panic!("{:?}", model.calls[0].prompt) };
    assert_eq!(blocks.len(), 3, "two content items and the shape");
    assert_eq!(finished(Ok(typed.clone())).cost, vec![Cost { source: "model:test".into(), microdollars: 7.0 }]);

    let mut json = Wire::new(WireWorld::default(), |label, _| (label == "llm.extractCall.call").then(|| model_reply(reply.clone(), 7.0)));
    let (mut served, mut unused) = (World::default(), Model { reply: Data::Null, calls: Vec::new() });
    let through_json = json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).models(&mut unused));
    assert_eq!(typed, through_json);
    assert_eq!(json.args_of("llm.extractCall.call").len(), 1);
}

/// The event parameter is the record the event fired on (`eventRecord`), so a
/// write to it updates that record in place, as a write to a traversal alias does.
#[test]
fn a_write_to_the_event_parameter_updates_the_record_the_event_fired_on() {
    let source = movement("", "  write monster { Slayer: \"Grace\" }\n");
    assert_eq!(errors(&source), vec![]);
    let mut world = World::default();
    let typed = block_on(run(&mut Hosts::new().adapters(&mut world), &input(&source))).unwrap();
    let ran = finished(Ok(typed.clone()));
    assert_eq!(ran.writes.len(), 1, "{ran:?}");
    let updates: Vec<&Data> = world.calls.iter().filter(|(method, _)| method == "updateRecord").map(|(_, args)| args).collect();
    assert_eq!(updates.len(), 1, "{:?}", world.calls);
    assert_eq!(updates[0].get("externalId").and_then(Data::as_text), Some("m1"));
    assert_eq!(updates[0].get("recordType").and_then(Data::as_text), Some("Monster"));
    assert_eq!(updates[0].get("fields").and_then(|f| f.get("Slayer")).and_then(Data::as_text), Some("Grace"));
    assert!(world.calls.iter().all(|(method, _)| method != "createRecord"));

    let mut json = Wire::new(WireWorld::default(), |_, _| None);
    let mut served = World::default();
    assert_eq!(typed, json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served)));
}

/// A walk bound to a name is a second name for the walk: a field read off the
/// name reads each landing's field, as the walk read in place does.
#[test]
fn a_field_of_a_walk_bound_to_a_name_reads_as_the_walk_does() {
    let source = movement("", "  lair = monster-[:Lair]->\n  write game-[:notes]-> { Title: \"bound ${lair.Title} / walked ${monster-[:Lair]->.Title}\" }\n");
    assert_eq!(errors(&source), vec![]);
    let mut world = World::default();
    finished(block_on(run(&mut Hosts::new().adapters(&mut world), &input(&source))));
    assert_eq!(titles(&world), vec!["bound Cave / walked Cave"]);
}

/// A model call's trace entry names the tier it was written with, the model
/// it ran on and how hard that model thought: `quick` and `careful` run on
/// one model at different efforts, so the model alone cannot tell them apart.
#[test]
fn a_model_call_s_trace_entry_names_its_tier_model_and_effort() {
    let traced_by = |source: &str, reply: Json| {
        assert_eq!(errors(source), vec![]);
        let (mut world, mut model, mut traced) = (World::default(), Model { reply: Data::from(reply), calls: Vec::new() }, Traced::default());
        finished(block_on(run(&mut Hosts::new().adapters(&mut world).models(&mut model).trace(&mut traced), &input(source))));
        traced.0
    };
    let of_kind = |entries: &[Data], kind: &str| -> Vec<(Option<String>, Option<String>, Option<String>)> {
        let text = |e: &Data, key: &str| e.get(key).and_then(Data::as_text).map(str::to_string);
        entries.iter().filter(|e| e.get("kind").and_then(Data::as_text) == Some(kind)).map(|e| (text(e, "tier"), text(e, "model"), text(e, "effort"))).collect()
    };

    let ai = movement("", "  line = ai(\"Describe ${monster.Name}\", { tier: \"careful\" })\n  plain = ai(\"Name ${monster.Name}\")\n  write game-[:notes]-> { Title: \"${line} ${plain}\" }\n");
    let traced = traced_by(&ai, json!({ "value": "x", "has_value": true }));
    assert_eq!(of_kind(&traced, "ai"), vec![(Some("careful".into()), Some("sonnet".into()), None), (None, Some("haiku".into()), Some("low".into()))]);

    let shape = "node Person: \"each person named\" { name: <text> \"their name\" }";
    let reply = json!({ "records": [{ "name": { "value": "Ada", "evidence": { "item": 0, "quote": "Ada" } } }] });
    for (settings, expected) in [
        (", { tier: \"quick\" }", (Some("quick".to_string()), Some("sonnet".to_string()), Some("low".to_string()))),
        (", { tier: \"careful\" }", (Some("careful".into()), Some("sonnet".into()), Some("high".into()))),
        ("", (None, Some("sonnet".into()), Some("low".into()))),
    ] {
        let source = movement("", &format!("  people = extract([monster.Slayer], {shape}{settings})\n  map(people, (p) => {{ write game-[:notes]-> {{ Title: p.name }} }})\n"));
        assert_eq!(of_kind(&traced_by(&source, reply.clone()), "extraction"), vec![expected], "{settings}");
    }
}

struct Judging(Verdict, usize);

impl Judge for Judging {
    fn arbitrate(&mut self, arbitration: Arbitration) -> HostFuture<Verdict> {
        self.1 += 1;
        assert_eq!(arbitration.record_type, "Note");
        assert_eq!(arbitration.asserted.get("Title"), Some(&Data::text("Dragon")));
        assert_eq!(arbitration.candidates.as_list().map(<[Data]>::len), Some(2));
        ready(Ok(self.0.clone()))
    }
}

const FUZZY: &str = "  note = write game-[:notes]-> {\n    unique by (FUZZY `Title`)\n    Title: monster.Name\n  }\n";

fn candidates() -> Vec<(String, String)> {
    vec![("note-91".into(), "Dragon Inc".into()), ("note-92".into(), "Dragon Labs".into())]
}

#[test]
fn the_identity_judge_picks_the_record_a_fuzzy_write_is_the_same_through_both_routes() {
    let source = movement("", FUZZY);
    assert_eq!(errors(&source), vec![]);
    let verdict = Verdict { index: Some(1), judge_unavailable: None, cost: vec![Cost { source: "model:judge".into(), microdollars: 11.0 }] };
    let (mut world, mut judge) = (World { candidates: candidates(), ..World::default() }, Judging(verdict, 0));
    let typed = block_on(run(&mut Hosts::new().adapters(&mut world).judge(&mut judge), &input(&source))).unwrap();
    assert_eq!(judge.1, 1);
    assert_eq!(world.updated, vec![("note-92".to_string(), "Dragon".to_string())], "the judge's pick is updated, nothing created");
    assert!(world.notes.is_empty());
    assert_eq!(finished(Ok(typed.clone())).cost, vec![Cost { source: "model:judge".into(), microdollars: 11.0 }]);

    let mut json = Wire::new(WireWorld { candidates: candidates(), ..WireWorld::default() }, |label, _| {
        (label == "llm.arbitrateEntities").then(|| json!({ "index": 1, "cost": [{ "source": "model:judge", "microdollars": 11 }] }))
    });
    let (mut served, mut unused) = (World::default(), Judging(Verdict { index: None, judge_unavailable: None, cost: vec![] }, 0));
    assert_eq!(typed, json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).judge(&mut unused)));
}

/// A judge that says no match, and one that cannot judge, both leave the
/// write creating a new record, as the JSON route does.
#[test]
fn a_judge_that_declines_or_is_unavailable_leaves_the_write_creating() {
    let source = movement("", FUZZY);
    for verdict in [
        Verdict { index: None, judge_unavailable: None, cost: vec![] },
        Verdict { index: None, judge_unavailable: Some("the judge is asleep".into()), cost: vec![] },
    ] {
        let reason = verdict.judge_unavailable.clone();
        let (mut world, mut judge) = (World { candidates: candidates(), ..World::default() }, Judging(verdict, 0));
        let typed = block_on(run(&mut Hosts::new().adapters(&mut world).judge(&mut judge), &input(&source))).unwrap();
        assert_eq!(titles(&world), vec!["Dragon"], "{typed:?}");
        let mut json = Wire::new(WireWorld { candidates: candidates(), ..WireWorld::default() }, |label, _| {
            (label == "llm.arbitrateEntities").then(|| match &reason {
                Some(reason) => json!({ "index": null, "judgeUnavailable": reason }),
                None => json!({ "index": null }),
            })
        });
        let (mut served, mut unused) = (World::default(), Judging(Verdict { index: None, judge_unavailable: None, cost: vec![] }, 0));
        assert_eq!(typed, json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).judge(&mut unused)));
    }
}

struct Library {
    read: Vec<FileRef>,
    rendered: Vec<(String, String)>,
}

impl Files for Library {
    fn render(&mut self, content: &str, kind: &str) -> HostFuture<FileRef> {
        self.rendered.push((content.into(), kind.into()));
        ready(Ok(FileRef::made(2, FileDescriptor { name: Some("made.txt".into()), content_type: Some("text/plain".into()), size: Some(content.len() as f64), handle: Some("blob-2".into()) })))
    }
    fn file_text(&mut self, file: &FileRef, _budget: &Json) -> HostFuture<(FileText, Vec<Cost>)> {
        self.read.push(file.clone());
        ready(Ok((FileText::Text { text: "The scroll says hi".into(), raw_text_id: None }, vec![Cost { source: "file:ocr".into(), microdollars: 3.0 }])))
    }
}

#[test]
fn a_file_is_read_and_a_file_is_made_the_same_through_both_routes() {
    let source = movement("", "  text = File.read(monster.Scroll)\n  doc = File.from(\"copy: ${text}\", \"text\")\n  write game-[:notes]-> { Title: coalesce(text, \"\"), Attachment: doc }\n");
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut library) = (World::default(), Library { read: Vec::new(), rendered: Vec::new() });
    let typed = block_on(run(&mut Hosts::new().adapters(&mut world).files(&mut library), &input(&source))).unwrap();
    assert_eq!(library.read.iter().map(|f| f.id).collect::<Vec<_>>(), vec![1], "the host is handed back the file it made");
    assert_eq!(library.rendered, vec![("copy: The scroll says hi".to_string(), "text".to_string())]);
    assert_eq!(titles(&world), vec!["The scroll says hi"]);
    let attachment = world.calls.iter().find(|(m, _)| m == "createRecord").and_then(|(_, a)| a.get("fields")).and_then(|f| f.get("Attachment")).cloned();
    assert!(matches!(attachment, Some(Data::File(FileRef { id: 2, .. }))), "{attachment:?}");
    assert_eq!(finished(Ok(typed.clone())).cost, vec![Cost { source: "file:ocr".into(), microdollars: 3.0 }]);

    let mut json = Wire::new(WireWorld::default(), |label, _| match label {
        "files.resolveFileText" => Some(o(vec![("text", json!("The scroll says hi")), ("cost", wire_cost("file:ocr", 3.0))])),
        "files.render" => Some(json!(["F", 2, { "name": "made.txt", "contentType": "text/plain", "size": 24.0, "handle": "blob-2" }])),
        _ => None,
    });
    let (mut served, mut unused) = (World::default(), Library { read: Vec::new(), rendered: Vec::new() });
    assert_eq!(typed, json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).files(&mut unused)));
}

struct Plugins(Vec<PluginCall>);

impl Modules for Plugins {
    fn invoke(&mut self, call: PluginCall) -> HostFuture<PluginReply> {
        self.0.push(call);
        ready(Ok(PluginReply { text: Some("looked up".into()), cost: vec![Cost { source: "plugin:lookup".into(), microdollars: 5.0 }], ..PluginReply::default() }))
    }
}

#[test]
fn a_plugin_call_runs_the_same_through_both_routes() {
    let source = movement("import { lookup } from plugins\n", "  hit = lookup(monster.Name)\n  write game-[:notes]-> { Title: hit }\n");
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut plugins) = (World::default(), Plugins(Vec::new()));
    let typed = block_on(run(&mut Hosts::new().adapters(&mut world).modules(&mut plugins), &input(&source))).unwrap();
    assert_eq!(titles(&world), vec!["looked up"]);
    assert_eq!(plugins.0.len(), 1);
    assert_eq!((plugins.0[0].plugin.as_str(), plugins.0[0].config.get("q")), ("lookup", Some(&Data::text("Dragon"))));
    assert_eq!(finished(Ok(typed.clone())).cost, vec![Cost { source: "plugin:lookup".into(), microdollars: 5.0 }]);

    let mut json = Wire::new(WireWorld::default(), |label, _| {
        (label == "llm.transforms.invoke").then(|| o(vec![("text", json!("looked up")), ("cost", wire_cost("plugin:lookup", 5.0))]))
    });
    let (mut served, mut unused) = (World::default(), Plugins(Vec::new()));
    assert_eq!(typed, json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).modules(&mut unused)));
}

/// A plugin that answers what it was asked for with one fixed reply.
struct Answers(PluginReply);

impl Modules for Answers {
    fn invoke(&mut self, _call: PluginCall) -> HostFuture<PluginReply> {
        ready(Ok(self.0.clone()))
    }
}

/// The trace a run appends, entry by entry.
#[derive(Default)]
struct Traced(Vec<Data>);

impl Trace for Traced {
    fn append(&mut self, entries: Vec<Data>) -> HostFuture<()> {
        self.0.extend(entries);
        ready(Ok(()))
    }
}

fn answered(source: &str, reply: PluginReply) -> (Outcome, World, Traced) {
    assert_eq!(errors(source), vec![]);
    let (mut world, mut traced) = (World::default(), Traced::default());
    let outcome = block_on(run(&mut Hosts::new().adapters(&mut world).modules(&mut Answers(reply)).trace(&mut traced), &input(source))).unwrap();
    (outcome, world, traced)
}

const WEIGHED: &str = "  p = weigh(monster.Name)\n  if (p >= 0.5) {\n    write game-[:notes]-> { Title: \"heavy\" }\n  }\n";

fn warnings(traced: &Traced) -> Vec<String> {
    traced.0.iter().filter(|e| e.get("kind").and_then(Data::as_text) == Some("warning")).filter_map(|e| e.get("message").and_then(Data::as_text).map(str::to_string)).collect()
}

#[test]
fn a_plugin_s_plain_value_arrives_as_the_type_it_declares() {
    let weighed = movement("import { weigh } from plugins\n", WEIGHED);
    let number = PluginReply { data: Some(Data::map([("value", Data::Number(0.8))])), ..PluginReply::default() };
    let (outcome, world, traced) = answered(&weighed, number);
    finished(Ok(outcome));
    assert_eq!(titles(&world), vec!["heavy"]);
    assert_eq!(warnings(&traced), Vec::<String>::new());

    let tagged = movement("import { tags } from plugins\n", "  t = tags(monster.Name)\n  write game-[:notes]-> { Title: coalesce(first(t), \"none\") }\n");
    let list = PluginReply { data: Some(Data::map([("value", Data::List(vec![Data::text("scaly"), Data::text("old")]))])), ..PluginReply::default() };
    let (outcome, world, _) = answered(&tagged, list);
    finished(Ok(outcome));
    assert_eq!(titles(&world), vec!["scaly"]);
}

#[test]
fn a_number_answered_as_its_text_is_read_as_the_number_under_0_12() {
    let weighed = movement("import { weigh } from plugins\n", WEIGHED);
    let as_text = PluginReply { text: Some(" 0.8".into()), ..PluginReply::default() };
    let (outcome, world, traced) = answered(&weighed, as_text);
    finished(Ok(outcome));
    assert_eq!(titles(&world), vec!["heavy"]);
    assert_eq!(warnings(&traced), Vec::<String>::new());
}

#[test]
fn a_value_outside_its_declared_type_runs_on_as_text_and_is_noted_under_0_12() {
    let weighed = movement("import { weigh } from plugins\n", "  p = weigh(monster.Name)\n  write game-[:notes]-> { Title: \"${p}\" }\n");
    let as_text = PluginReply { text: Some("heavy-ish".into()), ..PluginReply::default() };
    let (outcome, world, traced) = answered(&weighed, as_text);
    finished(Ok(outcome));
    assert_eq!(titles(&world), vec!["heavy-ish"]);
    let noted = warnings(&traced);
    assert_eq!(noted.len(), 1, "{:?}", traced.0);
    assert!(noted[0].contains("'weigh' declares it hands back number, and it handed back string"), "{}", noted[0]);
}

/// A model that refuses on its budget ends the run as the JSON route's
/// budget refusal does, not as a host fault.
struct Broke;

impl Models for Broke {
    fn call(&mut self, _call: ModelCall) -> HostFuture<ModelReply> {
        ready(Err(HostFailure::budget("no budget left for this call")))
    }
}

#[test]
fn a_model_that_refuses_on_budget_fails_the_run_as_the_json_route_does() {
    let source = movement("", "  line = ai(\"Describe ${monster.Name}\")\n  write game-[:notes]-> { Title: line }\n");
    let (mut world, mut broke) = (World::default(), Broke);
    let typed = block_on(run(&mut Hosts::new().adapters(&mut world).models(&mut broke), &input(&source))).unwrap();
    assert!(world.notes.is_empty());
    let mut json = Wire::new(WireWorld::default(), |label, _| {
        (label == "llm.client.call").then(|| o(vec![("error", o(vec![("kind", json!("budget")), ("message", json!("no budget left for this call"))]))]))
    });
    let (mut served, mut unused) = (World::default(), Broke);
    let through_json = json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).models(&mut unused));
    assert_eq!(typed, through_json);
    assert!(matches!(&typed, Outcome::Failed(f) if f.message.contains("no budget left")), "{typed:?}");
}

const TICKET: &str = "  t = write game-[:tickets]-> { Subject: monster.Name }\n  r = await t-[:Reply]->\n  write game-[:notes]-> { Title: coalesce(r.Body, \"\") }\n";

/// The answers a JSON host gives the waits family for a run whose one wait
/// (`w1`) has `arrivals` logged after its mark, each `(identity, body)`.
fn wait_answers(arrivals: Vec<(&'static str, &'static str)>) -> impl FnMut(&str, &Json) -> Option<Json> {
    move |label, _| match label {
        "park.waits.mark" => Some(json!({ "mark": 0 })),
        "park.waits.open" => Some(json!({ "waitId": "w1" })),
        "park.waits.arrivals" => {
            let listed = arrivals
                .iter()
                .enumerate()
                .map(|(seq, (identity, body))| {
                    o(vec![
                        ("seq", json!(seq + 1)),
                        ("identity", json!(identity)),
                        ("landing", o(vec![("recordId", json!(identity)), ("recordType", json!("Reply")), ("fields", o(vec![("Body", json!(body))]))])),
                    ])
                })
                .collect();
            Some(o(vec![("gone", json!(false)), ("arrivals", l(listed))]))
        }
        "park.waits.note" => Some(json!({ "counts": true })),
        "park.sink.commitAwaitPark" => Some(Json::Null),
        _ => None,
    }
}

#[test]
fn an_await_on_an_adapter_record_parks_and_resumes_when_the_reply_arrives() {
    let source = movement("", TICKET);
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))).unwrap();
    assert!(matches!(&parked, Outcome::Parked(ran) if ran.parked_address.is_some()), "{parked:?}");
    assert!(world.notes.is_empty() && parks.timers.is_empty() && parks.awaits.is_empty());
    let [park] = parks.wait_parks.as_slice() else { panic!("{:?}", parks.wait_parks) };
    let [wait] = parks.waits.as_slice() else { panic!("one wait") };
    assert_eq!((park.wait_id.as_str(), wait.edge.as_str()), ("w1", "Reply"));
    assert!(wait.key.starts_with("ticket:ticket-"), "{}", wait.key);

    // The reply arrives; the awaiting statement is entered again.
    let key = wait.key.clone();
    parks.reply_arrives(&key, "reply-1", "Thanks");
    let park = parks.wait_parks.remove(0);
    let calls_before_resume = world.calls.len();
    let resumed = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &park.state, Wake::Arrival)).unwrap();
    assert_eq!(titles(&world), vec!["Thanks"]);
    assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");
    // Re-entered, the await reads the log: it never lists the edge again.
    assert!(world.calls[calls_before_resume..].iter().all(|(method, _)| method != "getRelated"));

    // The JSON route: the same two segments, answered by hand.
    let mut json = Wire::new(WireWorld::default(), wait_answers(vec![]));
    let (mut served, mut store) = (World::default(), Parks::default());
    let through_json = json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(parked, through_json);
    let committed = json.args_of("park.sink.commitAwaitPark");
    assert_eq!(committed.len(), 1);
    assert_eq!((committed[0]["state"].clone(), committed[0]["address"].clone()), (park.state.0.clone(), json!(park.address)));
    assert_eq!(committed[0]["waitId"], json!("w1"));
    let opened = json.args_of("park.waits.open");
    assert_eq!((opened[0]["adapterType"].clone(), opened[0]["edge"].clone(), opened[0]["key"].clone(), opened[0]["since"].clone()), (json!("world"), json!("Reply"), json!(key), json!(0)));
    let mut json = Wire::new(WireWorld { calls: calls_before_resume, ..WireWorld::default() }, wait_answers(vec![("reply-1", "Thanks")]));
    let through_json = json.drive(&input(&source), Entry::Resume { state: &park.state, reenter: true }, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(resumed, through_json);
}

/// A reply that has not arrived keeps the flow parked: re-entering the
/// await reads the log again rather than stepping past it.
#[test]
fn an_await_woken_early_parks_again_instead_of_stepping_past() {
    let source = movement("", TICKET);
    let (mut world, mut parks) = (World::default(), Parks::default());
    block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))).unwrap();
    let park = parks.wait_parks.remove(0);
    let again = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &park.state, Wake::Arrival)).unwrap();
    assert!(matches!(again, Outcome::Parked(_)), "{again:?}");
    assert_eq!(parks.wait_parks.len(), 1);
    assert_eq!(parks.waits.len(), 1, "the re-entered await keeps its wait");
    assert!(world.notes.is_empty());
}

/// The JSON route's requests, labelled `family.method` (an adapter call by
/// its method), for `body` run against `answer`.
fn labels(body: &str, answer: impl FnMut(&str, &Json) -> Option<Json>) -> Vec<String> {
    labels_of(&movement("", body), answer)
}

/// `labels` for a whole movement's source.
fn labels_of(source: &str, answer: impl FnMut(&str, &Json) -> Option<Json>) -> Vec<String> {
    let source = source.to_string();
    assert_eq!(errors(&source), vec![]);
    let mut json = Wire::new(WireWorld::default(), answer);
    let (mut served, mut store) = (World::default(), Parks::default());
    json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).store(&mut store));
    json.seen
        .iter()
        .map(|(label, args)| match args.get("method").and_then(Json::as_str) {
            Some(method) if label == "adapters.call" => format!("adapters.call {method}"),
            _ => label.clone(),
        })
        .collect()
}

/// `wanted` appears in `labels` in this order (other requests between).
fn order(labels: &[String], wanted: &[&str]) -> Result<(), String> {
    let mut at = 0;
    for want in wanted {
        match labels[at..].iter().position(|label| label == want) {
            Some(found) => at += found + 1,
            None => return Err(format!("no '{want}' after {:?} in {labels:?}", &labels[..at])),
        }
    }
    Ok(())
}

#[test]
fn the_mark_is_taken_before_the_write_and_the_wait_opens_after_it() {
    let labels = labels("  msg = write game-[:tickets]-> { Subject: monster.Name }\n  i = await msg-[:Reply]->\n", wait_answers(vec![]));
    assert_eq!(order(&labels, &["park.waits.mark", "adapters.call createRecord", "adapters.call awaitKeys", "park.waits.open", "park.sink.commitAwaitPark"]), Ok(()));
}

#[test]
fn an_iterable_await_binds_an_existing_member_without_parking() {
    let source = movement("", TICKET);
    let (mut world, mut parks) = (World::default(), Parks::default());
    // The ticket the write makes is `ticket-1`: it already holds a reply.
    world.replies.push(("*".into(), "Already".into()));
    let ran = finished(block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))));
    assert_eq!(ran.parked_address, None);
    assert_eq!(titles(&world), vec!["Already"]);
    assert!(parks.wait_parks.is_empty());
    assert!(world.calls.iter().any(|(method, args)| method == "getRelated" && args.get("fieldId").and_then(Data::as_text) == Some("Reply")));
    // The member it took is noted, so a later arrival of it counts no more.
    assert_eq!(parks.waits[0].noted, vec![("reply-0".to_string(), true)]);
}

#[test]
fn await_new_never_lists_and_binds_a_logged_arrival() {
    let source = movement("", &TICKET.replace("await t-", "await new t-"));
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    // One reply already on the ticket, which `await new` never reads; one
    // that lands after the mark the write took, which it binds.
    world.replies.push(("*".into(), "Already".into()));
    parks.landing_as_it_opens.push(("reply-9".into(), "Logged".into()));
    let ran = finished(block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))));
    assert_eq!(ran.parked_address, None);
    assert_eq!(titles(&world), vec!["Logged"]);
    assert!(world.calls.iter().all(|(method, _)| method != "getRelated"), "{:?}", world.calls.iter().map(|(m, _)| m).collect::<Vec<_>>());
    assert!(parks.wait_parks.is_empty());
}

#[test]
fn a_captured_value_is_parked_and_used_on_resume_though_the_record_changed() {
    let body = "  t = write game-[:tickets]-> { Subject: monster.Name }
  r = await t-[r:Reply WHERE r.Body == monster.Slayer]->
  write game-[:notes]-> { Title: coalesce(r.Body, \"\") }
";
    let source = movement("", body);
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    let park = parks.wait_parks.remove(0);
    // The slayer read when the wait was reached was Ada; the record says Bob now.
    world.fields_now.push(("Slayer".into(), "Bob".into()));
    let key = parks.waits[0].key.clone();
    parks.reply_arrives(&key, "reply-1", "Bob");
    parks.reply_arrives(&key, "reply-2", "Ada");
    let resumed = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &park.state, Wake::Arrival)).unwrap();
    assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");
    assert_eq!(titles(&world), vec!["Ada"]);
    assert_eq!(parks.waits[0].noted, vec![("reply-1".to_string(), false), ("reply-2".to_string(), true)]);
}

/// A gone record settles its wait empty: the scope the `await` is in ends
/// quietly, so the code after it runs zero times, guarded or not.
#[test]
fn a_gone_wait_settles_empty() {
    let body = "  t = write game-[:tickets]-> { Subject: monster.Name }
  r = await t-[:Reply]->
  write game-[:notes]-> { Title: \"after ${r.Body}\" }
";
    let source = movement("", body);
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    world.gone.push("*".into());
    let ran = finished(block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))));
    assert_eq!(ran.parked_address, None);
    // No wait row for a gone record, and no park.
    assert!(parks.waits.is_empty() && parks.wait_parks.is_empty());
    assert_eq!(titles(&world), Vec::<&str>::new());

    // A record that goes while the run waits: its gone arrival settles the wait.
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    let park = parks.wait_parks.remove(0);
    let key = parks.waits[0].key.clone();
    parks.log.push(Logged { edge: "Reply".into(), key, identity: String::new(), landing: Data::Null, gone: true });
    let resumed = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &park.state, Wake::Arrival)).unwrap();
    assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");
    assert!(parks.wait_parks.is_empty());
    assert_eq!(titles(&world), Vec::<&str>::new());
}

#[test]
fn a_park_of_state_version_2_is_refused_naming_0_12() {
    let source = movement("", TICKET);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let state = ParkedState(json!(["o", [["version", 2], ["address", "s1"], ["bindingName", "r"], ["scopeChain", ["l", []]]]]));
    let refused = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &state, Wake::Arrival)).unwrap();
    let Outcome::Failed(failure) = refused else { panic!("{refused:?}") };
    assert!(failure.message.contains("this run parked under listen-fire 0.12 (park state 2); a 0.13 engine resumes park state 3"), "{}", failure.message);
}

/// The movement's source with `functions` declared before `m`, whose body is
/// `body`.
fn movement_with(functions: &str, body: &str) -> String {
    format!("import {{ world }} from adapters\ngame = connect world\n{functions}function m(monster: <game-[:Monster]->>) {{\n{body}}}\nlisten to game {{ events: [\"monster.slain\"] }} fire m\n")
}

/// The JSON host's answer for the monster's lair: one note, `note-lair`;
/// everything else as `answer` says.
fn with_lair(mut answer: impl FnMut(&str, &Json) -> Option<Json>) -> impl FnMut(&str, &Json) -> Option<Json> {
    move |label, args| {
        if label == "adapters.call" && args["method"] == json!("getRelated") {
            let identity = o(vec![("kind", json!("stable")), ("recordId", json!("note-lair")), ("data", o(vec![("Title", json!("Cave"))]))]);
            return Some(json!({ "result": l(vec![o(vec![("position", o(vec![("recordType", json!("Note")), ("identity", identity)]))])]) }));
        }
        answer(label, args)
    }
}

/// The lair note enters where `source` says, and its wait on `Comments`
/// opens there: the run parks on it, and a comment arriving resumes it. The
/// mark is taken before the lair is read, so a comment arriving during the
/// read counts.
fn the_lair_note_waits_from_before_it_was_read(source: &str) {
    assert_eq!(errors(source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(source))).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    let (_, key) = parks.wait_on("Comments");
    assert_eq!(key, "ticket:note-lair");
    let park = parks.wait_parks.remove(0);
    parks.arrives("Comments", &key, "comment-1", "hi");
    let resumed = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(source), &park.state, Wake::Arrival)).unwrap();
    assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");
    assert_eq!(titles(&world), vec!["comment hi"]);

    let labels = labels_of(source, with_lair(wait_answers(vec![])));
    assert_eq!(order(&labels, &["park.waits.mark", "adapters.call getRelated", "adapters.call awaitKeys", "park.waits.open", "park.sink.commitAwaitPark"]), Ok(()));
}

const WATCH: &str = "  c = await new n-[:Comments]->\n  write game-[:notes]-> { Title: \"comment ${c.Body}\" }\n";

#[test]
fn a_function_s_parameter_opens_its_wait_marked_before_the_argument_is_read() {
    let watch = format!("function watch(n: <game-[:Note]->>) {{\n{WATCH}}}\n");
    the_lair_note_waits_from_before_it_was_read(&movement_with(&watch, "  watch(only(monster-[:Lair]->))\n"));
}

#[test]
fn a_closure_s_parameter_opens_its_wait_marked_before_the_members_are_read() {
    the_lair_note_waits_from_before_it_was_read(&movement("", &format!("  map(monster-[:Lair]->, (n) => {{\n{WATCH}}})\n")));
}

#[test]
fn a_block_head_opens_its_landings_waits_marked_before_the_walk() {
    the_lair_note_waits_from_before_it_was_read(&movement("", &format!("  monster-[n:Lair]-> {{\n{WATCH}}}\n")));
}

/// The trigger's record waits from the mark its delivery was kept at
/// (`triggerMark`): an arrival logged before it is no answer to `await new`;
/// one logged after it is, though it landed before the run started.
#[test]
fn the_trigger_record_waits_from_the_mark_its_delivery_was_kept_at() {
    let source = movement("", "  c = await new monster-[:Taunts]->\n  write game-[:notes]-> { Title: \"taunt ${c.Body}\" }\n");
    assert_eq!(errors(&source), vec![]);
    let logged = || {
        let mut parks = Parks::default();
        parks.arrives("Taunts", "ticket:m1", "taunt-1", "before");
        parks.arrives("Taunts", "ticket:m1", "taunt-2", "after");
        parks
    };
    let (mut world, mut parks) = (World::default(), logged());
    let mut marked = input(&source);
    marked.trigger_mark = Some(1);
    let ran = finished(block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &marked)));
    assert_eq!(ran.parked_address, None);
    assert_eq!(titles(&world), vec!["taunt after"]);
    assert_eq!(parks.waits[0].since, 1);

    // With no mark, the run's start is the mark: both landed before it.
    let (mut world, mut parks) = (World::default(), logged());
    let parked = block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    assert_eq!(parks.waits[0].since, 2);
}

const REACTED: &str = "  t = write game-[:tickets]-> { Subject: monster.Name }\n  r = await t-[:Reply]->\n  x = await new r-[:Reactions]->\n  write game-[:notes]-> { Title: \"${r.Body}/${x.Body}\" }\n";

/// A reply bound off the arrival log is the reply its landing names, as a
/// listed one is: it opens its own waits, so an `await` off it works
/// whichever way it was bound.
#[test]
fn an_arrival_naming_its_record_binds_that_record_as_the_listing_would() {
    let source = movement("", REACTED);
    assert_eq!(errors(&source), vec![]);
    let reacted = |world: &mut World, parks: &mut Parks, reply: &str| {
        let (_, key) = parks.wait_on("Reactions");
        assert_eq!(key, format!("ticket:{reply}"));
        let park = parks.wait_parks.pop().unwrap();
        parks.arrives("Reactions", &key, "reaction-1", "wow");
        let resumed = block_on(resume(&mut Hosts::new().adapters(world).store(parks), &input(&source), &park.state, Wake::Arrival)).unwrap();
        assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");
    };

    // Listed: the reply already on the ticket.
    let (mut world, mut parks) = (World::default(), Parks::default());
    world.replies.push(("*".into(), "Already".into()));
    let parked = block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    reacted(&mut world, &mut parks, "reply-0");
    assert_eq!(titles(&world), vec!["Already/wow"]);

    // Arrived: the reply lands while the run waits.
    let (mut world, mut parks) = (World::default(), Parks::default());
    block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))).unwrap();
    let (_, key) = parks.wait_on("Reply");
    let park = parks.wait_parks.remove(0);
    parks.reply_arrives(&key, "reply-7", "Hi");
    let parked = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &park.state, Wake::Arrival)).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    reacted(&mut world, &mut parks, "reply-7");
    assert_eq!(titles(&world), vec!["Hi/wow"]);
}

/// Two plain awaits on one record's edge share the record's one wait, and
/// each takes the listing's first match: the second binds the same oldest
/// member as the first ("the existing match, or else the first to arrive").
#[test]
fn two_plain_awaits_on_one_edge_share_its_wait_and_bind_the_same_first_member() {
    let source = movement("", "  t = write game-[:tickets]-> { Subject: monster.Name }\n  a = await t-[:Reply]->\n  b = await t-[:Reply]->\n  write game-[:notes]-> { Title: \"${a.Body}+${b.Body}\" }\n");
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    world.replies.push(("*".into(), "First".into()));
    world.replies.push(("*".into(), "Second".into()));
    finished(block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))));
    assert_eq!(titles(&world), vec!["First+First"]);
    assert_eq!(parks.waits.len(), 1);
}

const CALLBACK: &str = "  approve = callback((who: <text>) => { write game-[:notes]-> { Title: \"approved by ${who}\" } })\n  tap = await approve-[:Called]->\n  write game-[:notes]-> { Title: \"tapped by ${tap.who} at ${tap.At}\" }\n";

#[test]
fn a_callback_is_minted_fired_and_its_awaiter_resumed() {
    let source = movement("", CALLBACK);
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    let [mint] = parks.mints.as_slice() else { panic!("{:?}", parks.mints) };
    assert_eq!(mint.params, vec![("who".to_string(), "text".to_string())]);
    assert!(mint.single_use);
    let [park] = parks.awaits.as_slice() else { panic!("{:?}", parks.awaits) };
    assert_eq!((park.adapter_type.as_str(), park.correlation_key.clone()), ("callback", json!("cb1")));

    // Someone calls it: the call lands on the ledger, its body runs, and the awaiter is woken.
    let call = CallbackCall { values: Data::map([("who", Data::text("Bo"))]), call_index: 0 };
    parks.calls.push(Data::map([("at", Data::text("2026-03-12T12:05:00.000Z")), ("values", call.values.clone())]));
    let (mint_state, await_state) = (mint.state.clone(), park.state.clone());
    let calls_before_fire = world.calls.len();
    let fired = block_on(fire(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &mint_state, &call)).unwrap();
    assert!(matches!(fired, Outcome::Finished(_)), "{fired:?}");
    assert_eq!(titles(&world), vec!["approved by Bo"]);
    let calls_before_resume = world.calls.len();
    let resumed = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &await_state, Wake::Arrival)).unwrap();
    assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");
    assert_eq!(titles(&world), vec!["approved by Bo", "tapped by Bo at 2026-03-12T12:05:00.000Z"]);

    // The JSON route, the same three segments.
    let ledger = json!(["l", [wire(json!({ "at": "2026-03-12T12:05:00.000Z", "values": { "who": "Bo" } }))]]);
    let (mut served, mut store) = (World::default(), Parks::default());
    let mut json = Wire::new(WireWorld::default(), |label, _| match label {
        "park.callbacks.mint" => Some(json!({ "id": "cb1", "url": "https://example.test/cb/cb1" })),
        "park.callbacks.calls" => Some(l(vec![])),
        "park.sink.commitAwaitPark" => Some(Json::Null),
        _ => None,
    });
    let through_json = json.drive(&input(&source), Entry::Run, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(parked, through_json);
    let minted = json.args_of("park.callbacks.mint");
    assert_eq!((minted[0]["state"].clone(), minted[0]["params"].clone()), (mint_state.0.clone(), json!([{ "name": "who", "type": "text" }])));
    let mut json = Wire::new(WireWorld { calls: calls_before_fire, ..WireWorld::default() }, |_, _| None);
    let through_json = json.drive(&input(&source), Entry::Fire { state: &mint_state, call: &call }, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(fired, through_json);
    let mut json = Wire::new(WireWorld { calls: calls_before_resume, ..WireWorld::default() }, |label, _| (label == "park.callbacks.calls").then(|| ledger.clone()));
    let through_json = json.drive(&input(&source), Entry::Resume { state: &await_state, reenter: true }, &mut Hosts::new().adapters(&mut served).store(&mut store));
    assert_eq!(resumed, through_json);
}

const JOIN: &str = "  r = all(\n    () => {\n      t = write game-[:tickets]-> { Subject: monster.Name }\n      x = await t-[:Reply]->\n      return coalesce(x.Body, \"\")\n    },\n    () => { return \"fast\" },\n  )\n  write game-[:notes]-> { Title: \"${r[0]}+${r[1]}\" }\n";

#[test]
fn a_join_with_a_parked_arm_closes_when_the_arm_resumes() {
    let source = movement("", JOIN);
    assert_eq!(errors(&source), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source))).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    assert!(world.notes.is_empty());
    assert_eq!(parks.joins.len(), 1, "the join recorded one parked arm: {:?}", parks.joins);
    assert_eq!(parks.joins[0].1, 1);
    assert_eq!(parks.exports.len(), 1, "the arm that finished left its export: {:?}", parks.exports.iter().map(|(f, e)| (f, e.branch_index)).collect::<Vec<_>>());
    let [park] = parks.wait_parks.as_slice() else { panic!("{:?}", parks.wait_parks) };
    let state = park.state.clone();
    let key = parks.waits[0].key.clone();
    parks.reply_arrives(&key, "reply-1", "Thanks");
    let resumed = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&source), &state, Wake::Arrival)).unwrap();
    assert!(matches!(resumed, Outcome::Finished(_)), "{resumed:?}");
    assert_eq!(titles(&world), vec!["Thanks+fast"]);
}

/// A timer wake steps past a `sleep` but re-tests an `until`'s condition:
/// the state says which it is parked on.
#[test]
fn a_timer_wake_retests_an_until_and_steps_past_a_sleep() {
    let until = movement("", "  await until(monster.Name == \"Wyrm\", { every: 15m })\n  write game-[:notes]-> { Title: \"done\" }\n");
    assert_eq!(errors(&until), vec![]);
    let (mut world, mut parks) = (World::default(), Parks::default());
    let parked = block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&until))).unwrap();
    assert!(matches!(parked, Outcome::Parked(_)), "{parked:?}");
    let timer = parks.timers.remove(0);
    assert_eq!(timer.wake_at, "2026-03-12T12:15:00.000Z");
    assert!(timer.state.is_until());
    let again = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&until), &timer.state, Wake::Timer)).unwrap();
    assert!(matches!(again, Outcome::Parked(_)), "the condition is still false: {again:?}");
    assert_eq!(parks.timers.len(), 1);
    assert!(world.notes.is_empty());

    let sleep = movement("", "  await sleep(1h)\n  write game-[:notes]-> { Title: \"done\" }\n");
    block_on(run(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&sleep))).unwrap();
    let timer = parks.timers.pop().unwrap();
    assert!(!timer.state.is_until());
    let done = block_on(resume(&mut Hosts::new().adapters(&mut world).store(&mut parks), &input(&sleep), &timer.state, Wake::Timer)).unwrap();
    assert!(matches!(done, Outcome::Finished(_)), "{done:?}");
    assert_eq!(titles(&world), vec!["done"]);
}

/// A model whose every call takes `ms` of the test clock to answer.
struct Slow {
    time: Time,
    ms: u64,
    started_at: Vec<u64>,
}

impl Models for Slow {
    fn call(&mut self, call: ModelCall) -> HostFuture<ModelReply> {
        self.started_at.push(self.time.now_ms());
        let Prompt::Message(prompt) = call.prompt else { return ready(Err("a message, not blocks".into())) };
        let landed = self.time.sleep(self.ms);
        Box::pin(async move {
            landed.await;
            Ok(ModelReply { parsed_json: Data::map([("value", Data::text(prompt)), ("has_value", Data::Bool(true))]), raw_text: None, cost: Vec::new() })
        })
    }
}

/// The arms of an `all(...)` ask at once, so two 100 ms calls take 100 ms,
/// not 200: the second is started before the first has answered.
#[test]
fn the_arms_of_an_all_are_served_at_once() {
    let source = movement("", "  r = all(\n    () => { return ai(\"one\") },\n    () => { return ai(\"two\") },\n  )\n  write game-[:notes]-> { Title: \"${r[0]}+${r[1]}\" }\n");
    assert_eq!(errors(&source), vec![]);
    let time = Time::default();
    let (mut world, mut model) = (World::default(), Slow { time: time.clone(), ms: 100, started_at: Vec::new() });
    let outcome = time.block_on(run(&mut Hosts::new().adapters(&mut world).models(&mut model), &input(&source)));
    finished(outcome);
    assert_eq!(titles(&world), vec!["one+two"]);
    assert_eq!(model.started_at, vec![0, 0], "both calls started before either answered");
    assert_eq!(time.now_ms(), 100);
}

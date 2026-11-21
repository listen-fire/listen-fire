//! The Rust half of the wasm boundary benchmark
//! (packages/movement-engine/bench/wasm_boundary): replays one run's captured
//! boundary payloads through the same JSON work the ABI does with each, by
//! the crates' own functions, and prints what each kind took as one JSON
//! line. Natively it reads the capture from the file its argument names;
//! built for wasm32-unknown-unknown it reads it from its `bench` imports and
//! is driven by the benchmark under Node (wasm_replay.ts there).
//!
//! What is timed, per export the run called (src/abi.rs, the parser's and
//! the checker's abi.rs):
//!
//! - `engine_start`: the input's UTF-8 check and `begin` (the input read as
//!   JSON, then as a `SegmentInput`); then, apart, the catalog the input
//!   carries as raw text, read by `CatalogSnapshot::load` as the segment
//!   does when it starts.
//! - `engine_answer`: the answer's UTF-8 check and `read_answer`.
//! - every engine output: `to_sorted_json` of the `Step` (rebuilt, untimed,
//!   from the captured output).
//! - each environment call: the request's `request_json` and `to_string`,
//!   and the reply's UTF-8 check, `from_json_text` and the typed read of its
//!   value (`HostImports::ask` in src/env_services.rs, which is wasm-only and
//!   private, so its few lines are repeated here).
//! - the parser's and checker's exports: their inputs' UTF-8 checks, a
//!   check's options and its catalog (`read_json_text`, `CatalogSnapshot::
//!   load`); their outputs, which are `serde_json::Value`s in the ABI too,
//!   by `to_sorted_json` and, where the ABI applies it, `external_bytes`.
//!
//! Not timed: building the values the engine serialises (its `json!`
//! requests, the parser's `to_value` of a tree, the checker's `to_json`), and
//! reading answers into the engine's own values (`env::Wire::decode`): those
//! are the engine's model being JSON values, not the text crossing.
//!
//! Each kind is timed over whole passes of every payload of its kind, so no
//! timer read sits inside an operation; the median pass is reported.

use std::hint::black_box;

use movement_engine::env_services::{self, NormalForm, Op, UrlParts, ZonedFields};
use movement_engine::executor::{PendingRequest, Step};
use movement_engine::js_string;
use movement_engine::run::SegmentInput;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form;
use movement_parser::{abi, to_sorted_json};
use serde::Deserialize;
use serde_json::{Value as Json, json};

#[derive(Deserialize)]
struct Capture {
    run: String,
    calls: Vec<Call>,
}

#[derive(Deserialize)]
struct Call {
    export: String,
    inputs: Vec<String>,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    status: Option<u32>,
    env: Vec<EnvCall>,
}

#[derive(Deserialize)]
struct EnvCall {
    request: String,
    reply: String,
}

/// The checker's options (movement_checker's abi.rs `AskedOptions`, private
/// there), read as it reads them.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)] // read for the cost of reading it
struct AskedOptions {
    #[serde(default)]
    upgrading_from: Option<String>,
}

/// What an environment reply is read as, by its request's op.
#[derive(Clone, Copy)]
enum ReplyType {
    Zoned,
    Url,
    Text,
}

struct EnvReplay {
    op: OwnedOp,
    reply: String,
}

enum OwnedOp {
    TzConvert { instant_iso: String, zone: String },
    UrlParse { text: String },
    Normalize { text: String, form: NormalForm },
}

impl OwnedOp {
    fn read(request: &str) -> OwnedOp {
        let request: Json = serde_json::from_str(request).expect("a captured request is JSON");
        let text = |name: &str| request[name].as_str().unwrap_or_else(|| panic!("a request's {name}")).to_string();
        match request["op"].as_str() {
            Some("tz_convert") => OwnedOp::TzConvert { instant_iso: text("instantIso"), zone: text("zone") },
            Some("url_parse") => OwnedOp::UrlParse { text: text("text") },
            Some("normalize") => OwnedOp::Normalize {
                text: text("text"),
                form: serde_json::from_value(request["form"].clone()).expect("a normal form"),
            },
            other => panic!("no environment op {other:?}"),
        }
    }

    fn op(&self) -> Op<'_> {
        match self {
            OwnedOp::TzConvert { instant_iso, zone } => Op::TzConvert { instant_iso, zone },
            OwnedOp::UrlParse { text } => Op::UrlParse { text },
            OwnedOp::Normalize { text, form } => Op::Normalize { text, form: *form },
        }
    }

    fn reply_type(&self) -> ReplyType {
        match self {
            OwnedOp::TzConvert { .. } => ReplyType::Zoned,
            OwnedOp::UrlParse { .. } => ReplyType::Url,
            OwnedOp::Normalize { .. } => ReplyType::Text,
        }
    }
}

/// An output the ABI serialises, rebuilt as the ABI holds it, and whether
/// an engine segment's export wrote it (the rest are the parser's and the
/// checker's, on the long-lived instance).
struct Output {
    engine: bool,
    serialised: Serialised,
}

enum Serialised {
    Step(Step),
    /// A `Value` the ABI serialises as it is; `external` where it applies
    /// `form::external_bytes` after (the parser's and the checker's).
    Value { value: Json, external: bool },
}

/// The engine's own exports (src/abi.rs) emit without `external_bytes`;
/// the parser's and the checker's emit with it.
fn is_engine_export(name: &str) -> bool {
    matches!(
        name,
        "engine_start" | "engine_answer" | "language_version" | "language_standing" | "judge_arrival" | "explain_arrival" | "listen_identity" | "landing_node" | "landing_misfits"
    )
}

fn step_of(output: &str) -> Step {
    let value: Json = serde_json::from_str(output).expect("a captured step is JSON");
    if let Some(done) = value.get("done") {
        return Step::Done(done.clone());
    }
    let pending = value["pending"].as_array().expect("a step is done or pending");
    Step::Pending(
        pending
            .iter()
            .map(|request| PendingRequest {
                id: u32::try_from(request["id"].as_u64().expect("a request's id")).expect("an id fits"),
                family: Box::leak(request["family"].as_str().expect("a request's family").to_string().into_boxed_str()),
                method: request["method"].as_str().expect("a request's method").to_string(),
                args: request["args"].clone(),
            })
            .collect(),
    )
}

fn output_of(call: &Call) -> Option<Output> {
    let output = call.output.as_deref()?;
    let engine = call.export == "engine_start" || call.export == "engine_answer";
    let serialised = if engine && call.status == Some(0) {
        Serialised::Step(step_of(output))
    } else {
        Serialised::Value { value: serde_json::from_str(output).expect("a captured output is JSON"), external: !is_engine_export(&call.export) }
    };
    Some(Output { engine, serialised })
}

fn utf8(text: &str, what: &str) -> usize {
    unsafe { abi::utf8(text.as_ptr(), u32::try_from(text.len()).expect("fits"), what) }.map(str::len).unwrap_or(0)
}

/// A pass over the capture's payloads of one kind. Each returns a number
/// derived from its work, so none is optimised away.
struct Replay {
    calls: Vec<Call>,
    outputs: Vec<Output>,
    env: Vec<EnvReplay>,
    /// The catalog texts the run's segments started with.
    segment_catalogs: Vec<String>,
}

impl Replay {
    fn new(capture: Capture) -> Replay {
        let outputs = capture.calls.iter().filter_map(output_of).collect();
        let env = capture
            .calls
            .iter()
            .flat_map(|call| call.env.iter())
            .map(|e| EnvReplay { op: OwnedOp::read(&e.request), reply: e.reply.clone() })
            .collect();
        let segment_catalogs = capture
            .calls
            .iter()
            .filter(|call| call.export == "engine_start")
            .map(|call| {
                let input: SegmentInput = js_string::from_json_text(&call.inputs[0]).expect("a captured segment input reads");
                input.catalog.get().to_string()
            })
            .collect();
        Replay { calls: capture.calls, outputs, env, segment_catalogs }
    }

    fn engine_inputs(&self) -> usize {
        let mut n = 0;
        for call in &self.calls {
            match call.export.as_str() {
                "engine_start" => {
                    n += utf8(&call.inputs[0], "the input");
                    n += usize::from(black_box(movement_engine::begin(&call.inputs[0])).is_ok());
                }
                "engine_answer" => {
                    n += utf8(&call.inputs[0], "the answer");
                    n += usize::from(black_box(movement_engine::read_answer(&call.inputs[0])).is_ok());
                }
                _ => {}
            }
        }
        n
    }

    fn engine_catalogs(&self) -> usize {
        self.segment_catalogs.iter().map(|catalog| usize::from(black_box(CatalogSnapshot::load(catalog)).is_ok())).sum()
    }

    fn checker_inputs(&self) -> usize {
        let mut n = 0;
        for call in self.calls.iter().filter(|call| !call.export.starts_with("engine_")) {
            for input in &call.inputs {
                n += utf8(input, "input");
            }
            if matches!(call.export.as_str(), "check_program" | "check_answer" | "story_analysis") {
                let options: Result<AskedOptions, _> = serde_json::from_str(&call.inputs[2]);
                n += usize::from(black_box(options).is_ok());
                n += usize::from(black_box(CatalogSnapshot::load(&form::read_json_text(&call.inputs[1]))).is_ok());
            }
        }
        n
    }

    fn outputs(&self, engine: bool) -> usize {
        let mut n = 0;
        for output in self.outputs.iter().filter(|output| output.engine == engine) {
            n += match &output.serialised {
                Serialised::Step(step) => black_box(to_sorted_json(step)).len(),
                Serialised::Value { value, external } => {
                    let bytes = to_sorted_json(value);
                    black_box(if *external { form::external_bytes(bytes) } else { bytes }).len()
                }
            };
        }
        n
    }

    fn env_requests(&self) -> usize {
        self.env.iter().map(|e| black_box(serde_json::to_string(&env_services::request_json(&e.op.op())).expect("serialises")).len()).sum()
    }

    fn env_replies(&self) -> usize {
        let mut n = 0;
        for e in &self.env {
            let text = std::str::from_utf8(e.reply.as_bytes()).expect("UTF-8");
            let reply: Json = js_string::from_json_text(text).expect("the reply is JSON");
            let value = reply.get("value").cloned().unwrap_or(Json::Null);
            n += match e.op.reply_type() {
                ReplyType::Zoned => usize::from(black_box(serde_json::from_value::<Option<ZonedFields>>(value)).is_ok()),
                ReplyType::Url => usize::from(black_box(serde_json::from_value::<Option<UrlParts>>(value)).is_ok()),
                ReplyType::Text => usize::from(black_box(serde_json::from_value::<String>(value)).is_ok()),
            };
        }
        n
    }
}

/// The median of `passes` passes, in ms, at least `min_ms` of passes in all.
fn time(min_ms: f64, mut pass: impl FnMut() -> usize) -> f64 {
    let mut samples = Vec::new();
    let mut spent = 0.0;
    // One untimed pass first: the allocator's and the caches' warm-up.
    black_box(pass());
    while samples.len() < 5 || (spent < min_ms && samples.len() < 2000) {
        let start = host::now_ms();
        black_box(pass());
        let ms = host::now_ms() - start;
        spent += ms;
        samples.push(ms);
    }
    samples.sort_by(f64::total_cmp);
    samples[samples.len() / 2]
}

fn main() {
    let capture: Capture = serde_json::from_str(&host::input()).expect("the capture reads");
    let run = capture.run.clone();
    let replay = Replay::new(capture);
    let min_ms = 200.0;
    let env_calls = replay.env.len();
    let result = json!({
        "run": run,
        "target": if cfg!(target_arch = "wasm32") { "wasm32" } else { "native" },
        "ms": {
            "engine.inputs": time(min_ms, || replay.engine_inputs()),
            "engine.catalog": time(min_ms, || replay.engine_catalogs()),
            "engine.outputs": time(min_ms, || replay.outputs(true)),
            "env.requests": if env_calls == 0 { 0.0 } else { time(min_ms, || replay.env_requests()) },
            "env.replies": if env_calls == 0 { 0.0 } else { time(min_ms, || replay.env_replies()) },
            "checker.inputs": time(min_ms, || replay.checker_inputs()),
            "checker.outputs": time(min_ms, || replay.outputs(false)),
        },
        "envCalls": env_calls,
    });
    host::emit(&result.to_string());
}

#[cfg(not(target_arch = "wasm32"))]
mod host {
    use std::sync::OnceLock;
    use std::time::Instant;

    static EPOCH: OnceLock<Instant> = OnceLock::new();

    pub fn now_ms() -> f64 {
        EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
    }

    pub fn input() -> String {
        let path = std::env::args().nth(1).expect("usage: wasm_boundary_replay <capture.json>");
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    pub fn emit(line: &str) {
        println!("{line}");
    }
}

#[cfg(target_arch = "wasm32")]
mod host {
    #[link(wasm_import_module = "bench")]
    unsafe extern "C" {
        fn now() -> f64;
        fn input_len() -> u32;
        fn input_read(ptr: *mut u8);
        fn output(ptr: *const u8, len: u32);
    }

    pub fn now_ms() -> f64 {
        unsafe { now() }
    }

    pub fn input() -> String {
        let mut bytes = vec![0u8; unsafe { input_len() } as usize];
        unsafe { input_read(bytes.as_mut_ptr()) };
        String::from_utf8(bytes).expect("the capture is UTF-8")
    }

    pub fn emit(line: &str) {
        unsafe { output(line.as_ptr(), u32::try_from(line.len()).expect("fits")) };
    }
}

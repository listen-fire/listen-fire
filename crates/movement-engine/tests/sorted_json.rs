//! `to_sorted_json` writes, for the engine's outputs, the bytes the `Value`
//! path wrote before it (`to_value`, then `to_vec`): every frozen case and
//! every oracle case, each as a value, as a finished step and as a pending
//! request's arguments, and the protocol's refusal. (The steps the engine's
//! own runs produce are held to it where its tests drive a segment:
//! `assert_written_as_through_value`.)
//!
//!   cargo test -p listen-fire-engine --test sorted_json

use movement_engine::executor::{PendingRequest, Step};
use movement_parser::to_sorted_json;
use serde::Serialize;
use serde_json::{Value as Json, json};

/// What `to_sorted_json` wrote before: the oracle.
fn through_value<T: Serialize>(value: &T) -> Vec<u8> {
    let value = serde_json::to_value(value).expect("representable as JSON");
    serde_json::to_vec(&value).expect("a Value always serialises")
}

fn same<T: Serialize>(what: &str, value: &T) {
    let (old, new) = (through_value(value), to_sorted_json(value));
    if old != new {
        panic!("{what}:\n  Value path {}\n  writer     {}", String::from_utf8_lossy(&old), String::from_utf8_lossy(&new));
    }
}

/// `value` alone, as a run's end, as a request's arguments, and the
/// envelopes the ABI wraps around a value.
fn every_way(what: &str, value: &Json) {
    same(what, value);
    same(what, &Step::Done(value.clone()));
    let request = |id, args: &Json| PendingRequest { id, family: "adapters", method: "call".into(), args: args.clone() };
    same(what, &Step::Pending(vec![request(1, value), request(2, &json!({ "zeta": value, "alpha": [value] }))]));
    same(what, &json!({ "error": { "message": what, "detail": value } }));
}

fn corpus(path: &str) -> String {
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

#[test]
fn every_frozen_case_writes_as_the_value_path_wrote_it() {
    let mut cases = 0;
    for name in ["chunks", "file_bound", "mixed_sort", "regex", "stdlib"] {
        for line in corpus(&format!("frozen/{name}.jsonl")).lines() {
            // As the frozen tests read a case: a lone surrogate's escape in the engine's form.
            let case: Json = movement_engine::js_string::from_json_text(line).unwrap_or_else(|e| panic!("{name}: {e}"));
            every_way(name, &case);
            cases += 1;
        }
    }
    assert!(cases > 20_000, "only {cases} frozen cases");
}

#[test]
fn every_oracle_case_writes_as_the_value_path_wrote_it() {
    let patterns: Json = serde_json::from_str(&corpus("oracle/patterns.json")).unwrap();
    every_way("patterns", &patterns);
    let cases = patterns["cases"].as_array().unwrap();
    assert!(cases.len() > 300, "only {} pattern cases", cases.len());
    for case in cases {
        every_way(case["pattern"].as_str().unwrap_or("a pattern"), case);
    }
    for path in ["oracle/order_limit.json", "oracle/priced.json", "env/fixture.json", "env/versions.json"] {
        let corpus: Json = serde_json::from_str(&corpus(path)).unwrap();
        every_way(path, &corpus);
        for case in corpus.as_array().into_iter().flatten() {
            every_way(path, case);
        }
    }
}

#[test]
fn a_protocol_refusal_writes_as_the_value_path_wrote_it() {
    for message in ["", "request 3 was answered with no segment running", "\"quoted\" \\ é 😀 \u{FDD0}\u{1}"] {
        same(message, &json!({ "error": { "message": message } }));
    }
    same("an empty step", &Step::Pending(vec![]));
}

//! The service's answers on the handbook's examples, blessed: what the wasm's
//! `language_query` and its TypeScript binding are held to
//! (packages/handbook/__test__/language_service_parity.unit.test.ts reads the
//! same files). tests/handbook/generate.ts writes the corpus; a change to an
//! answer is re-blessed with
//! `LF_BLESS=1 cargo test -p listen-fire-language --test handbook_parity`.
//!
//! answers.json: `{lists, programs: [{construct, probes: [{at, complete:
//! {items, word}, codeActions, hover?, definition?}]}]}`, hover and
//! definition asked only at each line's first identifier. Completion lists
//! repeat across probes, so each is written once in `lists` and a probe's
//! `complete.items` is its index there. The docs link's versioned base is
//! written `<docs>`, so a release does not re-bless.

use std::path::{Path, PathBuf};

use movement_language::abi::{Query, answer};
use movement_language::{Pos, Range, Service, docs_base};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::{Value, json};

fn corpus() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/handbook")
}

/// Where a probe asks: after each `.`, `-[`, backtick, `using ` and `{ `,
/// and at the first identifier of each line. Only that first identifier is
/// also asked for its hover and definition (`true`).
fn probes(source: &str) -> Vec<(Pos, bool)> {
    let mut found = Vec::new();
    for (line, text) in source.split('\n').enumerate() {
        let at = |byte: usize| Pos { line: line as u32, character: text[..byte].encode_utf16().count() as u32 };
        if let Some(first) = text.char_indices().find(|(_, c)| c.is_alphabetic() || *c == '_').map(|(byte, _)| byte) {
            found.push((at(first), true));
        }
        for (byte, c) in text.char_indices() {
            if c == '.' || c == '`' {
                found.push((at(byte + 1), false));
            }
            for marker in ["-[", "using ", "{ "] {
                if text[byte..].starts_with(marker) {
                    found.push((at(byte + marker.len()), false));
                }
            }
        }
    }
    // A position probed both ways keeps its hover and definition.
    found.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    found.dedup_by(|later, kept| later.0 == kept.0);
    found
}

fn pos_json(pos: Pos) -> Value {
    json!({ "line": pos.line, "character": pos.character })
}

/// Every answer in `answers.json`'s form.
fn answers() -> (Value, usize) {
    let catalog: Value = serde_json::from_str(&std::fs::read_to_string(corpus().join("catalog.json")).unwrap()).unwrap();
    let programs: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(corpus().join("programs.json")).unwrap()).unwrap();
    let plain = Service::new(CatalogSnapshot::load(&catalog.to_string()).unwrap());
    let docs = docs_base();
    let unversioned = |value: Value| -> Value { serde_json::from_str(&value.to_string().replace(&docs, "<docs>")).unwrap() };
    let mut lists: Vec<Value> = Vec::new();
    let mut probed = 0;
    let mut out = Vec::new();
    for program in &programs {
        let source = program["source"].as_str().unwrap();
        let with_files;
        let service = match program.get("files").and_then(Value::as_object) {
            Some(files) => {
                let mut catalog = catalog.clone();
                catalog["files"] = files.iter().map(|(path, text)| (path.clone(), json!({ "source": text }))).collect();
                with_files = Service::new(CatalogSnapshot::load(&catalog.to_string()).unwrap());
                &with_files
            }
            None => &plain,
        };
        let mut asked = Vec::new();
        for (at, first) in probes(source) {
            probed += 1;
            let completed = unversioned(answer(service, source, Query::Complete(at)));
            let items = completed["items"].clone();
            let index = match lists.iter().position(|l| *l == items) {
                Some(index) => index,
                None => {
                    lists.push(items);
                    lists.len() - 1
                }
            };
            let mut probe = json!({
                "at": pos_json(at),
                "complete": { "items": index, "word": completed["word"] },
                "codeActions": answer(service, source, Query::CodeActions(Range { start: at, end: at })),
            });
            if first {
                probe["hover"] = unversioned(answer(service, source, Query::Hover(at)));
                probe["definition"] = answer(service, source, Query::Definition(at));
            }
            asked.push(probe);
        }
        out.push(json!({ "construct": program["construct"], "probes": asked }));
    }
    (json!({ "lists": lists, "programs": out }), probed)
}

/// One list, and one probe, per line: a re-bless reads as a diff of answers.
fn written(answers: &Value) -> String {
    let line = |v: &Value| String::from_utf8(movement_parser::to_sorted_json(v)).unwrap();
    let mut out = String::from("{\n\"lists\": [\n");
    let lists = answers["lists"].as_array().unwrap();
    out.push_str(&lists.iter().map(line).collect::<Vec<_>>().join(",\n"));
    out.push_str("\n],\n\"programs\": [\n");
    let programs: Vec<String> = answers["programs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let probes: Vec<String> = p["probes"].as_array().unwrap().iter().map(line).collect();
            format!("{{\"construct\": {},\n\"probes\": [\n{}\n]}}", line(&p["construct"]), probes.join(",\n"))
        })
        .collect();
    out.push_str(&programs.join(",\n"));
    out.push_str("\n]\n}\n");
    out
}

#[test]
fn the_service_answers_the_handbook_as_blessed() {
    let (answers, probed) = answers();
    let path = corpus().join("answers.json");
    let text = written(&answers);
    if std::env::var_os("LF_BLESS").is_some() {
        std::fs::write(&path, &text).unwrap();
        eprintln!("blessed {} probes over {} programs", probed, answers["programs"].as_array().unwrap().len());
        return;
    }
    let blessed = std::fs::read_to_string(&path).expect("answers.json is missing: bless it with LF_BLESS=1");
    let blessed: Value = serde_json::from_str(&blessed).unwrap();
    assert_eq!(blessed["lists"].as_array().map(Vec::len), answers["lists"].as_array().map(Vec::len), "the completion lists differ: re-bless if the change is intended");
    for (index, (was, now)) in blessed["lists"].as_array().unwrap().iter().zip(answers["lists"].as_array().unwrap()).enumerate() {
        assert_eq!(was, now, "completion list {index} differs");
    }
    let (was, now) = (blessed["programs"].as_array().unwrap(), answers["programs"].as_array().unwrap());
    assert_eq!(was.len(), now.len(), "the corpus changed: re-bless");
    for (was, now) in was.iter().zip(now) {
        assert_eq!(was["construct"], now["construct"]);
        assert_eq!(was["probes"].as_array().map(Vec::len), now["probes"].as_array().map(Vec::len), "{}: the probes differ", now["construct"]);
        for (a, b) in was["probes"].as_array().unwrap().iter().zip(now["probes"].as_array().unwrap()) {
            assert_eq!(a, b, "{} at {}", now["construct"], b["at"]);
        }
    }
    assert!(probed > 1000, "only {probed} probes");
}

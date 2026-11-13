//! `to_sorted_json` writes, for every value the parser hands across the
//! boundary, the bytes the `Value` path wrote before it (`to_value`, then
//! `to_vec`): every corpus program, typed and as the ABI's value, plain and
//! eager; every expression slot of the frozen harvest; and the catalog
//! fixtures, read into the catalog's types (whose maps keep the text's
//! order).
//!
//!   cargo test -p listen-fire-parser --test sorted_json

use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::to_sorted_json;
use serde::{Deserialize, Serialize};

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

/// Run on a stack with room for the deepest tree's recursion, as the
/// parser's own corpus tests do.
fn roomy(test: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new().stack_size(256 << 20).spawn(test).unwrap().join().unwrap();
}

#[derive(Deserialize)]
struct Program {
    origin: String,
    source: String,
}

#[test]
fn every_corpus_program_writes_as_the_value_path_wrote_it() {
    roomy(|| {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/programs_v5.json")).unwrap();
        let programs: Vec<Program> = text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect();
        assert!(programs.len() >= 500, "only {} programs", programs.len());
        for Program { origin, source } in &programs {
            for eager in [false, true] {
                match movement_parser::stmt::parse_program(source, eager) {
                    Ok(program) => same(origin, &program),
                    Err(error) => same(origin, &error),
                }
            }
            same(origin, &movement_parser::parse_program(source));
            same(origin, &movement_parser::parse_program_eager(source));
        }
    });
}

#[derive(Deserialize)]
struct Slot {
    raw: String,
}

#[test]
fn every_expression_slot_writes_as_the_value_path_wrote_it() {
    roomy(|| {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/expression_slots.json")).unwrap();
        let slots: Vec<Slot> = serde_json::from_str(&text).unwrap();
        assert!(slots.len() > 1000, "only {} slots", slots.len());
        for Slot { raw } in &slots {
            match movement_parser::expr::parse_expression(raw) {
                Ok(tree) => same(raw, &tree),
                Err(error) => same(raw, &error),
            }
            same(raw, &movement_parser::parse_expression(raw));
        }
    });
}

/// A chain at the tree's limit is the deepest tree the parser hands out.
#[test]
fn the_deepest_trees_write_as_the_value_path_wrote_them() {
    roomy(|| {
        let limit = movement_parser::tree::MAX_CHAIN - 1;
        for text in [
            format!("a{}", ".b".repeat(limit)),
            format!("a{}", " + a".repeat(limit)),
            format!("a{}", ".f()".repeat(limit / 2)),
            format!("a{}", "-[:e]->".repeat(limit)),
            format!("{}a{}", "(".repeat(100), ")".repeat(100)),
        ] {
            let tree = movement_parser::expr::parse_expression(&text).unwrap_or_else(|e| panic!("{e:?}"));
            same("a deep tree", &tree);
        }
        let source = format!("{}x = 1{}", "if a {\n".repeat(100), "\n}".repeat(100));
        same("a deep program", &movement_parser::parse_program_eager(&source));
    });
}

#[test]
fn every_catalog_fixture_writes_as_the_value_path_wrote_it() {
    for path in [
        "../movement-language/tests/handbook/catalog.json",
        "../movement-language/tests/fixtures/service/catalog.json",
        "../movement-checker/tests/fixtures/story/catalog.json",
    ] {
        let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        same(path, &serde_json::from_str::<serde_json::Value>(&text).unwrap());
        let snapshot = CatalogSnapshot::load(&text).unwrap_or_else(|e| panic!("{path}: {e}"));
        assert!(!snapshot.adapters.is_empty(), "{path} has no adapters");
        same(path, &snapshot.plugins);
        same(path, &snapshot.files);
        for adapter in snapshot.adapters.values() {
            same(path, &adapter.spec);
            same(path, &adapter.schemas);
            same(path, &adapter.schema_notes);
            same(path, &adapter.construction_arg_options);
        }
    }
}

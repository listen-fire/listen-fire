//! `vocabulary.json` → `data.rs`. The JSON is the one place a human edits the
//! vocabulary; `data.rs` is its Rust spelling, so reading it costs the WASM
//! nothing. A family function is written as its name and parameters: its id,
//! signature and arity are derived here, so they cannot disagree.
//!
//! `cargo run -p listen-fire-parser --features generate --bin gen-vocabulary`
//! rewrites `data.rs`; the test below fails while the committed file differs.

use serde::Deserialize;
use std::fmt::Write;

pub const SOURCE_PATH: &str = "src/lowering/vocabulary/vocabulary.json";
pub const DATA_PATH: &str = "src/lowering/vocabulary/data.rs";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    ai_tiers: Vec<String>,
    file: File,
    read: Read,
    options: Vec<Options>,
    families: Vec<Family>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    #[serde(rename = "fn")]
    fn_: String,
    signature: String,
    artifact_types: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    #[serde(rename = "fn")]
    fn_: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Options {
    #[serde(rename = "fn")]
    fn_: String,
    signature: String,
    arity: usize,
    index: usize,
    options: Vec<OptionSpec>,
    #[serde(default)]
    exactly_one: Vec<ExactlyOne>,
    agree: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OptionSpec {
    key: String,
    #[serde(rename = "type")]
    type_: OptionType,
    #[serde(default)]
    required: bool,
    summary: String,
    values: Option<Vec<String>>,
    /// `[value, message]` pairs: an object would lose their order.
    unavailable: Option<Vec<(String, String)>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum OptionType {
    Number,
    Text,
    Literal,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExactlyOne {
    keys: Vec<String>,
    what: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Family {
    namespace: String,
    functions: Vec<FamilyFunction>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FamilyFunction {
    name: String,
    /// As the signature writes them; a trailing `?` marks an optional one.
    params: Vec<String>,
}

const HEADER: &str = "\
// Generated from vocabulary.json by generate.rs (`cargo run -p listen-fire-parser
// --features generate --bin gen-vocabulary`). Do not edit: change the JSON,
// regenerate, then rebuild the WASM.

use super::{Arity, ExactlyOne, Family, FamilyFunction, FileContract, OptionSpec, OptionType, OptionsContract, ReadContract, Vocabulary};
";

/// A Rust string literal; `str`'s `Debug` escapes exactly what one needs.
fn lit(s: &str) -> String {
    format!("{s:?}")
}

fn slice(items: &[String]) -> String {
    format!("&[{}]", items.iter().map(|s| lit(s)).collect::<Vec<_>>().join(", "))
}

/// The Rust source of `data.rs` for a `vocabulary.json`.
pub fn generate(json: &str) -> Result<String, String> {
    let source: Source = serde_json::from_str(json).map_err(|e| format!("vocabulary.json: {e}"))?;
    let mut out = String::from(HEADER);
    let w = &mut out;
    // `write!` into a String cannot fail.
    let _ = writeln!(w, "\npub static VOCABULARY: Vocabulary = Vocabulary {{");
    let _ = writeln!(w, "    ai_tiers: {},", slice(&source.ai_tiers));
    let f = &source.file;
    let _ = writeln!(
        w,
        "    file: FileContract {{ fn_: {}, signature: {}, artifact_types: {} }},",
        lit(&f.fn_),
        lit(&f.signature),
        slice(&f.artifact_types)
    );
    let _ = writeln!(w, "    read: ReadContract {{ fn_: {}, signature: {} }},", lit(&source.read.fn_), lit(&source.read.signature));
    let _ = writeln!(w, "    options: &[");
    for contract in &source.options {
        write_options(w, contract);
    }
    let _ = writeln!(w, "    ],");
    let _ = writeln!(w, "    families: &[");
    for family in &source.families {
        write_family(w, family)?;
    }
    let _ = writeln!(w, "    ],");
    let _ = writeln!(w, "}};");
    Ok(out)
}

fn write_options(w: &mut String, c: &Options) {
    let _ = writeln!(w, "        OptionsContract {{");
    let _ = writeln!(w, "            fn_: {},", lit(&c.fn_));
    let _ = writeln!(w, "            signature: {},", lit(&c.signature));
    let _ = writeln!(w, "            arity: {},", c.arity);
    let _ = writeln!(w, "            index: {},", c.index);
    let _ = writeln!(w, "            options: &[");
    for o in &c.options {
        let type_ = match o.type_ {
            OptionType::Number => "Number",
            OptionType::Text => "Text",
            OptionType::Literal => "Literal",
        };
        let values = o.values.as_ref().map_or("None".to_string(), |v| format!("Some({})", slice(v)));
        let unavailable = o.unavailable.as_ref().map_or("None".to_string(), |pairs| {
            let pairs: Vec<String> = pairs.iter().map(|(value, message)| format!("({}, {})", lit(value), lit(message))).collect();
            format!("Some(&[{}])", pairs.join(", "))
        });
        let _ = writeln!(w, "                OptionSpec {{");
        let _ = writeln!(w, "                    key: {},", lit(&o.key));
        let _ = writeln!(w, "                    type_: OptionType::{type_},");
        let _ = writeln!(w, "                    required: {},", o.required);
        let _ = writeln!(w, "                    summary: {},", lit(&o.summary));
        let _ = writeln!(w, "                    values: {values},");
        let _ = writeln!(w, "                    unavailable: {unavailable},");
        let _ = writeln!(w, "                }},");
    }
    let _ = writeln!(w, "            ],");
    let exactly_one: Vec<String> =
        c.exactly_one.iter().map(|e| format!("ExactlyOne {{ keys: {}, what: {} }}", slice(&e.keys), lit(&e.what))).collect();
    let _ = writeln!(w, "            exactly_one: &[{}],", exactly_one.join(", "));
    let _ = writeln!(w, "            // The cross-option rule is code; this names the one call_shape::agree carries.");
    let agree = c.agree.as_ref().map_or("None".to_string(), |rule| format!("Some({})", lit(rule)));
    let _ = writeln!(w, "            agree: {agree},");
    let _ = writeln!(w, "        }},");
}

fn write_family(w: &mut String, family: &Family) -> Result<(), String> {
    let _ = writeln!(w, "        Family {{");
    let _ = writeln!(w, "            namespace: {},", lit(&family.namespace));
    let _ = writeln!(w, "            functions: &[");
    for f in &family.functions {
        let required = f.params.iter().take_while(|p| !p.ends_with('?')).count();
        if f.params[required..].iter().any(|p| !p.ends_with('?')) {
            return Err(format!("{}.{}: a required parameter follows an optional one", family.namespace, f.name));
        }
        let id = format!("{}.{}", family.namespace, f.name).to_lowercase();
        let signature = format!("{}.{}({})", family.namespace, f.name, f.params.join(", "));
        let _ = writeln!(
            w,
            "                FamilyFunction {{ name: {}, id: {}, signature: {}, arity: Arity {{ min: {required}, max: {} }} }},",
            lit(&f.name),
            lit(&id),
            lit(&signature),
            f.params.len()
        );
    }
    let _ = writeln!(w, "            ],");
    let _ = writeln!(w, "        }},");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The committed `data.rs` is what `vocabulary.json` generates: an edit to
    /// one without regenerating the other fails here.
    #[test]
    fn the_committed_data_is_what_the_source_generates() {
        let generated = generate(include_str!("vocabulary.json")).unwrap();
        assert!(
            generated == include_str!("data.rs"),
            "{DATA_PATH} is not what {SOURCE_PATH} generates; run \
             `cargo run -p listen-fire-parser --features generate --bin gen-vocabulary`"
        );
    }

    #[test]
    fn an_unknown_key_is_refused() {
        let json = include_str!("vocabulary.json").replacen("\"ai_tiers\"", "\"ai_tier\"", 1);
        assert!(generate(&json).unwrap_err().starts_with("vocabulary.json: unknown field `ai_tier`"));
    }

    #[test]
    fn a_required_parameter_after_an_optional_one_is_refused() {
        let json = include_str!("vocabulary.json").replacen("[\"text\", \"pattern\", \"group?\"]", "[\"text\", \"group?\", \"pattern\"]", 1);
        assert_eq!(generate(&json).unwrap_err(), "TEXT.REGEX_EXTRACT: a required parameter follows an optional one");
    }
}

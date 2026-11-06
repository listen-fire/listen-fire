//! A field type as a program writes it: the one spelling the catalog's type
//! (here) and the checker's (`Ty`, which has variants a schema does not) both
//! go through, so the two cannot drift.
//!
//! The parser's written type grammar (`read_param_type`,
//! `read_value_type_member`, `read_null_suffix` in `crate::stmt`) has these
//! forms, spelled here exactly so: a name (`text`), a list (`text[]`), `| null`
//! on a name (`text | null`), a union of names (`A | B`), keys
//! (`{ a: text, b?: number }`) and a closure (`(c: <A>) => <text>`).
//!
//! Some types have no form in that grammar. They take the nearest spelling:
//!
//! - `| null` or `|` under or over a list (`text[] | null`, `(text | null)[]`):
//!   the grammar's own two forms put together, as TypeScript writes them.
//! - An enum: `"a" | "b"`, as a program declares a closed set of texts
//!   (`type T = <"a" | "b">`), each value as the parser's string literal reads
//!   it. `…` comes last when other values are legal too, and `…+3` counts the
//!   options cut; neither is a program's. In a list it takes parentheses, as
//!   any union does: `("a" | "b")[]`.
//! - A type its module names, or a record a field holds: that name, as a
//!   program writes a name.
//! - A record nobody can name: `record`.
//! - A dict with no keys known: `dict(text)`, in the form enum has.
//! - A tuple: `[text, number]`, a run in it `...text[]`, as TypeScript writes one.

use crate::catalog::types::{Composite, FieldType, PositionRef, Scalar};
use crate::stmt::spell_name;

/// A type's written form, not yet spelled.
#[derive(Debug, Clone, PartialEq)]
pub enum WrittenType {
    Name(String),
    /// What has no name and no form: said in words, as they are.
    Words(String),
    /// Where a slot could not be typed: `?`.
    Unknown,
    Null,
    List(Box<WrittenType>),
    /// Two or more members, `null` last. Build with `WrittenType::union`.
    Union(Vec<WrittenType>),
    /// Build with `WrittenType::keys`.
    Keys(Vec<WrittenKey>),
    Closure { params: Vec<(String, WrittenType)>, returns: Box<WrittenType> },
    Tuple { slots: Vec<WrittenType>, rest: Option<WrittenRest> },
    Dict(Box<WrittenType>),
    Enum { options: Vec<String>, open: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub struct WrittenKey {
    pub name: String,
    pub optional: bool,
    pub type_: WrittenType,
}

/// A tuple's run of any length: where it starts, and what it holds.
#[derive(Debug, Clone, PartialEq)]
pub struct WrittenRest {
    pub at: usize,
    pub of: Box<WrittenType>,
}

impl WrittenType {
    pub fn name(name: impl Into<String>) -> WrittenType {
        WrittenType::Name(name.into())
    }

    /// `T | U`: nested unions flattened, each member once, `null` last, as a
    /// program writes one whichever way round its parts were built.
    pub fn union(members: impl IntoIterator<Item = WrittenType>) -> WrittenType {
        fn add(member: WrittenType, flat: &mut Vec<WrittenType>) {
            match member {
                WrittenType::Union(inner) => inner.into_iter().for_each(|m| add(m, flat)),
                other if flat.contains(&other) => {}
                other => flat.push(other),
            }
        }
        let mut flat = Vec::new();
        members.into_iter().for_each(|member| add(member, &mut flat));
        let null = flat.iter().position(|m| *m == WrittenType::Null).map(|at| flat.remove(at));
        flat.extend(null);
        match flat.len() {
            0 => WrittenType::Unknown,
            1 => flat.remove(0),
            _ => WrittenType::Union(flat),
        }
    }

    /// `T | null`.
    pub fn or_null(of: WrittenType) -> WrittenType {
        WrittenType::union([of, WrittenType::Null])
    }

    /// `{ a: text, b?: number }`: a key that may be absent is the optional
    /// form, as a program's `b?: number` is `number | null`.
    pub fn keys(keys: impl IntoIterator<Item = (String, WrittenType)>) -> WrittenType {
        WrittenType::Keys(
            keys.into_iter()
                .map(|(name, type_)| match type_ {
                    WrittenType::Union(mut members) if members.last() == Some(&WrittenType::Null) => {
                        members.pop();
                        WrittenKey { name, optional: true, type_: WrittenType::union(members) }
                    }
                    type_ => WrittenKey { name, optional: false, type_ },
                })
                .collect(),
        )
    }

    /// The whole of it.
    pub fn spell(&self) -> String {
        self.spell_showing(None)
    }

    /// As `spell`, an enum showing at most `enum_options` of its options and
    /// counting the rest (`"a" | "b" | …+3`).
    pub fn spell_showing(&self, enum_options: Option<usize>) -> String {
        let spell = |type_: &WrittenType| type_.spell_showing(enum_options);
        match self {
            WrittenType::Name(name) => spell_name(name),
            WrittenType::Words(words) => words.clone(),
            WrittenType::Unknown => "?".to_string(),
            WrittenType::Null => "null".to_string(),
            WrittenType::List(of) => match &**of {
                WrittenType::Union(_) => format!("({})[]", spell(of)),
                WrittenType::Enum { options, open } if enum_parts(options, *open, enum_options).len() > 1 => format!("({})[]", spell(of)),
                WrittenType::Closure { .. } => format!("<{}>[]", spell(of)),
                _ => format!("{}[]", spell(of)),
            },
            WrittenType::Union(members) => members.iter().map(spell).collect::<Vec<_>>().join(" | "),
            WrittenType::Keys(keys) => {
                let keys: Vec<String> = keys.iter().map(|k| format!("{}{}: {}", spell_name(&k.name), if k.optional { "?" } else { "" }, spell(&k.type_))).collect();
                format!("{{ {} }}", keys.join(", "))
            }
            WrittenType::Closure { params, returns } => {
                let params: Vec<String> = params.iter().map(|(name, type_)| format!("{}: <{}>", spell_name(name), spell(type_))).collect();
                format!("({}) => <{}>", params.join(", "), spell(returns))
            }
            WrittenType::Tuple { slots, rest } => {
                let mut slots: Vec<String> = slots.iter().map(spell).collect();
                if let Some(rest) = rest {
                    slots.insert(rest.at.min(slots.len()), format!("...{}", spell(&WrittenType::List(rest.of.clone()))));
                }
                format!("[{}]", slots.join(", "))
            }
            WrittenType::Dict(of) => format!("dict({})", spell(of)),
            WrittenType::Enum { options, open } => match enum_parts(options, *open, enum_options) {
                parts if parts.is_empty() => "never".to_string(),
                parts => parts.join(" | "),
            },
        }
    }
}

/// An enum's options as string literals, then what says there are others.
fn enum_parts(options: &[String], open: bool, limit: Option<usize>) -> Vec<String> {
    let shown = limit.map_or(options.len(), |limit| limit.min(options.len()));
    let hidden = options.len() - shown;
    let more = if hidden > 0 { Some(format!("…+{hidden}")) } else { open.then(|| "…".to_string()) };
    options[..shown].iter().map(|option| string_literal(option)).chain(more).collect()
}

/// `value` as the parser's string literal reads it back (`lex_string`).
fn string_literal(value: &str) -> String {
    let mut literal = String::with_capacity(value.len() + 2);
    literal.push('"');
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => literal.push_str("\\\""),
            '\\' => literal.push_str("\\\\"),
            '\n' => literal.push_str("\\n"),
            '\t' => literal.push_str("\\t"),
            '\r' => literal.push_str("\\r"),
            '$' if chars.peek() == Some(&'{') => literal.push_str("\\$"),
            c => literal.push(c),
        }
    }
    literal.push('"');
    literal
}

impl From<&FieldType> for WrittenType {
    fn from(type_: &FieldType) -> WrittenType {
        let composite = match type_ {
            FieldType::Scalar(Scalar::Absent) => return WrittenType::Null,
            FieldType::Scalar(scalar @ (Scalar::Text | Scalar::Number | Scalar::Boolean | Scalar::Date | Scalar::Datetime | Scalar::File | Scalar::Json | Scalar::Never)) => {
                return WrittenType::name(scalar.name());
            }
            FieldType::Composite(composite) => composite,
        };
        let written = |of: &FieldType| WrittenType::from(of);
        match composite {
            Composite::List { of, .. } => WrittenType::List(Box::new(written(of))),
            Composite::Tuple { of, rest } => WrittenType::Tuple {
                slots: of.iter().map(|slot| slot.as_ref().map_or(WrittenType::Unknown, written)).collect(),
                rest: rest.as_ref().map(|rest| WrittenRest { at: rest.at.0 as usize, of: Box::new(rest.of.as_deref().map_or(WrittenType::Unknown, written)) }),
            },
            Composite::Dict { shape: Some(shape), .. } => WrittenType::keys(shape.iter().map(|(key, slot)| (key.clone(), slot.as_ref().map_or(WrittenType::Unknown, written)))),
            Composite::Dict { of, shape: None } => WrittenType::Dict(Box::new(written(of))),
            Composite::Enum { options, open } => WrittenType::Enum { options: options.clone(), open: open.is_some() },
            Composite::MaybeAbsent { of } => WrittenType::or_null(written(of)),
            Composite::Union { of } => WrittenType::union(of.iter().map(written)),
            Composite::Owned { name, .. } => WrittenType::name(name),
            Composite::Record { position } => match position.as_ref().and_then(PositionRef::name) {
                Some(name) => WrittenType::name(name),
                None => WrittenType::name("record"),
            },
        }
    }
}

/// `type_` as a program writes it.
pub fn spell_field_type(type_: &FieldType) -> String {
    WrittenType::from(type_).spell()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn field(value: serde_json::Value) -> FieldType {
        serde_json::from_value(value).unwrap()
    }

    fn spelled(value: serde_json::Value) -> String {
        spell_field_type(&field(value))
    }

    #[test]
    fn a_schema_type_is_spelled_as_a_program_writes_it() {
        for (type_, written) in [
            (json!("text"), "text"),
            (json!("datetime"), "datetime"),
            (json!("absent"), "null"),
            (json!("never"), "never"),
            (json!({ "kind": "list", "of": "text" }), "text[]"),
            (json!({ "kind": "list", "of": { "kind": "list", "of": "number" } }), "number[][]"),
            (json!({ "kind": "maybeAbsent", "of": "text" }), "text | null"),
            (json!({ "kind": "maybeAbsent", "of": { "kind": "list", "of": "text" } }), "text[] | null"),
            (json!({ "kind": "list", "of": { "kind": "maybeAbsent", "of": "text" } }), "(text | null)[]"),
            (json!({ "kind": "union", "of": ["text", "number"] }), "text | number"),
            (json!({ "kind": "union", "of": ["absent", "text"] }), "text | null"),
            (json!({ "kind": "maybeAbsent", "of": { "kind": "union", "of": ["text", "number"] } }), "text | number | null"),
            (json!({ "kind": "dict", "of": "json", "shape": { "a": "text", "b": { "kind": "maybeAbsent", "of": "number" }, "c d": null } }), "{ a: text, b?: number, `c d`: ? }"),
        ] {
            assert_eq!(spelled(type_), written);
        }
    }

    #[test]
    fn a_type_no_program_writes_takes_the_nearest_spelling() {
        for (type_, written) in [
            (json!({ "kind": "enum", "options": ["open", "paid"] }), r#""open" | "paid""#),
            (json!({ "kind": "enum", "options": ["open"], "open": {} }), r#""open" | …"#),
            (json!({ "kind": "enum", "options": [] }), "never"),
            (json!({ "kind": "list", "of": { "kind": "enum", "options": ["open", "paid"] } }), r#"("open" | "paid")[]"#),
            (json!({ "kind": "list", "of": { "kind": "enum", "options": ["open"] } }), r#""open"[]"#),
            (json!({ "kind": "list", "of": { "kind": "enum", "options": ["open"], "open": {} } }), r#"("open" | …)[]"#),
            (json!({ "kind": "maybeAbsent", "of": { "kind": "enum", "options": ["open", "paid"] } }), r#""open" | "paid" | null"#),
            (json!({ "kind": "owned", "name": "Cron", "owner": "cron" }), "Cron"),
            (json!({ "kind": "record" }), "record"),
            (json!({ "kind": "record", "position": { "kind": "position", "position": "Deal Row" } }), "`Deal Row`"),
            (json!({ "kind": "dict", "of": "text" }), "dict(text)"),
            (json!({ "kind": "tuple", "of": ["text", null] }), "[text, ?]"),
            (json!({ "kind": "tuple", "of": ["text"], "rest": { "at": 1, "of": "number" } }), "[text, ...number[]]"),
        ] {
            assert_eq!(spelled(type_), written);
        }
    }

    #[test]
    fn how_many_of_an_enums_options_show_is_the_callers() {
        let options = json!({ "kind": "enum", "options": ["a", "b", "c"] });
        let written = WrittenType::from(&field(options));
        assert_eq!(written.spell_showing(Some(2)), r#""a" | "b" | …+1"#);
        assert_eq!(written.spell_showing(Some(3)), r#""a" | "b" | "c""#);
        let open = WrittenType::from(&field(json!({ "kind": "enum", "options": ["a", "b", "c"], "open": {} })));
        assert_eq!(open.spell_showing(Some(2)), r#""a" | "b" | …+1"#);
        assert_eq!(open.spell_showing(Some(3)), r#""a" | "b" | "c" | …"#);
        let in_a_list = WrittenType::List(Box::new(written));
        assert_eq!(in_a_list.spell_showing(Some(0)), "…+3[]");
        assert_eq!(in_a_list.spell_showing(Some(1)), r#"("a" | …+2)[]"#);
    }

    /// Spelled, and read back by the parser's own string literal.
    #[test]
    fn an_enums_value_is_quoted_and_escaped_as_the_parsers_string_literal_reads_it() {
        for value in ["plain", "with \"quotes\"", "back\\slash", "line\nbreak", "tab\there", "return\rhere", "${not} an interpolation", "$ alone", "it's"] {
            let spelled = string_literal(value);
            match crate::expr::parse_expression_raw(&spelled) {
                Ok(crate::tree::MExpr::String { ref parts, .. }) => assert_eq!(*parts, [crate::tree::StringPart::Text(value.to_string())], "{spelled}"),
                other => panic!("{spelled}: {other:?}"),
            }
        }
    }

    /// The forms the module's head says are the grammar's, held to it: a
    /// spelling here that a program could not write would be a claim nothing checked.
    #[test]
    fn the_forms_said_to_be_a_programs_are_what_the_parser_reads() {
        let parses = |source: &str| crate::parse_program(source).is_ok();
        let takes = |marker: &str| format!("function f(x: {marker}) {{\n  return 1\n}}\n");
        for written in ["text", "text[]", "text[][]", "{ a: text, b?: number }", "A | B", "(c: <text>) => <text>"] {
            let source = takes(&format!("<{written}>"));
            assert!(parses(&source), "{source}");
        }
        assert!(parses(&takes("<(c: <text>) => <text>>[]")));
        assert!(parses("node N {\n  x: <text | null>\n}\n"));
        assert!(parses("type T = <\"a\" | \"b\">\n"));
        for written in ["text[] | null", "(text | null)[]", "dict(text)", "[text, number]"] {
            assert!(!parses(&takes(&format!("<{written}>"))), "the grammar reads {written} now: move it up in the module's head");
        }
    }
}

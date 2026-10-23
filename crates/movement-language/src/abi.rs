//! The service's C ABI answer, exported by the artifact that links this
//! crate (the engine's `movement.wasm`, from its own abi). Same conventions
//! as the checker's (`movement_checker::abi`): three UTF-8 inputs the caller
//! placed with `alloc` (source, catalog snapshot JSON, query JSON), the JSON
//! answer's pointer and length written to the two out slots, status 0, or
//! `{error}` and 1; the caller `dealloc`s the answer.
//!
//! A query is `{kind: "complete" | "hover" | "definition" | "codeActions",
//! position: {line, character}, range?}`, positions as the native service
//! counts them (0-based lines, UTF-16 columns). `range` is what code actions
//! are asked over; without it, the position. The answer is the native
//! `Service`'s, as JSON:
//! - complete: `{items: [{label, kind, detail?, insert?, replace?,
//!   connectAction?: {kind, adapter, credential?}}], word}`, `word` the range
//!   an item replaces when it carries no `replace` (the word before the cursor);
//! - hover: `{contents, range}` or null;
//! - definition: `{file, range, module?: {namespace, name}}` or null, `file`
//!   null for this file and a catalog file key for a library;
//! - codeActions: `[{title, edits: [{range, newText}], code, preferred}]`.

use movement_checker::host::ZoneLookup;
use movement_parser::abi::{install_panic_hook, utf8, write_out};
use movement_parser::catalog::types::CatalogSnapshot;
use serde_json::{Value, json};

use crate::text::{Text, trailing_word, utf16_len};
use crate::{Action, Item, ItemKind, Location, Pos, Range, Service, TextEdit};

/// What a position is asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Query {
    Complete(Pos),
    Hover(Pos),
    Definition(Pos),
    CodeActions(Range),
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AskedQuery {
    kind: AskedKind,
    position: AskedPos,
    #[serde(default)]
    range: Option<AskedRange>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
enum AskedKind {
    Complete,
    Hover,
    Definition,
    CodeActions,
}

#[derive(serde::Deserialize, Clone, Copy)]
#[serde(deny_unknown_fields)]
struct AskedPos {
    line: u32,
    character: u32,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AskedRange {
    start: AskedPos,
    end: AskedPos,
}

impl From<AskedPos> for Pos {
    fn from(p: AskedPos) -> Self {
        Pos { line: p.line, character: p.character }
    }
}

impl Query {
    /// A query's JSON, read.
    pub fn read(query_json: &str) -> Result<Query, String> {
        let asked: AskedQuery = serde_json::from_str(query_json).map_err(|e| format!("the language query does not read: {e}"))?;
        let at = Pos::from(asked.position);
        Ok(match asked.kind {
            AskedKind::Complete => Query::Complete(at),
            AskedKind::Hover => Query::Hover(at),
            AskedKind::Definition => Query::Definition(at),
            AskedKind::CodeActions => Query::CodeActions(match asked.range {
                Some(range) => Range { start: range.start.into(), end: range.end.into() },
                None => Range { start: at, end: at },
            }),
        })
    }
}

/// The service's answer to `query` on `source`, as JSON.
pub fn answer(service: &Service, source: &str, query: Query) -> Value {
    match query {
        Query::Complete(at) => {
            let items: Vec<Value> = service.complete(source, at).into_iter().map(item_json).collect();
            json!({ "items": items, "word": range_json(word_before(source, at)) })
        }
        Query::Hover(at) => service.hover(source, at).map_or(Value::Null, |h| json!({ "contents": h.contents, "range": range_json(h.range) })),
        Query::Definition(at) => service.definition(source, at).map_or(Value::Null, |found| location_json(&found)),
        Query::CodeActions(range) => Value::Array(service.code_actions(source, range).iter().map(action_json).collect()),
    }
}

/// `language_query`'s answer: the snapshot loaded as the checker loads it
/// (`movement_checker::check_json`), then the query answered; `{error}` for a
/// snapshot or a query that does not read.
pub fn language_query_json(source: &str, catalog_json: &str, query_json: &str, zones: &'static dyn ZoneLookup) -> Value {
    // Read as `JSON.parse` reads it: a lone surrogate's escape included.
    let catalog = match CatalogSnapshot::load(&movement_parser::util::form::read_json_text(catalog_json)) {
        Ok(catalog) => catalog,
        Err(message) => return json!({ "error": { "message": message } }),
    };
    let query = match Query::read(query_json) {
        Ok(query) => query,
        Err(message) => return json!({ "error": { "message": message } }),
    };
    answer(&Service::with_zones(catalog, zones), source, query)
}

/// `language_query(source, catalog snapshot JSON, query JSON)` against the
/// host's zone database: writes the answer and returns 0, or writes `{error}`
/// and returns 1. The artifact's C export is the engine's
/// (`movement_engine::abi`), which supplies its environment services as the
/// zone database.
///
/// # Safety
/// The three input ranges must be readable; the out slots writable.
#[allow(clippy::too_many_arguments)] // the C export's arguments, passed through
pub unsafe fn language_query_with(
    zones: &'static dyn ZoneLookup,
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    query_ptr: *const u8,
    query_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let read = || -> Result<(&str, &str, &str), Value> {
        let source = unsafe { utf8(src_ptr, src_len, "source") }?;
        let catalog = unsafe { utf8(catalog_ptr, catalog_len, "catalog") }?;
        let query = unsafe { utf8(query_ptr, query_len, "query") }?;
        Ok((source, catalog, query))
    };
    let answer = match read() {
        Ok((source, catalog, query)) => language_query_json(source, catalog, query, zones),
        Err(error) => json!({ "error": error }),
    };
    // Status 1 only for `{error}`: a hover with nothing to show is `null`.
    let status = u32::from(answer.as_object().is_some_and(|o| o.contains_key("error")));
    let bytes = movement_parser::util::form::external_bytes(movement_parser::to_sorted_json(&answer));
    unsafe { write_out(bytes, out_ptr_ptr, out_len_ptr) };
    status
}

/// The word before `at`, which an item without its own `replace` replaces.
fn word_before(source: &str, at: Pos) -> Range {
    let text = Text::new(source);
    let word = utf16_len(trailing_word(text.line_before(at))) as u32;
    Range { start: Pos { line: at.line, character: at.character.saturating_sub(word) }, end: at }
}

fn pos_json(pos: Pos) -> Value {
    json!({ "line": pos.line, "character": pos.character })
}

pub fn range_json(range: Range) -> Value {
    json!({ "start": pos_json(range.start), "end": pos_json(range.end) })
}

fn kind_name(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Variable => "variable",
        ItemKind::Function => "function",
        ItemKind::Field => "field",
        ItemKind::Edge => "edge",
        ItemKind::Module => "module",
        ItemKind::Keyword => "keyword",
        ItemKind::Property => "property",
        ItemKind::Credential => "credential",
        ItemKind::Type => "type",
        ItemKind::Namespace => "namespace",
    }
}

fn item_json(item: Item) -> Value {
    let mut value = json!({ "label": item.label, "kind": kind_name(item.kind) });
    if let Some(detail) = item.detail {
        value["detail"] = json!(detail);
    }
    if let Some(insert) = item.insert {
        value["insert"] = json!(insert);
    }
    if let Some(replace) = item.replace {
        value["replace"] = range_json(replace);
    }
    if let Some(action) = item.connect_action {
        let mut connect = json!({ "kind": action.kind, "adapter": action.adapter });
        if let Some(credential) = action.credential {
            connect["credential"] = json!(credential);
        }
        value["connectAction"] = connect;
    }
    value
}

fn location_json(found: &Location) -> Value {
    let mut value = json!({ "file": found.file, "range": range_json(found.range) });
    if let Some(module) = &found.module {
        value["module"] = json!({ "namespace": module.namespace.as_str(), "name": module.name });
    }
    value
}

fn edit_json(edit: &TextEdit) -> Value {
    json!({ "range": range_json(edit.range), "newText": edit.new_text })
}

fn action_json(action: &Action) -> Value {
    json!({ "title": action.title, "edits": action.edits.iter().map(edit_json).collect::<Vec<_>>(), "code": action.code, "preferred": action.preferred })
}

//! The engine's exports, beside the parser's (crates/movement-parser/src/
//! abi.rs, whose `alloc`, `dealloc` and `last_panic` this artifact shares and
//! whose conventions these follow: UTF-8 JSON in through `alloc`ed buffers,
//! UTF-8 JSON out through two out slots, status 0 or 1, the caller frees the
//! output).
//!
//! One instance runs one segment. `engine_start` begins it, `engine_answer`
//! hands it one answer, each returns the next `Step` (status 0) or
//! `{"error": {message}}` for a misuse of the protocol (status 1).
//! `engine_finish` drops the segment and everything it held; the loader then
//! discards the instance.

use std::cell::RefCell;

use movement_parser::abi::{install_panic_hook, utf8, write_out};
use movement_parser::to_sorted_json;
use serde_json::json;

use crate::executor::{ProtocolError, Segment, Step};

const OK: u32 = 0;
const ERROR: u32 = 1;

thread_local! {
    static SEGMENT: RefCell<Option<Segment>> = const { RefCell::new(None) };
}

/// # Safety
/// `input_ptr..input_ptr+input_len` must be readable; the out slots writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_start(
    input_ptr: *const u8,
    input_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let result = unsafe { utf8(input_ptr, input_len, "the input") }
        .map_err(|e| ProtocolError(e["message"].as_str().unwrap_or_default().to_string()))
        .and_then(start);
    unsafe { emit(result, out_ptr_ptr, out_len_ptr) }
}

/// `answer` is `{"value": …}`, `{}` (`undefined`) or `{"error": {message, …}}`.
///
/// # Safety
/// As `engine_start`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn engine_answer(
    id: u32,
    answer_ptr: *const u8,
    answer_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let result = unsafe { utf8(answer_ptr, answer_len, "the answer") }
        .map_err(|e| ProtocolError(e["message"].as_str().unwrap_or_default().to_string()))
        .and_then(|answer| answer_json(id, answer));
    unsafe { emit(result, out_ptr_ptr, out_len_ptr) }
}

#[unsafe(no_mangle)]
pub extern "C" fn engine_finish() {
    finish();
}

pub fn start(input: &str) -> Result<Step, ProtocolError> {
    if SEGMENT.with_borrow(Option::is_some) {
        return Err(ProtocolError("a segment is already running in this instance".into()));
    }
    let mut segment = crate::begin(input)?;
    let step = segment.start();
    SEGMENT.set(Some(segment));
    step
}

pub fn answer_json(id: u32, answer: &str) -> Result<Step, ProtocolError> {
    let answer = crate::read_answer(answer)?;
    SEGMENT.with_borrow_mut(|segment| match segment {
        Some(segment) => segment.answer(id, answer),
        None => Err(ProtocolError(format!("request {id} was answered with no segment running"))),
    })
}

pub fn finish() {
    // Taken out before it drops, so a future's drop that panics does not
    // leave the slot borrowed.
    drop(SEGMENT.take());
}

unsafe fn emit(result: Result<Step, ProtocolError>, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    let (status, bytes) = match result {
        Ok(step) => (OK, to_sorted_json(&step)),
        Err(ProtocolError(message)) => (ERROR, to_sorted_json(&json!({ "error": { "message": message } }))),
    };
    unsafe { write_out(bytes, out_ptr_ptr, out_len_ptr) };
    status
}


/// The checker's export (`movement_checker::abi::check_program_with`), its
/// zone database this engine's environment services.
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)] // the C ABI's arguments
pub unsafe extern "C" fn check_program(
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    options_ptr: *const u8,
    options_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    unsafe {
        movement_checker::abi::check_program_with(
            &crate::env_services::EnvZones,
            src_ptr,
            src_len,
            catalog_ptr,
            catalog_len,
            options_ptr,
            options_len,
            out_ptr_ptr,
            out_len_ptr,
        )
    }
}

/// The checker's `check.program` answer (`movement_checker::abi::check_answer_with`),
/// its zone database this engine's environment services.
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)] // the C ABI's arguments
pub unsafe extern "C" fn check_answer(
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    options_ptr: *const u8,
    options_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    unsafe {
        movement_checker::abi::check_answer_with(
            &crate::env_services::EnvZones,
            src_ptr,
            src_len,
            catalog_ptr,
            catalog_len,
            options_ptr,
            options_len,
            out_ptr_ptr,
            out_len_ptr,
        )
    }
}

/// The checker's `check.compatible` answer (`movement_checker::abi::check_compatible_with`).
///
/// # Safety
/// The input range must be readable; the out slots writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn check_compatible(request_ptr: *const u8, request_len: u32, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    unsafe { movement_checker::abi::check_compatible_with(request_ptr, request_len, out_ptr_ptr, out_len_ptr) }
}

/// The checker's built-in table (`movement_checker::abi::standard_library_with`).
///
/// # Safety
/// The out slots must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn standard_library(out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    unsafe { movement_checker::abi::standard_library_with(out_ptr_ptr, out_len_ptr) }
}

/// The checker's story analysis (`movement_checker::abi::story_analysis_with`),
/// its zone database this engine's environment services.
///
/// # Safety
/// The three input ranges must be readable; the out slots writable.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)] // the C ABI's arguments
pub unsafe extern "C" fn story_analysis(
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    options_ptr: *const u8,
    options_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    unsafe {
        movement_checker::abi::story_analysis_with(
            &crate::env_services::EnvZones,
            src_ptr,
            src_len,
            catalog_ptr,
            catalog_len,
            options_ptr,
            options_len,
            out_ptr_ptr,
            out_len_ptr,
        )
    }
}

/// The language service's answer (`movement_language::abi::language_query_with`),
/// its zone database this engine's environment services.
///
/// # Safety
/// The three input ranges must be readable; the out slots writable.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)] // the C ABI's arguments
pub unsafe extern "C" fn language_query(
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    query_ptr: *const u8,
    query_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    unsafe {
        movement_language::abi::language_query_with(
            &crate::env_services::EnvZones,
            src_ptr,
            src_len,
            catalog_ptr,
            catalog_len,
            query_ptr,
            query_len,
            out_ptr_ptr,
            out_len_ptr,
        )
    }
}

/// `language_version()`: the language this artifact reads, which is its
/// release's version (`movement_parser::version::LANGUAGE_VERSION`), as a
/// JSON string, and 0.
///
/// # Safety
/// The out slots must be writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn language_version(out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    install_panic_hook();
    unsafe { write_out(to_sorted_json(&json!(movement_parser::version::LANGUAGE_VERSION)), out_ptr_ptr, out_len_ptr) };
    OK
}

/// `language_standing(pin)`: how a pin stands against this artifact's
/// release, `{standing: "compatible" | "newer" | "olderKey" | "malformed",
/// message}` (the refusal's text, null when compatible), and 0; `{error}`
/// and 1 for a pin that is not text. A host asks this before choosing
/// whether to run a movement on this artifact.
///
/// # Safety
/// The input range must be readable; the out slots writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn language_standing(pin_ptr: *const u8, pin_len: u32, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    install_panic_hook();
    let (status, answer) = match unsafe { utf8(pin_ptr, pin_len, "the pin") } {
        Ok(pin) => (OK, standing_json(pin)),
        Err(error) => (ERROR, json!({ "error": error })),
    };
    unsafe { write_out(to_sorted_json(&answer), out_ptr_ptr, out_len_ptr) };
    status
}

fn standing_json(pin: &str) -> serde_json::Value {
    use movement_parser::version::{LANGUAGE_VERSION, Standing, refusal_message, standing};
    let standing = standing(pin, LANGUAGE_VERSION);
    let name = match standing {
        Standing::Compatible => "compatible",
        Standing::Newer => "newer",
        Standing::OlderKey => "olderKey",
        Standing::Malformed => "malformed",
    };
    json!({ "standing": name, "message": refusal_message(pin, LANGUAGE_VERSION, standing) })
}

#[cfg(test)]
mod tests {
    use movement_parser::abi::{alloc, dealloc, last_panic};
    use movement_parser::catalog::types::CatalogSnapshot;
    use serde_json::{Value as Json, json};

    use super::*;

    fn input(text: &str) -> (*mut u8, u32) {
        let len = u32::try_from(text.len()).unwrap();
        let ptr = alloc(len);
        unsafe { std::ptr::copy_nonoverlapping(text.as_ptr(), ptr, text.len()) };
        (ptr, len)
    }

    fn output(out_ptr: usize, out_len: usize) -> Json {
        let bytes = unsafe { std::slice::from_raw_parts(out_ptr as *const u8, out_len) }.to_vec();
        unsafe { dealloc(out_ptr as *mut u8, u32::try_from(out_len).unwrap()) };
        serde_json::from_slice(&bytes).unwrap()
    }

    fn call_start(text: &str) -> (u32, Json) {
        let (ptr, len) = input(text);
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe { engine_start(ptr, len, &mut out_ptr, &mut out_len) };
        unsafe { dealloc(ptr, len) };
        (status, output(out_ptr, out_len))
    }

    fn call_answer(id: u32, text: &str) -> (u32, Json) {
        let (ptr, len) = input(text);
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe { engine_answer(id, ptr, len, &mut out_ptr, &mut out_len) };
        unsafe { dealloc(ptr, len) };
        (status, output(out_ptr, out_len))
    }

    #[test]
    fn echo_round_trips_start_pending_answer_done() {
        let requests = json!({ "entry": "echo", "requests": [
            { "family": "adapters", "method": "credentialId", "args": { "credentialName": "crm" } },
            { "family": "echo", "method": "ping", "args": [1] },
        ] });
        let (status, step) = call_start(&requests.to_string());
        assert_eq!(status, OK);
        assert_eq!(
            step,
            json!({ "pending": [
                { "id": 1, "family": "adapters", "method": "credentialId", "args": { "credentialName": "crm" } },
                { "id": 2, "family": "echo", "method": "ping", "args": [1] },
            ] })
        );
        assert_eq!(call_answer(2, r#"{"error":{"message":"no ping"}}"#), (OK, json!({ "pending": [] })));
        assert_eq!(
            call_answer(1, r#"{"value":"cred-1"}"#),
            (OK, json!({ "done": { "answers": [{ "value": "cred-1" }, { "error": { "message": "no ping" } }] } }))
        );
        finish();
    }

    #[test]
    fn one_segment_per_instance_until_finish() {
        let echo = r#"{"entry":"echo","requests":[{"family":"echo","method":"m"}]}"#;
        assert_eq!(call_start(echo).0, OK);
        assert_eq!(
            call_start(echo),
            (ERROR, json!({ "error": { "message": "a segment is already running in this instance" } }))
        );
        finish();
        assert_eq!(call_start(echo).0, OK);
        finish();
        assert_eq!(
            call_answer(1, "{}"),
            (ERROR, json!({ "error": { "message": "request 1 was answered with no segment running" } }))
        );
    }

    #[test]
    fn bad_input_is_a_protocol_error() {
        assert_eq!(call_start("nope").0, ERROR);
        assert_eq!(call_start(r#"{"entry":"run"}"#), (ERROR, json!({ "error": { "message": "no entry `run`" } })));
        assert_eq!(call_start(r#"{"entry":"echo","requests":[{"family":"x","method":"m"}]}"#).0, ERROR);
        let (_, step) = call_start(r#"{"entry":"echo","requests":[{"family":"echo","method":"m"}]}"#);
        assert_eq!(step["pending"][0]["id"], 1);
        assert_eq!(call_answer(1, r#"{"value":1,"extra":2}"#).0, ERROR);
        assert_eq!(call_answer(1, r#"{"error":{}}"#).0, ERROR);
        finish();
    }

    #[test]
    fn the_standard_library_is_the_checker_table() {
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        let status = unsafe { standard_library(&mut out_ptr, &mut out_len) };
        assert_eq!(status, OK);
        let table = output(out_ptr, out_len);
        let rows = table.as_array().unwrap();
        assert_eq!(rows.len(), movement_checker::types::stdlib::STANDARD_LIBRARY.len());
        assert_eq!(
            rows[13],
            json!({
                "name": "SPLIT",
                "params": [{ "name": "text", "type": "text" }, { "name": "separator", "type": "text", "optional": true }],
                "returns": "list of text",
                "summary": "text cut into its trimmed, non-empty parts",
            })
        );
    }

    #[test]
    fn the_artifact_names_its_language_and_how_a_pin_stands_against_it() {
        let own = movement_parser::version::LANGUAGE_VERSION;
        let (mut out_ptr, mut out_len) = (0usize, 0usize);
        assert_eq!(unsafe { language_version(&mut out_ptr, &mut out_len) }, OK);
        assert_eq!(output(out_ptr, out_len), json!(own));
        let standing_of = |pin: &str| {
            let (ptr, len) = input(pin);
            let (mut out_ptr, mut out_len) = (0usize, 0usize);
            let status = unsafe { language_standing(ptr, len, &mut out_ptr, &mut out_len) };
            unsafe { dealloc(ptr, len) };
            (status, output(out_ptr, out_len))
        };
        assert_eq!(standing_of(own), (OK, json!({ "standing": "compatible", "message": null })));
        let (status, newer) = standing_of("99.0.0");
        assert_eq!((status, &newer["standing"]), (OK, &json!("newer")));
        assert_eq!(newer["message"], json!(format!("this automation pins language 99.0.0, newer than this release ({own}); upgrade the engine")));
        assert_eq!(standing_of("0.11.0").1["standing"], json!("olderKey"));
        assert_eq!(standing_of("5").1["standing"], json!("malformed"));
    }

    #[test]
    fn the_language_query_answers_the_native_service() {
        use movement_language::{Pos, Range, Service};
        let catalog = r#"{"adapters":{"slack":{"constructionArgs":[],"canFire":true,"connectActions":[{"kind":"picker","label":"Connect a channel"}],"schemas":{"":{"positions":{"channel":{"properties":{"Name":"text"},"edges":{}}},"collections":{"Channels":{"target":"channel"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;
        let source = "import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\nfunction scan(c: <chat-[:channel]->>) {\n  name = UPPER(c.Name)\n  return name\n}\n";
        let service = Service::new(CatalogSnapshot::load(catalog).unwrap());
        let ask = |query: Json| {
            let (src, src_len) = input(source);
            let (cat, cat_len) = input(catalog);
            let query = query.to_string();
            let (q, q_len) = input(&query);
            let (mut out_ptr, mut out_len) = (0usize, 0usize);
            let status = unsafe { language_query(src, src_len, cat, cat_len, q, q_len, &mut out_ptr, &mut out_len) };
            unsafe { (dealloc(src, src_len), dealloc(cat, cat_len), dealloc(q, q_len)) };
            (status, output(out_ptr, out_len))
        };
        let at = |line: u32, character: u32| Pos { line, character };
        let pos = |p: Pos| json!({ "line": p.line, "character": p.character });

        let completed = at(4, 17);
        let (status, answer) = ask(json!({ "kind": "complete", "position": pos(completed) }));
        assert_eq!(status, OK);
        let labels: Vec<&str> = answer["items"].as_array().unwrap().iter().map(|i| i["label"].as_str().unwrap()).collect();
        let native: Vec<String> = service.complete(source, completed).into_iter().map(|i| i.label).collect();
        assert_eq!(labels, native);
        assert_eq!(answer["items"][0], json!({ "label": "Name", "kind": "field", "detail": "text" }));
        assert_eq!(answer["word"], json!({ "start": pos(completed), "end": pos(completed) }));

        let hovered = at(4, 4);
        let (status, answer) = ask(json!({ "kind": "hover", "position": pos(hovered) }));
        assert_eq!(status, OK);
        assert_eq!(answer["contents"], json!(service.hover(source, hovered).unwrap().contents));

        let defined = at(1, 17);
        let (status, answer) = ask(json!({ "kind": "definition", "position": pos(defined) }));
        assert_eq!(status, OK);
        let native = service.definition(source, defined).unwrap();
        assert_eq!(answer["file"], Json::Null);
        assert_eq!(answer["range"]["start"], pos(native.range.start));
        assert_eq!(answer["module"], json!({ "namespace": "adapters", "name": "slack" }));

        let range = Range { start: at(4, 9), end: at(4, 9) };
        let (status, answer) = ask(json!({ "kind": "codeActions", "position": pos(range.start), "range": { "start": pos(range.start), "end": pos(range.end) } }));
        assert_eq!(status, OK);
        let titles: Vec<&str> = answer.as_array().unwrap().iter().map(|a| a["title"].as_str().unwrap()).collect();
        let native: Vec<String> = service.code_actions(source, range).into_iter().map(|a| a.title).collect();
        assert!(!native.is_empty());
        assert_eq!(titles, native);

        let (status, answer) = ask(json!({ "kind": "hover", "position": pos(at(2, 0)) }));
        assert_eq!((status, answer), (OK, Json::Null));
        let (status, answer) = ask(json!({ "kind": "rename", "position": pos(hovered) }));
        assert_eq!(status, ERROR);
        assert!(answer["error"]["message"].as_str().unwrap().starts_with("the language query does not read"), "{answer}");
    }

    #[test]
    fn the_story_analysis_is_the_checker_s() {
        let catalog = r#"{"adapters":{"slack":{"constructionArgs":[],"canFire":true,"schemas":{"":{"positions":{"channel":{"properties":{"Name":"text"},"edges":{}}},"collections":{"Channels":{"target":"channel"}},"writableRoots":{}}}}},"credentials":{},"plugins":{}}"#;
        let ask = |source: &str, options: &str| {
            let (src, src_len) = input(source);
            let (cat, cat_len) = input(catalog);
            let (opt, opt_len) = input(options);
            let (mut out_ptr, mut out_len) = (0usize, 0usize);
            let status = unsafe { story_analysis(src, src_len, cat, cat_len, opt, opt_len, &mut out_ptr, &mut out_len) };
            unsafe { (dealloc(src, src_len), dealloc(cat, cat_len), dealloc(opt, opt_len)) };
            (status, output(out_ptr, out_len))
        };
        let source = "import { `@lf/slack` as slack } from adapters\nchat = connect slack\n\nfunction scan(c: <chat-[:channel]->>) {\n  name = Text.upper(c.Name)\n  return name\n}\n";
        let (status, answer) = ask(source, "{}");
        assert_eq!(status, OK);
        let options = movement_checker::CheckOptions { upgrading_from: None, zones: &crate::env_services::EnvZones };
        assert_eq!(answer, movement_checker::story::story_analysis_json(source, catalog, options));
        assert_eq!(answer["storyAnalysisVersion"], json!(movement_checker::story::STORY_ANALYSIS_VERSION));
        assert!(answer["nodes"].as_array().unwrap().iter().any(|n| n["kind"] == "instance" && n["name"] == "chat"), "{answer}");

        let (status, answer) = ask("function (", "{}");
        assert_eq!(status, ERROR);
        assert!(answer["error"]["message"].is_string(), "{answer}");
        let (status, answer) = ask(source, r#"{"languageVersion":"0.12.0"}"#);
        assert_eq!(status, ERROR, "the options are the check's: {answer}");
    }

    #[test]
    fn a_panic_surfaces_through_last_panic() {
        install_panic_hook();
        // Natively a panic unwinds (the release build aborts, trapping the
        // instance); either way the hook has recorded it first.
        let caught = std::panic::catch_unwind(|| start(r#"{"entry":"panic","message":"boom 7"}"#));
        assert!(caught.is_err());
        let (mut ptr, mut len) = (0usize, 0usize);
        unsafe { last_panic(&mut ptr, &mut len) };
        let text = std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr as *const u8, len) }).unwrap();
        assert!(text.starts_with("panicked at crates/movement-engine/src/lib.rs:"), "{text}");
        assert!(text.ends_with("boom 7"), "{text}");
        finish();
    }
}

//! The checker's C ABI answer, exported by the WASM artifact that links this
//! crate (the engine's `movement.wasm`, from its own abi). Same conventions as the parser's
//! (`movement_parser::abi`): inputs are UTF-8 the caller placed with `alloc`,
//! the JSON answer's pointer and length go to the two out slots, and the
//! caller `dealloc`s it.

use movement_parser::abi::{install_panic_hook, utf8, write_out};

use crate::CheckOptions;

/// The options a check is asked with, as JSON: `{ "upgradingFrom": "0.11.0"
/// | null }` (the release a move up starts from). A check reads its own
/// release's language and takes no pin: the host holds a pin to the rule
/// before asking.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AskedOptions {
    #[serde(default)]
    upgrading_from: Option<String>,
}

/// The inputs a check reads: source, catalog and options, each as text.
///
/// # Safety
/// Each range must be readable.
unsafe fn inputs<'a>(source: (*const u8, u32), catalog: (*const u8, u32), options: (*const u8, u32)) -> Result<(&'a str, &'a str, AskedOptions), serde_json::Value> {
    let source = unsafe { utf8(source.0, source.1, "source") }?;
    let catalog = unsafe { utf8(catalog.0, catalog.1, "catalog") }?;
    let options = unsafe { utf8(options.0, options.1, "options") }?;
    let options = serde_json::from_str(options).map_err(|e| serde_json::json!({ "message": format!("the check's options do not read: {e}") }))?;
    Ok((source, catalog, options))
}

/// `check_program(source, catalog snapshot JSON, options JSON)` against the
/// host's zone database: writes `{diagnostics}` and returns 0, or writes
/// `{error}` and returns 1. The
/// artifact's C export is the engine's (`movement_engine::abi`), which
/// supplies its own environment services as the zone database.
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[allow(clippy::too_many_arguments)] // the C export's arguments, passed through
pub unsafe fn check_program_with(
    zones: &dyn crate::host::ZoneLookup,
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    options_ptr: *const u8,
    options_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let answer = match unsafe { inputs((src_ptr, src_len), (catalog_ptr, catalog_len), (options_ptr, options_len)) } {
        Ok((source, catalog, options)) => {
            crate::check_json(source, catalog, CheckOptions { upgrading_from: options.upgrading_from.as_deref(), zones })
        }
        Err(error) => serde_json::json!({ "error": error }),
    };
    write_answer(&answer, out_ptr_ptr, out_len_ptr)
}

/// `check_answer(source, catalog snapshot JSON, options JSON)`:
/// `check_program_with`'s inputs, answered `{diagnostics, stamps, link?}`
/// (crate::answer) and 0, or `{error}` and 1. What a host answers the
/// engine's `check.program` request with.
///
/// # Safety
/// Both input ranges must be readable; the out slots writable.
#[allow(clippy::too_many_arguments)] // the C export's arguments, passed through
pub unsafe fn check_answer_with(
    zones: &dyn crate::host::ZoneLookup,
    src_ptr: *const u8,
    src_len: u32,
    catalog_ptr: *const u8,
    catalog_len: u32,
    options_ptr: *const u8,
    options_len: u32,
    out_ptr_ptr: *mut usize,
    out_len_ptr: *mut usize,
) -> u32 {
    install_panic_hook();
    let answer = match unsafe { inputs((src_ptr, src_len), (catalog_ptr, catalog_len), (options_ptr, options_len)) } {
        Ok((source, catalog, options)) => {
            crate::check_answer_json(source, catalog, CheckOptions { upgrading_from: options.upgrading_from.as_deref(), zones })
        }
        Err(error) => serde_json::json!({ "error": error }),
    };
    write_answer(&answer, out_ptr_ptr, out_len_ptr)
}

/// `check_compatible(request JSON)`: the engine's `check.compatible` request
/// (crate::compatible), answered `{fits}` or `{undescribed: true}` and 0, or
/// `{error}` and 1.
///
/// # Safety
/// The input range must be readable; the out slots writable.
pub unsafe fn check_compatible_with(request_ptr: *const u8, request_len: u32, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    install_panic_hook();
    let answer = match unsafe { utf8(request_ptr, request_len, "request") } {
        Ok(request) => crate::compatible::compatible_json(request),
        Err(error) => serde_json::json!({ "error": error }),
    };
    write_answer(&answer, out_ptr_ptr, out_len_ptr)
}

/// `standard_library()`: the built-in table (crate::types::stdlib::
/// standard_library_json) and 0. Takes no input: the table is the same under
/// every language version this release reads.
///
/// # Safety
/// The out slots must be writable.
pub unsafe fn standard_library_with(out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    install_panic_hook();
    write_answer(&crate::types::stdlib::standard_library_json(), out_ptr_ptr, out_len_ptr)
}

/// Writes `answer` out as `JSON.stringify` writes it (the engine's text form
/// undone), and its status: 1 for `{error}`.
fn write_answer(answer: &serde_json::Value, out_ptr_ptr: *mut usize, out_len_ptr: *mut usize) -> u32 {
    let status = u32::from(answer.get("error").is_some());
    let bytes = movement_parser::util::form::external_bytes(movement_parser::to_sorted_json(answer));
    unsafe { write_out(bytes, out_ptr_ptr, out_len_ptr) };
    status
}

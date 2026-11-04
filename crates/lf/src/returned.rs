//! What a run's movement returned, treated as a cron job's output: every
//! run records it in its history (the `returned` member of the run's
//! outcome), however the run was started; it is shown to a person who
//! started or drove the run (`listen-fire run`, `listen-fire resume`), and it never
//! reaches an external system — no door answers with it, so what a run
//! returns can never be a side door for an effect.
//!
//! As recorded: `{value}`; `{json}`, its JSON as text, for a value nested past
//! `HISTORY_NESTING`; `{truncated: true, bytes, preview}` for a value whose
//! JSON is over the cap; `{unwritable: why}` for one with no plain form. A file
//! in the value is kept as a reference to the file (its owner and handle),
//! never its bytes or a URL to them.

use crate::json::{Js, Obj};
use crate::obj;
use crate::wire::Hv;

/// The most JSON text a run's history keeps of what it returned. A run's
/// outcome is read back on every segment that settles it and on every
/// `listen-fire runs`, so it stays small; 64 KiB holds any summary a person reads,
/// and anything bigger belongs in a file, which is recorded by reference.
pub const RECORDED_BYTES: usize = 64 * 1024;

/// How deep a value the run's history keeps as itself. Every store and reader
/// of a run's outcome reads it as JSON, most of them refusing it past 128
/// levels, and a refused outcome reads as no outcome. A value can nest far
/// deeper, and its JSON as a text nests not at all. Well under 128, as the
/// outcome and a rerun's attempts wrap it.
const HISTORY_NESTING: usize = 64;

/// The value as the run's history keeps it.
pub fn recorded(value: &Hv) -> Js {
    let plain = plain(value);
    match cut(&plain, RECORDED_BYTES) {
        Some(truncated) => truncated,
        None if nests_past(&plain, HISTORY_NESTING) => Js::Obj(obj! { "json" => Js::str(&plain.to_json()) }),
        None => Js::Obj(obj! { "value" => plain }),
    }
}

/// A value a write set, as the run's history lists it: plain, files by
/// reference, or cut as a returned value is when its JSON is over `cap`, and
/// as its JSON when it nests too deep to keep as itself.
pub fn written(value: &Hv, cap: usize) -> Js {
    let plain = plain(value);
    match cut(&plain, cap) {
        Some(truncated) => truncated,
        None if nests_past(&plain, HISTORY_NESTING) => Js::Obj(obj! { "json" => Js::str(&plain.to_json()) }),
        None => plain,
    }
}

fn nests_past(value: &Js, levels: usize) -> bool {
    match value {
        Js::Arr(items) => levels == 0 || items.iter().any(|member| nests_past(member, levels - 1)),
        Js::Obj(members) => levels == 0 || members.values().any(|member| nests_past(member, levels - 1)),
        _ => false,
    }
}

/// `{truncated: true, bytes, preview}` for a value whose JSON is over `cap`.
fn cut(plain: &Js, cap: usize) -> Option<Js> {
    let text = plain.to_json();
    if text.len() <= cap {
        return None;
    }
    let mut cut = cap;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    Some(Js::Obj(obj! {
        "truncated" => Js::Bool(true),
        "bytes" => Js::Num((text.len() as u64).into()),
        "preview" => Js::str(&text[..cut]),
    }))
}

/// A value the engine could not write out, with why.
pub fn unwritable(why: &str) -> Js {
    Js::Obj(obj! { "unwritable" => Js::str(why) })
}

/// The value with each file in it as a reference: its name, type and size,
/// and its owner type and handle (`wireSource`, which names no credential).
fn plain(value: &Hv) -> Js {
    match value {
        Hv::File { descriptor, .. } => {
            let mut reference: Obj = obj! { "__brand" => Js::str("FileRef") };
            for key in ["name", "contentType", "size"] {
                if let Some(member) = descriptor.get(key) {
                    reference.insert(key.into(), member.clone());
                }
            }
            if let Some(source) = crate::file_ref::wire_source(descriptor.get("source")) {
                reference.insert("source".into(), source);
            }
            Js::Obj(reference)
        }
        Hv::List(items) => Js::Arr(items.iter().map(plain).collect()),
        Hv::Obj(entries) => {
            let mut map = Obj::new();
            for (key, member) in entries {
                map.insert(key.clone(), plain(member));
            }
            Js::Obj(map)
        }
        Hv::Record { descriptor, .. } => plain(descriptor),
        Hv::Null | Hv::Bool(_) | Hv::Num(_) | Hv::Str(_) => value.js(),
    }
}

/// What the run's outcome (its row's JSON text) records it returned.
pub fn of_outcome(outcome: Option<&str>) -> Option<Js> {
    let outcome = Js::parse(outcome?.as_bytes()).ok()?;
    outcome.get("returned").cloned()
}

/// The line a person is shown under the run's own.
pub fn shown(recorded: &Js) -> String {
    if let Some(value) = recorded.get("value") {
        return format!("returned {}", value.to_json());
    }
    if let Some(json) = recorded.get("json").and_then(Js::as_str) {
        return format!("returned {json}");
    }
    if let Some(why) = recorded.get("unwritable").and_then(Js::as_str) {
        return format!("returned a value listen-fire cannot record: {why}");
    }
    let bytes = recorded.get("bytes").map(Js::to_json).unwrap_or_default();
    let preview = recorded.get("preview").and_then(Js::as_str).unwrap_or_default();
    format!("returned {bytes} bytes of JSON, more than the {RECORDED_BYTES} the run's history keeps; its start: {preview}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_value_under_the_cap_is_kept_whole() {
        let value = Hv::of_js(&Js::Obj(obj! { "greeting" => Js::str("Hello, henry!"), "n" => Js::Num(3.into()) }));
        let kept = recorded(&value);
        assert_eq!(kept.to_json(), r#"{"value":{"greeting":"Hello, henry!","n":3}}"#);
        assert_eq!(shown(&kept), r#"returned {"greeting":"Hello, henry!","n":3}"#);
    }

    #[test]
    fn a_value_too_deep_to_keep_as_itself_is_kept_as_its_json() {
        let nested = |levels: usize| (1..levels).fold(Js::Obj(Obj::new()), |inner, _| Js::Obj(obj! { "v" => inner }));
        assert!(recorded(&Hv::of_js(&nested(HISTORY_NESTING))).get("value").is_some());
        let deep = nested(HISTORY_NESTING + 1);
        let kept = recorded(&Hv::of_js(&deep));
        assert_eq!(kept.get("json").and_then(Js::as_str), Some(deep.to_json().as_str()));
        assert_eq!(shown(&kept), format!("returned {}", deep.to_json()));
        assert!(Js::parse(kept.to_json().as_bytes()).is_ok(), "the history's reader reads it");
    }

    #[test]
    fn a_value_over_the_cap_keeps_its_start_and_says_it_was_cut() {
        // Two-byte characters, so the cut must find a character boundary.
        let long = "é".repeat(RECORDED_BYTES);
        let kept = recorded(&Hv::Str(long.clone()));
        assert_eq!(kept.get("truncated"), Some(&Js::Bool(true)));
        assert_eq!(kept.get("bytes").map(Js::to_json), Some((long.len() + 2).to_string()));
        let preview = kept.get("preview").and_then(Js::as_str).unwrap();
        assert!(preview.len() <= RECORDED_BYTES && preview.len() > RECORDED_BYTES - 2);
        assert!(preview.starts_with("\"éé"));
        assert!(kept.get("value").is_none());
        assert!(shown(&kept).contains("more than the 65536"));
    }

    #[test]
    fn a_file_is_kept_as_its_reference_never_its_url() {
        let descriptor = obj! {
            "__brand" => Js::str("FileRef"),
            "name" => Js::str("report.pdf"),
            "contentType" => Js::str("application/pdf"),
            "size" => Js::Num(1234.into()),
            "source" => Js::Obj(obj! { "store" => Js::str("document"), "objectUri" => Js::str("lf-files://abc") }),
            "url" => Js::str("data:application/pdf;base64,JVBERi0xLjQK"),
        };
        let value = Hv::Obj(vec![("report".into(), Hv::File { id: 0, descriptor })]);
        let kept = recorded(&value).to_json();
        assert_eq!(
            kept,
            r#"{"value":{"report":{"__brand":"FileRef","name":"report.pdf","contentType":"application/pdf","size":1234,"source":{"ownerAdapterType":"document-store","handle":"lf-files://abc"}}}}"#
        );
        assert!(!kept.contains("base64"));
    }

    #[test]
    fn the_outcome_names_what_was_recorded() {
        assert_eq!(of_outcome(Some(r#"{"writes":0,"returned":{"value":"hi"}}"#)).map(|r| r.to_json()), Some(r#"{"value":"hi"}"#.into()));
        assert_eq!(of_outcome(Some(r#"{"writes":0}"#)), None);
        assert_eq!(of_outcome(None), None);
        assert_eq!(shown(&unwritable("a function")), "returned a value listen-fire cannot record: a function");
    }
}

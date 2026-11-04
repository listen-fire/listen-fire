//! A file the engine holds: an opaque handle onto a file the HOST keeps. The
//! host (the shim, rust_host.ts) makes every file, at an envelope that
//! declares one — a field the catalog types `file` (this engine names the
//! type, `declared_field_type`, and the host makes the files), a plugin
//! output's declared file, `files.render`'s answer, a parked `file` — and
//! hands the engine `["F", id, display]`: the segment's id for it, its
//! identity `handle`, and what a reader may print (`name`, `contentType`,
//! `size`). The descriptor — its source, credential, construction args,
//! store, URL — never reaches the engine. The engine hands the file back by
//! its id, and the host redeems that id.
//!
//! The `handle` is an OPAQUE identity string: the engine compares and
//! carries it (a FILE resource's `externalId`, a `file` provenance origin,
//! the dedupe key of a file read twice) and never parses or reads inside it.
//!
//! A file is its own value (`Js::File`), never a `Js::Object` with a key:
//! data carrying a descriptor's keys, `__brand` included, is data wherever it
//! goes.

use movement_parser::catalog::types::{FieldType, InstanceSchema};

use crate::js::{Js, JsObject};

/// A file as the engine holds it.
#[derive(Debug)]
pub struct FileHandle {
    /// The segment's id for the file: what the host redeems.
    pub id: u32,
    /// Its identity, opaque: compared and carried, never read inside.
    pub handle: Option<String>,
    /// Its opaque view — what a reader sees, on both engines: `name`,
    /// `contentType`, `size` and `handle` (each that the file has). A read of
    /// any other member is absent.
    pub display: JsObject,
}

/// `declaredFieldType`: the type an instance's schema declares for a field
/// of a position type — what the engine tells the host a field's answer is,
/// so the host makes its files.
pub fn declared_field_type<'a>(schema: Option<&'a InstanceSchema>, record_type: Option<&str>, field: &str) -> Option<&'a FieldType> {
    schema?.positions.get(record_type?)?.properties.get(field)
}

/// Whether a declared type can hold a file anywhere: only then is the host
/// told it.
pub fn may_hold_file(ty: &FieldType) -> bool {
    use movement_parser::catalog::types::{Composite, Scalar};
    match ty {
        FieldType::Scalar(scalar) => *scalar == Scalar::File,
        FieldType::Composite(Composite::List { of, .. } | Composite::Dict { of, .. } | Composite::MaybeAbsent { of }) => may_hold_file(of),
        FieldType::Composite(Composite::Tuple { of, .. }) => of.iter().flatten().any(may_hold_file),
        FieldType::Composite(_) => false,
    }
}

/// A file's opaque view as data: what JSON writes of it.
pub fn display(file: &FileHandle) -> Js {
    Js::object(JsObject::clone_of(&file.display))
}

/// `holdsFile`: a file anywhere in a value, through its lists and dicts.
pub fn holds_file(value: &Js) -> bool {
    if crate::js::holds_itself(value) {
        return file_within(&crate::js::acyclic(value));
    }
    file_within(value)
}

/// The walk, which asks about a circle once at the top: a value that holds no
/// circle holds none below it either.
fn file_within(value: &Js) -> bool {
    match value {
        Js::File(_) => true,
        Js::Array(list) => crate::deep::walking(|| list.items().iter().any(file_within)),
        Js::Object(dict) if crate::js::is_dict(value) => crate::deep::walking(|| dict.entries().iter().any(|(_, item)| file_within(item))),
        _ => false,
    }
}

/// `fileFieldsOf`: a record's fields that hold a file, each as its value
/// descriptor, beside the fields a park writes whole; `None` when no field
/// holds one. A file is written as itself: the wire hands the host its id,
/// and the host parks the descriptor it keeps.
pub fn file_fields_of(fields: &JsObject) -> Option<Js> {
    let mut out: Option<JsObject> = None;
    for (key, value) in fields.entries() {
        if holds_file(value) {
            out.get_or_insert_with(JsObject::new).set(key.clone(), file_field_value(value));
        }
    }
    out.map(Js::object)
}

/// `fileFieldValue`: a field's value with its files said to be.
fn file_field_value(value: &Js) -> Js {
    let of = |kind: &str, of: Js| crate::env::object_of(vec![("kind", Js::str(kind)), ("of", of)]);
    match value {
        Js::File(_) => crate::env::object_of(vec![("kind", Js::str("file")), ("file", value.clone())]),
        Js::Array(list) => of("list", crate::deep::walking(|| Js::array(list.items().iter().map(file_field_value).collect()))),
        Js::Object(dict) if crate::js::is_dict(value) => {
            let members = crate::deep::walking(|| {
                let mut members = JsObject::new();
                for (key, item) in dict.entries() {
                    members.set(key.clone(), file_field_value(item));
                }
                members
            });
            of("map", Js::object(members))
        }
        other => crate::env::object_of(vec![("kind", Js::str("data")), ("value", other.clone())]),
    }
}

/// A file as tests build one: what the host would hand the engine.
#[cfg(test)]
pub fn for_test(id: u32, handle: Option<&str>, name: Option<&str>) -> Js {
    let mut display = JsObject::new();
    if let Some(name) = name {
        display.set("name".into(), Js::str(name));
    }
    if let Some(handle) = handle {
        display.set("handle".into(), Js::str(handle));
    }
    Js::File(std::rc::Rc::new(FileHandle { id, handle: handle.map(String::from), display }))
}

#[cfg(test)]
mod tests {
    /// A file at the bottom of a value as deep as a loop makes one is found,
    /// and a value with none is cleared, on whatever stack the walk has.
    #[test]
    #[cfg(not(target_arch = "wasm32"))]
    fn a_deep_value_is_searched_for_files_without_ending_the_process() {
        use crate::deep::testing::{nested_lists, nested_maps, on_a_small_stack};
        use crate::js::{Js, JsObject};
        let (without, with_in_lists, with_in_maps, fields) = on_a_small_stack(|| {
            let file = super::for_test(1, Some("h"), Some("a.pdf"));
            let mut record = JsObject::new();
            record.set("held".into(), nested_lists(file.clone()));
            record.set("plain".into(), nested_lists(Js::Number(1.0)));
            let fields = super::file_fields_of(&record).map(|fields| fields.to_js_string());
            (super::holds_file(&nested_lists(Js::Number(1.0))), super::holds_file(&nested_lists(file.clone())), super::holds_file(&nested_maps(file)), fields)
        });
        assert!(!without);
        assert!(with_in_lists);
        assert!(with_in_maps);
        assert!(fields.is_some(), "the field holding a file is the one named");
    }

    /// JSON of a file — a prompt fragment, a trace's sample — is its opaque
    /// view, as the TypeScript's `toJSON` writes it: never its source.
    #[test]
    fn a_file_writes_out_as_its_opaque_view() {
        let file = crate::env::decode(&serde_json::json!(["F", 2, { "handle": "h-1", "name": "a.pdf", "size": 3 }])).unwrap();
        assert_eq!(crate::js::json_stringify(&file, 0), r#"{"name":"a.pdf","size":3,"handle":"h-1"}"#);
    }
}


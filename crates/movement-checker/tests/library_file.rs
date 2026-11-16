//! A diagnostic that came from an imported library names it in `file`, as
//! the checked file's import writes it: a host tells a library's fault by
//! the field, never by reading the message (which names it too).

use movement_checker::{CheckOptions, Diagnostic, check_source};
use movement_parser::catalog::types::CatalogSnapshot;

fn check(root: &str, files: &str) -> Vec<Diagnostic> {
    let catalog = CatalogSnapshot::load(&format!(r#"{{"adapters":{{}},"credentials":{{}},"plugins":{{}},"files":{files}}}"#)).unwrap();
    let options = CheckOptions { upgrading_from: None, limiting_function: None, zones: &movement_checker::host::native::NativeZones };
    check_source(root, &catalog, options).unwrap()
}

fn files_of(found: &[Diagnostic]) -> Vec<(&str, Option<&str>)> {
    found.iter().map(|d| (d.code.as_str(), d.file.as_deref())).collect()
}

#[test]
fn a_library_s_own_fault_names_the_library() {
    let files = r#"{"lib/a":{"source":"export function helper(t: <text>) {\n  return nope(t)\n}"}}"#;
    let found = check("import { helper } from \"lib/a\"\nfunction go(t: <text>) {\n  x = helper(t)\n}", files);
    assert_eq!(files_of(&found), [("MOV_FUNCTION_UNKNOWN", Some("lib/a"))], "{found:#?}");
    assert!(found[0].message.starts_with("\"lib/a\" line 2: "), "the message is as it was: {}", found[0].message);
    let json = serde_json::to_value(&found[0]).unwrap();
    assert_eq!(json["file"], "lib/a");
}

#[test]
fn a_library_that_does_not_parse_names_the_library() {
    let found = check("import { helper } from \"lib/a\"\nfunction go(t: <text>) {\n  x = 1\n}", r#"{"lib/a":{"source":"export function helper( {"}}"#);
    assert_eq!(files_of(&found), [("MOV_IMPORT_FILE_INVALID", Some("lib/a"))], "{found:#?}");
}

#[test]
fn a_fault_two_libraries_down_names_the_one_the_file_imports() {
    let files = r#"{"lib/a":{"source":"import { inner } from \"lib/b\"\nexport function helper(t: <text>) {\n  return inner(t)\n}"},"lib/b":{"source":"export function inner(t: <text>) {\n  return nope(t)\n}"},"lib/c":{"source":"import { x } from \"lib/d\"\nexport function helper2(t: <text>) {\n  return t\n}"},"lib/d":{"source":"export function x( {"}}"#;
    let found = check("import { helper } from \"lib/a\"\nimport { helper2 } from \"lib/c\"\nfunction go(t: <text>) {\n  x = helper(t)\n  y = helper2(t)\n}", files);
    let mut named = files_of(&found);
    named.sort();
    assert_eq!(named, [("MOV_FUNCTION_UNKNOWN", Some("lib/a")), ("MOV_IMPORT_FILE_INVALID", Some("lib/c"))], "{found:#?}");
}

#[test]
fn the_file_s_own_faults_name_no_library() {
    let found = check("import { helper } from \"lib/missing\"\nfunction go(t: <text>) {\n  x = nope(t)\n}", "{}");
    assert!(found.iter().all(|d| d.file.is_none()), "{found:#?}");
    assert!(!found.is_empty());
}

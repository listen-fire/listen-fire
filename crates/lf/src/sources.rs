//! The project's movement files, as the movements slot's module answers
//! them (crate::movements_slot): by default every `.mvt` under the movements
//! folder, entries in sorted order, folders walked depth first.

use std::path::PathBuf;
use std::rc::Rc;

use movement_parser::ast::Program;

use crate::check::ParseError;
use crate::project::Project;
use crate::routing::Listen;

pub const MOVEMENT_EXTENSION: &str = ".mvt";

#[derive(Debug, Clone)]
pub struct MovementFile {
    /// The path an import names: relative to the movements folder, no extension.
    pub name: String,
    /// Where it is on disk; under a served module, where it would be.
    pub path: PathBuf,
    pub source: String,
    /// The version the movements module answered it at.
    pub version: Option<String>,
}

/// One movement file's text read once: its program, and the listens it
/// routes. A set refreshed keeps the parse of each file whose text did not
/// change (`Parsed::each`), so a refresh parses only what moved.
pub struct Parsed {
    /// The file's name, as an import names it.
    pub name: String,
    pub path: PathBuf,
    /// The text it was read from.
    source: String,
    pub program: Result<Program, ParseError>,
    /// Empty when it does not parse (`check` says why).
    pub listens: Vec<Listen>,
}

impl Parsed {
    pub fn of(file: &MovementFile) -> Parsed {
        let program = crate::check::parse(&file.source);
        let listens = program.as_ref().map(|program| crate::routing::listens_of(&file.name, program)).unwrap_or_default();
        Parsed { name: file.name.clone(), path: file.path.clone(), source: file.source.clone(), program, listens }
    }

    /// Each file read, in order: `held`'s reading of a file kept while its
    /// name and text are the ones it was read from.
    pub fn each(files: &[MovementFile], held: &[Rc<Parsed>]) -> Vec<Rc<Parsed>> {
        files
            .iter()
            .map(|file| match held.iter().find(|p| p.name == file.name && p.source == file.source) {
                Some(kept) => kept.clone(),
                None => Rc::new(Parsed::of(file)),
            })
            .collect()
    }
}

pub fn scan_movements(project: &Project) -> Result<Vec<MovementFile>, String> {
    scan_movements_with(project, &std::env::vars().collect::<Vec<_>>())
}

/// `scan_movements` under `env`: where a movements module's own settings may come from.
pub fn scan_movements_with(project: &Project, env: &[(String, String)]) -> Result<Vec<MovementFile>, String> {
    crate::movements_slot::of_project(project, env)?.files(&project.movements_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, source: &str) -> MovementFile {
        MovementFile { name: name.into(), path: PathBuf::from(format!("{name}.mvt")), source: source.into(), version: None }
    }

    #[test]
    fn a_file_whose_text_is_unchanged_keeps_its_parse() {
        let hello = "function hello(run: <manual-[:Invocation]->>) {\n  return \"v1\"\n}\nlisten to manual fire hello\n";
        let held = Parsed::each(&[file("hello", hello), file("other", hello.replace("hello", "other").as_str())], &[]);
        assert_eq!(held[0].listens.len(), 1, "its listen is read with it");
        let again = Parsed::each(&[file("hello", hello), file("other", "function other(")], &held);
        assert!(Rc::ptr_eq(&again[0], &held[0]), "the unchanged file is not parsed again");
        assert!(!Rc::ptr_eq(&again[1], &held[1]), "the changed one is");
        assert!(again[1].program.is_err() && again[1].listens.is_empty(), "a file that does not parse routes nothing");
        let moved = Parsed::each(&[file("renamed", hello)], &held);
        assert!(!Rc::ptr_eq(&moved[0], &held[0]) && moved[0].listens[0].file == "renamed", "a parse is kept by its file and its text");
    }
}

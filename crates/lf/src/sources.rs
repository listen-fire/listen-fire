//! The project's movement files, as the movements slot's module answers
//! them (crate::movements_slot): by default every `.mvt` under the movements
//! folder, entries in sorted order, folders walked depth first.

use std::path::PathBuf;

use crate::project::Project;

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

pub fn scan_movements(project: &Project) -> Result<Vec<MovementFile>, String> {
    scan_movements_with(project, &std::env::vars().collect::<Vec<_>>())
}

/// `scan_movements` under `env`: where a movements module's own settings may come from.
pub fn scan_movements_with(project: &Project, env: &[(String, String)]) -> Result<Vec<MovementFile>, String> {
    crate::movements_slot::of_project(project, env)?.files(&project.movements_dir)
}

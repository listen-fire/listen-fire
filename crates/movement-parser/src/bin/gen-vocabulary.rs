//! Rewrites the lowering vocabulary's `data.rs` from `vocabulary.json`.

use movement_parser::lowering::vocabulary::generate::{DATA_PATH, SOURCE_PATH, generate};
use std::path::Path;
use std::process::ExitCode;

fn main() -> ExitCode {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let result = std::fs::read_to_string(crate_dir.join(SOURCE_PATH))
        .map_err(|e| format!("{SOURCE_PATH}: {e}"))
        .and_then(|json| generate(&json))
        .and_then(|data| std::fs::write(crate_dir.join(DATA_PATH), data).map_err(|e| format!("{DATA_PATH}: {e}")));
    match result {
        Ok(()) => {
            println!("wrote {DATA_PATH}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

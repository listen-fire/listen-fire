//! `LF_LOG`: how much listen-fire says beyond what an operator must act on.
//! `debug` adds the lines that say why something ran nothing when nothing
//! went wrong (an arrival a listen's WHERE refuses); unset, they stay unsaid.

use std::sync::atomic::{AtomicBool, Ordering};

static DEBUG: AtomicBool = AtomicBool::new(false);

/// `LF_LOG` read: `debug` says the debug lines; empty or unset says none.
pub fn debug_of(env: Option<&str>) -> Result<bool, String> {
    match env.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
        None | Some("") => Ok(false),
        Some("debug") => Ok(true),
        Some(other) => Err(format!("LF_LOG is \"{other}\": set it to debug for the debug lines, or leave it empty")),
    }
}

/// Reads `LF_LOG` once, as the process starts.
pub fn install(env: Option<&str>) -> Result<(), String> {
    DEBUG.store(debug_of(env)?, Ordering::Relaxed);
    Ok(())
}

/// Says the line on the error output under `LF_LOG=debug`; otherwise never
/// builds it.
pub fn debug(line: impl FnOnce() -> String) {
    if DEBUG.load(Ordering::Relaxed) {
        eprintln!("{}", line());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lf_log_says_the_debug_lines_only_when_set_to_debug_and_refuses_another_level_by_name() {
        assert_eq!((debug_of(None), debug_of(Some("")), debug_of(Some(" Debug "))), (Ok(false), Ok(false), Ok(true)));
        assert!(debug_of(Some("verbose")).unwrap_err().contains("LF_LOG is \"verbose\""));
    }
}

//! `lf init [dir]`: scaffold a starter project (lf.yaml, the movements and
//! externals folders, and one movement that checks clean with no external and
//! runs with `lf run hello`).
//! Existing files are never overwritten; a re-run reports what it made.

use std::fs;
use std::io::Write;
use std::path::Path;

use movement_parser::version::LANGUAGE_VERSION;

use crate::movements_slot::{self, WriteError, Written};

const STARTER_MOVEMENT: &str = r#"# A movement is a program the host runs when something happens. This one runs
# when you ask: `lf run hello`. `manual` and `cron` are the host's own, so they
# need no import; to run on a schedule instead, write
#
#   listen to cron { schedule: "0 9 * * 1" } fire hello
#
# (and type the parameter `<cron-[:Tick]->>`). To react to a system's events,
# install it under externals/ and connect it:
#
#   import { crm } from adapters
#   listen to crm { events: ["company.created"] } fire greet
function hello(run: <manual-[:Invocation]->>) {
  return "Hello, ${run.`Run by (name)`}!"
}

listen to manual fire hello
"#;

const PROJECT_TAIL: &str = "# Who events act as on this machine (@user_name, @user_email). Defaults to the OS user;
# LF_USER and LF_USER_EMAIL override.
# user: { name: Your Name, email: you@example.com }
# Where this lf is reached from outside; a callback's url is under it. Defaults to
# where `lf serve` listens.
# publicUrl: https://lf.example.com
";

/// What a project keeps out of version control: run state, and credentials.
const FOLDERS: [&str; 2] = [".lf", "externals"];

const IGNORED: &[&str] = &[".lf/", "secrets.yaml", ".env", ".env.*"];

/// What `scaffold` did.
#[derive(Debug)]
enum Scaffolded {
    Made(Vec<String>),
    /// The movements module holds the files read-only: the refusal, with nothing else made.
    Refused(String),
}

pub fn run(dir: &Path, out: &mut impl Write) -> Result<i32, String> {
    let made = match scaffold(dir)? {
        Scaffolded::Made(made) => made,
        Scaffolded::Refused(refusal) => {
            eprintln!("lf: {refusal}");
            return Ok(2);
        }
    };
    let line = if made.is_empty() { "already a project".to_string() } else { format!("made {}", made.join(", ")) };
    writeln!(out, "{line}").map_err(|e| e.to_string())?;
    Ok(0)
}

fn scaffold(root: &Path) -> Result<Scaffolded, String> {
    let mut made = Vec::new();
    // Loading the project (below) makes `.lf`, so what was there is noted first.
    let had: Vec<bool> = FOLDERS.iter().map(|folder| root.join(folder).exists()).collect();
    let write = |relative: &str, content: &str, made: &mut Vec<String>| -> Result<(), String> {
        let path = root.join(relative);
        if path.exists() {
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::write(&path, content).map_err(|e| format!("{}: {e}", path.display()))?;
        made.push(relative.to_string());
        Ok(())
    };
    fs::create_dir_all(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let project_file = format!("engine: {LANGUAGE_VERSION}\nmovements: movements\nexternals: externals\n{PROJECT_TAIL}");
    write("lf.yaml", &project_file, &mut made)?;
    // A project that names a movements module keeps its files there; otherwise they are this folder's.
    if crate::project::named_core_module(root, "movements").is_some() {
        let project = crate::project::load_project(root)?;
        let store = movements_slot::of_project(&project, &std::env::vars().collect::<Vec<_>>())?;
        match store.write("hello.mvt", STARTER_MOVEMENT, None) {
            Ok(Written::Written { .. }) => made.push("movements/hello.mvt".to_string()),
            // Already there, as when the file exists on disk.
            Ok(Written::Conflict { .. }) => {}
            Err(refused @ WriteError::ReadOnly { .. }) => return Ok(Scaffolded::Refused(refused.refusal())),
            Err(WriteError::Failed(message)) => return Err(message),
        }
    } else {
        write("movements/hello.mvt", STARTER_MOVEMENT, &mut made)?;
    }
    for (folder, had) in FOLDERS.iter().zip(had) {
        let path = root.join(folder);
        if !had {
            fs::create_dir_all(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            made.push(format!("{folder}/"));
        }
    }
    let gitignore = root.join(".gitignore");
    let existing = fs::read_to_string(&gitignore).unwrap_or_default();
    let present: Vec<&str> = existing.lines().map(str::trim).collect();
    let missing: Vec<&str> = IGNORED.iter().copied().filter(|entry| !present.contains(entry) && !present.contains(&entry.trim_end_matches('/'))).collect();
    if !missing.is_empty() {
        let lead = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
        let appended = format!("{existing}{lead}{}\n", missing.join("\n"));
        fs::write(&gitignore, appended).map_err(|e| format!("{}: {e}", gitignore.display()))?;
        made.push(format!(".gitignore entries {}", missing.join(" ")));
    }
    Ok(Scaffolded::Made(made))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn made(root: &Path) -> Vec<String> {
        match scaffold(root).unwrap() {
            Scaffolded::Made(made) => made,
            Scaffolded::Refused(refusal) => panic!("{refusal}"),
        }
    }

    #[test]
    fn a_fresh_folder_becomes_a_project_and_a_second_run_changes_nothing() {
        let root = std::env::temp_dir().join(format!("lf-init-{}", uuid::Uuid::new_v4())).join("nested");
        assert!(!made(&root).is_empty());
        let project = crate::project::load_project(&root).unwrap();
        assert_eq!(project.engine, LANGUAGE_VERSION);
        let ignored = fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(ignored.lines().any(|l| l == ".lf/") && ignored.lines().any(|l| l == "secrets.yaml"));
        assert!(made(&root).is_empty());
        fs::remove_dir_all(root.parent().unwrap()).ok();
    }
}

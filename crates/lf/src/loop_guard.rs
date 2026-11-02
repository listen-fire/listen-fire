//! The loop guard slot (docs/contracts/loop-guard-slot.md), retired: a run
//! host starts no guard, and a project that still names one in lf.yaml's
//! `core:` is told so once as listen-fire starts (`notice_retired`).
//! listen-fire's loop breaker (crate::loop_breaker) caps every chain of
//! writes and arrivals instead.
//!
//! What stays until the slot is removed is the slot's contract tooling:
//! `@lf/fingerprint-guard` and a guard module served as modules
//! (crate::contract_guard), so the contract suite still holds them.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
#[cfg(feature = "postgres")]
use tokio_postgres::Client;

use crate::json::Js;
use crate::store::iso;

/// How long the built-in remembers a write: an echo arrives within it (a
/// webhook in seconds, a poll within its interval).
pub const REMEMBERED_MS: i64 = 60 * 60 * 1000;

/// One record write a segment made, with the record as the source answered
/// it right after.
#[derive(Debug, Clone, PartialEq)]
pub struct Wrote {
    /// The external written to (its manifest name).
    pub adapter: String,
    /// The record type the write named, which reading it back takes.
    pub record_type: String,
    pub external_id: String,
    /// `null` for a record that is gone.
    pub record: Js,
}

pub trait LoopGuard: Send + Sync {
    /// `writer`'s write, remembered; its later write to the same record replaces it.
    fn record_write(&self, wrote: &Wrote, writer: &str) -> Result<(), String>;
}

/// A record's fingerprint: the hash of its JSON as the source answered it.
pub fn fingerprint(record: &Js) -> String {
    Sha256::digest(record.to_json().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// What listen-fire says of a loop guard lf.yaml names: it starts none.
pub fn retired(name: &str) -> String {
    format!("lf.yaml's core.loopGuard names {name}, but the loop guard slot is retired: listen-fire starts no guard, and its loop breaker (lf.yaml's loopWindow and loopDepth) replaces it. Remove core.loopGuard from lf.yaml.")
}

/// Tell the operator, once per process, that the guard lf.yaml names is not started.
pub fn notice_retired(project: &crate::project::Project) {
    static TOLD: std::sync::Once = std::sync::Once::new();
    if let Some(module) = &project.core.loop_guard {
        TOLD.call_once(|| eprintln!("listen-fire: {}", retired(&module.name)));
    }
}

/// The project's loop guard, if its slot is filled: started only to serve it
/// to the contract suite (`listen-fire --contract-guard-slot`).
pub fn of_project(project: &crate::project::Project, credentials: &crate::secrets::Credentials) -> Result<Option<std::sync::Arc<dyn LoopGuard>>, String> {
    let Some(module) = &project.core.loop_guard else { return Ok(None) };
    let settings = crate::core::settings_of(credentials, module);
    Ok(Some(match &module.process {
        Some(process) => std::sync::Arc::new(crate::guard_module::ProcessGuard::start(&module.name, process, &settings)?),
        None => std::sync::Arc::new(FingerprintGuard::open(&settings, &project.root, &project.lf_dir)?),
    }))
}

// ── @lf/fingerprint-guard ───────────────────────────────────────────────────

pub struct FingerprintGuard {
    memory: Mutex<Memory>,
}

enum Memory {
    File(Connection),
    #[cfg(feature = "postgres")]
    Postgres(Client),
}

const FILE_SCHEMA: &str = "
create table if not exists write_fingerprint (
  adapter text not null,
  external_id text not null,
  writer text not null,
  record_type text not null,
  fingerprint text not null,
  expires_at text not null,
  primary key (adapter, external_id, writer)
);";

#[cfg(feature = "postgres")]
const POSTGRES_SCHEMA: &str = "
create schema if not exists lf_guard;
create table if not exists lf_guard.write_fingerprint (
  adapter text not null,
  external_id text not null,
  writer text not null,
  record_type text not null,
  fingerprint text not null,
  expires_at timestamptz not null,
  primary key (adapter, external_id, writer)
);
create index if not exists write_fingerprint_expires_at on lf_guard.write_fingerprint (expires_at);";

/// The advisory lock the schema is created under: "lf-guard" as a number.
#[cfg(feature = "postgres")]
const SCHEMA_LOCK: i64 = 0x6c66_2d67_7561_7264;

impl FingerprintGuard {
    /// Open the guard's memory (creating it when missing): the `url`
    /// setting's Postgres database, else the `path` setting's file, else
    /// `.lf/guard.db`. Idempotent, so setup (`listen-fire connect`) and use share it.
    pub fn open(settings: &BTreeMap<String, String>, root: &Path, lf_dir: &Path) -> Result<FingerprintGuard, String> {
        let memory = match settings.get("url").filter(|u| !u.is_empty()) {
            #[cfg(not(feature = "postgres"))]
            Some(_) => return Err(crate::core::NO_POSTGRES.to_string()),
            #[cfg(feature = "postgres")]
            Some(url) => {
                let client = crate::pg_store::connect_client(url).map_err(|e| e.to_string())?;
                let failed = |e| crate::pg_store::failed(e).to_string();
                crate::pg_store::block_on(client.batch_execute(&format!("select pg_advisory_lock({SCHEMA_LOCK})"))).map_err(failed)?;
                let created = crate::pg_store::block_on(client.batch_execute(POSTGRES_SCHEMA)).map_err(failed);
                let _ = crate::pg_store::block_on(client.batch_execute(&format!("select pg_advisory_unlock({SCHEMA_LOCK})")));
                created?;
                Memory::Postgres(client)
            }
            None => {
                let path = match settings.get("path").filter(|p| !p.is_empty()) {
                    Some(path) => root.join(path),
                    None => lf_dir.join("guard.db"),
                };
                if let Some(folder) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                    std::fs::create_dir_all(folder).map_err(|e| format!("{}: {e}", folder.display()))?;
                }
                let at = |e: rusqlite::Error| format!("{}: {e}", path.display());
                let db = Connection::open(&path).map_err(at)?;
                // Two listen-fire processes may share the file.
                db.execute_batch("pragma journal_mode = wal; pragma busy_timeout = 5000;").map_err(at)?;
                db.execute_batch(FILE_SCHEMA).map_err(at)?;
                Memory::File(db)
            }
        };
        Ok(FingerprintGuard { memory: Mutex::new(memory) })
    }
}

impl LoopGuard for FingerprintGuard {
    fn record_write(&self, wrote: &Wrote, writer: &str) -> Result<(), String> {
        let (fingerprint, expires_at) = (fingerprint(&wrote.record), iso(REMEMBERED_MS));
        let memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        match &*memory {
            Memory::File(db) => {
                let failed = |e: rusqlite::Error| e.to_string();
                db.execute("delete from write_fingerprint where expires_at <= ?", params![iso(0)]).map_err(failed)?;
                db.execute(
                    "insert into write_fingerprint (adapter, external_id, writer, record_type, fingerprint, expires_at) values (?, ?, ?, ?, ?, ?) \
                     on conflict (adapter, external_id, writer) do update set record_type = excluded.record_type, fingerprint = excluded.fingerprint, expires_at = excluded.expires_at",
                    params![wrote.adapter, wrote.external_id, writer, wrote.record_type, fingerprint, expires_at],
                )
                .map_err(failed)?;
            }
            #[cfg(feature = "postgres")]
            Memory::Postgres(client) => {
                let failed = |e| crate::pg_store::failed(e).to_string();
                crate::pg_store::block_on(client.execute("delete from lf_guard.write_fingerprint where expires_at <= now()", &[])).map_err(failed)?;
                crate::pg_store::block_on(client.execute(
                    "insert into lf_guard.write_fingerprint (adapter, external_id, writer, record_type, fingerprint, expires_at)
                     values ($1::text, $2::text, $3::text, $4::text, $5::text, $6::text::timestamptz)
                     on conflict (adapter, external_id, writer)
                     do update set record_type = excluded.record_type, fingerprint = excluded.fingerprint, expires_at = excluded.expires_at",
                    &[&wrote.adapter, &wrote.external_id, &writer, &wrote.record_type, &fingerprint, &expires_at],
                ))
                .map_err(failed)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::obj;

    #[test]
    fn a_record_changed_by_anyone_has_another_fingerprint() {
        let written = Js::Obj(obj! { "description" => Js::str("Seen by lf") });
        let changed = Js::Obj(obj! { "description" => Js::str("Edited by Bob") });
        assert_eq!(fingerprint(&written), fingerprint(&written.clone()));
        assert_ne!(fingerprint(&written), fingerprint(&changed));
        assert_ne!(fingerprint(&written), fingerprint(&Js::Null));
    }

    fn guard() -> FingerprintGuard {
        let dir = std::env::temp_dir().join(format!("lf-guard-{}", uuid::Uuid::new_v4()));
        FingerprintGuard::open(&BTreeMap::new(), &dir, &dir.join(".lf")).unwrap()
    }

    fn wrote(description: &str) -> Wrote {
        Wrote { adapter: "attio".into(), record_type: "Companies".into(), external_id: "r1".into(), record: Js::Obj(obj! { "description" => Js::str(description) }) }
    }

    /// The fingerprint the guard remembers for `writer`'s write to r1.
    fn remembered(guard: &FingerprintGuard, writer: &str) -> Option<String> {
        use rusqlite::OptionalExtension;
        let memory = guard.memory.lock().unwrap();
        let Memory::File(db) = &*memory else { panic!("the tests open a file") };
        db.query_row("select fingerprint from write_fingerprint where adapter = 'attio' and external_id = 'r1' and writer = ?", params![writer], |r| r.get(0)).optional().unwrap()
    }

    #[test]
    fn a_later_write_replaces_the_earlier_one_for_its_writer_only() {
        let guard = guard();
        guard.record_write(&wrote("one"), "listen:sync:stamp").unwrap();
        guard.record_write(&wrote("audit"), "listen:audit:log").unwrap();
        guard.record_write(&wrote("two"), "listen:sync:stamp").unwrap();
        assert_eq!(remembered(&guard, "listen:sync:stamp"), Some(fingerprint(&wrote("two").record)));
        assert_eq!(remembered(&guard, "listen:audit:log"), Some(fingerprint(&wrote("audit").record)));
    }
}

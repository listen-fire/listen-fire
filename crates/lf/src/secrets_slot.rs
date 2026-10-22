//! The secrets slot: where lf's credentials are kept, a module like the other
//! slots' (crate::core). lf asks it for the credentials it holds, reads and
//! writes one back by compare-and-swap (the secrets family's rules,
//! crate::secrets_family), holds one under a lease while a refresh spends its
//! token, and changes whole entries for `lf connect`, `lf credential` and a
//! webhook's registration. Token refresh stays in lf; a module only stores.
//!
//! The default, `@lf/file-secrets`, is lf's secrets file (plain or SOPS) and
//! its lock file, in process (`FileSecretsModule`). A module lf does not build
//! in is spoken to over adapter protocol 2 (`ProcessSecrets`):
//!
//!   secrets.resolve { ref }                            → { fields, version } | null
//!   secrets.writeBack { ref, fields, expectedVersion } → { kind: written | not_persisted | conflict | missing, … }
//!   secrets.list {}                                    → [{ ref, external, binding: "install" | "legacy" | { credential }, version }]
//!   secrets.lock { ref, ttlMs }                        → { token } | null (another holds it; lf asks again)
//!   secrets.unlock { ref, token }
//!   secrets.assertWritable { ref }
//!   secrets.create | secrets.replace { ref, external, binding, fields }
//!   secrets.delete { ref }
//!
//! The three entry methods answer null, or `{ kind: "read_only", reason }` from
//! a module that cannot persist; lf then refuses by name (`EntryError`).
//!
//! Whichever module fills the slot, `LF_SECRET__<CREDENTIAL>__<FIELD>` lies
//! over what it holds (crate::secrets). The module's own settings cannot come
//! from itself: they are read from the environment and the secrets file only
//! (`module_settings`), and a project naming a module whose settings are in
//! neither is refused as it loads (`refuse_unbootstrapped`).

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::{Duration, Instant};

use crate::core::{CoreModule, ProcessModule};
use crate::json::{Js, Obj};
use crate::obj;
use crate::project::Project;
use crate::secret_stores::{Entry, EntryChange, FileSecrets, assert_sops_runs, change_entry, write_staged};
use crate::secrets::{Binding, Credentials, ENV_PREFIX, SecretsFile, install_of, parse_entry, read_secrets_file, secrets_file_of, secrets_paths};
use crate::secrets_family::{Fields, FileLock, LOCK_WAIT, Lease, LocalFuture, POLL_EVERY, Record, SecretsBackend, WriteBack, content_version};
use crate::slot_client::SlotClient;

/// One credential a store holds, as `secrets.list` names it.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub reference: String,
    pub external: String,
    pub binding: Binding,
    pub version: String,
}

/// One credential a store holds, with its fields.
pub struct Stored {
    pub reference: String,
    pub external: String,
    pub binding: Binding,
    pub fields: Fields,
}

/// Why a whole entry was not changed.
#[derive(Debug, Clone, PartialEq)]
pub enum EntryError {
    /// The module keeps its credentials where lf cannot change them.
    ReadOnly { module: String, reason: String },
    Failed(String),
}

impl EntryError {
    /// The refusal `lf connect`, `lf credential` and webhook registration give.
    pub const REGISTER_WHERE_IT_LIVES: &'static str = "Register the webhook where the credentials live.";

    pub fn refusal(&self) -> String {
        match self {
            EntryError::ReadOnly { module, reason } => format!("{module} holds its credentials read-only: {reason}. Add it where it lives."),
            EntryError::Failed(message) => message.clone(),
        }
    }

    /// `refusal`, a webhook's registration saying where to register instead.
    pub fn refusal_for_webhook(&self) -> String {
        match self {
            EntryError::ReadOnly { .. } => format!("{} {}", self.refusal(), EntryError::REGISTER_WHERE_IT_LIVES),
            EntryError::Failed(message) => message.clone(),
        }
    }
}

impl From<String> for EntryError {
    fn from(message: String) -> EntryError {
        EntryError::Failed(message)
    }
}

impl From<EntryError> for String {
    fn from(error: EntryError) -> String {
        error.refusal()
    }
}

/// What fills the secrets slot: the family's store (resolve, write back by
/// version, lease, writable) plus what lf reads the whole list by and
/// changes whole entries with.
pub trait SecretsStore: SecretsBackend {
    /// Where its credentials are kept, as messages name it (a file's path).
    fn label(&self) -> String;
    /// Where a credential that is not there was looked for.
    fn looked_in(&self) -> String;
    fn list(&self) -> Result<Vec<Listed>, String>;
    /// Every credential with its fields: `list`, then each resolved.
    fn entries(&self) -> Result<Vec<Stored>, String> {
        let mut entries = Vec::new();
        for listed in self.list()? {
            // Deleted between the two: not there.
            let Some(record) = self.resolve(&listed.reference)? else { continue };
            entries.push(Stored { reference: listed.reference, external: listed.external, binding: listed.binding, fields: record.fields });
        }
        Ok(entries)
    }
    /// A new entry; refused when it exists.
    fn create<'a>(&'a self, reference: &'a str, entry: Entry) -> LocalFuture<'a, Result<(), EntryError>>;
    /// The entry replaced by what `next` makes of it as stored now (None: there is none), under its lock.
    fn replace<'a>(&'a self, reference: &'a str, next: &'a dyn Fn(Option<Entry>) -> Result<Entry, String>) -> LocalFuture<'a, Result<(), EntryError>>;
    fn delete<'a>(&'a self, reference: &'a str) -> LocalFuture<'a, Result<(), EntryError>>;
}

// ── @lf/file-secrets ────────────────────────────────────────────────────────

/// lf's secrets file as the slot's module: the first of `LF_SECRETS_FILE`,
/// `<project>/.lf/secrets.yaml`, `~/.config/lf/secrets.yaml` that exists
/// (SOPS read with `sops -d`, changed with `sops set`), held under its lock
/// file. The file is found again on each call, so one `lf connect` creates
/// is read from then on.
pub struct FileSecretsModule {
    at: Where,
}

enum Where {
    /// One file (`lf --contract-secrets <file>`).
    File(PathBuf),
    Project { paths: Vec<PathBuf>, named: Option<String>, created: PathBuf },
}

impl FileSecretsModule {
    pub fn of_project(project: &Project, env: &[(String, String)]) -> FileSecretsModule {
        let named = env.iter().find(|(k, v)| k == "LF_SECRETS_FILE" && !v.is_empty()).map(|(_, v)| v.clone());
        FileSecretsModule { at: Where::Project { paths: secrets_paths(project, env), named, created: project.lf_dir.join("secrets.yaml") } }
    }

    pub fn at(path: &Path) -> Result<FileSecretsModule, String> {
        read_secrets_file(path)?;
        Ok(FileSecretsModule { at: Where::File(path.to_path_buf()) })
    }

    fn found(&self) -> Option<PathBuf> {
        match &self.at {
            Where::File(path) => Some(path.clone()),
            Where::Project { paths, .. } => paths.iter().find(|p| p.exists()).cloned(),
        }
    }

    /// The file its credentials are read from, if there is one.
    fn file(&self) -> Result<Option<FileSecrets>, String> {
        self.found().map(|path| secrets_file_of(&path).map(|file| FileSecrets { file })).transpose()
    }

    /// The file new entries go to: the one secrets are read from, else the
    /// project's `.lf/secrets.yaml` (created, readable by its owner only).
    fn file_for_writes(&self) -> Result<SecretsFile, String> {
        let (paths, named, created) = match &self.at {
            Where::File(path) => return secrets_file_of(path),
            Where::Project { paths, named, created } => (paths, named, created),
        };
        if let Some(path) = paths.iter().find(|p| p.exists()) {
            return secrets_file_of(path);
        }
        if let Some(named) = named {
            return Err(format!("LF_SECRETS_FILE points at {named}, which does not exist"));
        }
        write_staged(created, "secrets", "# Written by `lf connect` and `lf credential`; not edited by hand.\n")?;
        Ok(SecretsFile { path: created.clone(), encrypted: false })
    }
}

impl SecretsBackend for FileSecretsModule {
    fn resolve(&self, reference: &str) -> Result<Option<Record>, String> {
        match self.file()? {
            Some(file) => file.resolve(reference),
            None => Ok(None),
        }
    }

    fn write_back(&self, reference: &str, fields: &Fields, expected: &str) -> Result<WriteBack, String> {
        match self.file()? {
            Some(file) => file.write_back(reference, fields, expected),
            None => Ok(WriteBack::Missing),
        }
    }

    /// The file's lock file, whichever credential: a refresh and an entry's
    /// change take the same one.
    fn lock<'a>(&'a self, _reference: &'a str, ttl_ms: u64) -> LocalFuture<'a, Result<Lease, String>> {
        Box::pin(async move {
            match self.found() {
                Some(path) => Ok(Lease::of_file(FileLock::acquire_for(&path, Duration::from_millis(ttl_ms)).await?)),
                None => Ok(Lease::none()),
            }
        })
    }

    fn assert_writable(&self, reference: &str) -> Result<(), String> {
        match self.file()? {
            Some(file) => assert_sops_runs(reference, &file.file),
            None => Ok(()),
        }
    }
}

impl SecretsStore for FileSecretsModule {
    fn label(&self) -> String {
        let path = match (&self.at, self.found()) {
            (_, Some(path)) => path,
            (Where::Project { named: Some(named), .. }, None) => PathBuf::from(named),
            (Where::Project { created, .. }, None) => created.clone(),
            (Where::File(path), None) => path.clone(),
        };
        path.display().to_string()
    }

    fn looked_in(&self) -> String {
        match &self.at {
            Where::File(path) => path.display().to_string(),
            Where::Project { paths, .. } => paths.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "),
        }
    }

    fn list(&self) -> Result<Vec<Listed>, String> {
        Ok(self
            .entries()?
            .into_iter()
            .map(|s| Listed { version: content_version(&s.fields), reference: s.reference, external: s.external, binding: s.binding })
            .collect())
    }

    /// The file read once, every entry in its order.
    fn entries(&self) -> Result<Vec<Stored>, String> {
        let Some(path) = self.found() else {
            if let Where::Project { named: Some(named), .. } = &self.at {
                return Err(format!("LF_SECRETS_FILE points at {named}, which does not exist"));
            }
            return Ok(Vec::new());
        };
        let (content, _) = read_secrets_file(&path)?;
        let mut entries = Vec::new();
        for (name, raw) in content {
            if name == "sops" {
                continue;
            }
            let (external, binding, fields) = parse_entry(raw).map_err(|why| format!("{}: entry \"{name}\" {why}", path.display()))?;
            entries.push(Stored { reference: name, external, binding, fields });
        }
        Ok(entries)
    }

    fn create<'a>(&'a self, reference: &'a str, entry: Entry) -> LocalFuture<'a, Result<(), EntryError>> {
        Box::pin(async move { Ok(change_entry(&self.file_for_writes()?, reference, EntryChange::Create(entry)).await?) })
    }

    fn replace<'a>(&'a self, reference: &'a str, next: &'a dyn Fn(Option<Entry>) -> Result<Entry, String>) -> LocalFuture<'a, Result<(), EntryError>> {
        Box::pin(async move { Ok(change_entry(&self.file_for_writes()?, reference, EntryChange::Replace(next)).await?) })
    }

    fn delete<'a>(&'a self, reference: &'a str) -> LocalFuture<'a, Result<(), EntryError>> {
        Box::pin(async move {
            match self.file()? {
                Some(file) => Ok(change_entry(&file.file, reference, EntryChange::Delete).await?),
                None => Err(format!("{} has no entry \"{reference}\"", self.label()).into()),
            }
        })
    }
}

// ── A secrets module lf does not build in ──────────────────────────────────

/// A secrets module spoken to over the slot's methods (crate::slot_client).
pub struct ProcessSecrets {
    name: String,
    client: SlotClient,
}

impl ProcessSecrets {
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessSecrets, String> {
        Ok(ProcessSecrets { name: name.to_string(), client: SlotClient::start("secrets", name, process, settings)? })
    }

    fn call(&self, method: &str, params: Obj) -> Result<Js, String> {
        self.client.call_text(method, params)
    }

    fn unexpected(&self, method: &str, answer: &Js) -> String {
        format!("{}: {method} answered {}, not the slot's shape", self.client.label, shape_of(answer))
    }

    /// An entry method's answer: null when changed, `{ kind: "read_only", reason }`
    /// when the module keeps its credentials where lf cannot change them.
    fn changed(&self, method: &str, params: Obj) -> Result<(), EntryError> {
        let answer = self.call(method, params)?;
        match (&answer, answer.get("kind").and_then(Js::as_str)) {
            (Js::Null, _) => Ok(()),
            (_, Some("read_only")) => {
                let reason = answer.get("reason").and_then(Js::as_str).ok_or_else(|| self.unexpected(method, &answer))?;
                Err(EntryError::ReadOnly { module: self.name.clone(), reason: reason.to_string() })
            }
            _ => Err(self.unexpected(method, &answer).into()),
        }
    }

    /// The entry as stored now, its binding keys first (crate::connect::entry_content).
    fn current_entry(&self, reference: &str) -> Result<Option<Entry>, String> {
        let Some(listed) = self.list()?.into_iter().find(|l| l.reference == reference) else { return Ok(None) };
        let Some(record) = self.resolve(reference)? else { return Ok(None) };
        let fields: Vec<(String, String)> = record.fields.into_iter().collect();
        Ok(Some(crate::connect::entry_content(&listed.external, &listed.binding, &fields)))
    }
}

impl SecretsBackend for ProcessSecrets {
    fn resolve(&self, reference: &str) -> Result<Option<Record>, String> {
        let answer = self.call("secrets.resolve", obj! { "ref" => Js::str(reference) })?;
        match answer {
            Js::Null => Ok(None),
            answer => record_of(&answer).map(Some).ok_or_else(|| self.unexpected("secrets.resolve", &answer)),
        }
    }

    fn write_back(&self, reference: &str, fields: &Fields, expected: &str) -> Result<WriteBack, String> {
        let answer = self.call("secrets.writeBack", obj! { "ref" => Js::str(reference), "fields" => fields_js(fields), "expectedVersion" => Js::str(expected) })?;
        write_back_of(&answer).ok_or_else(|| self.unexpected("secrets.writeBack", &answer))
    }

    /// The module's lease: asked for again until it is free, as a lock file is waited for.
    fn lock<'a>(&'a self, reference: &'a str, ttl_ms: u64) -> LocalFuture<'a, Result<Lease, String>> {
        Box::pin(async move {
            let started = Instant::now();
            loop {
                let answer = self.call("secrets.lock", obj! { "ref" => Js::str(reference), "ttlMs" => Js::Num(ttl_ms.into()) })?;
                if let Some(token) = answer.get("token").and_then(Js::as_str) {
                    return Ok(Lease::of_token(token.to_string()));
                }
                if answer != Js::Null {
                    return Err(self.unexpected("secrets.lock", &answer));
                }
                if started.elapsed() > LOCK_WAIT {
                    return Err(format!("{} kept credential \"{reference}\" locked by another lf for {}s", self.client.label, LOCK_WAIT.as_secs()));
                }
                tokio::time::sleep(POLL_EVERY).await;
            }
        })
    }

    fn unlock(&self, reference: &str, lease: Lease) {
        if let Err(message) = self.call("secrets.unlock", obj! { "ref" => Js::str(reference), "token" => Js::str(&lease.token) }) {
            eprintln!("lf: credential \"{reference}\" was not unlocked ({message}); its lease lapses on its own");
        }
    }

    fn assert_writable(&self, reference: &str) -> Result<(), String> {
        self.call("secrets.assertWritable", obj! { "ref" => Js::str(reference) }).map(drop)
    }
}

impl SecretsStore for ProcessSecrets {
    fn label(&self) -> String {
        self.client.label.clone()
    }

    fn looked_in(&self) -> String {
        self.client.label.clone()
    }

    fn list(&self) -> Result<Vec<Listed>, String> {
        let answer = self.call("secrets.list", Obj::new())?;
        let listed = answer.as_array().ok_or_else(|| self.unexpected("secrets.list", &answer))?;
        listed.iter().map(|one| listed_of(one).ok_or_else(|| self.unexpected("secrets.list", &answer))).collect()
    }

    fn create<'a>(&'a self, reference: &'a str, entry: Entry) -> LocalFuture<'a, Result<(), EntryError>> {
        Box::pin(async move { self.changed("secrets.create", entry_params(reference, &entry)?) })
    }

    fn replace<'a>(&'a self, reference: &'a str, next: &'a dyn Fn(Option<Entry>) -> Result<Entry, String>) -> LocalFuture<'a, Result<(), EntryError>> {
        Box::pin(async move {
            let lease = self.lock(reference, crate::secrets_family::LEASE_TTL_MS).await?;
            let replaced = (|| {
                let entry = next(self.current_entry(reference)?)?;
                self.changed("secrets.replace", entry_params(reference, &entry)?)
            })();
            self.unlock(reference, lease);
            replaced
        })
    }

    fn delete<'a>(&'a self, reference: &'a str) -> LocalFuture<'a, Result<(), EntryError>> {
        Box::pin(async move { self.changed("secrets.delete", obj! { "ref" => Js::str(reference) }) })
    }
}

// ── The wire's shapes, both ways (crate::contract_secrets answers them) ─────

/// An answer named by its shape, never its values: a store's answer carries secrets.
fn shape_of(answer: &Js) -> String {
    match answer {
        Js::Null => "null".into(),
        Js::Bool(_) => "a boolean".into(),
        Js::Num(_) => "a number".into(),
        Js::Str(_) => "a string".into(),
        Js::Arr(_) => "a list".into(),
        Js::Obj(map) => format!("an object with {}", map.keys().cloned().collect::<Vec<_>>().join(", ")),
    }
}

pub fn fields_js(fields: &Fields) -> Js {
    Js::from(fields.iter().map(|(k, v)| (k.clone(), Js::str(v))).collect::<Obj>())
}

pub fn fields_of(js: &Js) -> Option<Fields> {
    match js {
        Js::Obj(map) => map.iter().map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect(),
        _ => None,
    }
}

pub fn record_js(record: &Record) -> Js {
    Js::from(obj! { "fields" => fields_js(&record.fields), "version" => Js::str(&record.version) })
}

pub fn record_of(js: &Js) -> Option<Record> {
    Some(Record { fields: fields_of(js.get("fields")?)?, version: js.get("version")?.as_str()?.to_string() })
}

pub fn write_back_js(outcome: &WriteBack) -> Js {
    Js::from(match outcome {
        WriteBack::Written(record) => obj! { "kind" => Js::str("written"), "record" => record_js(record) },
        WriteBack::NotPersisted { record, why } => obj! { "kind" => Js::str("not_persisted"), "record" => record_js(record), "why" => Js::str(why) },
        WriteBack::Conflict(current) => obj! { "kind" => Js::str("conflict"), "current" => record_js(current) },
        WriteBack::Missing => obj! { "kind" => Js::str("missing") },
    })
}

pub fn write_back_of(js: &Js) -> Option<WriteBack> {
    match js.get("kind")?.as_str()? {
        "written" => Some(WriteBack::Written(record_of(js.get("record")?)?)),
        "not_persisted" => Some(WriteBack::NotPersisted { record: record_of(js.get("record")?)?, why: js.get("why")?.as_str()?.to_string() }),
        "conflict" => Some(WriteBack::Conflict(record_of(js.get("current")?)?)),
        "missing" => Some(WriteBack::Missing),
        _ => None,
    }
}

pub fn binding_js(binding: &Binding) -> Js {
    match binding {
        Binding::Install => Js::str("install"),
        Binding::Legacy => Js::str("legacy"),
        Binding::Credential(declared) => Js::from(obj! { "credential" => Js::str(declared) }),
    }
}

pub fn binding_of(js: &Js) -> Option<Binding> {
    match js {
        Js::Str(s) if s == "install" => Some(Binding::Install),
        Js::Str(s) if s == "legacy" => Some(Binding::Legacy),
        Js::Obj(_) => Some(Binding::Credential(js.get("credential")?.as_str()?.to_string())),
        _ => None,
    }
}

pub fn listed_of(js: &Js) -> Option<Listed> {
    Some(Listed {
        reference: js.get("ref")?.as_str()?.to_string(),
        external: js.get("external")?.as_str()?.to_string(),
        binding: binding_of(js.get("binding")?)?,
        version: js.get("version")?.as_str()?.to_string(),
    })
}

/// A whole entry (its binding keys, then its fields) as `secrets.create` /
/// `secrets.replace` carry it.
fn entry_params(reference: &str, entry: &Entry) -> Result<Obj, String> {
    let mapping: serde_yaml::Mapping = entry.iter().map(|(k, v)| (serde_yaml::Value::String(k.clone()), serde_yaml::Value::String(v.clone()))).collect();
    let (external, binding, fields) = parse_entry(serde_yaml::Value::Mapping(mapping)).map_err(|why| format!("entry \"{reference}\" {why}"))?;
    Ok(obj! { "ref" => Js::str(reference), "external" => Js::str(external), "binding" => binding_js(&binding), "fields" => fields_js(&fields) })
}

// ── The slot, for the project on this thread ───────────────────────────────

// Per thread, as the wake slot is (crate::wake): each test's session keeps its own.
thread_local! {
    /// The store the last opened secrets came from: what a loaded
    /// credential is refreshed and written back through.
    static SLOT: RefCell<Option<Rc<dyn SecretsStore>>> = const { RefCell::new(None) };
    /// A module lf does not build in, reached once per project and module.
    static STARTED: RefCell<HashMap<(PathBuf, String), Rc<ProcessSecrets>>> = RefCell::new(HashMap::new());
}

pub fn install(store: Rc<dyn SecretsStore>) {
    SLOT.with(|slot| *slot.borrow_mut() = Some(store));
}

pub fn installed() -> Option<Rc<dyn SecretsStore>> {
    SLOT.with(|slot| slot.borrow().clone())
}

/// The module lf.yaml's `core: { secrets: … }` names, reached with its own settings.
pub fn of_project(project: &Project, env: &[(String, String)]) -> Result<Rc<dyn SecretsStore>, String> {
    let module = &project.core.secrets;
    let Some(process) = &module.process else { return Ok(Rc::new(FileSecretsModule::of_project(project, env))) };
    let key = (project.root.clone(), module.name.to_string());
    if let Some(started) = STARTED.with(|started| started.borrow().get(&key).cloned()) {
        return Ok(started);
    }
    let started = Rc::new(ProcessSecrets::start(&module.name, process, &module_settings(project, env, module)?)?);
    STARTED.with(|s| s.borrow_mut().insert(key, started.clone()));
    Ok(started)
}

/// The bootstrap rule: a secrets module's own settings come from the
/// environment and the secrets file, never from the module.
pub fn module_settings(project: &Project, env: &[(String, String)], module: &CoreModule) -> Result<BTreeMap<String, String>, String> {
    Ok(crate::core::settings_of(&local_credentials(project, env)?, module))
}

fn local_credentials(project: &Project, env: &[(String, String)]) -> Result<Credentials, String> {
    Ok(crate::secrets::Secrets::local(project, env)?.into_credentials())
}

/// A project whose secrets module needs settings neither the environment
/// nor the secrets file holds is refused as it loads.
pub fn refuse_unbootstrapped(project: &Project, env: &[(String, String)]) -> Result<(), String> {
    let module = &project.core.secrets;
    let Some(process) = &module.process else { return Ok(()) };
    let needs = module.settings.iter().any(|s| !s.optional) || process.auth_field.is_some();
    if !needs || install_of(&local_credentials(project, env)?, &module.name).is_some() {
        return Ok(());
    }
    let entry = crate::connect::core_entry_name(&module.name).to_uppercase();
    Err(format!(
        "core.secrets: {name}: the secrets module's own settings come from {ENV_PREFIX}… or the secrets file, not from the module; neither holds {name}'s install (run `lf connect {name}` before naming it in lf.yaml, or set {ENV_PREFIX}{entry}__EXTERNAL={name} and its settings as {ENV_PREFIX}{entry}__<SETTING>)",
        name = module.name
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed_js(listed: &Listed) -> Js {
        Js::from(obj! {
            "ref" => Js::str(&listed.reference),
            "external" => Js::str(&listed.external),
            "binding" => binding_js(&listed.binding),
            "version" => Js::str(&listed.version),
        })
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    fn file_with(text: &str) -> (PathBuf, FileSecretsModule) {
        let dir = std::env::temp_dir().join(format!("lf-file-secrets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.yaml");
        write_staged(&path, "secrets", text).unwrap();
        let module = FileSecretsModule::at(&path).unwrap();
        (path, module)
    }

    #[test]
    fn the_file_module_lists_every_entry_with_its_binding_and_version() {
        let (_, module) = file_with("# head\nacme:\n  external: acme_crm\n  token: t\nhub:\n  module: hubspot\n  client_id: c\nada:\n  module: hubspot\n  credential: oauth\n  access_token: a\n");
        let listed = module.list().unwrap();
        let bindings: Vec<(&str, &str, &Binding)> = listed.iter().map(|l| (l.reference.as_str(), l.external.as_str(), &l.binding)).collect();
        assert_eq!(bindings, [("acme", "acme_crm", &Binding::Legacy), ("hub", "hubspot", &Binding::Install), ("ada", "hubspot", &Binding::Credential("oauth".into()))]);
        assert_eq!(listed[0].version, module.resolve("acme").unwrap().unwrap().version, "a listed version is the one resolve answers");
        for one in &listed {
            assert_eq!(listed_of(&listed_js(one)).as_ref(), Some(one), "the wire's shape reads back");
        }
    }

    #[test]
    fn a_read_only_refusal_names_the_module_and_its_reason_and_the_remedy_of_the_command() {
        let read_only = EntryError::ReadOnly { module: "acme_vault".into(), reason: "it is filled from the platform".into() };
        assert_eq!(String::from(read_only.clone()), "acme_vault holds its credentials read-only: it is filled from the platform. Add it where it lives.");
        assert_eq!(
            read_only.refusal_for_webhook(),
            "acme_vault holds its credentials read-only: it is filled from the platform. Add it where it lives. Register the webhook where the credentials live."
        );
        assert_eq!(EntryError::Failed("boom".into()).refusal_for_webhook(), "boom");
    }

    #[test]
    fn the_file_modules_entry_methods_keep_the_files_comments() {
        let (path, module) = file_with("# keep\nacme:\n  external: acme_crm\n  token: t\n");
        block_on(async {
            module.create("ada", vec![("module".into(), "hubspot".into()), ("credential".into(), "oauth".into()), ("access_token".into(), "a".into())]).await.unwrap();
            assert!(String::from(module.create("ada", Vec::new()).await.unwrap_err()).contains("already has an entry \"ada\""));
            module.replace("acme", &|stored| Ok(crate::connect::spread(stored.unwrap(), vec![("token".into(), "t2".into())]))).await.unwrap();
            module.delete("ada").await.unwrap();
            assert!(String::from(module.delete("ada").await.unwrap_err()).contains("has no entry \"ada\""));
        });
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# keep\nacme:\n  external: acme_crm\n  token: t2\n");
    }

    #[test]
    fn the_file_modules_lease_is_its_lock_file_and_another_waits_for_it() {
        let (path, module) = file_with("acme:\n  external: acme_crm\n  token: t\n");
        let lock_file = PathBuf::from(format!("{}.lock", path.display()));
        block_on(async {
            let lease = module.lock("acme", 60_000).await.unwrap();
            assert!(lock_file.exists());
            assert_eq!(lease.token, lock_file.display().to_string());
            module.unlock("acme", lease);
            assert!(!lock_file.exists());
            // One left longer than the lease's ttl by a holder that died is taken over.
            std::fs::write(&lock_file, "").unwrap();
            std::thread::sleep(Duration::from_millis(5));
            let taken_over = module.lock("acme", 1).await.unwrap();
            module.unlock("acme", taken_over);
            assert!(!lock_file.exists());
        });
    }

    #[test]
    fn a_secrets_module_that_needs_settings_is_refused_unless_the_environment_or_file_holds_them() {
        let dir = std::env::temp_dir().join(format!("lf-secrets-boot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("externals/vault")).unwrap();
        std::fs::write(dir.join("externals/vault/lf-external.yaml"), "name: vault\nkind: core\nslot: secrets\nurl: http://127.0.0.1:9/\nsettings:\n  - { name: project }\n").unwrap();
        std::fs::write(dir.join("lf.yaml"), "engine: 0.12.0\ncore:\n  secrets: vault\n").unwrap();
        let project = crate::project::load_project_with(&dir, &[]).unwrap_err();
        assert!(project.contains("the secrets module's own settings come from LF_SECRET__… or the secrets file, not from the module"), "{project}");
        let env = [("LF_SECRET__VAULT__EXTERNAL".to_string(), "vault".to_string()), ("LF_SECRET__VAULT__PROJECT".to_string(), "p".to_string())];
        let project = crate::project::load_project_with(&dir, &env).unwrap();
        assert_eq!(module_settings(&project, &env, &project.core.secrets).unwrap().get("project").map(String::as_str), Some("p"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

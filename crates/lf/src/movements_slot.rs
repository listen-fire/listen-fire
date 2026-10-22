//! The movements slot: where the project's movement files live, a module like
//! the other slots' (crate::core). lf asks it for every file by name when a
//! command opens its project, and writes one back by compare-and-swap when
//! `lf upgrade` rewrites it or `lf init` creates the starter. lf.yaml and the
//! externals folder stay local files.
//!
//! The default, `@lf/folder-movements`, is the movements folder lf.yaml names,
//! walked in process as it always was (`FolderMovements`). A module lf does
//! not build in is spoken to over adapter protocol 2 (`ProcessMovements`):
//!
//!   movements.list {}                               → [{ path, version? }]
//!   movements.read { path }                         → { text, version } | null
//!   movements.write { path, text, expectedVersion } → { kind: written | conflict | read_only, … }
//!
//! A `path` is the file's name under the movements folder (`orders/sync.mvt`):
//! the name every identity lf keeps already uses (run rows, listen pipelines,
//! subscriptions, imports). A version is opaque and changes with the text;
//! lf keeps each text by its version for the process, so a scan whose listed
//! version it already holds asks no `read`.
//!
//! The module's own settings (a platform's tenant) cannot come from the
//! secrets slot, which may not open where files are still read (`lf lsp`):
//! they are read from the environment and the secrets file only, and a
//! project naming a module whose settings are in neither is refused as it
//! loads (`refuse_unbootstrapped`).

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use sha2::{Digest, Sha256};

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::obj;
use crate::project::{PROJECT_FILE, Project};
use crate::secrets_slot::shape_of;
use crate::slot_client::SlotClient;
use crate::sources::{MOVEMENT_EXTENSION, MovementFile};

/// The slot's methods (engine-contracts `slots/movements.ts` `MOVEMENTS_METHODS`).
pub const MOVEMENTS_METHODS: &[&str] = &["movements.list", "movements.read", "movements.write"];

/// One movement file a module holds, as `movements.list` names it.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub path: String,
    /// None: the module does not say, and lf reads the file on every scan.
    pub version: Option<String>,
}

/// One movement file's text, at its version.
#[derive(Debug, Clone, PartialEq)]
pub struct Text {
    pub text: String,
    pub version: String,
}

/// What a write did.
#[derive(Debug, Clone, PartialEq)]
pub enum Written {
    Written { version: String },
    /// Not at the expected version: the version there now (None: there is no file).
    Conflict { current: Option<String> },
}

/// Why a file was not written.
#[derive(Debug, Clone, PartialEq)]
pub enum WriteError {
    /// The module keeps the project's movements where lf cannot change them.
    ReadOnly { module: String, reason: String },
    Failed(String),
}

impl WriteError {
    /// What `lf upgrade` and `lf init` refuse with.
    pub fn refusal(&self) -> String {
        match self {
            WriteError::ReadOnly { module, reason } => format!("{module} holds the project's movements read-only: {reason}. Change them where they live."),
            WriteError::Failed(message) => message.clone(),
        }
    }
}

impl From<String> for WriteError {
    fn from(message: String) -> WriteError {
        WriteError::Failed(message)
    }
}

/// What fills the movements slot.
pub trait MovementsStore {
    /// Where the files are kept, as messages name it.
    fn label(&self) -> String;
    fn list(&self) -> Result<Vec<Listed>, String>;
    /// None: nothing is at `path`.
    fn read(&self, path: &str) -> Result<Option<Text>, String>;
    /// `text` at `path` if it is still at `expected` (None: if nothing is there).
    fn write(&self, path: &str, text: &str, expected: Option<&str>) -> Result<Written, WriteError>;
    /// Every file, in the walk's order: `list`, then each read. Each file's
    /// display path is under `movements_dir`.
    fn files(&self, movements_dir: &Path) -> Result<Vec<MovementFile>, String> {
        let mut files = Vec::new();
        for listed in in_order(self.list()?) {
            // Deleted between the two: not there.
            let Some(text) = self.read(&listed.path)? else { continue };
            files.push(movement_file(movements_dir, &listed.path, text));
        }
        Ok(files)
    }
}

fn movement_file(movements_dir: &Path, path: &str, text: Text) -> MovementFile {
    MovementFile { name: path.strip_suffix(MOVEMENT_EXTENSION).unwrap_or(path).to_string(), path: movements_dir.join(path), source: text.text, version: Some(text.version) }
}

/// A file's name under the movements folder: `/`-separated, ending `.mvt`,
/// no segment empty, `.` or `..`, no `\`.
pub fn is_movement_path(path: &str) -> bool {
    !path.contains('\\')
        && path.ends_with(MOVEMENT_EXTENSION)
        && path.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && path.rsplit('/').next() != Some(MOVEMENT_EXTENSION)
}

/// A text's version: the first 16 bytes of its SHA-256, in hex.
pub fn version_of(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// The walk's order over paths: segment by segment, each by UTF-16 code
/// units (`Array.prototype.sort`), so a folder's files come where the folder
/// sorts among its siblings (`a/b.mvt` before `a.mvt`).
pub fn order(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.split('/'), b.split('/'));
    loop {
        match (a.next(), b.next()) {
            (Some(x), Some(y)) => match x.encode_utf16().cmp(y.encode_utf16()) {
                Ordering::Equal => continue,
                unequal => return unequal,
            },
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        }
    }
}

fn in_order(mut listed: Vec<Listed>) -> Vec<Listed> {
    listed.sort_by(|a, b| order(&a.path, &b.path));
    listed
}

// ── @lf/folder-movements ────────────────────────────────────────────────────

/// The movements folder as the slot's module: every `.mvt` under it, each
/// folder's entries in sorted order, folders walked depth first.
pub struct FolderMovements {
    dir: PathBuf,
}

impl FolderMovements {
    pub fn at(dir: &Path) -> FolderMovements {
        FolderMovements { dir: dir.to_path_buf() }
    }

    fn walk(&self, dir: &Path, files: &mut Vec<MovementFile>) -> Result<(), String> {
        if !dir.exists() {
            return Ok(());
        }
        let mut entries: Vec<_> = fs::read_dir(dir)
            .map_err(|e| format!("{}: {e}", dir.display()))?
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("{}: {e}", dir.display()))?;
        // `Array.prototype.sort` orders by UTF-16 code units.
        entries.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        for entry in entries {
            let path = dir.join(&entry);
            if path.is_dir() {
                self.walk(&path, files)?;
            } else if let Some(stem) = entry.strip_suffix(MOVEMENT_EXTENSION) {
                let relative_dir = dir.strip_prefix(&self.dir).unwrap_or(Path::new(""));
                let name = relative_dir
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .chain(std::iter::once(stem.to_string()))
                    .collect::<Vec<_>>()
                    .join("/");
                let source = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                files.push(MovementFile { name, path, version: Some(version_of(&source)), source });
            }
        }
        Ok(())
    }

    fn on_disk(&self, path: &str) -> Result<PathBuf, String> {
        match is_movement_path(path) {
            true => Ok(self.dir.join(path)),
            false => Err(format!("\"{path}\" is not a movement file's path under {}", self.dir.display())),
        }
    }
}

impl MovementsStore for FolderMovements {
    fn label(&self) -> String {
        self.dir.display().to_string()
    }

    fn list(&self) -> Result<Vec<Listed>, String> {
        Ok(self.files(&self.dir)?.into_iter().map(|f| Listed { path: format!("{}{MOVEMENT_EXTENSION}", f.name), version: f.version }).collect())
    }

    fn read(&self, path: &str) -> Result<Option<Text>, String> {
        let at = self.on_disk(path)?;
        match fs::read_to_string(&at) {
            Ok(text) => Ok(Some(Text { version: version_of(&text), text })),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("{}: {e}", at.display())),
        }
    }

    /// Compared by re-reading, then written in place (`fs::write` keeps
    /// the file's inode and mode), its folders created.
    fn write(&self, path: &str, text: &str, expected: Option<&str>) -> Result<Written, WriteError> {
        let at = self.on_disk(path)?;
        let current = self.read(path)?.map(|t| t.version);
        if current.as_deref() != expected {
            return Ok(Written::Conflict { current });
        }
        if let Some(parent) = at.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        fs::write(&at, text).map_err(|e| format!("{}: {e}", at.display()))?;
        Ok(Written::Written { version: version_of(text) })
    }

    /// The walk itself: one read per file. Its display paths are where the
    /// files are, which is `movements_dir` for the project's folder.
    fn files(&self, _movements_dir: &Path) -> Result<Vec<MovementFile>, String> {
        let mut files = Vec::new();
        self.walk(&self.dir, &mut files)?;
        Ok(files)
    }
}

// ── A movements module lf does not build in ────────────────────────────────

/// A movements module spoken to over the slot's methods (crate::slot_client),
/// each text kept by its version for the process.
pub struct ProcessMovements {
    name: String,
    client: SlotClient,
    texts: RefCell<HashMap<String, Text>>,
}

impl ProcessMovements {
    pub fn start(name: &str, process: &ProcessModule, settings: &BTreeMap<String, String>) -> Result<ProcessMovements, String> {
        Ok(ProcessMovements { name: name.to_string(), client: SlotClient::start("movements", name, process, settings)?, texts: RefCell::new(HashMap::new()) })
    }

    fn unexpected(&self, method: &str, answer: &Js) -> String {
        unexpected(&self.client.label, method, answer)
    }

    fn kept(&self, listed: &Listed) -> Option<Text> {
        let version = listed.version.as_ref()?;
        self.texts.borrow().get(&listed.path).filter(|kept| &kept.version == version).cloned()
    }
}

/// A malformed answer named by its shape, never its text.
fn unexpected(label: &str, method: &str, answer: &Js) -> String {
    format!("{label}: {method} answered {}, not the slot's shape", shape_of(answer))
}

impl MovementsStore for ProcessMovements {
    fn label(&self) -> String {
        self.client.label.clone()
    }

    fn list(&self) -> Result<Vec<Listed>, String> {
        listed_of(&self.client.label, &self.client.call_text("movements.list", Obj::new())?)
    }

    fn read(&self, path: &str) -> Result<Option<Text>, String> {
        let answer = self.client.call_text("movements.read", obj! { "path" => Js::str(path) })?;
        let read = match answer {
            Js::Null => None,
            answer => Some(text_of(&answer).ok_or_else(|| self.unexpected("movements.read", &answer))?),
        };
        let mut texts = self.texts.borrow_mut();
        match &read {
            Some(text) => texts.insert(path.to_string(), text.clone()),
            None => texts.remove(path),
        };
        Ok(read)
    }

    fn write(&self, path: &str, text: &str, expected: Option<&str>) -> Result<Written, WriteError> {
        let params = obj! { "path" => Js::str(path), "text" => Js::str(text), "expectedVersion" => expected.map_or(Js::Null, Js::str) };
        let answer = self.client.call_text("movements.write", params)?;
        let written = written_of(&answer, &self.name).ok_or_else(|| self.unexpected("movements.write", &answer))?;
        if let Ok(Written::Written { .. }) = written {
            self.texts.borrow_mut().remove(path);
        }
        written
    }

    /// `list`, then a `read` only for a file whose listed version is not
    /// the one kept: one open's second scan is one `list`.
    fn files(&self, movements_dir: &Path) -> Result<Vec<MovementFile>, String> {
        let mut files = Vec::new();
        for listed in in_order(self.list()?) {
            let text = match self.kept(&listed) {
                Some(text) => text,
                None => match self.read(&listed.path)? {
                    Some(text) => text,
                    None => continue,
                },
            };
            files.push(movement_file(movements_dir, &listed.path, text));
        }
        Ok(files)
    }
}

// ── The wire's shapes, both ways ───────────────────────────────────────────

pub fn listed_js(listed: &[Listed]) -> Js {
    Js::Arr(
        listed
            .iter()
            .map(|l| {
                let mut one = obj! { "path" => Js::str(&l.path) };
                if let Some(version) = &l.version {
                    one.insert("version".into(), Js::str(version));
                }
                Js::from(one)
            })
            .collect(),
    )
}

/// `movements.list`'s answer from the module `label`: a path that is not a
/// movement path, or one named twice, is refused naming both.
pub fn listed_of(label: &str, answer: &Js) -> Result<Vec<Listed>, String> {
    let shape = || unexpected(label, "movements.list", answer);
    let mut seen = HashSet::new();
    let mut listed = Vec::new();
    for one in answer.as_array().ok_or_else(shape)? {
        let path = one.get("path").and_then(Js::as_str).ok_or_else(shape)?;
        let version = match one.get("version") {
            None | Some(Js::Null) => None,
            Some(Js::Str(version)) if !version.is_empty() => Some(version.clone()),
            Some(_) => return Err(shape()),
        };
        if !is_movement_path(path) {
            return Err(format!("{label}: movements.list named \"{path}\", which is not a movement file's path (relative to the movements folder, `/`-separated, ending {MOVEMENT_EXTENSION})"));
        }
        if !seen.insert(path.to_string()) {
            return Err(format!("{label}: movements.list named \"{path}\" twice"));
        }
        listed.push(Listed { path: path.to_string(), version });
    }
    Ok(listed)
}

pub fn text_js(text: &Text) -> Js {
    Js::from(obj! { "text" => Js::str(&text.text), "version" => Js::str(&text.version) })
}

pub fn text_of(js: &Js) -> Option<Text> {
    let version = js.get("version")?.as_str().filter(|v| !v.is_empty())?;
    Some(Text { text: js.get("text")?.as_str()?.to_string(), version: version.to_string() })
}

/// A write's answer on the wire; a failure is not one (it is the module's error).
pub fn written_js(outcome: &Result<Written, WriteError>) -> Result<Js, String> {
    Ok(Js::from(match outcome {
        Ok(Written::Written { version }) => obj! { "kind" => Js::str("written"), "version" => Js::str(version) },
        Ok(Written::Conflict { current }) => obj! { "kind" => Js::str("conflict"), "current" => current.as_deref().map_or(Js::Null, Js::str) },
        Err(WriteError::ReadOnly { reason, .. }) => obj! { "kind" => Js::str("read_only"), "reason" => Js::str(reason) },
        Err(WriteError::Failed(message)) => return Err(message.clone()),
    }))
}

/// `movements.write`'s answer from the module named `module`.
pub fn written_of(js: &Js, module: &str) -> Option<Result<Written, WriteError>> {
    match js.get("kind")?.as_str()? {
        "written" => Some(Ok(Written::Written { version: js.get("version")?.as_str().filter(|v| !v.is_empty())?.to_string() })),
        "conflict" => match js.get("current")? {
            Js::Null => Some(Ok(Written::Conflict { current: None })),
            Js::Str(current) => Some(Ok(Written::Conflict { current: Some(current.clone()) })),
            _ => None,
        },
        "read_only" => Some(Err(WriteError::ReadOnly { module: module.to_string(), reason: js.get("reason")?.as_str()?.to_string() })),
        _ => None,
    }
}

// ── The slot, for the project on this thread ───────────────────────────────

// Per thread, as the secrets slot's are (crate::secrets_slot).
thread_local! {
    /// A module lf does not build in, reached once per project and module.
    static STARTED: RefCell<HashMap<(PathBuf, String), Rc<ProcessMovements>>> = RefCell::new(HashMap::new());
}

/// The module lf.yaml's `core: { movements: … }` names, reached with its own settings.
pub fn of_project(project: &Project, env: &[(String, String)]) -> Result<Rc<dyn MovementsStore>, String> {
    let module = &project.core.movements;
    let Some(process) = &module.process else { return Ok(Rc::new(FolderMovements::at(&project.movements_dir))) };
    let key = (project.root.clone(), module.name.to_string());
    if let Some(started) = STARTED.with(|started| started.borrow().get(&key).cloned()) {
        return Ok(started);
    }
    // `lf upgrade` loads its project without the check: it is made here too.
    refuse_unbootstrapped(project, env).map_err(|why| format!("{}: {why}", project.root.join(PROJECT_FILE).display()))?;
    let started = Rc::new(ProcessMovements::start(&module.name, process, &crate::secrets_slot::module_settings(project, env, module)?)?);
    STARTED.with(|s| s.borrow_mut().insert(key, started.clone()));
    Ok(started)
}

/// A project whose movements module needs settings neither the environment
/// nor the secrets file holds is refused as it loads.
pub fn refuse_unbootstrapped(project: &Project, env: &[(String, String)]) -> Result<(), String> {
    crate::secrets_slot::refuse_unbootstrapped_module(project, env, &project.core.movements, "the secrets slot")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(prefix: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_folder_module_lists_what_the_walk_found_in_its_order() {
        let dir = temp("lf-folder-movements");
        fs::create_dir_all(dir.join("a")).unwrap();
        for (path, text) in [("a.mvt", "x = 1\n"), ("a/b.mvt", "x = 2\n"), ("B.mvt", "x = 3\n"), ("notes.txt", "not a movement")] {
            fs::write(dir.join(path), text).unwrap();
        }
        let module = FolderMovements::at(&dir);
        let files = module.files(&dir).unwrap();
        let names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["B", "a/b", "a"], "each folder's entries by UTF-16 code units, folders depth first");
        assert_eq!(files[1].path, dir.join("a/b.mvt"));
        assert_eq!(files[1].source, "x = 2\n");
        let listed = module.list().unwrap();
        let paths: Vec<&str> = listed.iter().map(|l| l.path.as_str()).collect();
        assert_eq!(paths, ["B.mvt", "a/b.mvt", "a.mvt"]);
        assert_eq!(in_order(listed.clone()), listed, "a served list in the same order reads as the walk");
        for (listed, file) in listed.iter().zip(&files) {
            let read = module.read(&listed.path).unwrap().unwrap();
            assert_eq!(listed.version.as_deref(), Some(read.version.as_str()), "a listed version is the one read answers");
            assert_eq!(file.version.as_deref(), Some(read.version.as_str()));
            assert_eq!(read.text, file.source);
        }
        assert_eq!(module.read("nowhere.mvt").unwrap(), None);
        assert!(module.read("../a.mvt").is_err());
        assert_eq!(FolderMovements::at(&dir.join("missing")).files(&dir).unwrap().len(), 0, "no folder: no files");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_folder_module_writes_by_compare_and_swap() {
        let dir = temp("lf-folder-write");
        let module = FolderMovements::at(&dir);
        let Ok(Written::Written { version: first }) = module.write("lib/greet.mvt", "x = 1\n", None) else { panic!("a new file is created, its folder with it") };
        assert_eq!(first, version_of("x = 1\n"));
        assert_eq!(fs::read_to_string(dir.join("lib/greet.mvt")).unwrap(), "x = 1\n");
        assert_eq!(module.write("lib/greet.mvt", "x = 2\n", None), Ok(Written::Conflict { current: Some(first.clone()) }), "None means nothing is there");
        assert_eq!(fs::read_to_string(dir.join("lib/greet.mvt")).unwrap(), "x = 1\n");
        let Ok(Written::Written { version: second }) = module.write("lib/greet.mvt", "x = 2\n", Some(&first)) else { panic!("the version read replaces the file") };
        assert_eq!(second, version_of("x = 2\n"));
        assert_ne!(first, second);
        assert_eq!(module.write("lib/greet.mvt", "x = 3\n", Some(&first)), Ok(Written::Conflict { current: Some(second.clone()) }), "a stale version writes nothing");
        assert_eq!(fs::read_to_string(dir.join("lib/greet.mvt")).unwrap(), "x = 2\n");
        assert_eq!(module.write("lib/other.mvt", "x = 3\n", Some(&first)), Ok(Written::Conflict { current: None }), "a version where no file is");
        assert!(!dir.join("lib/other.mvt").exists());
        assert_eq!(module.write("../out.mvt", "x\n", None).err().map(|e| e.refusal().contains("is not a movement file's path")), Some(true));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_write_into_a_folder_that_cannot_be_made_fails_naming_the_path() {
        let dir = temp("lf-folder-write-blocked");
        fs::write(dir.join("lib"), "a file where the folder should be").unwrap();
        let failed = FolderMovements::at(&dir).write("lib/greet.mvt", "x\n", None).unwrap_err();
        let WriteError::Failed(message) = failed else { panic!("not a read-only refusal") };
        assert!(message.starts_with(&dir.join("lib").display().to_string()), "{message}");
        assert!(fs::read_to_string(dir.join("lib")).unwrap().starts_with("a file"), "nothing is written over it");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_read_only_module_refuses_by_name_and_reason() {
        let refused = WriteError::ReadOnly { module: "acme_movements".into(), reason: "the platform keeps them".into() };
        assert_eq!(refused.refusal(), "acme_movements holds the project's movements read-only: the platform keeps them. Change them where they live.");
        assert_eq!(WriteError::Failed("a/b.mvt: boom".into()).refusal(), "a/b.mvt: boom");
    }

    #[test]
    fn a_version_is_stable_and_changes_with_the_text() {
        assert_eq!(version_of("x = 1\n"), version_of("x = 1\n"));
        assert_ne!(version_of("x = 1\n"), version_of("x = 1"));
        assert_eq!(version_of("").len(), 32);
    }

    #[test]
    fn paths_order_as_the_walk_does() {
        assert_eq!(order("a/b.mvt", "a.mvt"), Ordering::Less);
        assert_eq!(order("a.mvt", "b.mvt"), Ordering::Less);
        assert_eq!(order("B.mvt", "a.mvt"), Ordering::Less);
        assert_eq!(order("a/b.mvt", "a/b.mvt"), Ordering::Equal);
        let sorted = in_order(["b.mvt", "a.mvt", "a/b.mvt", "B.mvt"].map(|p| Listed { path: p.into(), version: None }).to_vec());
        assert_eq!(sorted.iter().map(|l| l.path.as_str()).collect::<Vec<_>>(), ["B.mvt", "a/b.mvt", "a.mvt", "b.mvt"]);
    }

    #[test]
    fn a_movement_path_is_relative_to_the_folder_and_ends_mvt() {
        for good in ["a.mvt", "orders/sync.mvt", "a.b/c.mvt"] {
            assert!(is_movement_path(good), "{good}");
        }
        for bad in ["/a.mvt", "a/../b.mvt", "a//b.mvt", "a\\b.mvt", "a.txt", "./a.mvt", "a/", ".mvt", ""] {
            assert!(!is_movement_path(bad), "{bad}");
        }
    }

    #[test]
    fn a_listed_bad_path_or_duplicate_is_refused_naming_the_module() {
        let label = "the movements module acme_movements";
        let list = |json: &str| listed_of(label, &Js::parse(json.as_bytes()).unwrap());
        let listed = list(r#"[{"path":"a.mvt","version":"1"},{"path":"lib/b.mvt"}]"#).unwrap();
        assert_eq!(listed, [Listed { path: "a.mvt".into(), version: Some("1".into()) }, Listed { path: "lib/b.mvt".into(), version: None }]);
        assert_eq!(listed_of(label, &listed_js(&listed)).unwrap(), listed, "the wire's shape reads back");
        let bad = list(r#"[{"path":"../a.mvt"}]"#).unwrap_err();
        assert!(bad.starts_with(label) && bad.contains("\"../a.mvt\", which is not a movement file's path"), "{bad}");
        let twice = list(r#"[{"path":"a.mvt"},{"path":"a.mvt"}]"#).unwrap_err();
        assert_eq!(twice, format!("{label}: movements.list named \"a.mvt\" twice"));
        let shape = list(r#"{"files":["secret text"]}"#).unwrap_err();
        assert_eq!(shape, format!("{label}: movements.list answered an object with files, not the slot's shape"), "named by its shape, never its text");
    }

    #[test]
    fn the_read_and_write_answers_read_back() {
        let text = Text { text: "x = \"é\"\n".into(), version: "v1".into() };
        assert_eq!(text_of(&text_js(&text)), Some(text));
        for outcome in [Ok(Written::Written { version: "v2".into() }), Ok(Written::Conflict { current: None }), Ok(Written::Conflict { current: Some("v3".into()) })] {
            assert_eq!(written_of(&written_js(&outcome).unwrap(), "acme_movements"), Some(outcome));
        }
        let read_only = Err(WriteError::ReadOnly { module: "acme_movements".into(), reason: "the platform keeps them".into() });
        assert_eq!(written_of(&written_js(&read_only).unwrap(), "acme_movements"), Some(read_only));
        assert_eq!(written_js(&Err(WriteError::Failed("boom".into()))), Err("boom".to_string()));
        assert_eq!(written_of(&Js::parse(br#"{"kind":"written"}"#).unwrap(), "m"), None);
    }

    #[test]
    fn a_movements_module_that_needs_settings_is_refused_unless_the_environment_or_file_holds_them() {
        let dir = temp("lf-movements-boot");
        fs::create_dir_all(dir.join("externals/acme_movements")).unwrap();
        fs::write(
            dir.join("externals/acme_movements/lf-external.yaml"),
            "name: acme_movements\nkind: core\nslot: movements\nurl: http://127.0.0.1:9/\nsettings:\n  - { name: tenant }\n",
        )
        .unwrap();
        fs::write(dir.join("lf.yaml"), "engine: 0.12.0\ncore:\n  movements: acme_movements\n").unwrap();
        let refused = crate::project::load_project_with(&dir, &[]).unwrap_err();
        let text = "core.movements: acme_movements: the movements module's own settings come from LF_SECRET__… or the secrets file, not from the secrets slot; neither holds acme_movements's install (run `lf connect acme_movements` before naming it in lf.yaml, or set LF_SECRET__ACME_MOVEMENTS__EXTERNAL=acme_movements and its settings as LF_SECRET__ACME_MOVEMENTS__<SETTING>)";
        assert!(refused.ends_with(text), "{refused}");
        let to_upgrade = crate::project::load_project_to_upgrade(&dir).unwrap();
        let refused_by_upgrade = of_project(&to_upgrade, &[]).err().expect("lf upgrade's project is refused when it reaches its files");
        assert_eq!(refused_by_upgrade, refused, "lf upgrade refuses with the same text");
        let env = [("LF_SECRET__ACME_MOVEMENTS__EXTERNAL".to_string(), "acme_movements".to_string()), ("LF_SECRET__ACME_MOVEMENTS__TENANT".to_string(), "t1".to_string())];
        let project = crate::project::load_project_with(&dir, &env).unwrap();
        assert_eq!(crate::secrets_slot::module_settings(&project, &env, &project.core.movements).unwrap().get("tenant").map(String::as_str), Some("t1"));
        assert_eq!(of_project(&project, &env).unwrap().label(), "the movements module acme_movements");
        fs::remove_dir_all(&dir).unwrap();
    }
}

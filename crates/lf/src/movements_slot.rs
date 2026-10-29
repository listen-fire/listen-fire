//! The movements slot: where the project's movement files live, a module like
//! the other slots' (crate::core). listen-fire asks it for every file by name when a
//! command opens its project, and writes one back by compare-and-swap when
//! `listen-fire upgrade` rewrites it or `listen-fire init` creates the starter. lf.yaml and the
//! externals folder stay local files.
//!
//! The default, `@lf/folder-movements`, is the movements folder lf.yaml names,
//! walked in process as it always was (`FolderMovements`). A module listen-fire does
//! not build in is spoken to over adapter protocol 2 (`ProcessMovements`):
//!
//!   movements.list {}                               → [{ path, version? }]
//!   movements.read { path }                         → { text, version } | null
//!   movements.write { path, text, expectedVersion } → { kind: written | conflict | read_only, … }
//!   movements.watch { cursor?, waitMs }             → { cursor, events: [{ kind, path, version? }] } | { resync: true }
//!
//! A watch is held by the module until something changes after the cursor,
//! or `waitMs` (at most 30 s) passes: `listen-fire serve` and `listen-fire drain` learn of an
//! edit from it rather than by listing on a timer. The folder module watches
//! the folder with the OS's own watcher (`FolderWatch`).
//!
//! A `path` is the file's name under the movements folder (`orders/sync.mvt`):
//! the name every identity listen-fire keeps already uses (run rows, listen pipelines,
//! subscriptions, imports). A version is opaque and changes with the text;
//! listen-fire keeps each text by its version for the process, so a scan whose listed
//! version it already holds asks no `read`.
//!
//! The module's own settings (a platform's tenant) cannot come from the
//! secrets slot, which may not open where files are still read (`listen-fire lsp`):
//! they are read from the environment and the secrets file only, and a
//! project naming a module whose settings are in neither is refused as it
//! loads (`refuse_unbootstrapped`).

use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedReceiver;
use tokio::time::Instant;

use sha2::{Digest, Sha256};

use crate::core::ProcessModule;
use crate::json::{Js, Obj};
use crate::obj;
use crate::project::{PROJECT_FILE, Project};
use crate::secrets_family::LocalFuture;
use crate::secrets_slot::shape_of;
use crate::slot_client::SlotClient;
use crate::sources::{MOVEMENT_EXTENSION, MovementFile};

/// The slot's methods (engine-contracts `slots/movements.ts` `MOVEMENTS_METHODS`).
pub const MOVEMENTS_METHODS: &[&str] = &["movements.list", "movements.read", "movements.write", "movements.watch"];

/// The longest a module must hold a watch (engine-contracts `slots/wire.ts`
/// `WATCH_WAIT_CAP_MS`).
pub const WATCH_WAIT_CAP: Duration = Duration::from_secs(30);

/// How much longer than the wait it asked for listen-fire gives a module's watch
/// before it gives up on the answer: the request has no timeout of its own.
const WATCH_ANSWER_SLACK: Duration = Duration::from_secs(10);

/// One movement file a module holds, as `movements.list` names it.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed {
    pub path: String,
    /// None: the module does not say, and listen-fire reads the file on every scan.
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
    /// The module keeps the project's movements where listen-fire cannot change them.
    ReadOnly { module: String, reason: String },
    Failed(String),
}

impl WriteError {
    /// What `listen-fire upgrade` and `listen-fire init` refuse with.
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

/// What changed at one path, as `movements.watch` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Added,
    Changed,
    Removed,
}

impl ChangeKind {
    pub fn name(self) -> &'static str {
        match self {
            ChangeKind::Added => "added",
            ChangeKind::Changed => "changed",
            ChangeKind::Removed => "removed",
        }
    }

    fn of(name: &str) -> Option<ChangeKind> {
        [ChangeKind::Added, ChangeKind::Changed, ChangeKind::Removed].into_iter().find(|kind| kind.name() == name)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub kind: ChangeKind,
    pub path: String,
    /// The text's version after an add or a change (None: the module does
    /// not say, and listen-fire reads the file); always None for a removal.
    pub version: Option<String>,
}

/// A watch's answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Watched {
    /// What changed after the cursor asked from, in order, and the cursor to ask from next.
    Events { cursor: String, events: Vec<Change> },
    /// The module cannot answer from that cursor: list again, then watch from a new one.
    Resync,
}

/// What fills the movements slot.
pub trait MovementsStore {
    fn list(&self) -> Result<Vec<Listed>, String>;
    /// What changed after `cursor` (None: the module's cursor now, with no
    /// events), waiting up to `wait` (at most `WATCH_WAIT_CAP`) for something to.
    fn watch<'a>(&'a self, cursor: Option<&'a str>, wait: Duration) -> LocalFuture<'a, Result<Watched, String>>;
    /// Whether the module answers `watch`, which `listen-fire serve` and `listen-fire drain` need.
    fn answers_watch(&self) -> Result<bool, String> {
        Ok(true)
    }
    /// None: nothing is at `path`.
    fn read(&self, path: &str) -> Result<Option<Text>, String>;
    /// `text` at `path` if it is still at `expected` (None: if nothing is there).
    fn write(&self, path: &str, text: &str, expected: Option<&str>) -> Result<Written, WriteError>;
    /// Every file, in the walk's order: `list`, then each read. Each file's
    /// display path is under `movements_dir`.
    fn files(&self, movements_dir: &Path) -> Result<Vec<MovementFile>, String> {
        let mut files = Vec::new();
        for listed in ordered(self.list()?) {
            // Deleted between the two: not there.
            let Some(text) = self.read(&listed.path)? else { continue };
            files.push(movement_file(movements_dir, &listed.path, text));
        }
        Ok(files)
    }
}

pub(crate) fn movement_file(movements_dir: &Path, path: &str, text: Text) -> MovementFile {
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

pub(crate) fn ordered(mut listed: Vec<Listed>) -> Vec<Listed> {
    listed.sort_by(|a, b| order(&a.path, &b.path));
    listed
}

// ── @lf/folder-movements ────────────────────────────────────────────────────

/// The movements folder as the slot's module: every `.mvt` under it, each
/// folder's entries in sorted order, folders walked depth first.
pub struct FolderMovements {
    dir: PathBuf,
    /// Started by the first watch, so a command that never watches never
    /// starts one; None again once the folder is gone.
    watching: RefCell<Option<Rc<FolderWatch>>>,
}

impl FolderMovements {
    pub fn at(dir: &Path) -> FolderMovements {
        FolderMovements { dir: dir.to_path_buf(), watching: RefCell::new(None) }
    }

    /// Each file's version, by its path under the folder.
    fn versions(&self) -> Result<HashMap<String, String>, String> {
        let mut files = Vec::new();
        self.walk(&self.dir, &mut files)?;
        Ok(files.into_iter().filter_map(|f| Some((format!("{}{MOVEMENT_EXTENSION}", f.name), f.version?))).collect())
    }

    /// The folder's watcher, started if it is not running; None while there is no folder.
    fn watcher(&self) -> Result<Option<Rc<FolderWatch>>, String> {
        let running = self.watching.borrow().clone();
        if let Some(watch) = running.filter(|w| !w.state.borrow().gone) {
            return Ok(Some(watch));
        }
        self.watching.replace(None);
        if !self.dir.is_dir() {
            return Ok(None);
        }
        let started = Rc::new(FolderWatch::start(self)?);
        self.watching.replace(Some(started.clone()));
        Ok(Some(started))
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

    /// Without a folder there is nothing to watch: answered at once, with a
    /// cursor no watcher gives, so the first one started answers it `resync`.
    fn watch<'a>(&'a self, cursor: Option<&'a str>, wait: Duration) -> LocalFuture<'a, Result<Watched, String>> {
        Box::pin(async move {
            let Some(watch) = self.watcher()? else {
                return Ok(match cursor {
                    None | Some(NO_FOLDER) => Watched::Events { cursor: NO_FOLDER.into(), events: Vec::new() },
                    Some(_) => Watched::Resync,
                });
            };
            watch.watch(self, cursor, wait.min(WATCH_WAIT_CAP)).await
        })
    }
}

/// The cursor a folder that is not there answers.
const NO_FOLDER: &str = "no-folder";
/// How many events the folder's watcher keeps for a cursor behind them.
const WATCH_LOG_ENTRIES: usize = 1024;
/// A burst of writes (an editor's save, a checkout) is taken as one change
/// once the folder has been quiet this long…
const DEBOUNCE_QUIET: Duration = Duration::from_millis(100);
/// …or this long after its first write, whichever is sooner.
const DEBOUNCE_MOST: Duration = Duration::from_secs(1);

/// The OS's watcher on the folder (FSEvents, inotify), its raw events
/// reconciled against the files it knows into a log of changes, which every
/// watch reads from its own cursor (`<epoch>:<n>`: the epoch this watcher's,
/// n the next change it has not seen).
struct FolderWatch {
    epoch: String,
    dir: PathBuf,
    /// The folder as the OS's events name it (macOS: `/private/var/…` for `/var/…`).
    canonical: PathBuf,
    state: RefCell<WatchState>,
    /// The raw events, read by one watch at a time; the others wait on `moved`.
    raw: tokio::sync::Mutex<UnboundedReceiver<notify::Result<notify::Event>>>,
    /// The log's next position, sent each time changes are logged.
    moved: tokio::sync::watch::Sender<u64>,
    _watcher: notify::RecommendedWatcher,
}

#[derive(Default)]
struct WatchState {
    /// Each file's version as last reconciled, by path.
    known: HashMap<String, String>,
    log: VecDeque<(u64, Change)>,
    next: u64,
    /// The `.mvt` paths raw events touched since the last reconcile.
    touched: BTreeSet<String>,
    /// A folder moved, or the OS lost track: the next reconcile walks.
    rescan: bool,
    /// The folder itself is gone: the next watch starts again.
    gone: bool,
}

impl WatchState {
    fn pending(&self) -> bool {
        self.rescan || !self.touched.is_empty()
    }

    fn first(&self) -> u64 {
        self.log.front().map_or(self.next, |(n, _)| *n)
    }

    fn push(&mut self, change: Change) {
        self.log.push_back((self.next, change));
        self.next += 1;
        while self.log.len() > WATCH_LOG_ENTRIES {
            self.log.pop_front();
        }
    }

    fn after(&self, from: u64) -> Vec<Change> {
        self.log.iter().filter(|(n, _)| *n >= from).map(|(_, change)| change.clone()).collect()
    }
}

impl FolderWatch {
    /// The watcher first, then the walk: a write between them is a raw event
    /// that reconciles to nothing, never a write missed.
    fn start(folder: &FolderMovements) -> Result<FolderWatch, String> {
        let dir = &folder.dir;
        let canonical = fs::canonicalize(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let (sender, raw) = tokio::sync::mpsc::unbounded_channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .map_err(|e| format!("{}: the folder cannot be watched: {e}", dir.display()))?;
        notify::Watcher::watch(&mut watcher, &canonical, notify::RecursiveMode::Recursive).map_err(|e| format!("{}: the folder cannot be watched: {e}", dir.display()))?;
        let known = folder.versions()?;
        Ok(FolderWatch {
            epoch: uuid::Uuid::new_v4().simple().to_string(),
            dir: dir.clone(),
            canonical,
            state: RefCell::new(WatchState { known, ..WatchState::default() }),
            raw: tokio::sync::Mutex::new(raw),
            moved: tokio::sync::watch::Sender::new(0),
            _watcher: watcher,
        })
    }

    fn cursor(&self) -> String {
        format!("{}:{}", self.epoch, self.state.borrow().next)
    }

    /// Where `cursor` points in the log; None for one this watcher never
    /// gave, or one behind what the log still holds.
    fn position(&self, cursor: &str) -> Option<u64> {
        let (epoch, n) = cursor.split_once(':')?;
        let n: u64 = n.parse().ok().filter(|_| epoch == self.epoch)?;
        let state = self.state.borrow();
        (state.first() <= n && n <= state.next).then_some(n)
    }

    async fn watch(&self, folder: &FolderMovements, cursor: Option<&str>, wait: Duration) -> Result<Watched, String> {
        let until = Instant::now() + wait;
        let Some(cursor) = cursor else {
            // "Now" is the folder as it is, not as the raw events so far say:
            // walked, what differs logged, and the cursor after it.
            self.state.borrow_mut().rescan = true;
            self.reconcile(folder)?;
            return Ok(Watched::Events { cursor: self.cursor(), events: Vec::new() });
        };
        let Some(from) = self.position(cursor) else { return Ok(Watched::Resync) };
        loop {
            let mut moved = self.moved.subscribe();
            if let Ok(mut raw) = self.raw.try_lock() {
                while let Ok(event) = raw.try_recv() {
                    self.record(event);
                }
            }
            if wait.is_zero() && self.state.borrow().pending() {
                self.reconcile(folder)?;
            }
            let events = self.state.borrow().after(from);
            if !events.is_empty() || Instant::now() >= until {
                return Ok(Watched::Events { cursor: self.cursor(), events });
            }
            tokio::select! {
                mut raw = self.raw.lock() => self.pump(folder, &mut raw, until).await?,
                _ = moved.changed() => {}
                () = tokio::time::sleep_until(until) => {}
            }
        }
    }

    /// Waits until `until` for a raw event that matters, then until the
    /// burst it starts is over, and reconciles.
    async fn pump(&self, folder: &FolderMovements, raw: &mut UnboundedReceiver<notify::Result<notify::Event>>, until: Instant) -> Result<(), String> {
        while !self.state.borrow().pending() {
            match tokio::time::timeout_at(until, raw.recv()).await {
                Ok(Some(event)) => self.record(event),
                Ok(None) | Err(_) => return Ok(()),
            }
        }
        let most = Instant::now() + DEBOUNCE_MOST;
        loop {
            let quiet = (Instant::now() + DEBOUNCE_QUIET).min(most);
            match tokio::time::timeout_at(quiet, raw.recv()).await {
                Ok(Some(event)) => self.record(event),
                Ok(None) | Err(_) => break,
            }
            if Instant::now() >= most {
                break;
            }
        }
        self.reconcile(folder)
    }

    /// A path under the folder, `/`-separated ("" for the folder itself);
    /// None outside it.
    fn relative(&self, path: &Path) -> Option<String> {
        let inside = path.strip_prefix(&self.canonical).or_else(|_| path.strip_prefix(&self.dir)).ok()?;
        Some(inside.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
    }

    /// What one raw event touched, kept until the next reconcile: a
    /// movement file by its path; a folder, or a path renamed away that may
    /// have been one, as a walk; anything else not at all.
    fn record(&self, event: notify::Result<notify::Event>) {
        use notify::EventKind;
        use notify::event::{CreateKind, ModifyKind, RemoveKind};
        let mut state = self.state.borrow_mut();
        let event = match event {
            Ok(event) if !event.need_rescan() => event,
            // The OS dropped events, or the watcher failed: only a walk knows.
            _ => {
                state.rescan = true;
                return;
            }
        };
        let folder_kind = matches!(event.kind, EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder));
        let renamed = matches!(event.kind, EventKind::Modify(ModifyKind::Name(_)));
        for path in &event.paths {
            let Some(relative) = self.relative(path) else { continue };
            if relative.is_empty() {
                state.rescan = true;
            } else if is_movement_path(&relative) {
                state.touched.insert(relative);
            } else if folder_kind || path.is_dir() || (renamed && !path.exists()) {
                state.rescan = true;
            }
        }
    }

    /// The touched files re-read (or, after a rescan, the whole folder
    /// walked) against the versions known: what differs is logged, in the
    /// walk's order, and every waiting watch woken.
    fn reconcile(&self, folder: &FolderMovements) -> Result<(), String> {
        let (touched, rescan) = {
            let mut state = self.state.borrow_mut();
            (std::mem::take(&mut state.touched), std::mem::take(&mut state.rescan))
        };
        let mut now: Vec<(String, Option<String>)> = Vec::new();
        if rescan {
            let found = match folder.versions() {
                Ok(found) => found,
                Err(message) => {
                    self.state.borrow_mut().rescan = true;
                    return Err(message);
                }
            };
            let state = self.state.borrow();
            now.extend(state.known.keys().filter(|path| !found.contains_key(*path)).map(|path| (path.clone(), None)));
            now.extend(found.into_iter().map(|(path, version)| (path, Some(version))));
            if !folder.dir.is_dir() {
                drop(state);
                self.state.borrow_mut().gone = true;
            }
        }
        for path in touched {
            if now.iter().any(|(seen, _)| *seen == path) {
                continue;
            }
            let version = match fs::read_to_string(folder.dir.join(&path)) {
                Ok(text) => Some(version_of(&text)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound || folder.dir.join(&path).is_dir() => None,
                // Unreadable for now (written as it is read): the next event re-reads it.
                Err(_) => continue,
            };
            now.push((path, version));
        }
        now.sort_by(|a, b| order(&a.0, &b.0));
        let mut state = self.state.borrow_mut();
        let before = state.next;
        for (path, version) in now {
            let kind = match (&version, state.known.get(&path)) {
                (Some(version), Some(known)) if version == known => continue,
                (Some(_), Some(_)) => ChangeKind::Changed,
                (Some(_), None) => ChangeKind::Added,
                (None, Some(_)) => ChangeKind::Removed,
                (None, None) => continue,
            };
            match &version {
                Some(version) => state.known.insert(path.clone(), version.clone()),
                None => state.known.remove(&path),
            };
            state.push(Change { kind, path, version });
        }
        if state.next != before {
            let next = state.next;
            drop(state);
            self.moved.send_replace(next);
        }
        Ok(())
    }
}

// ── A movements module listen-fire does not build in ────────────────────────────────

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
    fn list(&self) -> Result<Vec<Listed>, String> {
        listed_of(&self.client.label, &self.client.call_text("movements.list", Obj::new())?)
    }

    /// Awaited on the caller's runtime, never queued to the client's one
    /// thread: a held watch would hold every other call behind it.
    fn watch<'a>(&'a self, cursor: Option<&'a str>, wait: Duration) -> LocalFuture<'a, Result<Watched, String>> {
        Box::pin(async move {
            let wait = wait.min(WATCH_WAIT_CAP);
            let mut params = Obj::new();
            if let Some(cursor) = cursor {
                params.insert("cursor".into(), Js::str(cursor));
            }
            params.insert("waitMs".into(), Js::Num((wait.as_millis() as u64).into()));
            let limit = wait + WATCH_ANSWER_SLACK;
            let answer = tokio::time::timeout(limit, self.client.call_async("movements.watch", params))
                .await
                .map_err(|_| format!("{}: movements.watch: no answer within {} s", self.client.label, limit.as_secs()))??;
            let watched = watched_of(&self.client.label, &answer)?;
            if let Watched::Events { events, .. } = &watched {
                let mut texts = self.texts.borrow_mut();
                for change in events {
                    if texts.get(&change.path).is_some_and(|kept| change.version.as_ref() != Some(&kept.version)) {
                        texts.remove(&change.path);
                    }
                }
            }
            Ok(watched)
        })
    }

    fn answers_watch(&self) -> Result<bool, String> {
        let manifest = self.client.call_text("manifest", Obj::new())?;
        let methods = manifest.get("methods").and_then(Js::as_array).ok_or_else(|| self.unexpected("manifest", &manifest))?;
        Ok(methods.iter().any(|m| m.as_str() == Some("movements.watch")))
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
        for listed in ordered(self.list()?) {
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

pub fn watched_js(watched: &Watched) -> Js {
    match watched {
        Watched::Resync => Js::from(obj! { "resync" => Js::Bool(true) }),
        Watched::Events { cursor, events } => {
            let events = events
                .iter()
                .map(|change| {
                    let mut one = obj! { "kind" => Js::str(change.kind.name()), "path" => Js::str(&change.path) };
                    if let (Some(version), false) = (&change.version, change.kind == ChangeKind::Removed) {
                        one.insert("version".into(), Js::str(version));
                    }
                    Js::from(one)
                })
                .collect();
            Js::from(obj! { "cursor" => Js::str(cursor), "events" => Js::Arr(events) })
        }
    }
}

/// `movements.watch`'s answer from the module `label`: `{ cursor, events }`
/// or `{ resync: true }`, never both; a kind it does not know, or a path that
/// is not a movement path, is not the slot's shape.
pub fn watched_of(label: &str, answer: &Js) -> Result<Watched, String> {
    let shape = || unexpected(label, "movements.watch", answer);
    match (answer.get("resync"), answer.get("cursor"), answer.get("events")) {
        (Some(Js::Bool(true)), None, None) => return Ok(Watched::Resync),
        (None, Some(_), Some(_)) => {}
        _ => return Err(shape()),
    }
    let cursor = answer.get("cursor").and_then(Js::as_str).filter(|c| !c.is_empty()).ok_or_else(shape)?;
    let mut events = Vec::new();
    for one in answer.get("events").and_then(Js::as_array).ok_or_else(shape)? {
        let kind = one.get("kind").and_then(Js::as_str).and_then(ChangeKind::of).ok_or_else(shape)?;
        let path = one.get("path").and_then(Js::as_str).filter(|path| is_movement_path(path)).ok_or_else(shape)?;
        let version = match (kind, one.get("version")) {
            (ChangeKind::Removed, _) | (_, None | Some(Js::Null)) => None,
            (_, Some(Js::Str(version))) if !version.is_empty() => Some(version.clone()),
            _ => return Err(shape()),
        };
        events.push(Change { kind, path: path.to_string(), version });
    }
    Ok(Watched::Events { cursor: cursor.to_string(), events })
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
    /// A module listen-fire does not build in, reached once per project and module.
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
    // `listen-fire upgrade` loads its project without the check: it is made here too.
    refuse_unbootstrapped(project, env).map_err(|why| format!("{}: {why}", project.root.join(PROJECT_FILE).display()))?;
    let started = Rc::new(ProcessMovements::start(&module.name, process, &crate::secrets_slot::module_settings(project, env, module)?)?);
    STARTED.with(|s| s.borrow_mut().insert(key, started.clone()));
    Ok(started)
}

/// `listen-fire serve` and `listen-fire drain` learn of a changed movement from the module's
/// watch: one that does not answer it is refused as they start.
pub fn require_watch(project: &Project, env: &[(String, String)], command: &str) -> Result<(), String> {
    match of_project(project, env)?.answers_watch()? {
        true => Ok(()),
        false => Err(format!(
            "the movements module {} does not answer {}; {command} needs it",
            project.core.movements.name,
            crate::protocol::method_with_minor("movements.watch")
        )),
    }
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
        assert_eq!(ordered(listed.clone()), listed, "a served list in the same order reads as the walk");
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
        let sorted = ordered(["b.mvt", "a.mvt", "a/b.mvt", "B.mvt"].map(|p| Listed { path: p.into(), version: None }).to_vec());
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
    fn the_watch_answer_reads_back_and_a_malformed_one_is_named_by_shape() {
        let label = "the movements module acme_movements";
        let events = vec![
            Change { kind: ChangeKind::Added, path: "a.mvt".into(), version: Some("v1".into()) },
            Change { kind: ChangeKind::Changed, path: "lib/b.mvt".into(), version: None },
            Change { kind: ChangeKind::Removed, path: "c.mvt".into(), version: None },
        ];
        for watched in [Watched::Events { cursor: "e:3".into(), events }, Watched::Resync] {
            assert_eq!(watched_of(label, &watched_js(&watched)).unwrap(), watched);
        }
        let of = |json: &str| watched_of(label, &Js::parse(json.as_bytes()).unwrap());
        assert_eq!(of(r#"{"cursor":"e:1","events":[{"kind":"removed","path":"a.mvt","version":"v"}]}"#).unwrap(), Watched::Events { cursor: "e:1".into(), events: vec![Change { kind: ChangeKind::Removed, path: "a.mvt".into(), version: None }] });
        for bad in [
            r#"{"resync":true,"cursor":"e:1","events":[]}"#,
            r#"{"cursor":"e:1"}"#,
            r#"{"cursor":"","events":[]}"#,
            r#"{"cursor":"e:1","events":[{"kind":"renamed","path":"a.mvt"}]}"#,
            r#"{"cursor":"e:1","events":[{"kind":"added","path":"../a.mvt"}]}"#,
            r#"{"cursor":"e:1","events":[{"kind":"added","path":"a.mvt","version":7}]}"#,
            r#"{"resync":false}"#,
            r#"["secret text"]"#,
        ] {
            let refused = of(bad).unwrap_err();
            assert!(refused.starts_with(&format!("{label}: movements.watch answered ")) && !refused.contains("secret text"), "{bad}: {refused}");
        }
    }

    // ── The folder's watcher ────────────────────────────────────────────────

    const WAIT: Duration = Duration::from_secs(5);

    fn on_runtime(body: impl AsyncFnOnce()) {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(body());
    }

    async fn now(module: &FolderMovements) -> String {
        match module.watch(None, Duration::ZERO).await.unwrap() {
            Watched::Events { cursor, events } => {
                assert_eq!(events, [], "no cursor: no events");
                cursor
            }
            Watched::Resync => panic!("a watch without a cursor answered resync"),
        }
    }

    /// One watch from `cursor`, up to `wait`.
    async fn watched(module: &FolderMovements, cursor: &str, wait: Duration) -> (String, Vec<Change>) {
        match module.watch(Some(cursor), wait).await.unwrap() {
            Watched::Events { cursor, events } => (cursor, events),
            Watched::Resync => panic!("{cursor} answered resync"),
        }
    }

    /// Watches from `cursor` until `paths` events are in, or `WAIT` passes;
    /// every answer that carried events, in order.
    async fn answers_until(module: &FolderMovements, cursor: &str, paths: usize) -> (String, Vec<Vec<Change>>) {
        let deadline = std::time::Instant::now() + WAIT;
        let (mut cursor, mut answers) = (cursor.to_string(), Vec::new());
        while answers.iter().map(Vec::len).sum::<usize>() < paths && std::time::Instant::now() < deadline {
            let (next, events) = watched(module, &cursor, WAIT).await;
            cursor = next;
            if !events.is_empty() {
                answers.push(events);
            }
        }
        (cursor, answers)
    }

    async fn events_until(module: &FolderMovements, cursor: &str, paths: usize) -> (String, Vec<Change>) {
        let (cursor, answers) = answers_until(module, cursor, paths).await;
        (cursor, answers.concat())
    }

    fn change(kind: ChangeKind, path: &str, text: Option<&str>) -> Change {
        Change { kind, path: path.into(), version: text.map(version_of) }
    }

    #[test]
    fn create_edit_delete_are_added_changed_removed_with_versions() {
        let dir = temp("lf-watch-crud");
        let module = FolderMovements::at(&dir);
        on_runtime(async || {
            let cursor = now(&module).await;
            fs::create_dir_all(dir.join("lib")).unwrap();
            fs::write(dir.join("lib/a.mvt"), "one").unwrap();
            let (cursor, events) = events_until(&module, &cursor, 1).await;
            assert_eq!(events, [change(ChangeKind::Added, "lib/a.mvt", Some("one"))]);
            fs::write(dir.join("lib/a.mvt"), "two").unwrap();
            let (cursor, events) = events_until(&module, &cursor, 1).await;
            assert_eq!(events, [change(ChangeKind::Changed, "lib/a.mvt", Some("two"))]);
            assert_eq!(events[0].version, module.read("lib/a.mvt").unwrap().map(|t| t.version), "the version read answers");
            fs::remove_file(dir.join("lib/a.mvt")).unwrap();
            let (_, events) = events_until(&module, &cursor, 1).await;
            assert_eq!(events, [change(ChangeKind::Removed, "lib/a.mvt", None)]);
        });
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_rename_is_removed_then_added() {
        let dir = temp("lf-watch-rename");
        fs::write(dir.join("a.mvt"), "one").unwrap();
        let module = FolderMovements::at(&dir);
        on_runtime(async || {
            let cursor = now(&module).await;
            fs::rename(dir.join("a.mvt"), dir.join("b.mvt")).unwrap();
            let (_, events) = events_until(&module, &cursor, 2).await;
            assert_eq!(events, [change(ChangeKind::Removed, "a.mvt", None), change(ChangeKind::Added, "b.mvt", Some("one"))]);
        });
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_atomic_save_is_one_change() {
        let dir = temp("lf-watch-atomic");
        fs::write(dir.join("hello.mvt"), "one").unwrap();
        let module = FolderMovements::at(&dir);
        let save = |text: &str| {
            fs::write(dir.join(".hello.mvt.swp"), text).unwrap();
            fs::rename(dir.join(".hello.mvt.swp"), dir.join("hello.mvt")).unwrap();
        };
        on_runtime(async || {
            let cursor = now(&module).await;
            save("two");
            let (cursor, answers) = answers_until(&module, &cursor, 1).await;
            assert_eq!(answers, [vec![change(ChangeKind::Changed, "hello.mvt", Some("two"))]], "one change, never a removal");
            save("two");
            let (_, events) = watched(&module, &cursor, Duration::from_millis(1500)).await;
            assert_eq!(events, [], "the same text saved again is no change");
        });
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_non_mvt_file_is_ignored() {
        let dir = temp("lf-watch-other");
        let module = FolderMovements::at(&dir);
        on_runtime(async || {
            let cursor = now(&module).await;
            fs::write(dir.join("notes.txt"), "one").unwrap();
            fs::write(dir.join("notes.txt"), "two").unwrap();
            fs::remove_file(dir.join("notes.txt")).unwrap();
            let (cursor, events) = watched(&module, &cursor, Duration::from_millis(1500)).await;
            assert_eq!(events, []);
            fs::write(dir.join("x.mvt"), "x").unwrap();
            let (_, events) = events_until(&module, &cursor, 1).await;
            assert_eq!(events, [change(ChangeKind::Added, "x.mvt", Some("x"))], "the watcher still answers");
        });
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_burst_is_one_event_per_file() {
        let dir = temp("lf-watch-burst");
        let module = FolderMovements::at(&dir);
        on_runtime(async || {
            let cursor = now(&module).await;
            for n in 0..200 {
                fs::write(dir.join(format!("f{n}.mvt")), format!("x = {n}")).unwrap();
            }
            for n in 0..50 {
                fs::write(dir.join("hot.mvt"), format!("x = {n}")).unwrap();
            }
            let (_, answers) = answers_until(&module, &cursor, 201).await;
            let events = answers.concat();
            assert_eq!(events.len(), 201, "one event per file");
            assert_eq!(events.iter().map(|e| &e.path).collect::<HashSet<_>>().len(), 201);
            assert!(events.iter().all(|e| e.kind == ChangeKind::Added));
            assert_eq!(events.iter().find(|e| e.path == "hot.mvt").unwrap().version, Some(version_of("x = 49")), "the last write's version");
            assert_eq!(answers.len(), 1, "one answer, so one refresh");
        });
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_unknown_or_dropped_cursor_is_resync() {
        let dir = temp("lf-watch-cursor");
        let module = FolderMovements::at(&dir);
        on_runtime(async || {
            let first = now(&module).await;
            let (epoch, _) = first.split_once(':').unwrap();
            for unknown in ["conformance-unknown", "other:0", &format!("{epoch}:1"), &format!("{epoch}:x"), NO_FOLDER] {
                assert_eq!(module.watch(Some(unknown), Duration::ZERO).await.unwrap(), Watched::Resync, "{unknown}");
            }
            let watch = module.watching.borrow().clone().unwrap();
            for n in 0..WATCH_LOG_ENTRIES + 1 {
                watch.state.borrow_mut().push(change(ChangeKind::Added, &format!("f{n}.mvt"), Some("x")));
            }
            assert_eq!(module.watch(Some(&first), Duration::ZERO).await.unwrap(), Watched::Resync, "behind what the log keeps");
            let behind = format!("{epoch}:1");
            let (_, events) = watched(&module, &behind, Duration::ZERO).await;
            assert_eq!(events.len(), WATCH_LOG_ENTRIES, "the oldest kept onwards");
            let current = now(&module).await;
            assert_eq!(watched(&module, &current, Duration::ZERO).await, (current.clone(), vec![]));
        });
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn no_cursor_answers_now_with_no_events() {
        let dir = temp("lf-watch-now");
        fs::write(dir.join("a.mvt"), "one").unwrap();
        let module = FolderMovements::at(&dir);
        on_runtime(async || {
            let asked = std::time::Instant::now();
            let first = match module.watch(None, WAIT).await.unwrap() {
                Watched::Events { cursor, events } => {
                    assert_eq!(events, []);
                    cursor
                }
                Watched::Resync => panic!("resync"),
            };
            assert!(asked.elapsed() < Duration::from_secs(1), "answered at once, not after the wait");
            fs::write(dir.join("b.mvt"), "two").unwrap();
            let second = now(&module).await;
            let (_, events) = watched(&module, &second, Duration::from_millis(1500)).await;
            assert_eq!(events, [], "a write before the cursor is not an event after it");
            let (_, events) = events_until(&module, &first, 1).await;
            assert_eq!(events, [change(ChangeKind::Added, "b.mvt", Some("two"))], "a watcher behind it still sees it");
        });
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_folder_answers_at_once() {
        let root = temp("lf-watch-missing");
        let dir = root.join("movements");
        let module = FolderMovements::at(&dir);
        on_runtime(async || {
            let asked = std::time::Instant::now();
            let cursor = now(&module).await;
            let (again, events) = watched(&module, &cursor, WAIT).await;
            assert_eq!((again.as_str(), events), (cursor.as_str(), vec![]));
            assert!(asked.elapsed() < Duration::from_secs(1), "answered at once, so listen-fire pauses");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("a.mvt"), "one").unwrap();
            assert_eq!(module.watch(Some(&cursor), WAIT).await.unwrap(), Watched::Resync, "the watcher started: list again");
            let cursor = now(&module).await;
            fs::write(dir.join("a.mvt"), "two").unwrap();
            let (_, events) = events_until(&module, &cursor, 1).await;
            assert_eq!(events, [change(ChangeKind::Changed, "a.mvt", Some("two"))]);
        });
        fs::remove_dir_all(&root).unwrap();
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
        let text = "core.movements: acme_movements: the movements module's own settings come from LF_SECRET__… or the secrets file, not from the secrets slot; neither holds acme_movements's install (run `listen-fire connect acme_movements` before naming it in lf.yaml, or set LF_SECRET__ACME_MOVEMENTS__EXTERNAL=acme_movements and its settings as LF_SECRET__ACME_MOVEMENTS__<SETTING>)";
        assert!(refused.ends_with(text), "{refused}");
        let to_upgrade = crate::project::load_project_to_upgrade(&dir).unwrap();
        let refused_by_upgrade = of_project(&to_upgrade, &[]).err().expect("listen-fire upgrade's project is refused when it reaches its files");
        assert_eq!(refused_by_upgrade, refused, "listen-fire upgrade refuses with the same text");
        let env = [("LF_SECRET__ACME_MOVEMENTS__EXTERNAL".to_string(), "acme_movements".to_string()), ("LF_SECRET__ACME_MOVEMENTS__TENANT".to_string(), "t1".to_string())];
        let project = crate::project::load_project_with(&dir, &env).unwrap();
        assert_eq!(crate::secrets_slot::module_settings(&project, &env, &project.core.movements).unwrap().get("tenant").map(String::as_str), Some("t1"));
        of_project(&project, &env).unwrap();
        fs::remove_dir_all(&dir).unwrap();
    }
}

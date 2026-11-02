//! A project is a folder with `lf.yaml` at its root: the engine version it is
//! pinned to, where its movement files live, and its externals folder. `.lf/`
//! beside it holds what the host keeps (state, files, secrets).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use movement_parser::version::{LANGUAGE_VERSION, Standing, refusal_message, standing};
use serde::Deserialize;

pub const PROJECT_FILE: &str = "lf.yaml";

// Unknown keys are ignored, so a newer lf.yaml still loads.
#[derive(Deserialize)]
struct ProjectFile {
    engine: String,
    #[serde(default = "default_movements")]
    movements: String,
    #[serde(default = "default_externals")]
    externals: String,
    #[serde(default)]
    user: UserFile,
    /// The module filling each core slot (crate::core), by slot name.
    #[serde(default)]
    core: std::collections::BTreeMap<String, String>,
    /// Superseded by `core: { store: … }`: refused with the way over.
    store: Option<serde_yaml::Value>,
    #[serde(rename = "publicUrl")]
    public_url: Option<String>,
    /// Seconds a started external has to print `listening <port>`.
    #[serde(rename = "startTimeout")]
    start_timeout: Option<f64>,
    /// Seconds a started module process may sit unused before listen-fire stops it.
    #[serde(rename = "moduleIdleTimeout")]
    module_idle_timeout: Option<f64>,
    /// Seconds one call to a module may take.
    #[serde(rename = "callTimeout")]
    call_timeout: Option<f64>,
    /// The most one run may spend, in US dollars (the platform's
    /// `MOVEMENT_MAX_RUN_COST_USD`).
    #[serde(rename = "maxRunCostUsd")]
    max_run_cost_usd: Option<f64>,
    /// How long the drain keeps a settled delivery's receipt.
    deliveries: Option<DeliveriesFile>,
    /// How often each connection's polled edges are polled, by the
    /// credential it polls as (its module, for one that uses none): each a
    /// duration (`30s`, `5m`), over what the edge declares.
    #[serde(rename = "pollEvery", default)]
    poll_every: std::collections::BTreeMap<String, serde_yaml::Value>,
    /// How often each connection's listens re-list the earlier hops they
    /// filter, by the credential the connection names (its module, for one
    /// that names none): each a duration, over what the hops declare.
    #[serde(rename = "resolveEvery", default)]
    resolve_every: std::collections::BTreeMap<String, serde_yaml::Value>,
    /// How long each module's provider may re-send an arrival, by the
    /// module: each a duration, over what the module declares.
    #[serde(rename = "resendWindow", default)]
    resend_window: std::collections::BTreeMap<String, serde_yaml::Value>,
    /// The most records a listen's earlier hops may match before it is
    /// suspended.
    #[serde(rename = "listenScopeLimit")]
    listen_scope_limit: Option<serde_yaml::Value>,
    /// How soon after a run's write an arrival on the record it wrote
    /// counts as caused by it (crate::loop_breaker): a duration.
    #[serde(rename = "loopWindow")]
    loop_window: Option<serde_yaml::Value>,
    /// The most runs one chain of writes and arrivals may be before the
    /// listen that would start the next is paused.
    #[serde(rename = "loopDepth")]
    loop_depth: Option<serde_yaml::Value>,
}

/// The most records a listen's earlier hops may match when lf.yaml says
/// nothing (`listenScopeLimit`): one poll or subscription each.
pub const DEFAULT_LISTEN_SCOPE_LIMIT: usize = 500;

fn listen_scope_limit_of(value: Option<&serde_yaml::Value>, at: &str) -> Result<usize, String> {
    let Some(value) = value else { return Ok(DEFAULT_LISTEN_SCOPE_LIMIT) };
    value
        .as_u64()
        .filter(|limit| *limit >= 1)
        .and_then(|limit| usize::try_from(limit).ok())
        .ok_or_else(|| format!("{at}: listenScopeLimit: a whole number, at least 1, of the records a listen's earlier hops may match (default {DEFAULT_LISTEN_SCOPE_LIMIT})"))
}

/// How soon after a run's write an arrival counts as caused by it when
/// lf.yaml says nothing (`loopWindow`): later than this it is more likely a
/// person acted than a slow loopback.
pub const DEFAULT_LOOP_WINDOW_MS: i64 = 20_000;

/// The most runs one chain of writes and arrivals may be when lf.yaml says
/// nothing (`loopDepth`).
pub const DEFAULT_LOOP_DEPTH: usize = 10;

fn loop_window_of(value: Option<&serde_yaml::Value>, at: &str) -> Result<i64, String> {
    let Some(value) = value else { return Ok(DEFAULT_LOOP_WINDOW_MS) };
    let ms = value.as_str().and_then(movement_engine::park::duration_ms).filter(|ms| ms.is_finite() && *ms >= 1.0);
    ms.map(|ms| ms as i64).ok_or_else(|| {
        let default = DEFAULT_LOOP_WINDOW_MS / 1000;
        format!("{at}: loopWindow: a duration, such as {default}s: how soon after a run's write an arrival on the record it wrote counts as caused by it (default {default}s)")
    })
}

fn loop_depth_of(value: Option<&serde_yaml::Value>, at: &str) -> Result<usize, String> {
    let Some(value) = value else { return Ok(DEFAULT_LOOP_DEPTH) };
    value
        .as_u64()
        .filter(|depth| *depth >= 1)
        .and_then(|depth| usize::try_from(depth).ok())
        .ok_or_else(|| format!("{at}: loopDepth: a whole number, at least 1, of the runs one chain of writes and arrivals may be before its listen is paused (default {DEFAULT_LOOP_DEPTH})"))
}

#[derive(Deserialize)]
struct DeliveriesFile {
    #[serde(rename = "retainDays")]
    retain_days: Option<serde_yaml::Value>,
}

/// Days a delivery's receipt is kept when lf.yaml says nothing.
pub const DEFAULT_DELIVERY_RETAIN_DAYS: u32 = 14;

fn retain_days_of(value: Option<&serde_yaml::Value>, at: &str) -> Result<u32, String> {
    let Some(value) = value else { return Ok(DEFAULT_DELIVERY_RETAIN_DAYS) };
    value
        .as_u64()
        .filter(|days| *days >= 1)
        .and_then(|days| u32::try_from(days).ok())
        .ok_or_else(|| format!("{at}: deliveries.retainDays: a whole number of days, at least 1 (default {DEFAULT_DELIVERY_RETAIN_DAYS})"))
}

/// `pollEvery`, each duration to milliseconds; a value that is no positive
/// duration is refused, naming its key.
fn poll_every_of(declared: &std::collections::BTreeMap<String, serde_yaml::Value>, at: &str) -> Result<std::collections::BTreeMap<String, i64>, String> {
    durations_of(declared, &format!("{at}: pollEvery"), "how often that connection's polled edges are polled")
}

/// `resendWindow`, as `pollEvery` is read.
fn resend_window_of(declared: &std::collections::BTreeMap<String, serde_yaml::Value>, at: &str) -> Result<std::collections::BTreeMap<String, i64>, String> {
    durations_of(declared, &format!("{at}: resendWindow"), "how long that module's provider may re-send an arrival")
}

/// `resolveEvery`, as `pollEvery` is read.
fn resolve_every_of(declared: &std::collections::BTreeMap<String, serde_yaml::Value>, at: &str) -> Result<std::collections::BTreeMap<String, i64>, String> {
    durations_of(declared, &format!("{at}: resolveEvery"), "how often that connection's listens re-list the earlier hops they filter")
}

fn durations_of(declared: &std::collections::BTreeMap<String, serde_yaml::Value>, at: &str, what: &str) -> Result<std::collections::BTreeMap<String, i64>, String> {
    declared
        .iter()
        .map(|(connection, value)| {
            let ms = value.as_str().and_then(movement_engine::park::duration_ms).filter(|ms| ms.is_finite() && *ms >= 1.0);
            match ms {
                Some(ms) => Ok((connection.clone(), ms as i64)),
                None => Err(format!("{at}.{connection}: a duration, such as 30s or 5m: {what}")),
            }
        })
        .collect()
}

#[derive(Deserialize, Default)]
struct UserFile {
    name: Option<String>,
    email: Option<String>,
}

fn default_movements() -> String {
    "movements".into()
}

fn default_externals() -> String {
    "externals".into()
}

#[derive(Debug, Clone)]
#[allow(dead_code)] // `root`, `engine` and `user` are read by the run path (G2)
pub struct Project {
    pub root: PathBuf,
    /// The host's own folder: `<root>/.lf`.
    pub lf_dir: PathBuf,
    pub engine: String,
    /// The release the project is pinned to: `engine:`, a release's version.
    pub language_version: String,
    pub movements_dir: PathBuf,
    pub externals_dir: PathBuf,
    /// The local acting identity lf.yaml names.
    pub user: (Option<String>, Option<String>),
    /// The module filling each core slot: lf.yaml's `core:`, defaults beside.
    pub core: crate::core::CoreChoice,
    /// Where listen-fire is reached from outside (`publicUrl`), when lf.yaml names it.
    pub public_url: Option<String>,
    /// How long a started external (a module's serve-module included) has to
    /// print `listening <port>`: lf.yaml's `startTimeout`, unless
    /// `--start-timeout` names another.
    pub start_timeout: Duration,
    /// How long a module process may sit unused before listen-fire stops it
    /// (`moduleIdleTimeout`); the next call starts it again.
    pub module_idle_timeout: Duration,
    /// How long one call to a module may take (`callTimeout`).
    pub call_timeout: Duration,
    /// The most one run may spend on model calls and paid services, in
    /// microdollars (lf.yaml's `maxRunCostUsd`); None: no cap.
    pub cost_cap_microdollars: Option<f64>,
    /// How many days the drain keeps a settled delivery's receipt
    /// (lf.yaml's `deliveries.retainDays`).
    pub delivery_retain_days: u32,
    /// How often, in milliseconds, each connection's polled edges are
    /// polled (lf.yaml's `pollEvery`), by the credential it polls as, or its
    /// module for one that uses none. A connection it does not name is
    /// polled at the interval its edge declares (crate::edge_polls).
    pub poll_every: std::collections::BTreeMap<String, i64>,
    /// How often, in milliseconds, each connection's listens re-list the
    /// earlier hops they filter (lf.yaml's `resolveEvery`), by the
    /// credential the connection names, or its module. A connection it does
    /// not name re-lists as its hops declare (crate::resolve).
    pub resolve_every: std::collections::BTreeMap<String, i64>,
    /// The most records a listen's earlier hops may match
    /// (`listenScopeLimit`): over it the listen is suspended.
    pub listen_scope_limit: usize,
    /// How long, in milliseconds, each module's provider may re-send an
    /// arrival (lf.yaml's `resendWindow`), by the module: an identity logged
    /// is a repeat for that long. A module it does not name keeps the window
    /// it declares (crate::externals::resend_window_ms).
    pub resend_window: std::collections::BTreeMap<String, i64>,
    /// How soon, in milliseconds, after a run's write an arrival on the
    /// record it wrote counts as caused by it (lf.yaml's `loopWindow`).
    pub loop_window_ms: i64,
    /// The most runs one chain of writes and arrivals may be (lf.yaml's
    /// `loopDepth`): the listen that would start the next is paused.
    pub loop_depth: usize,
}

/// `maxRunCostUsd` as the platform reads `MOVEMENT_MAX_RUN_COST_USD`
/// (`parseRunCostCap`): a positive number of US dollars, to microdollars.
fn cost_cap_of(dollars: f64, at: &str) -> Result<f64, String> {
    if !(dollars.is_finite() && dollars > 0.0) {
        return Err(format!(
            "{at}: maxRunCostUsd: a positive number of US dollars, the most one run may spend on model calls and paid services (e.g. 5); leave it out for no cap"
        ));
    }
    Ok((dollars * 1_000_000.0).round())
}

/// A started external's wait when lf.yaml names none: a module's first start
/// compiles its TypeScript, which can take a while on a cold cache.
pub const DEFAULT_START_TIMEOUT: Duration = Duration::from_secs(30);

/// `startTimeout` / `--start-timeout`: a positive number of seconds.
pub fn start_timeout_of(seconds: f64, from: &str) -> Result<Duration, String> {
    if !(seconds.is_finite() && seconds > 0.0) {
        return Err(format!("{from}: a positive number of seconds, e.g. 30"));
    }
    Ok(Duration::from_secs_f64(seconds))
}

/// The language an `engine:` pin asks for: the pin itself when this listen-fire reads
/// it, else the rule's refusal with the remedy for lf.yaml.
pub fn language_version_of_engine(engine: &str) -> Result<String, String> {
    let own = LANGUAGE_VERSION;
    match standing(engine, own) {
        Standing::Compatible => Ok(engine.to_string()),
        Standing::Newer => Err(format!("lf.yaml pins engine {engine}, newer than this listen-fire ({own}); upgrade listen-fire")),
        Standing::OlderKey => Err(format!("lf.yaml pins engine {engine}, which this listen-fire ({own}) does not read; run `listen-fire upgrade`")),
        Standing::Malformed => Err(refusal_message(engine, own, Standing::Malformed).unwrap_or_default()),
    }
}

/// `http://` or `https://` and a host.
pub fn is_http_url(text: &str) -> bool {
    let rest = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://"));
    rest.is_some_and(|rest| rest.split(['/', '?', '#']).next().is_some_and(|host| !host.is_empty() && !host.contains(char::is_whitespace)))
}

/// The project whose `lf.yaml` is at `from` or the nearest folder above it.
pub fn load_project(from: &Path) -> Result<Project, String> {
    load_project_with(from, &std::env::vars().collect::<Vec<_>>())
}

/// `load_project` under `env`: where a secrets or movements module's own settings may come from.
pub fn load_project_with(from: &Path, env: &[(String, String)]) -> Result<Project, String> {
    let project = load_pinned(from, false)?;
    crate::secrets_slot::refuse_unbootstrapped(&project, env).map_err(|why| format!("{}: {why}", project.root.join(PROJECT_FILE).display()))?;
    crate::movements_slot::refuse_unbootstrapped(&project, env).map_err(|why| format!("{}: {why}", project.root.join(PROJECT_FILE).display()))?;
    Ok(project)
}

/// The module `lf.yaml` at exactly `root` names for a core slot, read from the
/// `core:` map alone: no pin check, no externals, so a command that runs before
/// a project loads (`listen-fire init`) can ask. None when there is no `lf.yaml`, it
/// does not parse, or it names nothing for the slot.
pub fn named_core_module(root: &Path, slot: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct CoreOnly {
        #[serde(default)]
        core: std::collections::BTreeMap<String, String>,
    }
    let text = fs::read_to_string(root.join(PROJECT_FILE)).ok()?;
    serde_yaml::from_str::<CoreOnly>(&text).ok()?.core.remove(slot)
}

/// The same, for `listen-fire upgrade`: a pin of an older key loads (the upgrade is
/// what moves it), checked in this release's language.
pub fn load_project_to_upgrade(from: &Path) -> Result<Project, String> {
    load_pinned(from, true)
}

fn load_pinned(from: &Path, older_key_loads: bool) -> Result<Project, String> {
    let mut dir = std::path::absolute(from).map_err(|e| format!("{}: {e}", from.display()))?;
    while !dir.join(PROJECT_FILE).exists() {
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => return Err(format!("no {PROJECT_FILE} here or in any folder above (run `listen-fire init`)")),
        }
    }
    let path = dir.join(PROJECT_FILE);
    let text = fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    // An empty file reads as an empty mapping: every key at its default.
    let value: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let value = if value.is_null() { serde_yaml::Value::Mapping(Default::default()) } else { value };
    let file: ProjectFile = serde_yaml::from_value(value).map_err(|e| format!("{}: {e}", path.display()))?;
    if let Some(url) = &file.public_url
        && !is_http_url(url)
    {
        return Err(format!("{}: publicUrl: an http(s) URL, e.g. https://lf.example.com", path.display()));
    }
    let start_timeout = match file.start_timeout {
        None => DEFAULT_START_TIMEOUT,
        Some(seconds) => start_timeout_of(seconds, &format!("{}: startTimeout", path.display()))?,
    };
    let seconds_or = |value: Option<f64>, default: Duration, key: &str| match value {
        None => Ok(default),
        Some(seconds) => start_timeout_of(seconds, &format!("{}: {key}", path.display())),
    };
    let module_idle_timeout = seconds_or(file.module_idle_timeout, crate::module_hosts::DEFAULT_IDLE_TIMEOUT, "moduleIdleTimeout")?;
    let call_timeout = seconds_or(file.call_timeout, crate::module_hosts::DEFAULT_CALL_TIMEOUT, "callTimeout")?;
    let cost_cap_microdollars = file.max_run_cost_usd.map(|d| cost_cap_of(d, &path.display().to_string())).transpose()?;
    let delivery_retain_days = retain_days_of(file.deliveries.as_ref().and_then(|d| d.retain_days.as_ref()), "lf.yaml")?;
    let poll_every = poll_every_of(&file.poll_every, "lf.yaml")?;
    let resolve_every = resolve_every_of(&file.resolve_every, "lf.yaml")?;
    let listen_scope_limit = listen_scope_limit_of(file.listen_scope_limit.as_ref(), "lf.yaml")?;
    let resend_window = resend_window_of(&file.resend_window, "lf.yaml")?;
    let loop_window_ms = loop_window_of(file.loop_window.as_ref(), "lf.yaml")?;
    let loop_depth = loop_depth_of(file.loop_depth.as_ref(), "lf.yaml")?;
    if file.store.is_some() {
        return Err(format!(
            "{}: store: run state is kept by the store module now: `core: {{ store: \"@lf/postgres-store\" }}` (or @lf/sqlite-store, the default), set up with `listen-fire connect @lf/postgres-store`",
            path.display()
        ));
    }
    let externals_dir = dir.join(&file.externals);
    // The externals folder is read only when `core:` names a module listen-fire does not build in.
    let installed = match file.core.values().all(|name| crate::core::builtin(name).is_some()) {
        true => Vec::new(),
        false => crate::externals::core_modules_in(&externals_dir)?,
    };
    let core = crate::core::CoreChoice::of(&file.core, &installed, &path.display().to_string())?;
    let language_version = match standing(&file.engine, LANGUAGE_VERSION) {
        Standing::OlderKey if older_key_loads => LANGUAGE_VERSION.to_string(),
        _ => language_version_of_engine(&file.engine)?,
    };
    let lf_dir = dir.join(".lf");
    fs::create_dir_all(&lf_dir).map_err(|e| format!("{}: {e}", lf_dir.display()))?;
    Ok(Project {
        movements_dir: dir.join(&file.movements),
        externals_dir,
        lf_dir,
        engine: file.engine,
        language_version,
        user: (file.user.name, file.user.email),
        core,
        public_url: file.public_url,
        start_timeout,
        module_idle_timeout,
        call_timeout,
        cost_cap_microdollars,
        delivery_retain_days,
        poll_every,
        resolve_every,
        resend_window,
        listen_scope_limit,
        loop_window_ms,
        loop_depth,
        root: dir,
    })
}

/// Pins that stand against this release however many releases it has had:
/// derived from `LANGUAGE_VERSION`, so a bump never leaves a test naming a
/// key that has become the current one.
#[cfg(test)]
pub(crate) struct Pins {
    pub same_key: String,
    pub older_key: String,
    pub newer: String,
}

#[cfg(test)]
pub(crate) fn pins_against_this_release() -> Pins {
    let key = movement_parser::version::compatibility_key(LANGUAGE_VERSION).unwrap();
    let minor: u64 = key.strip_prefix("0.").expect("a 0.x release").parse().unwrap();
    Pins { same_key: format!("{key}.0"), older_key: format!("0.{}.13", minor - 1), newer: format!("0.{}.0", minor + 1) }
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_older_key_pin_loads_only_to_be_upgraded() {
        let root = std::env::temp_dir().join(format!("lf-pin-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let pins = pins_against_this_release();
        fs::write(root.join(PROJECT_FILE), format!("engine: {}\n", pins.older_key)).unwrap();
        assert!(load_project(&root).unwrap_err().contains("run `listen-fire upgrade`"));
        let project = load_project_to_upgrade(&root).unwrap();
        assert_eq!((project.engine.as_str(), project.language_version.as_str()), (pins.older_key.as_str(), LANGUAGE_VERSION));
        fs::write(root.join(PROJECT_FILE), format!("engine: {}\n", pins.newer)).unwrap();
        assert!(load_project_to_upgrade(&root).unwrap_err().contains("newer than this listen-fire"));
        fs::remove_dir_all(&root).ok();
    }

    use super::*;

    #[test]
    fn the_module_lf_yaml_names_for_a_slot_is_read_without_loading_the_project() {
        let root = std::env::temp_dir().join(format!("lf-named-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert_eq!(named_core_module(&root, "movements"), None, "no lf.yaml");
        fs::write(root.join(PROJECT_FILE), "engine: 0.11.0\ncore:\n  movements: acme_movements\n").unwrap();
        assert_eq!(named_core_module(&root, "movements"), Some("acme_movements".to_string()), "an older pin is not checked");
        assert_eq!(named_core_module(&root, "store"), None);
        fs::write(root.join(PROJECT_FILE), "engine: 0.13.0\n").unwrap();
        assert_eq!(named_core_module(&root, "movements"), None);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_engine_pin_is_read_by_its_standing_against_this_release() {
        let pins = pins_against_this_release();
        assert_eq!(language_version_of_engine(&pins.same_key), Ok(pins.same_key.clone()));
        assert_eq!(language_version_of_engine(LANGUAGE_VERSION), Ok(LANGUAGE_VERSION.to_string()));
        assert_eq!(
            language_version_of_engine(&pins.newer),
            Err(format!("lf.yaml pins engine {}, newer than this listen-fire ({LANGUAGE_VERSION}); upgrade listen-fire", pins.newer))
        );
        assert_eq!(
            language_version_of_engine(&pins.older_key),
            Err(format!("lf.yaml pins engine {}, which this listen-fire ({LANGUAGE_VERSION}) does not read; run `listen-fire upgrade`", pins.older_key))
        );
        let malformed = language_version_of_engine("5").unwrap_err();
        assert!(malformed.contains("pins language 5, which is not a version"), "{malformed}");
    }

    #[test]
    fn retain_days_defaults_to_fourteen_and_refuses_zero() {
        let yaml = |text: &str| serde_yaml::from_str::<serde_yaml::Value>(text).unwrap();
        assert_eq!(retain_days_of(None, "lf.yaml"), Ok(14));
        assert_eq!(retain_days_of(Some(&yaml("30")), "lf.yaml"), Ok(30));
        for bad in ["0", "-3", "1.5", "\"soon\""] {
            assert_eq!(
                retain_days_of(Some(&yaml(bad)), "lf.yaml"),
                Err("lf.yaml: deliveries.retainDays: a whole number of days, at least 1 (default 14)".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn poll_every_reads_a_duration_per_connection_and_refuses_one_that_is_none() {
        let yaml = |text: &str| serde_yaml::from_str::<std::collections::BTreeMap<String, serde_yaml::Value>>(text).unwrap();
        assert_eq!(poll_every_of(&yaml("feed: 1s\nmy_gmail: 5m"), "lf.yaml"), Ok([("feed".to_string(), 1_000), ("my_gmail".to_string(), 300_000)].into()));
        assert_eq!(poll_every_of(&yaml("{}"), "lf.yaml"), Ok(Default::default()));
        for bad in ["feed: soon", "feed: 30", "feed: 0s", "feed: -1m"] {
            assert_eq!(
                poll_every_of(&yaml(bad), "lf.yaml"),
                Err("lf.yaml: pollEvery.feed: a duration, such as 30s or 5m: how often that connection's polled edges are polled".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn resolve_every_reads_a_duration_per_connection_and_the_scope_limit_a_positive_number() {
        let yaml = |text: &str| serde_yaml::from_str::<std::collections::BTreeMap<String, serde_yaml::Value>>(text).unwrap();
        assert_eq!(resolve_every_of(&yaml("feed: 5m"), "lf.yaml"), Ok([("feed".to_string(), 300_000)].into()));
        assert_eq!(
            resolve_every_of(&yaml("feed: often"), "lf.yaml"),
            Err("lf.yaml: resolveEvery.feed: a duration, such as 30s or 5m: how often that connection's listens re-list the earlier hops they filter".to_string())
        );
        let value = |text: &str| serde_yaml::from_str::<serde_yaml::Value>(text).unwrap();
        assert_eq!(listen_scope_limit_of(None, "lf.yaml"), Ok(DEFAULT_LISTEN_SCOPE_LIMIT));
        assert_eq!(listen_scope_limit_of(Some(&value("1")), "lf.yaml"), Ok(1));
        for bad in ["0", "-3", "many", "2.5"] {
            assert_eq!(
                listen_scope_limit_of(Some(&value(bad)), "lf.yaml"),
                Err("lf.yaml: listenScopeLimit: a whole number, at least 1, of the records a listen's earlier hops may match (default 500)".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_loop_window_is_a_duration_and_the_loop_depth_a_positive_number() {
        let value = |text: &str| serde_yaml::from_str::<serde_yaml::Value>(text).unwrap();
        assert_eq!(loop_window_of(None, "lf.yaml"), Ok(20_000));
        assert_eq!(loop_window_of(Some(&value("1m")), "lf.yaml"), Ok(60_000));
        for bad in ["soon", "20", "0s"] {
            assert_eq!(
                loop_window_of(Some(&value(bad)), "lf.yaml"),
                Err("lf.yaml: loopWindow: a duration, such as 20s: how soon after a run's write an arrival on the record it wrote counts as caused by it (default 20s)".to_string()),
                "{bad}"
            );
        }
        assert_eq!(loop_depth_of(None, "lf.yaml"), Ok(10));
        assert_eq!(loop_depth_of(Some(&value("3")), "lf.yaml"), Ok(3));
        for bad in ["0", "-1", "many", "2.5"] {
            assert_eq!(
                loop_depth_of(Some(&value(bad)), "lf.yaml"),
                Err("lf.yaml: loopDepth: a whole number, at least 1, of the runs one chain of writes and arrivals may be before its listen is paused (default 10)".to_string()),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_cost_cap_is_read_as_the_platform_reads_its_setting() {
        assert_eq!(cost_cap_of(5.0, "lf.yaml"), Ok(5_000_000.0));
        assert_eq!(cost_cap_of(0.25, "lf.yaml"), Ok(250_000.0));
        assert!(cost_cap_of(0.0, "lf.yaml").unwrap_err().contains("maxRunCostUsd"));
        assert!(cost_cap_of(-1.0, "lf.yaml").is_err());
    }

    /// listen-fire's slots are the protocol's: `CORE_SLOTS` names `Slot::ALL`, in order.
    #[test]
    fn the_core_slots_are_the_protocols() {
        let protocol = include_str!("../../../packages/engine-contracts/protocol.ts");
        let marker = "export const CORE_SLOTS = [";
        let start = protocol.find(marker).expect("protocol.ts declares CORE_SLOTS") + marker.len();
        let end = start + protocol[start..].find(']').expect("the list ends");
        let named: Vec<&str> = protocol[start..end].split(',').map(|s| s.trim().trim_matches('\'')).filter(|s| !s.is_empty()).collect();
        let slots: Vec<&str> = crate::core::Slot::ALL.iter().map(|s| s.name()).collect();
        assert_eq!(named, slots);
    }

    /// The crates and the TypeScript packages are one release: each reads its
    /// own manifest's version (`LANGUAGE_VERSION` on both sides).
    #[test]
    fn the_crates_are_the_same_release_as_the_language_package() {
        let manifest = include_str!("../../../packages/movement-lang/package.json");
        let marker = "\"version\": \"";
        let start = manifest.find(marker).expect("the language package names its version") + marker.len();
        let end = start + manifest[start..].find('"').expect("the version ends");
        assert_eq!(&manifest[start..end], env!("CARGO_PKG_VERSION"));
        assert_eq!(LANGUAGE_VERSION, env!("CARGO_PKG_VERSION"));
    }
}

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
    /// Seconds a started module process may sit unused before lf stops it.
    #[serde(rename = "moduleIdleTimeout")]
    module_idle_timeout: Option<f64>,
    /// Seconds one call to a module may take.
    #[serde(rename = "callTimeout")]
    call_timeout: Option<f64>,
    /// The most one run may spend, in US dollars (the platform's
    /// `MOVEMENT_MAX_RUN_COST_USD`).
    #[serde(rename = "maxRunCostUsd")]
    max_run_cost_usd: Option<f64>,
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
    /// Where lf is reached from outside (`publicUrl`), when lf.yaml names it.
    pub public_url: Option<String>,
    /// How long a started external (a module's serve-module included) has to
    /// print `listening <port>`: lf.yaml's `startTimeout`, unless
    /// `--start-timeout` names another.
    pub start_timeout: Duration,
    /// How long a module process may sit unused before lf stops it
    /// (`moduleIdleTimeout`); the next call starts it again.
    pub module_idle_timeout: Duration,
    /// How long one call to a module may take (`callTimeout`).
    pub call_timeout: Duration,
    /// The most one run may spend on model calls and paid services, in
    /// microdollars (lf.yaml's `maxRunCostUsd`); None: no cap.
    pub cost_cap_microdollars: Option<f64>,
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

/// The language an `engine:` pin asks for: the pin itself when this lf reads
/// it, else the rule's refusal with the remedy for lf.yaml.
pub fn language_version_of_engine(engine: &str) -> Result<String, String> {
    let own = LANGUAGE_VERSION;
    match standing(engine, own) {
        Standing::Compatible => Ok(engine.to_string()),
        Standing::Newer => Err(format!("lf.yaml pins engine {engine}, newer than this lf ({own}); upgrade lf")),
        Standing::OlderKey => Err(format!("lf.yaml pins engine {engine}, which this lf ({own}) does not read; run `lf upgrade`")),
        Standing::Malformed => Err(refusal_message(engine, own, Standing::Malformed).unwrap_or_default()),
    }
}

/// `http://` or `https://` and a host.
fn is_http_url(text: &str) -> bool {
    let rest = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://"));
    rest.is_some_and(|rest| rest.split(['/', '?', '#']).next().is_some_and(|host| !host.is_empty() && !host.contains(char::is_whitespace)))
}

/// The project whose `lf.yaml` is at `from` or the nearest folder above it.
pub fn load_project(from: &Path) -> Result<Project, String> {
    load_project_with(from, &std::env::vars().collect::<Vec<_>>())
}

/// `load_project` under `env`: where a secrets module's own settings may come from.
pub fn load_project_with(from: &Path, env: &[(String, String)]) -> Result<Project, String> {
    let project = load_pinned(from, false)?;
    crate::secrets_slot::refuse_unbootstrapped(&project, env).map_err(|why| format!("{}: {why}", project.root.join(PROJECT_FILE).display()))?;
    Ok(project)
}

/// The same, for `lf upgrade`: a pin of an older key loads (the upgrade is
/// what moves it), checked in this release's language.
pub fn load_project_to_upgrade(from: &Path) -> Result<Project, String> {
    load_pinned(from, true)
}

fn load_pinned(from: &Path, older_key_loads: bool) -> Result<Project, String> {
    let mut dir = std::path::absolute(from).map_err(|e| format!("{}: {e}", from.display()))?;
    while !dir.join(PROJECT_FILE).exists() {
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => return Err(format!("no {PROJECT_FILE} here or in any folder above (run `lf init`)")),
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
    if file.store.is_some() {
        return Err(format!(
            "{}: store: run state is kept by the store module now: `core: {{ store: \"@lf/postgres-store\" }}` (or @lf/sqlite-store, the default), set up with `lf connect @lf/postgres-store`",
            path.display()
        ));
    }
    let externals_dir = dir.join(&file.externals);
    // The externals folder is read only when `core:` names a module lf does not build in.
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
        root: dir,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_older_key_pin_loads_only_to_be_upgraded() {
        let root = std::env::temp_dir().join(format!("lf-pin-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(PROJECT_FILE), "engine: 0.11.0\n").unwrap();
        assert!(load_project(&root).unwrap_err().contains("run `lf upgrade`"));
        let project = load_project_to_upgrade(&root).unwrap();
        assert_eq!((project.engine.as_str(), project.language_version.as_str()), ("0.11.0", LANGUAGE_VERSION));
        fs::write(root.join(PROJECT_FILE), "engine: 0.13.0\n").unwrap();
        assert!(load_project_to_upgrade(&root).unwrap_err().contains("newer than this lf"));
        fs::remove_dir_all(&root).ok();
    }

    use super::*;

    #[test]
    fn an_engine_pin_is_read_by_its_standing_against_this_release() {
        assert_eq!(language_version_of_engine("0.12.0"), Ok("0.12.0".to_string()));
        assert_eq!(language_version_of_engine(LANGUAGE_VERSION), Ok(LANGUAGE_VERSION.to_string()));
        assert_eq!(
            language_version_of_engine("0.13.0"),
            Err(format!("lf.yaml pins engine 0.13.0, newer than this lf ({LANGUAGE_VERSION}); upgrade lf"))
        );
        assert_eq!(
            language_version_of_engine("0.11.0"),
            Err(format!("lf.yaml pins engine 0.11.0, which this lf ({LANGUAGE_VERSION}) does not read; run `lf upgrade`"))
        );
        let malformed = language_version_of_engine("5").unwrap_err();
        assert!(malformed.contains("pins language 5, which is not a version"), "{malformed}");
    }

    #[test]
    fn the_cost_cap_is_read_as_the_platform_reads_its_setting() {
        assert_eq!(cost_cap_of(5.0, "lf.yaml"), Ok(5_000_000.0));
        assert_eq!(cost_cap_of(0.25, "lf.yaml"), Ok(250_000.0));
        assert!(cost_cap_of(0.0, "lf.yaml").unwrap_err().contains("maxRunCostUsd"));
        assert!(cost_cap_of(-1.0, "lf.yaml").is_err());
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

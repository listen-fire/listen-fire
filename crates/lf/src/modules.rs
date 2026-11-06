//! `listen-fire modules`: the modules this listen-fire can install, and
//! `listen-fire modules show <module>`, a short summary of one: what it reads,
//! writes and listens to, so a program is written knowing what the module
//! cannot do. Everything in the summary is read from the module itself (its
//! manifest answer and the schema it describes), never written down beside it.
//!
//! A module is started to be read and asked for no credential. One whose
//! schema comes from the connected account (its manifest says
//! `introspectedSchema`) is not described: the summary says so, and what to do.

use crate::check::{LOCAL_TENANT, describe_as};
use crate::schema_view::{LEGEND, SchemaView};
use crate::connect::{find_external, known_modules, process_env};
use crate::externals::{External, ExternalManifest, RunningExternal, start_externals};
use crate::json::Js;
use crate::obj;
use crate::oauth2::{Declaration, DeclarationKind};
use crate::project::Project;
use crate::secrets::{Binding, Credentials, Secrets};

/// `listen-fire modules` and a bare `listen-fire connect`: the modules known here, one per line.
pub fn list(project: &Project, json: bool) -> Result<i32, String> {
    let known = known_modules(project)?;
    if json {
        let doc = Js::Obj(obj! { "modules" => Js::Arr(known.into_iter().map(|m| Js::Obj(m.facts)).collect()) });
        println!("{}", doc.to_json());
    } else if known.is_empty() {
        println!("no modules known here; install one: listen-fire connect <package or name>");
    } else {
        println!("{}", known.iter().map(|m| m.line.as_str()).collect::<Vec<_>>().join("\n"));
        println!("\nlisten-fire modules show <module> says what one reads, writes and listens to; listen-fire connect <module> sets it up");
    }
    Ok(0)
}

pub async fn run(project: &Project, rest: &[String], json: bool) -> Result<i32, String> {
    match rest {
        [] => list(project, json),
        [show, reference] if show == "show" => {
            let summary = summarize(project, reference).await?;
            println!("{}", if json { summary.to_json() } else { summary.to_text() });
            Ok(0)
        }
        _ => {
            eprintln!("usage: listen-fire modules [--json]\n       listen-fire modules show <module> [--json]");
            Ok(2)
        }
    }
}

// ── The summary ──────────────────────────────────────────────────────────────

/// Where a module's schema stands.
enum Schema {
    /// Read from the module; no account was needed.
    Described(SchemaView),
    /// Comes from the connected account, so it was not read.
    FromAccount,
    /// The module has no schema to read (a plugin module), or could not give one without a credential.
    Unread(String),
}

struct Plugin {
    call: String,
    priced: bool,
    description: Option<String>,
}

struct Summary {
    reference: String,
    /// How a program's `connect` names it (crate::externals::External::connect_name).
    connect_name: String,
    /// What the project calls it, when it is installed here.
    installed_as: Option<String>,
    description: Option<String>,
    /// `adapter`, `plugin`, or the slot a core module fills.
    kind: String,
    schema: Schema,
    triggers: Vec<String>,
    poll_seconds: Option<u64>,
    /// `name (kind): field, field?` lines, one credential each.
    credentials: Vec<String>,
    settings: Vec<String>,
    plugins: Vec<Plugin>,
    /// The flags `connect --yes` cannot do without.
    needs: Vec<String>,
    /// The adapter protocol minor the module needs its host to speak; none for a slot module.
    protocol_minor: Option<u64>,
}

async fn summarize(project: &Project, reference: &str) -> Result<Summary, String> {
    let core = crate::core::builtin(reference).cloned().or_else(|| crate::externals::core_modules_in(&project.externals_dir).ok()?.into_iter().find(|m| m.name == reference));
    if let Some(module) = core {
        return Ok(core_summary(reference, &module));
    }
    let installed = find_external(project, reference)?;
    let (external, scratch) = match &installed {
        Some(external) => (external.clone(), None),
        None => {
            if crate::externals::bundled_module(reference).is_none() {
                return Err(format!("no module \"{reference}\" is installed here or bundled with this listen-fire; listen-fire modules lists them"));
            }
            let (external, scratch) = scratch_external(reference)?;
            (external, Some(scratch))
        }
    };
    let state_dir = project.lf_dir.join("externals").join(&external.manifest.name);
    let state_existed = state_dir.exists();
    let credentials: Credentials = match &installed {
        Some(_) => Secrets::open(project, &process_env())?.into_credentials().into_iter().filter(|c| c.external == external.manifest.name && c.binding == Binding::Install).collect(),
        None => Vec::new(),
    };
    let summary = read_module(project, reference, &external, &credentials, installed.is_some()).await;
    if let Some(scratch) = scratch {
        let _ = std::fs::remove_dir_all(scratch);
        if !state_existed {
            let _ = std::fs::remove_dir_all(state_dir);
        }
    }
    summary
}

/// A module of the bundle, not installed here, as an external in a folder of its own to be started from.
fn scratch_external(reference: &str) -> Result<(External, std::path::PathBuf), String> {
    let name: String = reference.rsplit('/').next().unwrap_or(reference).chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let dir = std::env::temp_dir().join(format!("lf-modules-show-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let manifest: ExternalManifest = serde_yaml::from_str(&format!("name: {name}\nmodule: {}\n", serde_json::Value::String(reference.into()))).map_err(|e| e.to_string())?;
    Ok((External { dir: dir.clone(), manifest }, dir))
}

async fn read_module(project: &Project, reference: &str, external: &External, credentials: &Credentials, installed: bool) -> Result<Summary, String> {
    let running = start_externals(project, std::slice::from_ref(external), credentials, LOCAL_TENANT).await?;
    let running = running.first().ok_or_else(|| format!("module \"{reference}\" did not answer its manifest"))?;
    let answer = &running.manifest_answer;
    let live = Js::is_true(answer.get("introspectedSchema"));
    let mut summary = Summary {
        reference: reference.to_string(),
        connect_name: external.connect_name(),
        installed_as: installed.then(|| external.manifest.name.clone()),
        description: answer.get("description").and_then(Js::as_str).map(str::to_string),
        kind: if running.is_plugin() || answer.get("plugins").is_some() { "plugin".into() } else { "adapter".into() },
        schema: Schema::Unread("it declares no schema".into()),
        triggers: running.supported_triggers.clone(),
        poll_seconds: running.poll_interval_seconds,
        credentials: running.credential_declarations.iter().map(credential_line).collect(),
        settings: settings_lines(answer),
        plugins: plugins_of(running),
        needs: needs_of(running),
        protocol_minor: Some(module_wire::envelope::protocol_minor_of(answer)),
    };
    if summary.kind == "plugin" {
        return Ok(summary);
    }
    summary.schema = if live {
        Schema::FromAccount
    } else {
        match describe_as(running, &Vec::new(), None, None).await {
            Ok((_, schema)) => match SchemaView::of(&external.manifest.name, &schema) {
                Ok(view) => Schema::Described(view),
                Err(why) => Schema::Unread(format!("its schema does not read ({why})")),
            },
            Err(why) => Schema::Unread(format!("the module cannot describe itself without a credential ({})", last_clause(first_line(&why)))),
        }
    };
    Ok(summary)
}

fn core_summary(reference: &str, module: &crate::core::CoreModule) -> Summary {
    let settings = module
        .settings
        .iter()
        .map(|s| {
            let mut notes = Vec::new();
            if s.secret {
                notes.push("secret");
            }
            if s.optional {
                notes.push("optional");
            }
            let label = if s.label.is_empty() { String::new() } else { format!(": {}", s.label) };
            let notes = if notes.is_empty() { String::new() } else { format!(" ({})", notes.join(", ")) };
            format!("{}{notes}{label}", s.name)
        })
        .collect();
    let needs = module.settings.iter().filter(|s| !s.optional).map(|s| format!("--setting {}=<value>", s.name)).collect();
    Summary {
        reference: reference.to_string(),
        connect_name: format!("#{}", external_name(reference)),
        installed_as: None,
        description: None,
        kind: format!("{} slot", module.slot.name()),
        schema: Schema::Unread("a slot module has no records".into()),
        triggers: Vec::new(),
        poll_seconds: None,
        credentials: Vec::new(),
        settings,
        plugins: Vec::new(),
        needs,
        protocol_minor: None,
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or(text)
}

/// What a module said, without the protocol's wrapping of it.
fn last_clause(text: &str) -> &str {
    text.rsplit(" — ").next().unwrap_or(text)
}

fn credential_line(declaration: &Declaration) -> String {
    let kind = match &declaration.kind {
        DeclarationKind::Static => "fields".to_string(),
        DeclarationKind::OAuth2(oauth) if oauth.scopes.is_empty() => "OAuth 2 sign-in".to_string(),
        DeclarationKind::OAuth2(oauth) => format!("OAuth 2 sign-in, scopes {}", oauth.scopes.join(" ")),
    };
    // An OAuth 2 credential's tokens are the sign-in's; the fields are what else it holds.
    let fields: Vec<String> = declaration.fields.iter().map(|f| if f.optional == Some(true) { format!("{}?", f.name) } else { f.name.clone() }).collect();
    format!("{} ({kind}){}", declaration.name, if fields.is_empty() { String::new() } else { format!(": {}", fields.join(", ")) })
}

fn settings_lines(answer: &Js) -> Vec<String> {
    answer
        .get("settings")
        .and_then(Js::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(|s| {
            let name = s.get("name")?.as_str()?;
            let mut notes = Vec::new();
            if Js::is_true(s.get("secret")) {
                notes.push("secret");
            }
            if Js::is_true(s.get("optional")) {
                notes.push("optional");
            }
            let notes = if notes.is_empty() { String::new() } else { format!(" ({})", notes.join(", ")) };
            let label = s.get("label").and_then(Js::as_str).map(|l| format!(": {l}")).unwrap_or_default();
            Some(format!("{name}{notes}{label}"))
        })
        .collect()
}

fn plugins_of(running: &RunningExternal) -> Vec<Plugin> {
    let namespace = running.external.manifest.name.clone();
    crate::externals::plugin_entries(running.plugins.as_ref())
        .into_iter()
        .map(|(name, spec)| Plugin {
            call: format!("{namespace}.{}", plugin_call(&name.replace('-', "_"), &spec)),
            priced: Js::is_true(spec.get("priced")),
            description: spec.get("description").and_then(Js::as_str).map(str::to_string),
        })
        .collect()
}

/// `render(text, pageSize?)`: a plugin called by `name`, each argument it
/// takes, those it may go without marked `?`.
pub(crate) fn plugin_call(name: &str, spec: &Js) -> String {
    let required: Vec<&str> = spec.get("requiredArgs").and_then(Js::as_array).unwrap_or_default().iter().filter_map(Js::as_str).collect();
    let args: Vec<String> = spec
        .get("args")
        .and_then(Js::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Js::as_str)
        .map(|arg| if required.contains(&arg) { arg.to_string() } else { format!("{arg}?") })
        .collect();
    format!("{name}({})", args.join(", "))
}

/// What `connect --yes` cannot choose a default for. The webhook secret is generated when not given.
fn needs_of(running: &RunningExternal) -> Vec<String> {
    let mut needs = Vec::new();
    if running.external.manifest.auth.is_some() {
        needs.push("--server-secret <secret>".to_string());
    }
    for setting in running.manifest_answer.get("settings").and_then(Js::as_array).unwrap_or_default() {
        let Some(name) = setting.get("name").and_then(Js::as_str) else { continue };
        if !Js::is_true(setting.get("optional")) {
            needs.push(format!("--setting {name}=<value>"));
        }
    }
    let declarations = &running.credential_declarations;
    if !declarations.is_empty() && declarations.iter().all(|d| d.oauth2().is_some()) {
        needs.push("--client-id <your OAuth app's client id>".to_string());
    }
    needs
}

// ── Output ───────────────────────────────────────────────────────────────────

impl Summary {
    /// What a program and the commands call the module here.
    fn module_name(&self) -> String {
        self.installed_as.clone().unwrap_or_else(|| external_name(&self.reference))
    }

    fn is_slot(&self) -> bool {
        self.kind.ends_with(" slot")
    }

    fn read_only(&self) -> bool {
        matches!(&self.schema, Schema::Described(view) if view.read_only())
    }

    fn to_text(&self) -> String {
        let mut out = Vec::new();
        let mut line = |text: String| out.push(text);
        if matches!(self.schema, Schema::Described(_)) {
            line(LEGEND.into());
        }
        line(format!("{} ({})", self.reference, self.kind));
        if let Some(description) = &self.description {
            line(description.clone());
        }
        if self.is_slot() {
            line("fills a slot of listen-fire itself; lf.yaml's core: names it".into());
        } else {
            line(match &self.installed_as {
                Some(name) => format!("installed here as {name}"),
                None => format!("not installed here: listen-fire connect {}", self.reference),
            });
        }

        match &self.schema {
            Schema::Described(view) => {
                line(String::new());
                line(format!("access: {}", if view.read_only() { "read-only (it writes nothing)" } else { "reads and writes" }));
                line("schema: the module's own; no account is needed to check against it".into());
                let mut lines = Vec::new();
                view.lines(&mut lines);
                lines.into_iter().for_each(&mut line);
            }
            Schema::FromAccount => {
                line(String::new());
                line("schema: comes from the connected account (its tables, fields and the like), so it cannot be read here without one".into());
                line(format!("  to see it: listen-fire credential add --module {} <credential>, connect it in a movement (c = connect {} using <credential>), then listen-fire catalog", self.module_name(), self.connect_name));
            }
            Schema::Unread(_) if self.kind == "plugin" || self.is_slot() => {}
            Schema::Unread(why) => {
                line(String::new());
                line(format!("schema: not read; {why}"));
            }
        }

        if !self.plugins.is_empty() {
            line(String::new());
            line("plugins:".into());
            for plugin in &self.plugins {
                let priced = if plugin.priced { " (priced per call)" } else { "" };
                line(format!("  {}{priced}{}", plugin.call, plugin.description.as_deref().map(|d| format!(": {d}")).unwrap_or_default()));
            }
        }

        let listens = self.kind == "adapter";
        if listens {
            line(String::new());
        }
        if self.triggers.is_empty() {
            if listens {
                line("listens: nothing; no listen can name it".into());
            }
        } else {
            let how = self
                .triggers
                .iter()
                .map(|t| match (t.as_str(), self.poll_seconds) {
                    ("poll", Some(seconds)) => format!("poll (every {seconds}s unless the listen says)"),
                    _ => t.clone(),
                })
                .collect::<Vec<_>>()
                .join(", ");
            line(format!("listens: {how}"));
        }

        if !self.credentials.is_empty() || !self.settings.is_empty() {
            line(String::new());
        }
        for credential in &self.credentials {
            line(format!("credential: {credential}"));
        }
        for setting in &self.settings {
            line(format!("setting: {setting}"));
        }

        line(String::new());
        let needs = if self.needs.is_empty() { String::new() } else { format!(" {}", self.needs.join(" ")) };
        line(format!("set up: listen-fire connect {} --yes{needs}", self.reference));
        if !self.credentials.is_empty() {
            line(format!("then: listen-fire credential add --module {} <name>", self.module_name()));
        }
        let name = self.module_name();
        match (self.kind.as_str(), self.credentials.is_empty()) {
            ("plugin", _) => line(format!("use: import {{ {name} }} from plugins")),
            ("adapter", false) => line(format!("use: c = connect {} using <credential>", self.connect_name)),
            ("adapter", true) => line(format!("use: c = connect {}", self.connect_name)),
            _ => {}
        }
        movement_parser::util::form::external_text(&out.join("\n")).into_owned()
    }

    fn to_json(&self) -> String {
        let (schema, view) = match &self.schema {
            Schema::Described(view) => (obj! { "source" => Js::str("module") }, view.to_json()),
            Schema::FromAccount => (obj! { "source" => Js::str("account") }, SchemaView::default().to_json()),
            Schema::Unread(why) => (obj! { "source" => Js::str("unread"), "why" => Js::str(why) }, SchemaView::default().to_json()),
        };
        let mut doc = obj! {
            "module" => Js::str(&self.reference),
            "kind" => Js::str(&self.kind),
            "description" => self.description.as_deref().map_or(Js::Null, Js::str),
            "installedAs" => self.installed_as.as_deref().map_or(Js::Null, Js::str),
            "readOnly" => Js::Bool(self.read_only()),
            "schema" => Js::Obj(schema),
        };
        doc.extend(view);
        doc.extend(obj! {
            "listens" => Js::Obj(obj! {
                "triggers" => Js::strings(&self.triggers),
                "pollSeconds" => self.poll_seconds.map_or(Js::Null, |s| Js::Num(s.into())),
            }),
            "credentials" => Js::strings(&self.credentials),
            "settings" => Js::strings(&self.settings),
            "plugins" => Js::Arr(self.plugins.iter().map(|p| Js::Obj(obj! {
                "call" => Js::str(&p.call),
                "priced" => Js::Bool(p.priced),
                "description" => p.description.as_deref().map_or(Js::Null, Js::str),
            })).collect()),
            "connectNeeds" => Js::strings(&self.needs),
            "protocolMinor" => self.protocol_minor.map_or(Js::Null, |m| Js::Num(m.into())),
        });
        Js::Obj(doc).to_json()
    }
}

pub(crate) fn first_sentence(text: &str) -> String {
    text.split_once(". ").map_or(text, |(first, _)| first).trim_end_matches('.').to_string()
}

/// What an uninstalled `@lf/<folder>` would be called as an external.
fn external_name(reference: &str) -> String {
    reference.rsplit('/').next().unwrap_or(reference).chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect()
}

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
use crate::connect::{find_external, known_modules, process_env};
use crate::externals::{External, ExternalManifest, RunningExternal, start_externals};
use crate::json::{Js, Obj};
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

/// What a described schema offers a program: the edges a walk or a listen
/// starts from, the record types, and what it writes. `modules show` prints
/// a module's own; `listen-fire catalog` prints each connection's, live
/// types included (crate::catalog::catalog_text).
#[derive(Default)]
pub(crate) struct SchemaView {
    collections: Vec<Edge>,
    records: Vec<Record>,
    writes: Vec<Write>,
}

/// An edge from the connection or from a record, and how a program may follow it.
struct Edge {
    name: String,
    target: String,
    access: EdgeAccess,
}

/// What a program does with an edge: walk it, listen on it, or only write along it.
#[derive(Clone, Copy)]
enum EdgeAccess {
    Read,
    ReadAndListen,
    ListenOnly,
    WriteOnly,
}

impl EdgeAccess {
    fn of(edge: &Js) -> EdgeAccess {
        match (!Js::is_false(edge.get("readable")), Js::is_true(edge.get("listenable"))) {
            (true, false) => EdgeAccess::Read,
            (true, true) => EdgeAccess::ReadAndListen,
            (false, true) => EdgeAccess::ListenOnly,
            (false, false) => EdgeAccess::WriteOnly,
        }
    }

    fn mark(self) -> &'static str {
        match self {
            EdgeAccess::Read => "",
            EdgeAccess::ReadAndListen => " (listenable)",
            EdgeAccess::ListenOnly => " (listen only)",
            EdgeAccess::WriteOnly => " (write only)",
        }
    }
}

struct Record {
    name: String,
    description: Option<String>,
    fields: Vec<(String, String)>,
    edges: Vec<Edge>,
    /// The fields a read's WHERE must set with `==`: the read's arguments (an MCP tool's).
    pinned: Vec<String>,
}

/// A write: along an edge from a record, or from the connection's own collection.
struct Write {
    along: String,
    target: String,
    /// A field and whether the write requires it.
    fields: Vec<(String, bool)>,
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
            Ok((_, schema)) => Schema::Described(SchemaView::of(&schema)),
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

// ── The schema, as a program sees it ─────────────────────────────────────────

fn object(value: Option<&Js>) -> Obj {
    match value {
        Some(Js::Obj(o)) => o.clone(),
        _ => Obj::new(),
    }
}

fn edge_of(name: &str, edge: &Js) -> Edge {
    Edge { name: name.to_string(), target: edge.get("target").and_then(Js::as_str).unwrap_or("(several)").to_string(), access: EdgeAccess::of(edge) }
}

impl SchemaView {
    /// The view of a described schema (`InstanceSchema`, docs/contracts/catalog-snapshot.md).
    pub(crate) fn of(schema: &Js) -> SchemaView {
        let positions = object(schema.get("positions"));
        let collections: Vec<Edge> = object(schema.get("collections")).iter().filter(|(_, c)| c.get("target").and_then(Js::as_str).is_some()).map(|(name, c)| edge_of(name, c)).collect();
        let mut records = Vec::new();
        for (name, position) in &positions {
            if Js::is_true(position.get("undescribed")) {
                continue;
            }
            let fields = object(position.get("properties")).iter().map(|(field, type_)| (field.clone(), type_text(type_))).collect();
            // A write-only edge is said under the writes.
            let edges = object(position.get("edges")).iter().map(|(edge_name, edge)| edge_of(edge_name, edge)).filter(|edge| !matches!(edge.access, EdgeAccess::WriteOnly)).collect();
            let pinned = position.get("pinnedProperties").and_then(Js::as_array).unwrap_or_default().iter().filter_map(Js::as_str).map(str::to_string).collect();
            records.push(Record { name: name.clone(), description: position.get("description").and_then(Js::as_str).map(str::to_string), fields, edges, pinned });
        }

        let writable_roots = object(schema.get("writableRoots"));
        let shapes: Obj = writable_roots.clone().into_iter().chain(object(schema.get("createShapes"))).collect();
        let write_fields = |target: &str| -> Vec<(String, bool)> {
            let Some(shape) = shapes.get(target) else { return Vec::new() };
            let required: Vec<&str> = shape.get("requiredFields").and_then(Js::as_array).unwrap_or_default().iter().filter_map(Js::as_str).collect();
            object(shape.get("fields")).keys().map(|f| (f.clone(), required.contains(&f.as_str()))).collect()
        };
        let mut writes = Vec::new();
        for collection in &collections {
            if writable_roots.contains_key(&collection.target) {
                writes.push(Write { along: format!("the connection's {}", collection.name), target: collection.target.clone(), fields: write_fields(&collection.target) });
            }
        }
        for (name, position) in &positions {
            for (edge_name, edge) in object(position.get("edges")) {
                if !Js::is_true(edge.get("writable")) {
                    continue;
                }
                let target = edge.get("target").and_then(Js::as_str).unwrap_or_default().to_string();
                let write_only = if Js::is_false(edge.get("readable")) { ", write only" } else { "" };
                writes.push(Write { along: format!("{name}.{edge_name}{write_only}"), fields: write_fields(&target), target });
            }
        }
        SchemaView { collections, records, writes }
    }

    fn read_only(&self) -> bool {
        self.writes.is_empty()
    }

    /// Where a walk or a listen starts, the record types and the writes, a blank line before each.
    pub(crate) fn lines(&self, out: &mut Vec<String>) {
        if !self.collections.is_empty() {
            out.push(String::new());
            out.push("reads: start a walk (or a listen, where marked) from the connection with".into());
            for edge in &self.collections {
                out.push(format!("  {} -> {}{}", edge.name, edge.target, edge.access.mark()));
            }
        }
        if !self.records.is_empty() {
            out.push(String::new());
            let pins = if self.records.iter().any(|r| !r.pinned.is_empty()) { "; pinned: the fields a read's WHERE must set with ==" } else { "" };
            out.push(format!("record types (a name with a space is written in backticks{pins}):"));
            for record in &self.records {
                out.push(format!("  {}{}", record.name, record.description.as_deref().map(|d| format!(": {}", first_sentence(d))).unwrap_or_default()));
                if !record.fields.is_empty() {
                    out.push(format!("    fields: {}", record.fields.iter().map(|(n, t)| format!("{n} {t}")).collect::<Vec<_>>().join(", ")));
                }
                if !record.pinned.is_empty() {
                    out.push(format!("    pinned: {}", record.pinned.join(", ")));
                }
                if !record.edges.is_empty() {
                    out.push(format!("    edges: {}", record.edges.iter().map(|e| format!("{} -> {}{}", e.name, e.target, e.access.mark())).collect::<Vec<_>>().join(", ")));
                }
            }
        }
        if !self.writes.is_empty() {
            out.push(String::new());
            out.push("writes (a * is required):".into());
            for write in &self.writes {
                let fields: Vec<String> = write.fields.iter().map(|(n, required)| format!("{n}{}", if *required { "*" } else { "" })).collect();
                out.push(format!("  a {} along {}: {}", write.target, write.along, if fields.is_empty() { "(no fields)".into() } else { fields.join(", ") }));
            }
        }
    }

    fn to_json(&self) -> Obj {
        let edge = |e: &Edge| {
            Js::Obj(obj! {
                "name" => Js::str(&e.name),
                "target" => Js::str(&e.target),
                "readable" => Js::Bool(matches!(e.access, EdgeAccess::Read | EdgeAccess::ReadAndListen)),
                "listenable" => Js::Bool(matches!(e.access, EdgeAccess::ReadAndListen | EdgeAccess::ListenOnly)),
            })
        };
        obj! {
            "collections" => Js::Arr(self.collections.iter().map(edge).collect()),
            "records" => Js::Arr(self.records.iter().map(|r| Js::Obj(obj! {
                "name" => Js::str(&r.name),
                "description" => r.description.as_deref().map_or(Js::Null, Js::str),
                "fields" => Js::Arr(r.fields.iter().map(|(n, t)| Js::Obj(obj! { "name" => Js::str(n), "type" => Js::str(t) })).collect()),
                "pinned" => Js::strings(&r.pinned),
                "edges" => Js::Arr(r.edges.iter().map(edge).collect()),
            })).collect()),
            "writes" => Js::Arr(self.writes.iter().map(|w| Js::Obj(obj! {
                "along" => Js::str(&w.along),
                "target" => Js::str(&w.target),
                "fields" => Js::Arr(w.fields.iter().map(|(n, required)| Js::Obj(obj! { "name" => Js::str(n), "required" => Js::Bool(*required) })).collect()),
            })).collect()),
        }
    }
}

/// A field's type as a program spells it: `text`, `enum(open|paid)`, `list<text>`.
fn type_text(type_: &Js) -> String {
    match type_ {
        Js::Str(name) => name.clone(),
        Js::Obj(_) => match type_.get("kind").and_then(Js::as_str) {
            Some("enum") => {
                let options: Vec<&str> = type_.get("options").and_then(Js::as_array).unwrap_or_default().iter().filter_map(Js::as_str).collect();
                format!("enum({})", options.join("|"))
            }
            Some("list") => format!("list<{}>", type_.get("of").map_or_else(|| "?".to_string(), |of| type_text(of))),
            Some(other) => other.to_string(),
            None => "?".to_string(),
        },
        _ => "?".to_string(),
    }
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
        out.join("\n")
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

fn first_sentence(text: &str) -> String {
    text.split_once(". ").map_or(text, |(first, _)| first).trim_end_matches('.').to_string()
}

/// What an uninstalled `@lf/<folder>` would be called as an external.
fn external_name(reference: &str) -> String {
    reference.rsplit('/').next().unwrap_or(reference).chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect()
}

//! The catalog snapshot the checker reads (movement-engine's
//! `catalog_snapshot.ts` `buildCatalogSnapshot`): each adapter external's
//! manifest answer and schema, the credentials the secrets name, and the
//! project's files. Written in the TypeScript's key order (crate::json).

use std::rc::Rc;

use indexmap::IndexMap;

use crate::externals::{RunningExternal, plugin_entries};
use crate::json::{Js, Obj};
use crate::obj;
use crate::secrets::{Binding, Credential, Credentials};
use crate::sources::MovementFile;

/// `CATALOG_SNAPSHOT_VERSION`.
const CATALOG_SNAPSHOT_VERSION: u64 = 3;

/// `instanceSchemaKey({ credentialName })`: the credential's name, `''` for none.
fn instance_schema_key(credential_name: Option<&str>) -> String {
    credential_name.unwrap_or("").to_string()
}

/// Each connection's schema, by the key the catalog files it under
/// (`instanceSchemaKey`): `''` for the instance made with no credential.
pub type ConnectionSchemas = IndexMap<String, Described>;

/// One connection as its module described it, and as the catalog serves it:
/// with a refined position for each selection a hop's WHERE makes on it
/// (crate::refinements).
#[derive(Clone)]
pub struct Described {
    /// Its `listEntryPoints` answer.
    pub entries: Vec<Js>,
    /// Its schema as projected from its introspection.
    pub described: Js,
    /// The hop chains whose WHEREs `schema` is narrowed by.
    pub chains: Vec<crate::refinements::InstanceChain>,
    /// What the checker reads.
    pub schema: Js,
    /// What each of the module's position args may be set to, by arg; empty
    /// for a connection described in a position.
    pub position_options: std::collections::BTreeMap<String, Vec<String>>,
}

/// What one adapter external's instances are made with.
pub struct Connections<'c> {
    /// Its instances take a credential at all.
    pub credentialed: bool,
    /// An instance must name one.
    pub credential_required: bool,
    /// The credentials an instance may name and the module declares, in the
    /// secrets file's order.
    pub credentials: Vec<&'c Credential>,
}

/// The connections an adapter external can be made as: the credentials bound
/// to it, and the credential-free instance when it works without one. Each is
/// described, and typed, on its own: two connections of one module may serve
/// different schemas (two workspaces, two MCP servers).
pub fn connections_of<'c>(r: &RunningExternal, credentials: &'c Credentials) -> Connections<'c> {
    let name = &r.external.manifest.name;
    // The hosted product holds a remote install's secret itself, so there
    // it constructs credential-free; here the secrets file names it.
    let installed = credentials.iter().any(|c| c.external == *name && c.binding == Binding::Install);
    let remote_secret = r.external.manifest.auth.is_some() && !installed;
    let credentialed = !r.credential_declarations.is_empty() || remote_secret;
    // A module whose credentials are all optional works without one
    // (email receives with none; sending refuses by name when it is
    // called), so constructing it with no `using` is a whole instance.
    let credential_required = remote_secret || !r.credential_declarations.iter().all(optional_credential);
    // A credential bound to a declaration the module lacks is refused by name
    // at check (MOV_CREDENTIAL_*); it is not asked anything.
    let connects = |c: &Credential| match &c.binding {
        Binding::Install => false,
        Binding::Credential(declared) => r.credential_declarations.iter().any(|d| d.name == *declared),
        Binding::Legacy => true,
    };
    let credentials = match credentialed {
        true => credentials.iter().filter(|c| c.external == *name && connects(c)).collect(),
        false => Vec::new(),
    };
    Connections { credentialed, credential_required, credentials }
}

pub fn catalog_of(running: &[Rc<RunningExternal>], schemas: &IndexMap<String, ConnectionSchemas>, credentials: &Credentials, files: &[MovementFile]) -> Js {
    let mut credential_specs = Obj::new();
    for credential in credentials {
        // An install's secret signs calls; it is no account a `using` may name.
        let mut spec = obj! { "adapters" => Js::strings([&credential.external]) };
        match &credential.binding {
            Binding::Install => continue,
            Binding::Credential(declared) => {
                spec.insert("credential".into(), Js::str(declared));
            }
            Binding::Legacy => {}
        }
        credential_specs.insert(credential.name.clone(), Js::from(spec));
    }
    let mut adapters = Obj::new();
    let external_names: Vec<&str> = running.iter().filter(|r| !r.is_plugin()).map(|r| r.external.manifest.name.as_str()).collect();
    for unit in movement_parser::version::RUN_HOST_UNITS {
        if let Some(unit) = crate::units::unit_named(unit, external_names.iter().copied()) {
            adapters.insert(unit.to_string(), unit_snapshot(unit));
        }
    }
    for r in running.iter().filter(|r| !r.is_plugin()) {
        let name = &r.external.manifest.name;
        let connections = connections_of(r, credentials);
        // Each connection's own answer, in the key order a JavaScript object
        // holds them; a connection whose describe gave none is untyped, never
        // typed by another's.
        let mut adapter_schemas = Obj::new();
        // `constructionArgOptions`: by credential import name (`''` for
        // none), then arg. Only a connection in no position reads them, and
        // its key is that name.
        let mut construction_arg_options = Obj::new();
        if let Some(described) = schemas.get(name) {
            for (key, connection) in described {
                adapter_schemas.insert(key.clone(), connection.schema.clone());
                if !connection.position_options.is_empty() {
                    let by_arg: Obj = connection.position_options.iter().map(|(arg, options)| (arg.clone(), Js::strings(options))).collect();
                    construction_arg_options.insert(key.clone(), Js::from(by_arg));
                }
            }
        }
        movement_parser::util::js::object_key_order(&mut adapter_schemas);
        movement_parser::util::js::object_key_order(&mut construction_arg_options);
        let mut construction_args = if connections.credentialed {
            vec![Js::from(obj! { "name" => Js::str("credentials"), "kind" => Js::str("credential"), "required" => Js::Bool(connections.credential_required) })]
        } else {
            Vec::new()
        };
        for position in r.position_args() {
            let mut arg = obj! { "name" => Js::str(&position.name), "kind" => Js::str("position"), "required" => Js::Bool(false), "optionsFromType" => Js::str(&position.options_from) };
            if let Some(label) = &position.label {
                arg.insert("label".into(), Js::str(label));
            }
            construction_args.push(Js::from(arg));
        }
        let description = r.manifest_answer.get("description").and_then(Js::as_str).filter(|d| !d.is_empty()).map(str::to_string);
        let resend_window_seconds = crate::externals::resend_window_seconds(&r.manifest_answer);
        adapters.insert(
            name.clone(),
            adapter_snapshot_of(AdapterDeclarations {
                package: r.external.package(),
                supported_triggers: &r.supported_triggers,
                listen: &r.listen,
                construction_args,
                declared_credentials: &declared_names(&r.credential_declarations),
                description,
                resend_window_seconds,
                schemas: adapter_schemas,
                construction_arg_options,
            }),
        );
    }
    let files: Obj = files.iter().map(|f| (f.name.clone(), Js::from(obj! { "source" => Js::str(&f.source) }))).collect();
    Js::from(obj! {
        "contractVersion" => Js::Num(CATALOG_SNAPSHOT_VERSION.into()),
        "adapters" => Js::from(adapters),
        "credentials" => Js::from(credential_specs),
        "plugins" => Js::from(plugins_of(running)),
        "files" => Js::from(files),
    })
}

/// A unit's entry: credential-free, its schema projected from its own
/// introspection as an external's is.
fn unit_snapshot(unit: &str) -> Js {
    let schemas: Obj = [(instance_schema_key(None), unit_schema(unit))].into_iter().collect();
    adapter_snapshot_of(AdapterDeclarations {
        package: None,
        supported_triggers: &["webhook".to_string()],
        listen: &crate::units::listen_vocabulary(unit),
        construction_args: Vec::new(),
        declared_credentials: &[],
        description: None,
        resend_window_seconds: None,
        schemas,
        construction_arg_options: Obj::new(),
    })
}

/// A unit's schema, projected from its own introspection.
pub fn unit_schema(unit: &str) -> Js {
    let entries = crate::units::entry_points(unit);
    let descriptors: IndexMap<String, Js> =
        crate::units::descriptors(unit).into_iter().map(|d| (d.get("typeId").and_then(Js::as_str).unwrap_or_default().to_string(), d)).collect();
    crate::schema::describe_external_schema(unit, &crate::schema::Introspected { entries: &entries, reached: &crate::units::reached(unit), descriptors: &descriptors })
}

/// A static credential every field of which may be left out. An OAuth 2
/// credential is never optional: its tokens are the point of it.
pub fn optional_credential(declaration: &crate::oauth2::Declaration) -> bool {
    declaration.oauth2().is_none() && declaration.fields.iter().all(|f| f.optional == Some(true))
}

fn declared_names(declarations: &[crate::oauth2::Declaration]) -> Vec<String> {
    declarations.iter().map(|d| d.name.clone()).collect()
}

/// What one adapter's catalog entry is made of.
struct AdapterDeclarations<'a> {
    /// The package the module is installed from, which a `connect` names it by.
    package: Option<&'a str>,
    supported_triggers: &'a [String],
    listen: &'a Obj,
    construction_args: Vec<Js>,
    declared_credentials: &'a [String],
    /// Its manifest's `description`.
    description: Option<String>,
    /// Its manifest's `resendWindowSeconds`.
    resend_window_seconds: Option<u64>,
    schemas: Obj,
    construction_arg_options: Obj,
}

/// The adapter key a `connect` names as written: the adapter installed from
/// that package (compared whole), else the name itself (a project's own
/// module, or an import's original). The fallback is where a module that is
/// not a package is read, as `CatalogSnapshot::own_module_named` reads it.
pub fn adapter_named(catalog: &Js, written: &str) -> String {
    let installed_from = |(_, adapter): &(&String, &Js)| adapter.get("package").and_then(Js::as_str) == Some(written);
    match catalog.get("adapters") {
        Some(Js::Obj(adapters)) => adapters.iter().find(installed_from).map_or_else(|| written.to_string(), |(key, _)| key.clone()),
        _ => written.to_string(),
    }
}

/// `adapterSnapshotOf` for a remote adapter's manifest: no construction
/// blocks, no connect affordance, no trigger expectation, an introspected schema.
fn adapter_snapshot_of(adapter: AdapterDeclarations) -> Js {
    let mut snapshot = obj! { "constructionArgs" => Js::Arr(adapter.construction_args) };
    if let Some(package) = adapter.package {
        snapshot.insert("package".into(), Js::str(package));
    }
    if !adapter.declared_credentials.is_empty() {
        snapshot.insert("declaredCredentials".into(), Js::strings(adapter.declared_credentials));
    }
    if !adapter.supported_triggers.is_empty() {
        snapshot.insert("canFire".into(), Js::Bool(true));
    }
    if let Some(description) = adapter.description {
        snapshot.insert("description".into(), Js::str(description));
    }
    if let Some(seconds) = adapter.resend_window_seconds {
        snapshot.insert("resendWindowSeconds".into(), Js::Num(seconds.into()));
    }
    if let Some(become_) = adapter.listen.get("listenSettingsBecome") {
        snapshot.insert("listenSettingsBecome".into(), become_.clone());
    }
    snapshot.insert("schemaShape".into(), Js::str("introspected"));
    snapshot.insert("schemas".into(), Js::from(adapter.schemas));
    if !adapter.construction_arg_options.is_empty() {
        snapshot.insert("constructionArgOptions".into(), Js::from(adapter.construction_arg_options));
    }
    Js::from(snapshot)
}

// ── The catalog as text ──────────────────────────────────────────────────────

/// `listen-fire catalog` without `--json`: each connection the project holds
/// (a program connecting it or not), as a program reads, writes and listens to
/// it, in the notation `listen-fire modules show` prints a module in
/// (crate::modules::SchemaView), from the schema the catalog holds for it, so
/// its live types (an MCP server's tools, a CRM's fields) are there. Then the
/// plugins the files import, the units every program has, and the credentials
/// no installed module describes.
pub fn catalog_text(catalog: &Js) -> String {
    let adapters = match catalog.get("adapters") {
        Some(Js::Obj(adapters)) => adapters.clone(),
        _ => Obj::new(),
    };
    let credentials = match catalog.get("credentials") {
        Some(Js::Obj(credentials)) => credentials.clone(),
        _ => Obj::new(),
    };
    let mut out = vec![
        "each connection the project holds, as a program reads, writes and listens to it (listen-fire catalog --json: the whole snapshot)".to_string(),
        "a record type is named one hop off its connection: a parameter holding a Message of connection c is typed <c-[:Message]->>".to_string(),
    ];
    let is_unit = |name: &str| movement_parser::version::RUN_HOST_UNITS.contains(&name);
    for (name, adapter) in adapters.iter().filter(|(name, _)| !is_unit(name)) {
        let spelled = match adapter.get("package").and_then(Js::as_str) {
            Some(package) => format!("`{package}`"),
            None => format!("#{name}"),
        };
        let schemas = match adapter.get("schemas") {
            Some(Js::Obj(schemas)) if !schemas.is_empty() => schemas.clone(),
            _ => {
                out.push(String::new());
                out.push(format!("module {spelled}: no connection described"));
                continue;
            }
        };
        for (key, schema) in &schemas {
            out.push(String::new());
            let (header, using, positioned) = match key.as_str() {
                "" => (format!("connection {name} (no credential): {spelled}"), String::new(), false),
                credential if credentials.contains_key(credential) => (format!("connection {credential}: {spelled}"), format!(" using {credential}"), false),
                // A connection in a position (an Airtable base) is the program's own construction.
                positioned => (format!("connection {positioned}: {spelled}, in the position its program's connect names"), " using <credential> as the program's connect says".to_string(), true),
            };
            out.push(header);
            if let Some(description) = adapter.get("description").and_then(Js::as_str) {
                out.push(description.to_string());
            }
            let connect = format!("c = connect {spelled}{using}");
            out.push(format!("use: {connect}"));
            if !positioned {
                out.extend(position_lines(adapter, key, &connect));
            }
            crate::modules::SchemaView::of(schema).lines(&mut out);
        }
    }

    if let Some(Js::Obj(plugins)) = catalog.get("plugins")
        && !plugins.is_empty()
    {
        out.push(String::new());
        out.push("plugins (use: import { <name> } from plugins, then call it by position, settings last):".into());
        for (key, spec) in plugins {
            let name = spec.get("name").and_then(Js::as_str).unwrap_or(key);
            let description = spec.get("description").and_then(Js::as_str).map(|d| format!(": {d}")).unwrap_or_default();
            let priced = if Js::is_true(spec.get("priced")) { " (priced per call)" } else { "" };
            out.push(format!("  {}{priced}{description}", crate::modules::plugin_call(name, spec)));
        }
    }

    // Every program has them, and the handbook's chapter on each has the
    // listens written out, so here each is where it starts and what lands:
    // a listen on a schedule reads its tick's fields.
    let units: Vec<(&String, crate::modules::SchemaView)> =
        adapters.iter().filter(|(name, _)| is_unit(name)).filter_map(|(name, adapter)| Some((name, crate::modules::SchemaView::of(adapter.get("schemas")?.get("")?)))).collect();
    if !units.is_empty() {
        let chapters: Vec<String> = units.iter().map(|(name, _)| format!("system:{name}")).collect();
        out.push(String::new());
        out.push(format!("always connected (a program names each with no connect; a name with a space is written in backticks; see handbook: {}):", chapters.join(", ")));
        for (name, view) in &units {
            out.push(format!("  {name}: {}", view.starts().join(", ")));
            out.extend(view.record_summaries().into_iter().map(|record| format!("    {record}")));
        }
    }

    let unconnected: Vec<String> = credentials
        .iter()
        .filter(|(credential, spec)| {
            let adapter = spec.get("adapters").and_then(Js::as_array).and_then(|a| a.first()).and_then(Js::as_str).unwrap_or_default();
            !adapters.get(adapter).and_then(|a| a.get("schemas")).is_some_and(|s| s.get(credential).is_some())
        })
        .map(|(credential, spec)| {
            let modules: Vec<&str> = spec.get("adapters").and_then(Js::as_array).unwrap_or_default().iter().filter_map(Js::as_str).collect();
            format!("{credential} ({})", modules.join(", "))
        })
        .collect();
    if !unconnected.is_empty() {
        out.push(String::new());
        out.push(format!("credentials no installed module describes (its module is not installed here, or does not declare that credential): {}", unconnected.join(", ")));
    }
    out.join("\n")
}

/// How a connection with no position is connected in one (its module's
/// `positionArgs`: an Airtable base): the connect with its settings, the
/// values each may take as the connection's own describe listed them, and
/// what the connection is then. A program that never connects in a position
/// shows none of the record types the position holds, so the text says
/// where they come from rather than leave a reader to look for them under
/// the records it does show.
fn position_lines(adapter: &Js, key: &str, connect: &str) -> Vec<String> {
    let args: Vec<&Js> = adapter.get("constructionArgs").and_then(Js::as_array).unwrap_or_default().iter().filter(|arg| arg.get("kind").and_then(Js::as_str) == Some("position")).collect();
    let Some(first) = args.first() else { return Vec::new() };
    let text = |arg: &Js, k: &str| arg.get(k).and_then(Js::as_str).unwrap_or_default().to_string();
    let label = |arg: &Js| arg.get("label").and_then(Js::as_str).map(str::to_string).unwrap_or_else(|| text(arg, "optionsFromType"));
    let options = |arg: &Js| -> Vec<String> {
        let listed = adapter.get("constructionArgOptions").and_then(|o| o.get(key)).and_then(|o| o.get(&text(arg, "name"))).and_then(Js::as_array).unwrap_or_default();
        listed.iter().filter_map(Js::as_str).map(|o| Js::str(o).to_json()).collect()
    };
    let settings: Vec<String> = args.iter().map(|arg| format!("{}: {}", text(arg, "name"), options(arg).first().cloned().unwrap_or_else(|| "\"…\"".into()))).collect();
    let choices: Vec<String> = args.iter().filter(|arg| !options(arg).is_empty()).map(|arg| format!("{}: {}", text(arg, "name"), options(arg).join(" or "))).collect();
    let choices = if choices.is_empty() { String::new() } else { format!(" ({})", choices.join("; ")) };
    let at = label(first);
    vec![
        format!("or at one {at}: {connect} {{ {} }}{choices}", settings.join(", ")),
        format!("  connected at a {at}, the connection is that {at}: each thing the {at} holds by name is an edge off the connection, c-[:<its name>]->, its records read, written and listened to along that edge"),
        format!("  those edges, with their fields, are listed here once a program in the project connects at a {at} (run listen-fire catalog again then)"),
    ]
}

/// `pluginsOf`: each plugin external's package, keyed by module and name, each
/// spec tagged with the package it is imported from and the name a program
/// spells it.
fn plugins_of(running: &[Rc<RunningExternal>]) -> Obj {
    let mut plugins = Obj::new();
    for r in running {
        let Some(package) = r.plugins.as_ref().and_then(|d| d.get("package")).cloned() else { continue };
        for (name, spec) in plugin_entries(r.plugins.as_ref()) {
            let mut spec = match spec {
                Js::Obj(spec) => spec,
                _ => continue,
            };
            let program_name = name.replace('-', "_");
            spec.insert("package".into(), package.clone());
            spec.insert("name".into(), Js::Str(program_name.clone()));
            let tag = package.as_str().unwrap_or_default();
            plugins.insert(movement_parser::catalog::packages::plugin_key(tag, &program_name), Js::Obj(spec));
        }
    }
    plugins
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connect_s_package_name_is_compared_whole_against_each_adapter_s_package() {
        let catalog = Js::parse(br#"{"adapters":{"github":{"package":"@lf/github"},"google_drive":{"package":"@lf/google-drive"},"acme_crm":{}}}"#).unwrap();
        assert_eq!(adapter_named(&catalog, "@lf/github"), "github");
        assert_eq!(adapter_named(&catalog, "@lf/google-drive"), "google_drive", "the key is never derived from the package name");
        assert_eq!(adapter_named(&catalog, "acme_crm"), "acme_crm");
        assert_eq!(adapter_named(&catalog, "@lf/acme_crm"), "@lf/acme_crm", "no package answers, so nothing is cut");
    }

    #[test]
    fn a_modules_settings_mapping_reaches_the_checker_as_the_catalog_types_it() {
        let declared = r#"{"path":["Bases","Tables","Changes"],"aliases":["b","t","c"],"paramFrom":"Record Change","keys":{"table":{"hop":1,"field":"Id","op":"eq"}}}"#;
        let listen = match Js::parse(format!(r#"{{"listenSettingsBecome":{declared}}}"#).as_bytes()).unwrap() {
            Js::Obj(listen) => listen,
            _ => unreachable!(),
        };
        let snapshot = adapter_snapshot_of(AdapterDeclarations {
            package: None,
            supported_triggers: &[],
            listen: &listen,
            construction_args: Vec::new(),
            declared_credentials: &[],
            description: None,
            resend_window_seconds: None,
            schemas: Obj::new(),
            construction_arg_options: Obj::new(),
        });
        let catalog = format!(r#"{{"adapters":{{"at":{}}},"credentials":{{}},"plugins":{{}}}}"#, snapshot.to_json());
        let catalog = movement_parser::catalog::types::CatalogSnapshot::load(&catalog).unwrap();
        let become_ = catalog.adapter("at").and_then(|spec| spec.listen_settings_become.clone()).unwrap();
        assert_eq!(become_.path, ["Bases", "Tables", "Changes"]);
        assert_eq!(become_.keys["table"].hop, 1);
    }
}

#[cfg(test)]
mod text_tests {
    use super::*;

    #[test]
    fn the_text_is_each_connection_as_modules_show_spells_a_module_with_its_live_types_the_units_and_what_no_module_describes() {
        let catalog = Js::parse(
            br#"{"contractVersion":3,
            "adapters":{
              "manual":{"constructionArgs":[],"canFire":true,"schemaShape":"introspected","schemas":{"":{"positions":{"Invocation":{"properties":{"Text":"text"},"edges":{}}},"collections":{"Invocations":{"target":"Invocation","readable":false,"listenable":true}},"writableRoots":{}}}},
              "mcp":{"constructionArgs":[{"name":"credentials","kind":"credential","required":true}],"package":"@lf/mcp","description":"Any remote MCP server.","schemaShape":"introspected",
                "schemas":{"crm":{"positions":{"find_customer":{"properties":{"email":"text","plan":{"kind":"enum","options":["monthly","yearly"]}},"edges":{},"pinnedProperties":["email"],"description":"The customer with this email. More words."}},
                  "collections":{"find_customer":{"target":"find_customer"},"add_note":{"target":"add_note","readable":false}},
                  "writableRoots":{"add_note":{"fields":{"customer":"text","body":"text"},"requiredFields":["customer"],"resultShape":{}}}}}},
              "stripe":{"constructionArgs":[],"package":"@lf/stripe","listenSettingsBecome":{"path":["Invoices","Changes"]},"schemaShape":"introspected",
                "schemas":{"stripe_account":{"positions":{"Invoice":{"properties":{"Id":"text"},"edges":{"Changes":{"target":"InvoiceChange","readable":false,"listenable":true},"Customer":{"target":"Customer"}}}},"collections":{"Invoices":{"target":"Invoice"}},"writableRoots":{}}}},
              "acme_crm":{"constructionArgs":[],"schemaShape":"introspected","schemas":{"":{"positions":{"Company":{"properties":{"Name":"text"},"edges":{}}},"collections":{"Company":{"target":"Company","listenable":true}},"writableRoots":{}}}}},
            "credentials":{"crm":{"adapters":["mcp"],"credential":"mcp_token"},"stripe_account":{"adapters":["stripe"],"credential":"stripe"},"crm_two":{"adapters":["mcp"],"credential":"mcp_token"}},
            "plugins":{"@lf/pdf/render":{"package":"@lf/pdf","name":"render","args":["text","pageSize"],"requiredArgs":["text"],"description":"A PDF of the text."}},
            "files":{}}"#,
        )
        .unwrap();
        let text = catalog_text(&catalog);
        let expected = [
            "each connection the project holds, as a program reads, writes and listens to it (listen-fire catalog --json: the whole snapshot)",
            "a record type is named one hop off its connection: a parameter holding a Message of connection c is typed <c-[:Message]->>",
            "",
            "connection crm: `@lf/mcp`",
            "Any remote MCP server.",
            "use: c = connect `@lf/mcp` using crm",
            "",
            "reads: start a walk (or a listen, where marked) from the connection with",
            "  find_customer -> find_customer",
            "  add_note -> add_note (write only)",
            "",
            "record types (a name with a space is written in backticks; pinned: the fields a read's WHERE must set with ==):",
            "  find_customer: The customer with this email",
            "    fields: email text, plan enum(monthly|yearly)",
            "    pinned: email",
            "",
            "writes (a * is required):",
            "  a add_note along the connection's add_note: customer*, body",
            "",
            "connection stripe_account: `@lf/stripe`",
            "use: c = connect `@lf/stripe` using stripe_account",
            "",
            "reads: start a walk (or a listen, where marked) from the connection with",
            "  Invoices -> Invoice",
            "",
            "record types (a name with a space is written in backticks):",
            "  Invoice",
            "    fields: Id text",
            "    edges: Changes -> InvoiceChange (listen only), Customer -> Customer",
            "",
            "connection acme_crm (no credential): #acme_crm",
            "use: c = connect #acme_crm",
            "",
            "reads: start a walk (or a listen, where marked) from the connection with",
            "  Company -> Company (listenable)",
            "",
            "record types (a name with a space is written in backticks):",
            "  Company",
            "    fields: Name text",
            "",
            "plugins (use: import { <name> } from plugins, then call it by position, settings last):",
            "  render(text, pageSize?): A PDF of the text.",
            "",
            "always connected (a program names each with no connect; a name with a space is written in backticks; see handbook: system:manual):",
            "  manual: Invocations -> Invocation (listen only)",
            "    Invocation: Text text",
            "",
            "credentials no installed module describes (its module is not installed here, or does not declare that credential): crm_two (mcp)",
        ];
        assert_eq!(text, expected.join("\n"));
        assert!(!text.contains("listenSettingsBecome") && !text.contains("Bases"), "no retired 0.12 mapping in the text");
    }

    /// A second shape beside Airtable's: the setting's name, its label and
    /// the values the connection listed are the module's, never spelled here.
    #[test]
    fn a_connection_with_no_position_says_how_its_program_connects_in_one_and_what_it_then_is() {
        let catalog = Js::parse(
            br#"{"adapters":{"sheets":{"package":"@lf/sheets","schemaShape":"introspected",
              "constructionArgs":[{"name":"credentials","kind":"credential","required":true},{"name":"spreadsheet","kind":"position","required":false,"optionsFromType":"Spreadsheet","label":"Spreadsheet"}],
              "constructionArgOptions":{"team":{"spreadsheet":["Q3 \"plan\"","Hiring"]}},
              "schemas":{"team":{"positions":{"Spreadsheet":{"properties":{"Title":"text"},"edges":{}}},"collections":{"Spreadsheet":{"target":"Spreadsheet"}},"writableRoots":{}},
                "team::[[\"spreadsheet\",\"Hiring\"]]":{"positions":{"Candidates":{"properties":{"Name":"text"},"edges":{}}},"collections":{"Candidates":{"target":"Candidates"}},"writableRoots":{}}}}},
            "credentials":{"team":{"adapters":["sheets"],"credential":"google"}},"plugins":{},"files":{}}"#,
        )
        .unwrap();
        let text = catalog_text(&catalog);
        let lines: Vec<&str> = text.lines().collect();
        let use_ = lines.iter().position(|l| *l == "use: c = connect `@lf/sheets` using team").expect(&text);
        assert_eq!(
            lines[use_ + 1..use_ + 4],
            [
                r#"or at one Spreadsheet: c = connect `@lf/sheets` using team { spreadsheet: "Q3 \"plan\"" } (spreadsheet: "Q3 \"plan\"" or "Hiring")"#,
                "  connected at a Spreadsheet, the connection is that Spreadsheet: each thing the Spreadsheet holds by name is an edge off the connection, c-[:<its name>]->, its records read, written and listened to along that edge",
                "  those edges, with their fields, are listed here once a program in the project connects at a Spreadsheet (run listen-fire catalog again then)",
            ]
        );
        assert_eq!(text.matches("or at one Spreadsheet").count(), 1, "a connection already in a position says nothing of one: {text}");
    }
}

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
const CATALOG_SNAPSHOT_VERSION: u64 = 1;

/// `instanceSchemaKey({ credentialName })`: the credential's name, `''` for none.
fn instance_schema_key(credential_name: Option<&str>) -> String {
    credential_name.unwrap_or("").to_string()
}

/// Each connection's schema, by the key the catalog files it under
/// (`instanceSchemaKey`): `''` for the instance made with no credential.
pub type ConnectionSchemas = IndexMap<String, Described>;

/// One connection as its module described it, and as the catalog serves it:
/// with an event position grafted for each address the signatures name
/// against it (crate::listen_narrowing).
#[derive(Clone)]
pub struct Described {
    /// Its `listEntryPoints` answer.
    pub entries: Vec<Js>,
    /// Its schema as projected from its introspection.
    pub described: Js,
    /// The addresses `schema` is narrowed by.
    pub addresses: Vec<movement_checker::types::event_address::EventAddress>,
    /// What the checker reads.
    pub schema: Js,
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
        if let Some(described) = schemas.get(name) {
            for (key, connection) in described {
                adapter_schemas.insert(key.clone(), connection.schema.clone());
            }
        }
        movement_parser::util::js::object_key_order(&mut adapter_schemas);
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
        adapters.insert(
            name.clone(),
            adapter_snapshot_of(AdapterDeclarations {
                supported_triggers: &r.supported_triggers,
                listen: &r.listen,
                construction_args,
                declared_credentials: &declared_names(&r.credential_declarations),
                description,
                schemas: adapter_schemas,
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
    let entries = crate::units::entry_points(unit);
    let descriptors: IndexMap<String, Js> =
        crate::units::descriptors(unit).into_iter().map(|d| (d.get("typeId").and_then(Js::as_str).unwrap_or_default().to_string(), d)).collect();
    let schema = crate::schema::describe_external_schema(unit, &entries, &descriptors);
    let schemas: Obj = [(instance_schema_key(None), schema)].into_iter().collect();
    adapter_snapshot_of(AdapterDeclarations {
        supported_triggers: &["webhook".to_string()],
        listen: &crate::units::listen_vocabulary(unit),
        construction_args: Vec::new(),
        declared_credentials: &[],
        description: None,
        schemas,
    })
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
    supported_triggers: &'a [String],
    listen: &'a Obj,
    construction_args: Vec<Js>,
    declared_credentials: &'a [String],
    /// Its manifest's `description`.
    description: Option<String>,
    schemas: Obj,
}

/// `adapterSnapshotOf` for a remote adapter's manifest: no construction
/// blocks, no connect affordance, no trigger expectation, an introspected schema.
fn adapter_snapshot_of(adapter: AdapterDeclarations) -> Js {
    let mut snapshot = obj! { "constructionArgs" => Js::Arr(adapter.construction_args) };
    if !adapter.declared_credentials.is_empty() {
        snapshot.insert("declaredCredentials".into(), Js::strings(adapter.declared_credentials));
    }
    for (k, v) in trigger_config_vocabulary(adapter.supported_triggers, adapter.listen) {
        snapshot.insert(k, v);
    }
    if let Some(description) = adapter.description {
        snapshot.insert("description".into(), Js::str(description));
    }
    snapshot.insert("schemaShape".into(), Js::str("introspected"));
    snapshot.insert("schemas".into(), Js::from(adapter.schemas));
    Js::from(snapshot)
}

/// `triggerConfigVocabulary` for a manifest with no `triggerConfig` blocks.
fn trigger_config_vocabulary(supported_triggers: &[String], listen: &Obj) -> Obj {
    let mut keys: Vec<String> = Vec::new();
    let mut options = Obj::new();
    let mut required: Vec<String> = Vec::new();
    let mut formats = Obj::new();
    let subscribable = listen.get("subscribableEvents").and_then(Js::as_array).unwrap_or(&[]);
    if !subscribable.is_empty() {
        keys.push("events".into());
        options.insert("events".into(), Js::Arr(subscribable.to_vec()));
    }
    for entry in listen.get("listenConfig").and_then(Js::as_array).unwrap_or(&[]) {
        let Some(key) = entry.get("key").and_then(Js::as_str) else { continue };
        if !keys.iter().any(|k| k == key) {
            keys.push(key.into());
        }
        if Js::is_true(entry.get("required")) && !required.iter().any(|k| k == key) {
            required.push(key.into());
        }
        if let Some(format) = entry.get("format") {
            formats.insert(key.into(), format.clone());
        }
    }
    // Every polled source takes its listen's own interval (spelled `every`
    // in this release by the checker, over this key).
    if supported_triggers.iter().any(|t| t == "poll") && !keys.iter().any(|k| k == "pollIntervalSeconds") {
        keys.push("pollIntervalSeconds".into());
    }
    let mut out = Obj::new();
    if !supported_triggers.is_empty() {
        out.insert("canFire".into(), Js::Bool(true));
    }
    if !keys.is_empty() {
        out.insert("triggerConfig".into(), Js::strings(&keys));
    }
    if !options.is_empty() {
        out.insert("triggerConfigOptions".into(), Js::from(options));
    }
    if !required.is_empty() {
        out.insert("triggerConfigRequired".into(), Js::strings(&required));
    }
    if !formats.is_empty() {
        out.insert("triggerConfigFormats".into(), Js::from(formats));
    }
    let defaults = listen.get("defaultSubscribedEvents").and_then(Js::as_array).unwrap_or(&[]);
    if !defaults.is_empty() {
        out.insert("defaultEvents".into(), Js::Arr(defaults.to_vec()));
    }
    out
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

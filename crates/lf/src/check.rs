//! `listen-fire check`: every diagnostic the project's files have, by the Rust
//! checker natively (the same `check_source` the engine artifact's
//! `check_program` export runs), against the catalog the externals answer.
//! Its output: one line per diagnostic, then a count; exit 1 when any is an error.

use std::io::Write;
use std::rc::Rc;

use std::collections::BTreeMap;

use indexmap::IndexMap;
use movement_checker::host::native::NativeZones;
use movement_checker::types::event_address::EventAddress;
use movement_checker::{CheckOptions, Severity};
use movement_parser::ast::Program;
use movement_parser::catalog::helpers::position_key;
use movement_parser::catalog::snapshot::{Args, instance_schema_key};
use movement_parser::catalog::types::{ArgKind, CatalogSnapshot, ConstructionArg, JsMap};
use movement_parser::util::form::{external_text, form_of_text, read_json_text};
use serde_json::json;

use crate::catalog::{ConnectionSchemas, Described, catalog_of, connections_of};
use crate::listen_narrowing::{Narrowing, Walk, Walker, address_hops, narrow_event_positions, position_arg_options, with_event_narrowing_keys};
use crate::externals::{RunningExternal, needed_externals, rpc_in, scan_externals, start_externals};
use crate::json::Js;
use crate::project::Project;
use crate::refinements::{InstanceChain, Refining, refine_instance_schema};
use crate::protocol::shape_error;
use crate::schema::{Declarant, ambiguous_arrivals, describe_external_schema, retired_reference_key, undeclared_arrival_field, unreadable_answer_shape_from, unreadable_listening, unreadable_literals_from, unreadable_owned_field, unreadable_record_field, unreadable_settings_become};
use crate::secrets::{Construction, Credential, Credentials, Imported, MissingCredential, Secrets, imported_credentials, missing_credentials};
use crate::sources::{MovementFile, Parsed, scan_movements};

/// The one tenant a local project is (`LOCAL_TENANT`).
pub const LOCAL_TENANT: &str = "local";

/// A parse refusal, worded as `MovementParseError` words it.
pub struct ParseError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

/// The program, parsed as the TypeScript `parseProgram` parses it (eagerly,
/// over the engine's text form).
pub fn parse(source: &str) -> Result<Program, ParseError> {
    movement_parser::stmt::parse_program(&form_of_text(source), true).map_err(|e| ParseError {
        message: format!("{} (line {}, col {})", external_text(&e.message), e.loc.line, e.loc.col),
        line: e.loc.line,
        column: e.loc.col,
    })
}

pub struct FileDiagnostic {
    pub line: usize,
    pub column: usize,
    pub end_line: usize,
    pub end_column: usize,
    pub code: String,
    pub message: String,
    pub severity: &'static str,
    /// The exact rewrite that resolves it, when the checker offers one.
    pub fix: Option<Js>,
}

/// Every diagnostic one file has. A file that does not parse has one, its parse refusal.
pub fn check_file(file: &MovementFile, catalog: &CatalogSnapshot) -> Result<Vec<FileDiagnostic>, String> {
    check_parsed(file, &parse(&file.source), catalog)
}

/// `check_file`, the file already parsed (`parsed`, its text's parse).
pub fn check_parsed(file: &MovementFile, parsed: &Result<Program, ParseError>, catalog: &CatalogSnapshot) -> Result<Vec<FileDiagnostic>, String> {
    if let Err(refused) = parsed {
        return Ok(vec![FileDiagnostic {
            line: refused.line,
            column: refused.column,
            end_line: refused.line,
            end_column: refused.column,
            code: "MOV_PARSE".into(),
            message: refused.message.clone(),
            severity: "error",
            fix: None,
        }]);
    }
    let options = CheckOptions { upgrading_from: None, zones: &NativeZones };
    let diagnostics = movement_checker::check_source(&file.source, catalog, options)
        .map_err(|refusal| format!("the Rust checker refused {}: {}", file.path.display(), refusal.message))?;
    Ok(diagnostics
        .into_iter()
        .map(|d| FileDiagnostic {
            line: d.span.start.line,
            column: d.span.start.col,
            end_line: d.span.end.line,
            end_column: d.span.end.col,
            fix: d.fix.as_ref().and_then(|fix| Js::parse(fix.to_string().as_bytes()).ok()),
            message: external_text(&d.message).into_owned(),
            code: d.code,
            severity: match d.severity {
                None => "error",
                Some(Severity::Warning) => "warning",
                Some(Severity::Info) => "info",
            },
        })
        .collect())
}

/// What `check` reads: the project's files and the catalog they check against.
pub struct Checking {
    pub files: Vec<MovementFile>,
    pub catalog: Js,
    /// The externals the catalog was read from (their processes stay up
    /// until idle: crate::module_hosts).
    pub _running: Vec<Rc<RunningExternal>>,
    secrets: Secrets,
    /// Each external's connections as described, by its name: what
    /// `catalog_with` narrows further.
    schemas: IndexMap<String, ConnectionSchemas>,
}

pub enum Opened {
    Ready(Checking),
    /// Credentials the files name that the secrets lack, printed as the check's errors.
    MissingCredentials(Vec<MissingCredential>),
}

pub async fn open_checking(project: &Project) -> Result<Opened, String> {
    let env: Vec<(String, String)> = std::env::vars().collect();
    let secrets = Secrets::open(project, &env)?;
    let credentials = secrets.credentials();
    let files = scan_movements(project)?;
    let parsed = Parsed::each(&files, &[]);
    let missing = missing_credentials(&parsed, &secrets);
    if !missing.is_empty() {
        return Ok(Opened::MissingCredentials(missing));
    }
    // A check starts only what the files import: a third-party graph is
    // read live, so its module runs for the check.
    let externals = needed_externals(scan_externals(project)?, &parsed, |_| false);
    let running: Vec<Rc<RunningExternal>> = start_externals(project, &externals, credentials, LOCAL_TENANT).await?.into_iter().map(Rc::new).collect();
    let imported = imported_credentials(&parsed);
    let mut schemas = IndexMap::new();
    for r in running.iter().filter(|r| !r.is_plugin()) {
        schemas.insert(r.external.manifest.name.clone(), describe_external(r, credentials, &imported, ConnectionSchemas::new()).await?);
    }
    // Scanned again after the externals start: one may have written a movement file.
    let files = scan_movements(project)?;
    let catalog = catalog_of(&running, &schemas, credentials, &files);
    Ok(Opened::Ready(Checking { files, catalog, _running: running, secrets, schemas }))
}

/// The catalog the files check against, each connection narrowed by the
/// hops `walked` walk as well as by the files' own: what a text the files
/// will become (an upgrade's rewrite) needs to check as it will.
pub async fn catalog_with(checking: &mut Checking, walked: &[MovementFile]) -> Result<Js, String> {
    let sources: Vec<MovementFile> = checking.files.iter().chain(walked).cloned().collect();
    let imported = imported_credentials(&Parsed::each(&sources, &[]));
    let credentials = checking.secrets.credentials();
    for running in checking._running.iter().filter(|r| !r.is_plugin()) {
        let name = running.external.manifest.name.clone();
        let known = checking.schemas.shift_remove(&name).unwrap_or_else(ConnectionSchemas::new);
        let described = describe_external(running, credentials, &imported, known).await?;
        checking.schemas.insert(name, described);
    }
    Ok(catalog_of(&checking._running, &checking.schemas, credentials, &checking.files))
}

/// Each connection's schema (crate::catalog::connections_of) the files can
/// make, described as that connection, as the hosted product describes each:
/// the credential-free instance when the external works without one, and one
/// describe per credential bound to it that the files import (one bound but
/// never imported is never asked, so a server it names that is down fails no
/// check). `known` is kept: only a connection it lacks is described. Each is
/// narrowed by the event addresses the files' signatures name against it
/// (crate::listen_narrowing) and by the WHEREs the files' hops select with
/// (crate::refinements), again whenever those change.
pub async fn describe_external(running: &RunningExternal, credentials: &Credentials, imported: &Imported, known: ConnectionSchemas) -> Result<ConnectionSchemas, String> {
    let connections = connections_of(running, credentials);
    let mut wanted: Vec<Wanted> = Vec::new();
    if !connections.credential_required {
        wanted.push(Wanted { key: String::new(), credential: None, settings: None, position_values: BTreeMap::new() });
    }
    for credential in connections.credentials.iter().copied().filter(|c| imported.contains(&c.name)) {
        wanted.push(Wanted { key: credential.name.clone(), credential: Some(credential), settings: None, position_values: BTreeMap::new() });
    }
    // A connection that pins an entry position (`base: "CRM"`) is described in
    // that position, under a key of its own: its schema is that position's.
    for (construction, position) in positions_of(running, imported) {
        let credential = match &construction.credential {
            Some(name) => match connections.credentials.iter().find(|c| c.name == *name) {
                Some(credential) => Some(*credential),
                None => continue,
            },
            None if connections.credential_required => continue,
            None => None,
        };
        let key = instance_schema_key(construction.credential.as_deref(), Some(&position.key));
        let position_values = position.settings.as_object().into_iter().flatten().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect();
        wanted.push(Wanted { key, credential, settings: Some(position.settings), position_values });
    }
    let mut schemas = known;
    let adapter_type = running.manifest_answer.get("adapterType").and_then(Js::as_str).unwrap_or(&running.external.manifest.name);
    let position_args = running.position_args();
    for connection in wanted {
        let addresses = addresses_of(running, imported, &connection.key);
        let chains = chains_of(running, imported, &connection.key);
        let walk = ConnectionWalk { running, credentials, credential: connection.credential, settings: connection.settings.clone() };
        let failed = |why: String| {
            let external = &running.external.manifest.name;
            match connection.credential {
                Some(credential) => format!("couldn't read external \"{external}\"'s schema with credential \"{}\": {why}", credential.name),
                None => format!("couldn't read external \"{external}\"'s schema: {why}"),
            }
        };
        let (entries, described, position_options) = match schemas.get(&connection.key) {
            Some(held) if held.addresses == addresses && held.chains == chains => continue,
            Some(held) => (held.entries.clone(), held.described.clone(), held.position_options.clone()),
            None => {
                let (entries, described) = describe_as(running, credentials, connection.credential, connection.settings.clone()).await.map_err(failed)?;
                // What its position args may be set to, read where no position is set yet.
                let position_options = match connection.settings.is_none() && !position_args.is_empty() {
                    true => position_arg_options(&walk, adapter_type, &position_args).await.map_err(failed)?,
                    false => BTreeMap::new(),
                };
                (entries, described, position_options)
            }
        };
        let hops = address_hops(&running.listen, &connection.position_values);
        let narrowing = Narrowing { adapter: &running.external.manifest.name, adapter_type, hops: &hops, addresses: &addresses, entries: &entries, walk: &walk };
        let schema = narrow_event_positions(with_event_narrowing_keys(described.clone(), &hops), &narrowing).await.map_err(failed)?;
        let walker = Walker::new(&walk, adapter_type);
        let refining = Refining { adapter: &running.external.manifest.name, entries: &entries, walker: &walker };
        let schema = refine_instance_schema(schema, &chains.iter().collect::<Vec<_>>(), &refining).await.map_err(failed)?;
        schemas.insert(connection.key, Described { entries, described, addresses, chains, schema, position_options });
    }
    Ok(schemas)
}

/// One connection `describe_external` serves.
struct Wanted<'c> {
    key: String,
    credential: Option<&'c Credential>,
    /// What a call in its position carries.
    settings: Option<serde_json::Value>,
    /// Its position's values, by position arg.
    position_values: BTreeMap<String, String>,
}

/// The event addresses the files' signatures name against the connection
/// filed under `key`, in the files' order.
fn addresses_of(running: &RunningExternal, imported: &Imported, key: &str) -> Vec<EventAddress> {
    let of_connection = connection_filter(running, key);
    imported.event_addresses.iter().filter(|a| of_connection(&a.construction)).map(|a| a.address.clone()).collect()
}

/// The hop chains the files walk from the connection filed under `key`, in the files' order.
fn chains_of(running: &RunningExternal, imported: &Imported, key: &str) -> Vec<InstanceChain> {
    let of_connection = connection_filter(running, key);
    imported.chains.iter().filter(|c| of_connection(&c.construction)).cloned().collect()
}

/// Whether a construction makes the connection of this module filed under `key`.
fn connection_filter<'a>(running: &'a RunningExternal, key: &'a str) -> impl Fn(&Construction) -> bool + 'a {
    let manifest = &running.external.manifest;
    let construction_args = position_construction_args(running);
    move |construction: &Construction| {
        let args: Args = JsMap(construction.args.iter().cloned().collect());
        (manifest.name == construction.adapter || manifest.module.as_deref() == Some(construction.adapter.as_str()))
            && instance_schema_key(construction.credential.as_deref(), Some(&position_key(&construction_args, Some(&args)))) == key
    }
}

/// A walk of one connection: its module's `edgesFrom`, asked as that
/// connection, in its position.
pub(crate) struct ConnectionWalk<'a> {
    pub(crate) running: &'a RunningExternal,
    pub(crate) credentials: &'a Credentials,
    pub(crate) credential: Option<&'a Credential>,
    pub(crate) settings: Option<serde_json::Value>,
}

impl Walk for ConnectionWalk<'_> {
    async fn edges_from(&self, position: &Js, cursor: Option<&Js>) -> Result<Js, String> {
        if !self.running.methods.iter().any(|m| m == "edgesFrom") {
            return Ok(Js::Null);
        }
        let mut params = json!({ "position": crate::wire::json_of_js(position) });
        if let Some(cursor) = cursor {
            params["cursor"] = crate::wire::json_of_js(cursor);
        }
        rpc_in(self.running, self.credentials, self.credential, LOCAL_TENANT, "edgesFrom", params, self.settings.clone()).await
    }
}

/// The position a construction pins: the key its schema is stored under (the
/// checker's own `position_key`) and the `settings` a call in it carries.
struct Position {
    key: String,
    settings: serde_json::Value,
}

/// The module's position args, as the catalog's construction args.
fn position_construction_args(running: &RunningExternal) -> Vec<ConstructionArg> {
    running
        .position_args()
        .into_iter()
        .map(|d| ConstructionArg { name: d.name, kind: ArgKind::Position, required: false, options_from_type: Some(d.options_from), label: d.label })
        .collect()
}

/// The key a connection's schema is filed under (`instanceSchemaKey`): its
/// credential, and the position its construction `args` pin, if any.
pub(crate) fn connection_schema_key(running: &RunningExternal, credential: Option<&str>, args: &[(String, String)]) -> String {
    let args: Args = JsMap(args.iter().cloned().collect());
    instance_schema_key(credential, Some(&position_key(&position_construction_args(running), Some(&args))))
}

/// The constructions of this module that pin a position, each with its position.
fn positions_of<'a>(running: &RunningExternal, imported: &'a Imported) -> Vec<(&'a Construction, Position)> {
    let construction_args = position_construction_args(running);
    if construction_args.is_empty() {
        return Vec::new();
    }
    let manifest = &running.external.manifest;
    let mut positions = Vec::new();
    for construction in imported.constructions.iter().filter(|c| manifest.name == c.adapter || manifest.module.as_deref() == Some(c.adapter.as_str())) {
        let args: Args = JsMap(construction.args.iter().cloned().collect());
        let key = position_key(&construction_args, Some(&args));
        let Some(settings) = running.position_settings(&construction.args).filter(|_| !key.is_empty()) else { continue };
        positions.push((construction, Position { key, settings }));
    }
    positions
}

/// `describeExternal`: its entry points and one `describe` per entry point,
/// asked as one connection, projected as the hosted product projects them.
pub(crate) async fn describe_as(running: &RunningExternal, credentials: &Credentials, credential: Option<&Credential>, settings: Option<serde_json::Value>) -> Result<(Vec<Js>, Js), String> {
    let name = &running.external.manifest.name;
    let rpc = |method: &'static str, params: serde_json::Value| rpc_in(running, credentials, credential, LOCAL_TENANT, method, params, settings.clone());
    let entries = rpc("listEntryPoints", json!({})).await?;
    let entry_list = entries
        .as_array()
        .filter(|list| list.iter().all(is_entry_point))
        .ok_or_else(|| shape_error("listEntryPoints", name, &entries, "expected an array of { typeId, displayName, writable, readable }"))?
        .to_vec();
    let mut descriptors = IndexMap::new();
    for entry in &entry_list {
        let type_id = entry.get("typeId").and_then(Js::as_str).unwrap_or_default().to_string();
        let descriptor = rpc("describe", json!({ "typeId": type_id })).await?;
        match &descriptor {
            Js::Null => {}
            d if is_type_descriptor(d) => {
                descriptors.insert(type_id, descriptor);
            }
            _ => return Err(shape_error("describe", name, &descriptor, "expected null or { typeId, displayName, fields, references }")),
        }
    }
    for (type_id, descriptor) in &descriptors {
        if let Some(refusal) = descriptor.get("fields").and_then(Js::as_array).into_iter().flatten().find_map(|field| unreadable_owned_field(field).or_else(|| unreadable_record_field(field))) {
            return Err(format!("Remote adapter \"{name}\" describes '{type_id}': {refusal}"));
        }
        let mut references = descriptor.get("references").and_then(Js::as_array).into_iter().flatten();
        if let Some(refusal) = references.find_map(|r| {
            retired_reference_key(r)
                .or_else(|| undeclared_arrival_field(r, &descriptors))
                .or_else(|| unreadable_literals_from(r, &descriptors))
                .or_else(|| unreadable_answer_shape_from(r, descriptor, &descriptors))
                .or_else(|| unreadable_listening(Declarant::Reference { reference: r, owner: type_id }, &entry_list, &descriptors))
        }) {
            return Err(format!("Remote adapter \"{name}\" describes '{type_id}': {refusal}"));
        }
    }
    for entry in &entry_list {
        if let Some(refusal) = unreadable_listening(Declarant::Entry(entry), &entry_list, &descriptors) {
            let type_id = entry.get("typeId").and_then(Js::as_str).unwrap_or_default();
            return Err(format!("Remote adapter \"{name}\" lists '{type_id}': {refusal}"));
        }
    }
    if let Some(refusal) = ambiguous_arrivals(&entry_list, &descriptors) {
        return Err(format!("Remote adapter \"{name}\" declares {refusal}"));
    }
    if let Some(become_) = running.listen.get("listenSettingsBecome") {
        let become_ = crate::externals::settings_become(become_).map_err(|e| format!("Remote adapter \"{name}\" declares {e}"))?;
        if let Some(refusal) = unreadable_settings_become(&become_, &entry_list, &descriptors) {
            return Err(format!("Remote adapter \"{name}\" declares {refusal}"));
        }
    }
    let schema = describe_external_schema(name, &entry_list, &descriptors);
    Ok((entry_list, schema))
}

/// `WireSchemaEntryPoint`'s envelope (the rest passes through).
fn is_entry_point(entry: &Js) -> bool {
    let string = |k: &str| entry.get(k).and_then(Js::as_str).is_some();
    let boolean = |k: &str| matches!(entry.get(k), Some(Js::Bool(_)));
    string("typeId") && string("displayName") && boolean("writable") && boolean("readable")
}

/// `WireSchemaTypeDescriptor`'s envelope (the rest passes through).
fn is_type_descriptor(descriptor: &Js) -> bool {
    let string = |v: Option<&Js>| v.and_then(Js::as_str).is_some();
    let all_have_field_id = |k: &str| descriptor.get(k).and_then(Js::as_array).is_some_and(|items| items.iter().all(|i| string(i.get("fieldId"))));
    string(descriptor.get("typeId"))
        && string(descriptor.get("displayName"))
        && all_have_field_id("fields")
        && all_have_field_id("references")
        && descriptor.get("deletable").is_none_or(|d| matches!(d, Js::Bool(_)))
}

/// A diagnostic of the file at `path`, as `check` prints it.
pub fn diagnostic_line(path: &std::path::Path, d: &FileDiagnostic) -> String {
    format!("{}:{}:{} {} {} {}", path.display(), d.line, d.column, d.severity, d.code, d.message)
}

/// A missing credential, as `check` words it.
pub fn missing_line(m: &MissingCredential) -> String {
    format!("{}:{}:{} error MISSING_CREDENTIAL {}", m.file.display(), m.line, m.column, m.message)
}

/// The command: prints each diagnostic and the count, as `listen-fire check` does.
pub async fn run(project: &Project, json: bool, out: &mut impl Write) -> Result<i32, String> {
    let checking = match open_checking(project).await? {
        Opened::MissingCredentials(missing) => {
            if json {
                return crate::lfjson::emit(out, &crate::lfjson::check_doc(&[], &missing), 1);
            }
            for m in &missing {
                writeln!(out, "{}", missing_line(m)).map_err(|e| e.to_string())?;
            }
            writeln!(out, "{} error(s)", missing.len()).map_err(|e| e.to_string())?;
            return Ok(1);
        }
        Opened::Ready(checking) => checking,
    };
    let catalog = CatalogSnapshot::load(&read_json_text(&checking.catalog.to_json())).map_err(|e| format!("the catalog does not load: {e}"))?;
    let mut errors = 0;
    let mut checked = Vec::new();
    for file in &checking.files {
        let diagnostics = check_file(file, &catalog)?;
        errors += diagnostics.iter().filter(|d| d.severity == "error").count();
        if !json {
            for d in &diagnostics {
                writeln!(out, "{}", diagnostic_line(&file.path, d)).map_err(|e| e.to_string())?;
            }
        }
        checked.push((file.path.clone(), diagnostics));
    }
    let code = if errors > 0 { 1 } else { 0 };
    if json {
        return crate::lfjson::emit(out, &crate::lfjson::check_doc(&checked, &[]), code);
    }
    writeln!(out, "{} file(s), {errors} error(s)", checking.files.len()).map_err(|e| e.to_string())?;
    Ok(code)
}

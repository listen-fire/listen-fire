//! `lf check`: every diagnostic the project's files have, by the Rust
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
use crate::listen_narrowing::{Narrowing, Walk, address_hops, narrow_event_positions, with_event_narrowing_keys};
use crate::externals::{RunningExternal, needed_externals, rpc_in, scan_externals, start_externals};
use crate::json::Js;
use crate::project::Project;
use crate::protocol::shape_error;
use crate::schema::describe_external_schema;
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
    Ok(Opened::Ready(Checking { files, catalog, _running: running }))
}

/// Each connection's schema (crate::catalog::connections_of) the files can
/// make, described as that connection, as the hosted product describes each:
/// the credential-free instance when the external works without one, and one
/// describe per credential bound to it that the files import (one bound but
/// never imported is never asked, so a server it names that is down fails no
/// check). `known` is kept: only a connection it lacks is described. Each is
/// narrowed by the event addresses the files' signatures name against it
/// (crate::listen_narrowing), again whenever those change.
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
    for connection in wanted {
        let addresses = addresses_of(running, imported, &connection.key);
        let walk = ConnectionWalk { running, credentials, credential: connection.credential, settings: connection.settings.clone() };
        let (entries, described) = match schemas.get(&connection.key) {
            Some(held) if held.addresses == addresses => continue,
            Some(held) => (held.entries.clone(), held.described.clone()),
            None => describe_as(running, credentials, connection.credential, connection.settings.clone()).await?,
        };
        let hops = address_hops(&running.listen, &connection.position_values);
        let narrowing = Narrowing {
            adapter: &running.external.manifest.name,
            adapter_type: running.manifest_answer.get("adapterType").and_then(Js::as_str).unwrap_or(&running.external.manifest.name),
            hops: &hops,
            addresses: &addresses,
            entries: &entries,
            walk: &walk,
        };
        let schema = narrow_event_positions(with_event_narrowing_keys(described.clone(), &hops), &narrowing).await;
        schemas.insert(connection.key, Described { entries, described, addresses, schema });
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
    let manifest = &running.external.manifest;
    let construction_args = position_construction_args(running);
    imported
        .event_addresses
        .iter()
        .filter(|a| manifest.name == a.construction.adapter || manifest.module.as_deref() == Some(a.construction.adapter.as_str()))
        .filter(|a| {
            let args: Args = JsMap(a.construction.args.iter().cloned().collect());
            instance_schema_key(a.construction.credential.as_deref(), Some(&position_key(&construction_args, Some(&args)))) == key
        })
        .map(|a| a.address.clone())
        .collect()
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
async fn describe_as(running: &RunningExternal, credentials: &Credentials, credential: Option<&Credential>, settings: Option<serde_json::Value>) -> Result<(Vec<Js>, Js), String> {
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

/// A missing credential, as `check` words it.
pub fn missing_line(m: &MissingCredential) -> String {
    format!("{}:{}:{} error MISSING_CREDENTIAL {}", m.file.display(), m.line, m.column, m.message)
}

/// The command: prints each diagnostic and the count, as `lf check` does.
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
                writeln!(out, "{}:{}:{} {} {} {}", file.path.display(), d.line, d.column, d.severity, d.code, d.message).map_err(|e| e.to_string())?;
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

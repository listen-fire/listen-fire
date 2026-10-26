//! `lf check`: every diagnostic the project's files have, by the Rust
//! checker natively (the same `check_source` the engine artifact's
//! `check_program` export runs), against the catalog the externals answer.
//! Its output: one line per diagnostic, then a count; exit 1 when any is an error.

use std::io::Write;
use std::rc::Rc;

use indexmap::IndexMap;
use movement_checker::host::native::NativeZones;
use movement_checker::{CheckOptions, Severity};
use movement_parser::ast::Program;
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::{external_text, form_of_text, read_json_text};
use serde_json::json;

use crate::catalog::{ConnectionSchemas, catalog_of, connections_of};
use crate::externals::{RunningExternal, needed_externals, rpc_as, scan_externals, start_externals};
use crate::json::Js;
use crate::project::Project;
use crate::protocol::shape_error;
use crate::schema::describe_external_schema;
use crate::secrets::{Credential, Credentials, MissingCredential, Secrets, missing_credentials};
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
    let mut schemas = IndexMap::new();
    for r in running.iter().filter(|r| !r.is_plugin()) {
        schemas.insert(r.external.manifest.name.clone(), describe_external(r, credentials).await?);
    }
    // Scanned again after the externals start: one may have written a movement file.
    let files = scan_movements(project)?;
    let catalog = catalog_of(&running, &schemas, credentials, &files);
    Ok(Opened::Ready(Checking { files, catalog, _running: running }))
}

/// Every connection's schema (crate::catalog::connections_of), each described
/// as that connection, as the hosted product describes each: one describe per
/// credential bound to the external, so a check costs one per connection.
pub async fn describe_external(running: &RunningExternal, credentials: &Credentials) -> Result<ConnectionSchemas, String> {
    let connections = connections_of(running, credentials);
    let mut schemas = ConnectionSchemas::new();
    if !connections.credential_required {
        schemas.insert(String::new(), describe_as(running, credentials, None).await?);
    }
    for credential in connections.credentials {
        schemas.insert(credential.name.clone(), describe_as(running, credentials, Some(credential)).await?);
    }
    Ok(schemas)
}

/// `describeExternal`: its entry points and one `describe` per entry point,
/// asked as one connection, projected as the hosted product projects them.
async fn describe_as(running: &RunningExternal, credentials: &Credentials, credential: Option<&Credential>) -> Result<Js, String> {
    let name = &running.external.manifest.name;
    let rpc = |method: &'static str, params: serde_json::Value| rpc_as(running, credentials, credential, LOCAL_TENANT, method, params);
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
    Ok(describe_external_schema(name, &entry_list, &descriptors))
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

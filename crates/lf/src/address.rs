//! `listen-fire catalog <address>`: one connection, or one place in it. The
//! address is read and landed as the checker reads one
//! (movement_checker::address); here its program is narrowed by asking the
//! project's modules, as any program's is, and what it lands on printed.

use std::io::Write;
use std::path::PathBuf;

use movement_checker::address::Address;
use movement_checker::host::native::NativeZones;
use movement_checker::{Diagnostic, Severity};
use movement_parser::catalog::helpers::entry_position_key_of;
use movement_parser::catalog::snapshot::{Args, instance_schema_key};
use movement_parser::catalog::types::{CatalogSnapshot, JsMap};
use movement_parser::util::form::{external_text, read_json_text};

use crate::check::{Opened, open_checking_of};
use crate::project::Project;
use crate::schema_view::place_text;
use crate::secrets::{Named, construction_of};
use crate::sources::MovementFile;

fn say(out: &mut impl Write, line: &str) -> Result<(), String> {
    writeln!(out, "{line}").map_err(|e| e.to_string())
}

fn say_diagnostic(out: &mut impl Write, diagnostic: &Diagnostic) -> Result<(), String> {
    let severity = match diagnostic.severity {
        None => "error",
        Some(Severity::Warning) => "warning",
        Some(Severity::Info) => "info",
    };
    say(out, &format!("{severity} {} {}", diagnostic.code, external_text(&diagnostic.message)))
}

pub async fn run(project: &Project, address: &str, out: &mut impl Write) -> Result<i32, String> {
    let (read, program) = match Address::read(address) {
        Ok(read) => read,
        Err(refused) => {
            say_diagnostic(out, &refused)?;
            return Ok(1);
        }
    };
    let source = read.program();
    let file = MovementFile { name: "address".into(), path: PathBuf::from("address"), source, version: None };
    let checking = match open_checking_of(project, &file).await? {
        Opened::Ready(checking) => checking,
        Opened::MissingCredentials(missing) => {
            for credential in &missing {
                say(out, &format!("error MISSING_CREDENTIAL {}", credential.message))?;
            }
            return Ok(1);
        }
    };
    let catalog = CatalogSnapshot::load(&read_json_text(&checking.catalog.to_json())).map_err(|e| format!("the catalog does not load: {e}"))?;
    let landed = read.land(&program, &catalog, &NativeZones)?;
    for diagnostic in &landed.diagnostics {
        say_diagnostic(out, diagnostic)?;
    }
    if landed.diagnostics.iter().any(Diagnostic::is_error) {
        return Ok(1);
    }
    if read.walk.is_none() {
        let named = Named::of(&program);
        let construct = named.constructs.first().ok_or("the address's connect makes no connection")?;
        let construction = construction_of(construct, &named.originals);
        let adapter = catalog.adapter_connected(&construct.callee, construct.own).unwrap_or(&construct.callee);
        let args: Args = JsMap(construction.args.iter().cloned().collect());
        let position = catalog.adapter(adapter).map(|spec| entry_position_key_of(spec, Some(&args))).unwrap_or_default();
        let credential = construction.credential.as_deref();
        let keys = [instance_schema_key(credential, Some(&position)), instance_schema_key(credential, None)];
        return match crate::catalog::connection_text(&checking.catalog, adapter, &keys) {
            Some(text) => {
                say(out, &text)?;
                Ok(0)
            }
            None => {
                say(out, &format!("module {adapter}: no connection described"))?;
                Ok(1)
            }
        };
    }
    match &landed.landing {
        Some(landing) => {
            say(out, &external_text(&place_text(address, landing)))?;
            Ok(0)
        }
        None => {
            say(out, &format!("error {address} lands nowhere a description reaches"))?;
            Ok(1)
        }
    }
}


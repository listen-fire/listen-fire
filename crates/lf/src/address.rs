//! `listen-fire catalog <address>`: one connection, or one place in it. An
//! address is what a program writes, so it goes through what reads a program:
//! the part before the first hop becomes a `connect`, the rest the walk. Both
//! are narrowed, checked and typed as any program's are, and nothing here
//! knows what a hop is or what kinds there are.

use std::io::Write;
use std::path::PathBuf;

use movement_checker::host::native::NativeZones;
use movement_checker::query::{WalkQuery, analyze};
use movement_checker::slots::expression_of_text;
use movement_checker::{CheckOptions, Diagnostic, Severity};
use movement_parser::ast::Loc;
use movement_parser::catalog::helpers::entry_position_key_of;
use movement_parser::catalog::snapshot::{Args, instance_schema_key};
use movement_parser::catalog::types::{CatalogSnapshot, JsMap};
use movement_parser::catalog::written_type::WrittenType;
use movement_parser::util::form::{external_text, read_json_text};

use crate::check::{Opened, open_checking_of, parse};
use crate::project::Project;
use crate::schema_view::place_text;
use crate::secrets::{Named, construction_of};
use crate::sources::MovementFile;

/// The name the connection is bound to, in the walk a diagnostic quotes.
const CONNECTION: &str = "c";

/// An address, as a program writes it.
struct Written {
    /// `c = connect … using …`.
    connect: String,
    /// `c-[…]->`, where it goes on past the connection.
    walk: Option<String>,
}

impl Written {
    fn of(address: &str) -> Written {
        let (head, hops) = split_at_first_hop(address);
        let (module, after_module) = module_of(head.trim());
        let (credential, settings) = match after_module.strip_prefix(':') {
            Some(after) => name_of(after),
            None => ("", after_module),
        };
        let using = if credential.is_empty() { String::new() } else { format!(" using {credential}") };
        let settings = if settings.trim().is_empty() { String::new() } else { format!(" {}", settings.trim()) };
        Written { connect: format!("{CONNECTION} = connect {module}{using}{settings}"), walk: (!hops.is_empty()).then(|| format!("{CONNECTION}{hops}")) }
    }

    /// A bare walk is no statement, and narrowing reads hops out of statements.
    fn program(&self) -> String {
        match &self.walk {
            Some(walk) => format!("{}\nhere = {walk}\n", self.connect),
            None => format!("{}\n", self.connect),
        }
    }
}

/// Before the first `-[` not inside a position's string, and from it on.
fn split_at_first_hop(address: &str) -> (&str, &str) {
    let mut quote = None;
    let mut chars = address.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match (quote, c) {
            (Some(_), '\\') => {
                chars.next();
            }
            (Some(open), c) if c == open => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'' | '`') => quote = Some(c),
            (None, '-') if address[at..].starts_with("-[") => return address.split_at(at),
            (None, _) => {}
        }
    }
    (address, "")
}

/// A module as `connect` writes it, and what follows it: a package's name
/// taken whole, `#` and a name for a project's own.
fn module_of(head: &str) -> (String, &str) {
    let own = head.strip_prefix('#');
    let (name, rest) = name_of(own.unwrap_or(head));
    let spelled = if name.starts_with('`') { name.to_string() } else { WrittenType::name(name).spell() };
    (if own.is_some() { format!("#{spelled}") } else { spelled }, rest)
}

/// A name up to what ends it, a backticked one whole.
fn name_of(text: &str) -> (&str, &str) {
    if let Some(close) = text.strip_prefix('`').and_then(|rest| rest.find('`')) {
        return text.split_at(close + 2);
    }
    text.split_at(text.find(|c: char| c == ':' || c == '{' || c.is_whitespace()).unwrap_or(text.len()))
}

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
    let written = Written::of(address);
    if let Err(refused) = parse(&written.connect) {
        say(out, &format!("error MOV_PARSE the connection, written as a program's connect ({}): {}", written.connect, refused.message))?;
        return Ok(1);
    }
    if let Some(walk) = &written.walk
        && let Err(refused) = expression_of_text(walk)
    {
        say(out, &format!("error {} the walk {walk}: {}", refused.code.as_deref().unwrap_or("MOV_PARSE"), external_text(&refused.message)))?;
        return Ok(1);
    }
    // The query answers for any text, a field's read with the record it reads
    // off; an address asks for a place.
    if written.walk.as_deref().is_some_and(|walk| !walk.trim_end().ends_with("]->")) {
        say(out, &format!("error {address} goes on past its last hop: an address names a place, and ends on a hop"))?;
        return Ok(1);
    }
    let source = written.program();
    let program = match parse(&source) {
        Ok(program) => program,
        Err(refused) => {
            say(out, &format!("error MOV_PARSE {}: {}", source.trim(), refused.message))?;
            return Ok(1);
        }
    };
    let file = MovementFile { name: "address".into(), path: PathBuf::from("address"), source: source.clone(), version: None };
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
    let analysis = analyze(&program, &catalog, CheckOptions { upgrading_from: None, zones: &NativeZones });
    // The binding line is not a program anyone wrote: a read it refuses is
    // the query's to say or not. The connect line is the address's own.
    let connect_lines = written.connect.lines().count();
    let of_connect: Vec<&Diagnostic> = analysis.diagnostics.iter().filter(|d| d.span.start.line <= connect_lines).collect();
    if !of_connect.is_empty() {
        for diagnostic in of_connect {
            say_diagnostic(out, diagnostic)?;
        }
        return Ok(1);
    }
    let Some(walk) = &written.walk else {
        let named = Named::of(&program);
        let construct = named.constructs.first().ok_or("the address's connect makes no connection")?;
        let construction = construction_of(construct, &named.originals);
        let adapter = catalog.adapter_connected(&construct.callee, construct.own).unwrap_or(&construct.callee);
        let args: Args = JsMap(construction.args.iter().cloned().collect());
        let position = catalog.adapter(adapter).map(|spec| entry_position_key_of(spec, Some(&args))).unwrap_or_default();
        let credential = construction.credential.as_deref();
        let keys = [instance_schema_key(credential, Some(&position)), instance_schema_key(credential, None)];
        match crate::catalog::connection_text(&checking.catalog, adapter, &keys) {
            Some(text) => {
                say(out, &text)?;
                return Ok(0);
            }
            None => {
                say(out, &format!("module {adapter}: no connection described"))?;
                return Ok(1);
            }
        }
    };
    // Just past where the connect begins: it sees the connection, and no name further down.
    let at = Loc { line: 1, col: 2 };
    let typed = analysis.type_walk(WalkQuery { at, text: walk, describing: true, zones: &NativeZones }).map_err(|refused| refused.message)?;
    if !typed.diagnostics.is_empty() {
        for diagnostic in &typed.diagnostics {
            say_diagnostic(out, diagnostic)?;
        }
        return Ok(1);
    }
    match &typed.landing {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn expanded(address: &str) -> (String, Option<String>) {
        let written = Written::of(address);
        (written.connect, written.walk)
    }

    #[test]
    fn an_address_becomes_a_connect_and_a_walk() {
        let connect = |text: &str| text.to_string();
        for (address, expected, walk) in [
            ("@lf/slack:team_workspace", "c = connect `@lf/slack` using team_workspace", None),
            ("@lf/slack:team_workspace-[:Channels]->-[:Messages]->", "c = connect `@lf/slack` using team_workspace", Some("c-[:Channels]->-[:Messages]->")),
            ("#acme_crm-[:Company]->", "c = connect #acme_crm", Some("c-[:Company]->")),
            ("#acme_crm", "c = connect #acme_crm", None),
            (r#"@lf/airtable:acme { baseId: "x-[y" }-[:Tasks]->"#, r#"c = connect `@lf/airtable` using acme { baseId: "x-[y" }"#, Some("c-[:Tasks]->")),
            ("@lf/mcp:`Acme CRM`-[:`Linked Users` WHERE Name == 'a-[b']->", "c = connect `@lf/mcp` using `Acme CRM`", Some("c-[:`Linked Users` WHERE Name == 'a-[b']->")),
            ("@lf/nope { dryRun: true }", "c = connect `@lf/nope` { dryRun: true }", None),
        ] {
            assert_eq!(expanded(address), (connect(expected), walk.map(str::to_string)), "{address}");
            assert!(parse(&Written::of(address).program()).is_ok(), "{address}");
        }
    }
}

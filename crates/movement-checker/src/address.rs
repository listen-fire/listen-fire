//! An address: one connection, or one place in it, as a program writes it
//! (`'@lf/slack:team_workspace-[:Channels]->'`). It goes through what reads a
//! program: the part before the first hop becomes a `connect`, the rest the
//! walk. Both are checked and typed as any program's are, against whatever
//! catalog the host narrowed, and nothing here knows what a hop is or what
//! kinds there are. `listen-fire catalog '<address>'` and the engine's
//! describing query (movement_language::describe) both read one this way.

use movement_parser::ast::{Loc, Program, Span};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::catalog::written_type::WrittenType;
use movement_parser::util::form::form_of_text;

use crate::query::{WalkQuery, analyze};
use crate::slots::expression_of_text;
use crate::types::position::Position;
use crate::{CheckOptions, Diagnostic, host};

/// The name the connection is bound to, in the walk a diagnostic quotes.
pub const CONNECTION: &str = "c";

/// What every host reports a program that does not parse with.
const PARSE: &str = "MOV_PARSE";

/// An address, as a program writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Address {
    /// `c = connect … using …`.
    pub connect: String,
    /// `c-[…]->`, where it goes on past the connection.
    pub walk: Option<String>,
}

/// Where an address lands, and what its lines say.
pub struct Landed {
    /// The connect line's diagnostics, then the walk's. A refused read on the
    /// line binding the walk is not among them: that line is no program anyone
    /// wrote, and describing reads along any edge.
    pub diagnostics: Vec<Diagnostic>,
    /// The place; the connection itself for an address with no walk. None
    /// where a diagnostic is an error, or where nothing describes it.
    pub landing: Option<Position>,
}

impl Address {
    pub fn of(address: &str) -> Address {
        let (head, hops) = split_at_first_hop(address);
        let (module, after_module) = module_of(head.trim());
        let (credential, settings) = match after_module.strip_prefix(':') {
            Some(after) => name_of(after),
            None => ("", after_module),
        };
        let using = if credential.is_empty() { String::new() } else { format!(" using {credential}") };
        let settings = if settings.trim().is_empty() { String::new() } else { format!(" {}", settings.trim()) };
        Address { connect: format!("{CONNECTION} = connect {module}{using}{settings}"), walk: (!hops.is_empty()).then(|| format!("{CONNECTION}{hops}")) }
    }

    /// The address and the program it is, or the diagnostic that refuses it
    /// before any catalog is read: a connect or a walk that does not parse,
    /// or a walk that goes on past its last hop.
    pub fn read(address: &str) -> Result<(Address, Program), Diagnostic> {
        let read = Address::of(address);
        let at = Span { start: Loc { line: 1, col: 1 }, end: Loc { line: 1, col: 1 } };
        if let Err(refused) = parse(&read.connect) {
            return Err(Diagnostic::error(PARSE, format!("the connection, written as a program's connect ({}): {refused}", read.connect), at));
        }
        if let Some(walk) = &read.walk {
            if let Err(refused) = expression_of_text(walk) {
                return Err(Diagnostic::error(refused.code.as_deref().unwrap_or(PARSE), format!("the walk {walk}: {}", refused.message), at));
            }
            // The query answers for any text, a field's read with the record it
            // reads off; an address asks for a place.
            if !walk.trim_end().ends_with("]->") {
                return Err(Diagnostic::error(PARSE, format!("{address} goes on past its last hop: an address names a place, and ends on a hop"), at));
            }
        }
        let source = read.program();
        let program = parse(&source).map_err(|refused| Diagnostic::error(PARSE, format!("{}: {refused}", source.trim()), at))?;
        Ok((read, program))
    }

    /// A bare walk is no statement, and narrowing reads hops out of statements.
    pub fn program(&self) -> String {
        match &self.walk {
            Some(walk) => format!("{}\nhere = {walk}\n", self.connect),
            None => format!("{}\n", self.connect),
        }
    }

    /// Checks `program` (this address's) against `catalog`, and types the walk
    /// with the describing option. A host narrows the catalog first, as it
    /// would for any program.
    pub fn land(&self, program: &Program, catalog: &CatalogSnapshot, zones: &dyn host::ZoneLookup) -> Result<Landed, String> {
        let analysis = analyze(program, catalog, CheckOptions { upgrading_from: None, zones });
        let connect_lines = self.connect.lines().count();
        let mut diagnostics: Vec<Diagnostic> = analysis.diagnostics.iter().filter(|d| d.span.start.line <= connect_lines).cloned().collect();
        if diagnostics.iter().any(Diagnostic::is_error) {
            return Ok(Landed { diagnostics, landing: None });
        }
        // Just past where the connect begins: it sees the connection, and no name further down.
        let at = Loc { line: 1, col: 2 };
        let text = self.walk.as_deref().unwrap_or(CONNECTION);
        let typed = analysis.type_walk(WalkQuery { at, text, describing: true, zones }).map_err(|refused| refused.message)?;
        let refused = typed.diagnostics.iter().any(Diagnostic::is_error);
        diagnostics.extend(typed.diagnostics);
        Ok(Landed { diagnostics, landing: typed.landing.filter(|_| !refused) })
    }
}

/// As every host parses a program, the message with where it stopped.
fn parse(source: &str) -> Result<Program, String> {
    movement_parser::stmt::parse_program(&form_of_text(source), true).map_err(|e| format!("{} (line {}, col {})", e.message, e.loc.line, e.loc.col))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn expanded(address: &str) -> (String, Option<String>) {
        let read = Address::of(address);
        (read.connect, read.walk)
    }

    #[test]
    fn an_address_becomes_a_connect_and_a_walk() {
        for (address, expected, walk) in [
            ("@lf/slack:team_workspace", "c = connect `@lf/slack` using team_workspace", None),
            ("@lf/slack:team_workspace-[:Channels]->-[:Messages]->", "c = connect `@lf/slack` using team_workspace", Some("c-[:Channels]->-[:Messages]->")),
            ("#acme_crm-[:Company]->", "c = connect #acme_crm", Some("c-[:Company]->")),
            ("#acme_crm", "c = connect #acme_crm", None),
            (r#"@lf/airtable:acme { baseId: "x-[y" }-[:Tasks]->"#, r#"c = connect `@lf/airtable` using acme { baseId: "x-[y" }"#, Some("c-[:Tasks]->")),
            ("@lf/mcp:`Acme CRM`-[:`Linked Users` WHERE Name == 'a-[b']->", "c = connect `@lf/mcp` using `Acme CRM`", Some("c-[:`Linked Users` WHERE Name == 'a-[b']->")),
            ("@lf/nope { dryRun: true }", "c = connect `@lf/nope` { dryRun: true }", None),
        ] {
            assert_eq!(expanded(address), (expected.to_string(), walk.map(str::to_string)), "{address}");
            assert!(Address::read(address).is_ok(), "{address}");
        }
    }

    #[test]
    fn an_address_that_is_no_program_is_refused_by_a_diagnostic_before_any_catalog() {
        let refused = |address: &str| Address::read(address).err().map(|d| format!("{} {}", d.code, d.message)).unwrap_or_default();
        assert!(refused("#places-[:Channels").starts_with("MOV_PARSE the walk c-[:Channels: "), "{}", refused("#places-[:Channels"));
        assert!(refused("#places nonsense").starts_with("MOV_PARSE the connection, written as a program's connect (c = connect #places nonsense): "));
        assert!(refused("#places-[:Channels]->.Name").contains("goes on past its last hop"));
    }
}

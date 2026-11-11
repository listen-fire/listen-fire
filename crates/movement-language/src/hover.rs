//! Hover: the name under the cursor, what it is (in its adapter's or author's
//! own words first, where they wrote some, then what the structure says), and
//! its page in the versioned docs.
//!
//! The wording is hover's own: `describe_position` and `SymbolKind::describe`
//! word error messages, so they stay as they are and are used here only where
//! nothing plainer exists.

use movement_checker::description::{DescribedEdge, DescribedField, Description, Showing, describe_landing};
use movement_checker::query::Analysis;
use movement_checker::scope::{Symbol, SymbolKind};
use movement_checker::types::field::{Ty, is_maybe_absent, written_type};
use movement_checker::types::position::{Position, describe_position, display_name_of};
use movement_parser::ast::Loc;
use movement_parser::catalog::types::{AdapterSnapshot, InstanceSchema, PluginOutput, PluginSpec};
use movement_parser::catalog::written_type::WrittenType;

use crate::docs::{FIELD, WALK, builtin_page, page_of};
use crate::text::{Pos, Range, Text, in_comment, inside_backticks, is_word_char, loc_of, trailing_word, utf16_len, written_name};
use crate::{Service, builtins, docs_url, walk};

#[derive(Debug, Clone)]
pub struct Hover {
    /// Markdown.
    pub contents: String,
    pub range: Range,
}

/// The name under a position, and what is written just before it.
pub struct Word {
    pub name: String,
    pub range: Range,
    /// Read off a receiver: `x.name`, ``x.`name` ``.
    pub after_dot: bool,
    /// The document's text before the `.`, or before the hop's `-[`.
    pub receiver: String,
    /// The edge of a hop: `-[name`, `-[a:name`.
    pub in_hop: bool,
}

pub fn word_at(text: &Text<'_>, pos: Pos) -> Option<Word> {
    let line = text.line(pos.line);
    let before = text.line_before(pos);
    let after = text.line_after(pos);
    let (name, outer_start, end) = if inside_backticks(before) {
        let open = before.rfind('`')?;
        let close = after.find('`')?;
        (format!("{}{}", &before[open + 1..], &after[..close]), open, before.len() + close + 1)
    } else {
        let left = trailing_word(before);
        let right: &str = &after[..after.find(|c: char| !is_word_char(c)).unwrap_or(after.len())];
        if left.is_empty() && right.is_empty() {
            // On a backticked name's opening backtick.
            let rest = after.strip_prefix('`')?;
            let close = rest.find('`')?;
            (rest[..close].to_string(), before.len(), before.len() + close + 2)
        } else {
            (format!("{left}{right}"), before.len() - left.len(), before.len() + right.len())
        }
    };
    let prefix = &line[..outer_start];
    let above = text.before(Pos { line: pos.line, character: 0 });
    let after_dot = prefix.ends_with('.');
    let hop_head = prefix.strip_suffix(':').map(|p| p.strip_suffix(trailing_word(p)).unwrap_or(p)).unwrap_or(prefix);
    let in_hop = !after_dot && hop_head.ends_with("-[") && (prefix.ends_with(':') || prefix.ends_with("-["));
    let receiver = if after_dot {
        format!("{above}{}", &prefix[..prefix.len() - 1])
    } else if in_hop {
        format!("{above}{}", &hop_head[..hop_head.len() - 2])
    } else {
        String::new()
    };
    let start = Pos { line: pos.line, character: utf16_len(&line[..outer_start]) as u32 };
    let end = Pos { line: pos.line, character: utf16_len(&line[..end.min(line.len())]) as u32 };
    Some(Word { name, range: Range { start, end }, after_dot, receiver, in_hop })
}

/// An adapter, `name` as written, `key` the catalog's.
fn adapter_card(service: &Service, name: &str, key: &str) -> String {
    let adapter = service.catalog.adapters.get(key);
    let mut lines: Vec<String> = adapter.and_then(|a| a.spec.description.clone()).into_iter().collect();
    let credentialed = adapter.is_some_and(|a| a.spec.construction_args.iter().any(|arg| arg.kind == movement_parser::catalog::types::ArgKind::Credential));
    let using = if credentialed || adapter.is_none() { " using <credential>" } else { "" };
    lines.push(format!("An adapter. Use it with `connect {name}{using}`."));
    lines.extend(adapter.and_then(any_schema).and_then(holds_line));
    lines.extend(adapter.and_then(any_schema).and_then(listen_to_line));
    card(name, &lines, page_of(SymbolKind::Adapter))
}

/// A credential, `name` as written, `key` the catalog's.
fn credential_card(service: &Service, name: &str, key: &str) -> String {
    let adapters = service.catalog.credentials.get(key).map(|c| match c {
        movement_parser::catalog::types::SnapshotCredential::Adapters(spec) => spec.adapters.clone(),
        movement_parser::catalog::types::SnapshotCredential::Adapter(legacy) => vec![legacy.adapter.clone()],
    });
    let what = match adapters.as_deref() {
        Some([]) | None => "A sign-in".to_string(),
        Some(adapters) => format!("Sign-in for {}", adapters.join(" or ")),
    };
    let line = format!("{what}. listen-fire reads it from secrets.yaml or the environment when the movement runs; it never appears in the file.");
    card(name, &[line], page_of(SymbolKind::Credential))
}

/// A name in one of `connect`'s two positions, which name the catalog's
/// adapter and credential directly (no import binds them).
pub(crate) enum ConnectPosition {
    /// `own`: written `#name`, a module of the project's own.
    Adapter { own: bool },
    Credential,
}

/// Which of `connect`'s positions a word starts in, from the line before it.
pub(crate) fn connect_position(line_before: &str) -> Option<ConnectPosition> {
    let before = line_before.trim_end_matches('`');
    let own = before.ends_with('#');
    let words: Vec<&str> = before.trim_end_matches('#').split_whitespace().collect();
    match words.as_slice() {
        [.., "connect"] => Some(ConnectPosition::Adapter { own }),
        [.., "connect", _, "using"] => Some(ConnectPosition::Credential),
        _ => None,
    }
}


/// The word's card when it is a catalog adapter or credential in a `connect`.
fn connect_position_card(service: &Service, line_before: &str, name: &str) -> Option<String> {
    match connect_position(line_before)? {
        ConnectPosition::Adapter { own } => service.catalog.adapter_connected(name, own).map(|key| adapter_card(service, name, key)),
        ConnectPosition::Credential => service.catalog.credentials.get(name).map(|_| credential_card(service, name, name)),
    }
}

/// A header in a code block, a paragraph per line, and the docs link.
fn card(header: &str, lines: &[String], (page, anchor): (&str, &str)) -> String {
    let body: String = lines.iter().filter(|l| !l.is_empty()).map(|l| format!("{l}\n\n")).collect();
    format!("```movement\n{header}\n```\n{body}[Docs]({})", docs_url(page, anchor))
}

pub fn builtin_card(name: &str) -> Option<String> {
    let builtin = builtins::by_name(name)?;
    let (page, anchor) = builtin_page(builtin.name);
    Some(card(&builtin.signature(), &builtin.doc().into_iter().collect::<Vec<_>>(), (page, &anchor)))
}

/// Long lists stop here, then say how many more there are.
const LISTED: usize = 8;

/// `names`, then that `more` were left out.
fn listed(names: impl IntoIterator<Item = String>, more: usize) -> Option<String> {
    let shown = names.into_iter().collect::<Vec<_>>().join(", ");
    if shown.is_empty() {
        return None;
    }
    Some(match more {
        0 => shown,
        more => format!("{shown} and {more} more"),
    })
}

/// The first of `names` a list shows.
fn listed_first(names: impl IntoIterator<Item = String>) -> Option<String> {
    let names: Vec<String> = names.into_iter().collect();
    let more = names.len().saturating_sub(LISTED);
    listed(names.into_iter().take(LISTED), more)
}

/// What a hover shows of a landing: as many fields as a list does.
fn described(position: &Position) -> Description {
    describe_landing(position, Showing { fields: Some(LISTED), ..Showing::default() })
}

/// A field as the one notation writes it; one only a write gives says so,
/// as the catalog's place does.
fn field_words(field: &DescribedField) -> String {
    if field.write_only { format!("{} (write only)", field.written()) } else { field.written() }
}

/// "Fields: Text! text, `Sent At`~ date and 3 more".
fn fields_line(described: &Description) -> Option<String> {
    Some(format!("Fields: {}", listed(described.fields.shown.iter().map(field_words), described.fields.cut)?))
}

/// "Walk on: -[:Comments]-> Comment, -[:Reactions]-> Reaction [fires]".
fn walk_on_line(described: &Description) -> Option<String> {
    Some(format!("Walk on: {}", listed_first(described.edges.iter().map(DescribedEdge::hop))?))
}

fn record_lines(described: &Description) -> Vec<String> {
    [fields_line(described), walk_on_line(described)].into_iter().flatten().collect()
}

fn article(noun: &str) -> &'static str {
    if noun.starts_with(['A', 'E', 'I', 'O', 'U', 'a', 'e', 'i', 'o', 'u']) { "an" } else { "a" }
}

/// The record type and the connection a position is a record of: (`Company`, `crm`).
fn record_of(position: &Position) -> Option<(String, String)> {
    match strip(position) {
        Position::Position(p) => Some((display_name_of(&p.instance, &p.position), p.instance.name.clone())),
        Position::Handle(h) => Some((display_name_of(&h.instance, h.position.as_ref()?), h.instance.name.clone())),
        _ => None,
    }
}

/// A type as a hover header writes it: `Company (from crm)` for a record.
fn type_words(position: Option<&Position>, ty: Option<String>) -> Option<String> {
    if let Some((record, connection)) = position.and_then(record_of) {
        let maybe = if matches!(position, Some(Position::MaybeEmpty(_))) { ", which may be empty" } else { "" };
        return Some(format!("{record} (from {connection}{maybe})"));
    }
    ty
}

fn contains(outer: &movement_parser::ast::Span, at: Loc) -> bool {
    (outer.start.line, outer.start.col) <= (at.line, at.col) && (at.line, at.col) <= (outer.end.line, outer.end.col)
}

/// "Holds: Company, Comment": the record types an instance schema names.
fn holds_line(schema: &InstanceSchema) -> Option<String> {
    let names = schema.positions.iter().map(|(key, p)| written_name(p.display_name.as_deref().unwrap_or(key)));
    Some(format!("Holds: {}", listed_first(names)?))
}

/// "Listen to: Messages, Reactions": the edges a listen may end on, off the
/// connection or off any of its records (a channel's `Messages`), each named
/// once.
fn listen_to_line(schema: &InstanceSchema) -> Option<String> {
    let roots = schema.collections.iter().filter(|(_, c)| c.listenable == Some(true)).map(|(name, _)| name.as_str());
    let off_records = schema.positions.iter().flat_map(|(_, p)| p.edges.iter().filter(|(_, e)| e.listenable == Some(true)).map(|(name, _)| name.as_str()));
    let mut named: Vec<&str> = Vec::new();
    for name in roots.chain(off_records) {
        if !named.contains(&name) {
            named.push(name);
        }
    }
    Some(format!("Listen to: {}", listed_first(named.into_iter().map(written_name))?))
}

/// Any one schema an adapter's catalog entry holds (they share their record types).
fn any_schema(adapter: &AdapterSnapshot) -> Option<&InstanceSchema> {
    adapter.schemas.values().next()
}

/// A plugin's call as a signature: `reverse(text: text) → text`.
fn plugin_signature(written: &str, spec: &PluginSpec) -> String {
    let required = spec.required_args.clone().unwrap_or_default();
    let params: Vec<String> = spec
        .args
        .iter()
        .map(|arg| {
            let optional = if required.contains(arg) || spec.required_args.is_none() { "" } else { "?" };
            match spec.arg_types.as_ref().and_then(|t| t.get(arg)) {
                Some(ty) => format!("{arg}{optional}: {}", written_type(&Ty::from_schema(ty)).spell()),
                None => format!("{arg}{optional}"),
            }
        })
        .collect();
    let gives = match &spec.output {
        Some(PluginOutput::Value { type_ }) => format!(" → {}", written_type(&Ty::from_schema(type_)).spell()),
        Some(PluginOutput::Record { .. }) => " → a record".to_string(),
        Some(PluginOutput::Records { .. }) => " → records".to_string(),
        None => String::new(),
    };
    format!("{written}({}){gives}", params.join(", "))
}

fn plugin_card(written: &str, spec: &PluginSpec) -> String {
    let mut lines: Vec<String> = spec.description.iter().cloned().collect();
    if let Some(package) = &spec.package {
        lines.push(format!("From plugin package {package}."));
    }
    if spec.priced() {
        lines.push("May cost money.".into());
    }
    if spec.effects.as_ref().and_then(|e| e.ai) == Some(true) {
        lines.push("Calls an AI model.".into());
    }
    card(&plugin_signature(written, spec), &lines, page_of(SymbolKind::Plugin))
}

/// The catalog's plugin a symbol imports: by its key, or by the name it is spelled.
fn plugin_of<'s>(service: &'s Service, symbol: &Symbol) -> Option<&'s PluginSpec> {
    let imported = symbol.imported_name.as_deref().unwrap_or(&symbol.name);
    service.catalog.plugins.get(imported).or_else(|| service.catalog.plugins.values().find(|spec| spec.name.as_deref() == Some(imported)))
}

/// A package imported from plugins binds only its members (`inbox.pending`):
/// its own name's card lists them.
fn package_card(service: &Service, analysis: &Analysis, at: Loc, local: &str) -> Option<String> {
    let prefix = format!("{local}.");
    let members: Vec<(&Symbol, &PluginSpec)> = analysis
        .visible(at)
        .into_iter()
        .filter(|v| v.symbol.kind == SymbolKind::Plugin && v.symbol.name.starts_with(&prefix))
        .filter_map(|v| Some((v.symbol, plugin_of(service, v.symbol)?)))
        .collect();
    let package = members.iter().find_map(|(_, spec)| spec.package.clone())?;
    let mut lines = vec![format!("Plugin package {package}.")];
    lines.extend(members.iter().map(|(symbol, spec)| format!("`{}`", plugin_signature(&symbol.name[prefix.len()..], spec))));
    Some(card(local, &lines, page_of(SymbolKind::Plugin)))
}

/// `listen to manual`, for each listen in the file that fires `name`.
fn listens_firing(text: &Text<'_>, name: &str) -> Vec<String> {
    (0..text.line_count() as u32)
        .map(|n| text.line(n).trim())
        .filter(|line| line.starts_with("listen to "))
        .filter_map(|line| {
            let (head, fired) = line.rsplit_once(" fire ")?;
            (fired.trim() == name).then(|| head.trim().to_string())
        })
        .collect()
}

/// The function a parameter belongs to, and whether it is that function's own
/// (written in its first line) rather than an inline function's inside it.
fn parameter_of<'a>(analysis: &'a Analysis, symbol: &Symbol) -> Option<(&'a Symbol, bool)> {
    let at = symbol.span.start;
    let owner = analysis
        .visible(at)
        .into_iter()
        .filter(|v| v.symbol.kind == SymbolKind::Movement && !v.symbol.unit && contains(&v.symbol.span, at))
        .min_by_key(|v| (v.symbol.span.end.line - v.symbol.span.start.line, v.symbol.span.end.col))?
        .symbol;
    Some((owner, at.line == owner.span.start.line))
}

fn symbol_card(service: &Service, analysis: &Analysis, text: &Text<'_>, id: movement_checker::scope::SymbolId) -> String {
    let symbol = analysis.symbol(id);
    let position = analysis.position_of(id);
    let ty = analysis.type_text(id);
    let name = &symbol.name;
    let named_type = |ty: Option<String>| match ty {
        Some(ty) => format!("{name}: {ty}"),
        None => name.clone(),
    };
    let landing = position.map(described);
    let landing_lines = || landing.as_ref().map(record_lines).unwrap_or_default();
    let docs = page_of(symbol.kind);
    match symbol.kind {
        SymbolKind::Movement | SymbolKind::Shape | SymbolKind::Type if !symbol.unit => {
            let imported = analysis.imported(name);
            let header = match imported {
                Some(_) => ty.clone().unwrap_or_else(|| name.clone()),
                None => {
                    let declared = text.slice(&symbol.span);
                    let first = declared.lines().next().unwrap_or(name);
                    first.split('{').next().unwrap_or(first).trim().to_string()
                }
            };
            let mut lines = Vec::new();
            if let Some(imported) = imported {
                lines.push(format!("Imported from {}.", imported.file));
            } else if symbol.kind == SymbolKind::Movement {
                let listens = listens_firing(text, name);
                lines.push(match listens.as_slice() {
                    [] => "No listen fires it; it runs when it is called.".to_string(),
                    _ => format!("Runs when: {}.", listens.iter().map(|l| format!("`{l}`")).collect::<Vec<_>>().join(" or ")),
                });
            } else {
                lines.push(format!("Declared on line {}.", symbol.span.start.line));
                lines.extend(landing_lines());
            }
            card(&header, &lines, docs)
        }
        SymbolKind::Instance if symbol.unit => {
            let adapter = service.catalog.adapters.get(name);
            let mut lines = vec!["Built into listen-fire; no import needed.".to_string()];
            lines.extend(adapter.and_then(any_schema).and_then(listen_to_line));
            card(name, &lines, docs)
        }
        SymbolKind::Instance => {
            let instance = symbol.instance.as_deref();
            let adapter_name = instance.and_then(|i| i.adapter.clone()).or_else(|| symbol.adapter.clone());
            let adapter = adapter_name.as_deref().and_then(|a| service.catalog.adapters.get(a));
            let header = match &adapter_name {
                Some(adapter) => format!("{name} = connect {adapter}"),
                None => name.clone(),
            };
            let mut lines: Vec<String> = adapter.and_then(|a| a.spec.description.clone()).into_iter().collect();
            if let Some(adapter_name) = &adapter_name {
                lines.push(match instance.and_then(|i| i.credential.as_deref()) {
                    Some(credential) => format!("Your {adapter_name} account, signed in with the credential {credential}."),
                    None => format!("A connection to {adapter_name}."),
                });
            }
            let schema = instance.and_then(|i| i.schema.as_ref()).or_else(|| adapter.and_then(any_schema));
            lines.extend(schema.and_then(holds_line));
            lines.extend(schema.and_then(listen_to_line));
            card(&header, &lines, docs)
        }
        SymbolKind::Adapter => adapter_card(service, name, symbol.imported_name.as_deref().unwrap_or(name)),
        SymbolKind::Credential => credential_card(service, name, symbol.imported_name.as_deref().unwrap_or(name)),
        SymbolKind::Plugin => match plugin_of(service, symbol) {
            Some(spec) => plugin_card(name, spec),
            None => card(name, &["A plugin the catalog does not describe.".to_string()], docs),
        },
        SymbolKind::Param => {
            let mut lines: Vec<String> = landing.as_ref().and_then(|landing| landing.description.clone()).into_iter().collect();
            lines.push(match parameter_of(analysis, symbol) {
                Some((owner, true)) => format!("Parameter of {}.", owner.name),
                Some((owner, false)) => format!("Parameter of a function written inside {}.", owner.name),
                None => "A parameter.".to_string(),
            });
            lines.extend(landing_lines());
            card(&named_type(type_words(position, ty)), &lines, docs)
        }
        SymbolKind::Binding => {
            let may_be_empty = matches!(position, Some(Position::MaybeEmpty(_))) || is_maybe_absent(symbol.types.field.as_ref());
            let set = format!("Set on line {}.", symbol.span.start.line);
            let mut lines = vec![if may_be_empty { format!("{set} It may be empty, so check it before use.") } else { set }];
            lines.extend(landing_lines());
            card(&named_type(type_words(position, ty)), &lines, docs)
        }
        SymbolKind::Alias => {
            let declared = text.line(symbol.span.start.line.saturating_sub(1) as u32);
            let edge = declared.find(&format!("-[{name}:")).and_then(|at| walk::hop_edge(&declared[at + 2..]));
            let reached = match edge {
                Some(edge) => format!("Each {} record the walk on line {} reaches.", written_name(&edge), symbol.span.start.line),
                None => format!("Each record the walk on line {} reaches.", symbol.span.start.line),
            };
            let mut lines = vec![reached];
            lines.extend(landing_lines());
            card(&named_type(type_words(position, ty)), &lines, docs)
        }
        SymbolKind::FileImport => {
            let line = match analysis.imported(name) {
                Some(imported) => format!("Imported from {}.", imported.file),
                None => "Imported from another file.".to_string(),
            };
            card(&named_type(ty), &[line], docs)
        }
        // A file's own node or type that is also a host unit's name: the unit's words.
        SymbolKind::Movement | SymbolKind::Shape | SymbolKind::Type => card(&named_type(ty), &[format!("Declared on line {}.", symbol.span.start.line)], docs),
    }
}

pub fn hover(service: &Service, source: &str, pos: Pos) -> Option<Hover> {
    let text = Text::new(source);
    if in_comment(text.line_before(pos)) {
        return None;
    }
    let word = word_at(&text, pos)?;
    let at = loc_of(pos);
    let finish = |contents: String| Some(Hover { contents, range: word.range });
    if word.after_dot {
        let receiver_name = walk::trailing_name(word.receiver.trim_end()).unwrap_or_default();
        let analyzed = service.analyze(source, Some(pos.line));
        let resolves = analyzed.as_ref().is_some_and(|a| a.analysis.resolve(at, &receiver_name).is_some());
        if !resolves && builtins::namespaces().contains(&receiver_name.as_str()) {
            return finish(builtin_card(&format!("{receiver_name}.{}", word.name))?);
        }
        let analyzed = analyzed?;
        let analysis = &analyzed.analysis;
        if let Some(position) = walk::receiver(&analyzed, &word.receiver, at) {
            return finish(field_card(&position, &word.name, &receiver_name));
        }
        // A package's member, bound as `web.fetchUrl`.
        let id = analysis.resolve(at, &format!("{receiver_name}.{}", word.name))?;
        return finish(symbol_card(service, analysis, &text, id));
    }
    let line_before = text.line_before(word.range.start);
    if let Some(card) = connect_position_card(service, line_before, &word.name) {
        return finish(card);
    }
    let analyzed = service.analyze(source, Some(pos.line));
    if word.in_hop {
        let position = walk::receiver(analyzed.as_ref()?, &word.receiver, at)?;
        let receiver_name = walk::trailing_name(word.receiver.trim_end()).unwrap_or_default();
        return finish(edge_card(&position, &word.name, &receiver_name)?);
    }
    if let Some(analyzed) = &analyzed {
        let analysis = &analyzed.analysis;
        if let Some(id) = analysis.resolve(at, &word.name) {
            return finish(symbol_card(service, analysis, &text, id));
        }
        if let Some(package) = package_card(service, analysis, at, &word.name) {
            return finish(package);
        }
    }
    finish(builtin_card(&word.name)?)
}

/// `company.Name`: the field's type, the adapter's words for it, and the record it is read off.
fn field_card(position: &Position, field: &str, receiver_name: &str) -> String {
    let described = describe_landing(position, Showing::default());
    let found = described.fields.shown.iter().find(|f| f.name == field);
    // Named, then typed, as a hover's header writes any name; the marks are the one notation's.
    let header = match found {
        Some(found) => format!("{}: {}{}", found.marked_name(), found.type_, if found.write_only { " (write only)" } else { "" }),
        None => format!("{}: not a field it has", WrittenType::name(field).spell()),
    };
    let mut lines: Vec<String> = found.and_then(|f| f.description.clone()).into_iter().collect();
    lines.push(match record_of(position) {
        Some((record, connection)) => format!("On {} {record} record from {connection}.", article(&record)),
        None => format!("On {}.", describe_position(strip(position))),
    });
    if matches!(position, Position::MaybeEmpty(_)) && !receiver_name.is_empty() {
        lines.push(format!("Absent when `{receiver_name}` holds nothing."));
    }
    card(&header, &lines, FIELD)
}

/// `crm-[:Company]->`: where the edge lands, the adapter's words for it, and what is there.
fn edge_card(position: &Position, edge: &str, receiver_name: &str) -> Option<String> {
    let found = describe_landing(position, Showing { fields: Some(0), ..Showing::default() }).edges.into_iter().find(|e| e.name == edge)?;
    let hop = format!("{receiver_name}{}", found.hop());
    let Some(landing) = &found.landing else {
        return Some(card(&hop, &["Where it lands is not described, so what is read there is not checked.".to_string()], WALK));
    };
    let there = described(landing);
    let mut lines: Vec<String> = found.description.clone().or_else(|| there.description.clone()).into_iter().collect();
    let writable = if found.can.write { " You can write new ones here." } else { "" };
    lines.push(match record_of(landing) {
        Some((record, connection)) => format!("{record} records in {connection}.{writable}"),
        None => format!("Lands on {}.{writable}", describe_position(landing)),
    });
    lines.extend(record_lines(&there));
    Some(card(&hop, &lines, WALK))
}

/// The record itself, whether or not it may be missing.
fn strip(position: &Position) -> &Position {
    match position {
        Position::MaybeEmpty(of) => strip(of),
        other => other,
    }
}

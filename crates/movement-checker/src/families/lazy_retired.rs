//! `lazy` is retired in 0.14: a closure keeps a walk to run when it is read
//! (`people = () => crm-[:People]->`, read as `people()`). Each `lazy` is
//! refused where it is written, with the rewrite `listen-fire upgrade` takes
//! where the closure means what `lazy` meant.
//!
//! What `lazy` meant, and so what the rewrite keeps:
//! - `x = lazy W` kept the walk, and every read of `x` ran it again in the
//!   scope it was written in: read bare it was what `W` landed on then, read
//!   through (`x.F`, `x-[…]->`) it went on from there. `x = () => W` read as
//!   `x()` does the same at every call. Two reads differ: `y = x` kept the
//!   walk in `y` too, where `y = x()` keeps what it landed on then; and an
//!   argument `f(x)` handed the callee the kept walk as its record, where a
//!   function's parameter takes no list a call returns.
//! - `return lazy W` ran the walk where it was returned: `return W`.
//! - A node's entry `k: lazy W` walked again at each read of the edge `k`.
//!   No node entry does now; without `lazy`, `k: W` walks once, when the
//!   node is built.
//!
//! The program is read as its JSON tree, as a park's code places are: a read
//! is a name in an expression slot or at a walk's root, and anything else
//! naming the binding (a `delete`, a spread into a node) is one the rewrite
//! cannot vouch for, so it offers none.
//!
//! Code: MOV_LAZY_RETIRED.

use movement_parser::ast::{Loc, Span, Statement};
use movement_parser::util::utf16::Utf16;
use serde_json::{Value, json};

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::Diagnostic;
use crate::families::names::spell_name;

const RETIRED: &str = "`lazy` is retired in 0.14";

/// The reads of a lazy binding, found in the statements it is visible to.
#[derive(Default)]
struct Reads {
    /// Where a read ends: `()` goes there.
    calls: Vec<Loc>,
    /// The names it is bound to whole (`y = x`).
    aliases: Vec<String>,
    /// The functions it is passed to (`f(x)`).
    passed: Vec<String>,
    /// A naming the rewrite cannot account for.
    unaccounted: bool,
}

impl Checker<'_> {
    /// MOV_LAZY_RETIRED, once for each `lazy` the file writes.
    pub(crate) fn report_lazy_retired(&mut self, statements: &[Statement]) {
        let tree = serde_json::to_value(statements).expect("the program tree is always representable as JSON");
        let mut found = Vec::new();
        find_lazy(&tree, &mut found);
        for diagnostic in found {
            self.push(diagnostic);
        }
    }
}

fn find_lazy(value: &Value, found: &mut Vec<Diagnostic>) {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                if kind(item) == Some("assign") && kind(&item["value"]) == Some("lazy") {
                    found.extend(retired_binding(item, items, index));
                } else if kind(item) == Some("return") && kind(&item["value"]) == Some("lazy") {
                    found.extend(retired_return(item));
                }
                find_lazy(item, found);
            }
        }
        Value::Object(object) => {
            if kind(value) == Some("traversal") && object.get("lazy") == Some(&Value::Bool(true)) {
                found.extend(retired_entry(value));
            }
            object.values().for_each(|child| find_lazy(child, found));
        }
        _ => {}
    }
}

fn kind(value: &Value) -> Option<&str> {
    value.get("kind").and_then(Value::as_str)
}

fn span_of(value: &Value) -> Option<Span> {
    serde_json::from_value(value.get("span")?.clone()).ok()
}

fn edit(start: Loc, end: Loc, text: &str) -> Value {
    json!({ "span": Span { start, end }, "text": text })
}

fn insert(at: Loc, text: &str) -> Value {
    edit(at, at, text)
}

/// The kept walk as written, from its JSON (`crm-[c:Companies]->`).
fn head_text(head: &Value) -> String {
    let root = match head.get("root") {
        Some(root) if kind(root) == Some("name") => root["name"].as_str().map(spell_name).unwrap_or_default(),
        Some(root) => root["expr"]["raw"].as_str().unwrap_or_default().to_string(),
        None => String::new(),
    };
    format!("{root}{}", head["hopsRaw"].as_str().unwrap_or_default())
}

/// `W node { … }` as a closure's body: a block whose one statement returns
/// the walk's block, which returns each landing's node. `indent` is the
/// binding's own.
struct Mapped {
    open: String,
    between: String,
    close: String,
}

fn mapped(indent: usize, opens_closure: bool) -> Mapped {
    let pad = |n: usize| " ".repeat(n);
    let (inner, close) = if opens_closure { (indent + 2, format!("\n{}}}\n{}}}", pad(indent + 2), pad(indent))) } else { (indent, format!("\n{}}}", pad(indent))) };
    Mapped {
        open: if opens_closure { format!("() => {{\n{}return ", pad(inner)) } else { String::new() },
        between: format!(" {{\n{}return", pad(inner + 2)),
        close,
    }
}

// ── x = lazy W ──

fn retired_binding(statement: &Value, body: &[Value], index: usize) -> Option<Diagnostic> {
    let name = statement["name"].as_str()?;
    let lazy = &statement["value"]["lazy"];
    let lazy_span = span_of(lazy)?;
    let head = &lazy["head"];
    let head_span = span_of(head)?;
    let walk = head_text(head);
    let spelled = spell_name(name);
    let is_mapped = lazy.get("mapping").is_some();

    let mut reads = Reads::default();
    for (i, other) in body.iter().enumerate() {
        if i != index {
            reads_in(other, name, &mut reads);
        }
    }

    let closure = if is_mapped { format!("{spelled} = () => {{ return {walk} {{ return node {{ … }} }} }}") } else { format!("{spelled} = () => {walk}") };
    let mut message = format!("{RETIRED}: a closure keeps a walk to run where it is read. Write `{closure}` and read it as `{spelled}()`");
    let mut edits = Vec::new();
    if is_mapped {
        let indent = span_of(statement)?.start.col - 1;
        let parts = mapped(indent, true);
        edits.push(edit(lazy_span.start, head_span.start, &parts.open));
        edits.push(insert(head_span.end, &parts.between));
        edits.push(insert(lazy_span.end, &parts.close));
    } else {
        edits.push(edit(lazy_span.start, head_span.start, "() => "));
    }
    edits.extend(reads.calls.iter().map(|at| insert(*at, "()")));

    let fix = if reads.unaccounted {
        message.push_str(&format!(" (there is no rewrite: '{name}' is named somewhere a call can't stand, so rewrite it by hand)"));
        None
    } else if !reads.passed.is_empty() {
        let callees = quoted(&reads.passed);
        message.push_str(&format!(
            " (there is no rewrite: '{name}' is passed to {callees}, whose parameter held the kept walk as its record, and a parameter takes no list a call returns; walk inside {callees} instead)"
        ));
        None
    } else if !reads.aliases.is_empty() {
        let aliases = quoted(&reads.aliases);
        message.push_str(&format!(
            " (`listen-fire upgrade --all` rewrites it: {aliases} then holds what the walk landed on when it was bound, where '{name}' bound whole kept the walk, and each read walked again)"
        ));
        Some(json!({ "edits": edits }))
    } else {
        message.push_str("; `listen-fire upgrade` rewrites it");
        Some(json!({ "edits": edits, "safe": true }))
    };
    let mut diagnostic = Diagnostic::error(codes::LAZY_RETIRED, message, lazy_span);
    diagnostic.fix = fix;
    Some(diagnostic)
}

fn quoted(names: &[String]) -> String {
    let mut distinct: Vec<&String> = Vec::new();
    for name in names {
        if !distinct.contains(&name) {
            distinct.push(name);
        }
    }
    distinct.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(", ")
}

// ── return lazy W ──

fn retired_return(statement: &Value) -> Option<Diagnostic> {
    let lazy = &statement["value"]["lazy"];
    let lazy_span = span_of(lazy)?;
    let head = &lazy["head"];
    let head_span = span_of(head)?;
    let walk = head_text(head);
    let mut edits = vec![edit(lazy_span.start, head_span.start, "")];
    let written = if lazy.get("mapping").is_some() {
        let parts = mapped(span_of(statement)?.start.col - 1, false);
        edits.push(insert(head_span.end, &parts.between));
        edits.push(insert(lazy_span.end, &parts.close));
        format!("return {walk} {{ return node {{ … }} }}")
    } else {
        format!("return {walk}")
    };
    let message = format!("{RETIRED}, and a walk returned runs where it is returned, as `lazy` did there. Write `{written}`; `listen-fire upgrade` rewrites it");
    let mut diagnostic = Diagnostic::error(codes::LAZY_RETIRED, message, lazy_span);
    diagnostic.fix = Some(json!({ "edits": edits, "safe": true }));
    Some(diagnostic)
}

// ── node { k: lazy W } ──

fn retired_entry(entry: &Value) -> Option<Diagnostic> {
    let name = entry["name"].as_str()?;
    let span = span_of(entry)?;
    let head = &entry["head"];
    let head_span = span_of(head)?;
    let walk = head_text(head);
    let spelled = spell_name(name);
    let message = format!(
        "{RETIRED}, and no node entry walks again at each read. To walk at each read, bind a closure beside the node (`{spelled} = () => {walk}`) and read it as `{spelled}()`. Or drop `lazy` to keep what the walk lands on when the node is built (`{spelled}: {walk}`); `listen-fire upgrade --all` drops it (the walk then runs once, when the node is built, where `lazy` ran it at every read of '{name}': a record added or removed in between is seen differently)"
    );
    let mut diagnostic = Diagnostic::error(codes::LAZY_RETIRED, message, span);
    diagnostic.fix = Some(json!({ "edits": [edit(span.start, head_span.start, &format!("{spelled}: "))] }));
    Some(diagnostic)
}

// ── Finding the reads ──

/// Every read of `name` in `value`, a statement it is visible to.
fn reads_in(value: &Value, name: &str, reads: &mut Reads) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| reads_in(item, name, reads)),
        Value::Object(object) => {
            if let Some((raw, start)) = slot(value) {
                slot_reads(raw, start, name, reads);
                return;
            }
            if object.contains_key("hopsRaw") {
                head_reads(value, name, reads);
                return;
            }
            if let (Some(callee), Some(args)) = (object.get("callee").and_then(Value::as_str), object.get("args").and_then(Value::as_array)) {
                // Positional arguments are read in the call's own slot.
                if let Some((raw, start)) = object.get("expression").and_then(slot) {
                    slot_reads(raw, start, name, reads);
                    return;
                }
                for arg in args {
                    match arg.get("expr").and_then(slot) {
                        Some((raw, start)) if raw.trim() == name => {
                            if is_builtin(callee) {
                                reads.calls.push(after(start, raw.trim_end()));
                            } else {
                                reads.passed.push(callee.to_string());
                            }
                        }
                        _ => reads_in(arg, name, reads),
                    }
                }
                return;
            }
            if kind(value) == Some("assign") && kind(&value["value"]) == Some("expr") {
                if let Some((raw, start)) = slot(&value["value"]["expr"]) {
                    if raw.trim() == name {
                        reads.aliases.push(value["name"].as_str().unwrap_or_default().to_string());
                        reads.calls.push(after(start, raw.trim_end()));
                        return;
                    }
                }
            }
            for (key, child) in object {
                if key != "kind" && child.as_str() == Some(name) {
                    reads.unaccounted = true;
                }
                reads_in(child, name, reads);
            }
        }
        _ => {}
    }
}

/// An expression slot's text and where it starts.
fn slot(value: &Value) -> Option<(&str, Loc)> {
    let object = value.as_object()?;
    if object.keys().any(|k| !matches!(k.as_str(), "raw" | "span" | "__slot")) {
        return None;
    }
    Some((object.get("raw")?.as_str()?, span_of(value)?.start))
}

/// Where `text`, written from `start`, ends.
fn after(start: Loc, text: &str) -> Loc {
    locate(start, text, Utf16::new(text).len())
}

/// The location of UTF-16 offset `offset` in `text`, written from `start`.
fn locate(start: Loc, text: &str, offset: usize) -> Loc {
    let mut loc = start;
    for unit in text.encode_utf16().take(offset) {
        if unit == u16::from(b'\n') {
            loc = Loc { line: loc.line + 1, col: 1 };
        } else {
            loc.col += 1;
        }
    }
    loc
}

/// A walk's head: its root, and every name its hops read.
fn head_reads(head: &Value, name: &str, reads: &mut Reads) {
    let Some(span) = span_of(head) else {
        reads.unaccounted = true;
        return;
    };
    match head.get("root") {
        Some(root) if kind(root) == Some("name") && root["name"].as_str() == Some(name) => {
            reads.calls.push(Loc { line: span.start.line, col: span.start.col + Utf16::new(&spell_name(name)).len() });
        }
        Some(root) => {
            if let Some((raw, start)) = root.get("expr").and_then(slot) {
                slot_reads(raw, start, name, reads);
            }
        }
        None => {}
    }
    let hops = head["hopsRaw"].as_str().unwrap_or_default();
    if occurrences(hops, name) == 0 {
        return;
    }
    // A head is written on one line, and its hops end it.
    if hops.contains('\n') || span.start.line != span.end.line {
        reads.unaccounted = true;
        return;
    }
    let start = Loc { line: span.end.line, col: span.end.col - Utf16::new(hops).len() };
    slot_reads(hops, start, name, reads);
}

/// The reads of `name` in an expression's text, written from `start`. A
/// text that does not parse, or a closure's block body in it (which the
/// expression tree holds only as its extent) naming `name`, is one the
/// rewrite cannot account for.
fn slot_reads(raw: &str, start: Loc, name: &str, reads: &mut Reads) {
    if occurrences(raw, name) == 0 {
        return;
    }
    let Ok(tree) = movement_parser::expr::parse_expression_raw(raw) else {
        reads.unaccounted = true;
        return;
    };
    let tree = serde_json::to_value(&tree).expect("an expression tree is always representable as JSON");
    let text = Utf16::new(raw);
    let mut blocks = Vec::new();
    block_bodies(&tree, &mut blocks);
    for (from, to) in blocks {
        // The body inside its braces, read as the statements it is.
        let inner = text.text(from + 1, to.saturating_sub(1).max(from + 1));
        if occurrences(&inner, name) > 0 {
            block_reads(&inner, locate(start, raw, from + 1), name, reads);
        }
    }
    let mut found = Vec::new();
    names_read(&tree, None, name, &mut found);
    for read in found {
        match read {
            Read::Value(end) => reads.calls.push(locate(start, raw, end)),
            Read::Passed(callee) => reads.passed.push(callee),
        }
    }
}

enum Read {
    /// Read where a call's answer reads the same: ends at this offset.
    Value(usize),
    /// Handed to a function that is not the library's.
    Passed(String),
}

/// The names `name` read in an expression tree; `call` is the callee when
/// `value` is one of a call's arguments.
fn names_read(value: &Value, call: Option<&str>, name: &str, found: &mut Vec<Read>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| names_read(item, call, name, found)),
        Value::Object(object) => {
            if kind(value) == Some("name") && value.get("field").is_none() && value["name"]["text"].as_str() == Some(name) {
                let Some(end) = value["at"]["end"].as_u64() else { return };
                found.push(match call {
                    Some(callee) if !is_builtin(callee) => Read::Passed(callee.to_string()),
                    _ => Read::Value(end as usize),
                });
                return;
            }
            if kind(value) == Some("call") {
                let callee = callee_name(&value["callee"]);
                names_read(&value["callee"], None, name, found);
                for arg in value["args"].as_array().into_iter().flatten() {
                    // The argument itself, not what it is built from.
                    match &arg["value"] {
                        bare if kind(bare) == Some("name") => names_read(bare, Some(callee.as_deref().unwrap_or("a function")), name, found),
                        other => names_read(other, None, name, found),
                    }
                }
                return;
            }
            object.values().for_each(|child| names_read(child, None, name, found));
        }
        _ => {}
    }
}

/// The reads in a closure's block body written inside an expression, which
/// the expression tree holds only as its extent: its statements parsed, and
/// each place found in them moved to where the body starts.
fn block_reads(body: &str, origin: Loc, name: &str, reads: &mut Reads) {
    let Ok(program) = movement_parser::stmt::parse_program(body, false) else {
        reads.unaccounted = true;
        return;
    };
    let tree = serde_json::to_value(&program.statements).expect("the program tree is always representable as JSON");
    let mut inner = Reads::default();
    reads_in(&tree, name, &mut inner);
    let moved = |at: Loc| if at.line == 1 { Loc { line: origin.line, col: origin.col + at.col - 1 } } else { Loc { line: origin.line + at.line - 1, col: at.col } };
    reads.calls.extend(inner.calls.into_iter().map(moved));
    reads.aliases.extend(inner.aliases);
    reads.passed.extend(inner.passed);
    reads.unaccounted |= inner.unaccounted;
}

/// The extents of the closure block bodies an expression tree holds unread.
fn block_bodies(value: &Value, found: &mut Vec<(usize, usize)>) {
    match value {
        Value::Array(items) => items.iter().for_each(|item| block_bodies(item, found)),
        Value::Object(object) => {
            if kind(value) == Some("closure") && kind(&value["body"]) == Some("block") {
                if let (Some(from), Some(to)) = (value["body"]["at"]["start"].as_u64(), value["body"]["at"]["end"].as_u64()) {
                    found.push((from as usize, to as usize));
                }
            }
            object.values().for_each(|child| block_bodies(child, found));
        }
        _ => {}
    }
}

/// `count`, `List.from`, `pdf.render`: a callee spelled as its dotted name.
fn callee_name(callee: &Value) -> Option<String> {
    match kind(callee)? {
        "name" => Some(callee["name"]["text"].as_str()?.to_string()),
        "member" => Some(format!("{}.{}", callee_name(&callee["object"])?, callee["property"]["text"].as_str()?)),
        _ => None,
    }
}

/// A call of the standard library, by its current spelling or its canonical one.
fn is_builtin(callee: &str) -> bool {
    let canonical = movement_parser::surface::table::by_current(callee).map_or(callee, |row| row.canonical);
    crate::types::stdlib::builtin_under(canonical).is_some()
}

/// How many times `name` is written as a word in `text`.
fn occurrences(text: &str, name: &str) -> usize {
    let is_word = |c: char| c.is_alphanumeric() || c == '_';
    text.match_indices(name)
        .filter(|(at, _)| {
            let before = text[..*at].chars().next_back();
            let after = text[at + name.len()..].chars().next();
            !before.is_some_and(is_word) && !after.is_some_and(is_word)
        })
        .count()
}

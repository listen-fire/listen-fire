//! `lazy` is retired in 0.14: a closure keeps a walk to run when it is read
//! (`people = () => crm-[:People]->`, read as `people()`). Each `lazy` is
//! refused where it is written, and replaced by hand: `listen-fire upgrade`
//! offers no rewrite, because where a closure's call reads differently from
//! the kept walk (a name bound to it whole, an argument, a node's entry) only
//! the author knows which meaning was wanted.
//!
//! The program is read as its JSON tree, so a `lazy` is found wherever it is
//! written.
//!
//! Code: MOV_LAZY_RETIRED.

use movement_parser::ast::{Span, Statement};
use serde_json::Value;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::Diagnostic;
use crate::families::names::spell_name;

const RETIRED: &str = "`lazy` is retired in 0.14; replace it by hand";
const NOT_REWRITTEN: &str = "`listen-fire upgrade` does not rewrite it";

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
            for item in items {
                if kind(item) == Some("assign") && kind(&item["value"]) == Some("lazy") {
                    found.extend(retired_binding(item));
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

/// The kept walk as written, from its JSON (`crm-[c:Companies]->`).
fn head_text(head: &Value) -> String {
    let root = match head.get("root") {
        Some(root) if kind(root) == Some("name") => root["name"].as_str().map(spell_name).unwrap_or_default(),
        Some(root) => root["expr"]["raw"].as_str().unwrap_or_default().to_string(),
        None => String::new(),
    };
    format!("{root}{}", head["hopsRaw"].as_str().unwrap_or_default())
}

/// `W`, or `W { return node { … } }` for a mapped walk (`lazy W node { … }`).
fn walk_text(lazy: &Value) -> String {
    let walk = head_text(&lazy["head"]);
    if lazy.get("mapping").is_some() { format!("{walk} {{ return node {{ … }} }}") } else { walk }
}

/// `x = lazy W`: a closure, `x = () => W`, read as `x()`.
fn retired_binding(statement: &Value) -> Option<Diagnostic> {
    let spelled = spell_name(statement["name"].as_str()?);
    let lazy = &statement["value"]["lazy"];
    let walk = walk_text(lazy);
    let closure = if lazy.get("mapping").is_some() { format!("{spelled} = () => {{ return {walk} }}") } else { format!("{spelled} = () => {walk}") };
    let message = format!("{RETIRED} with a closure, `{closure}`, read as `{spelled}()` where it walked again at each read ({NOT_REWRITTEN})");
    Some(Diagnostic::error(codes::LAZY_RETIRED, message, span_of(lazy)?))
}

/// `return lazy W`: the walk ran where it was returned, as `return W` does.
fn retired_return(statement: &Value) -> Option<Diagnostic> {
    let lazy = &statement["value"]["lazy"];
    let message = format!("{RETIRED}: `return {}` runs the walk where it is returned, as `return lazy` did ({NOT_REWRITTEN})", walk_text(lazy));
    Some(Diagnostic::error(codes::LAZY_RETIRED, message, span_of(lazy)?))
}

/// `node { k: lazy W }`: no node entry walks again at each read.
fn retired_entry(entry: &Value) -> Option<Diagnostic> {
    let spelled = spell_name(entry["name"].as_str()?);
    let walk = head_text(&entry["head"]);
    let message = format!(
        "{RETIRED} with a closure bound beside the node, `{spelled} = () => {walk}`, read as `{spelled}()`: no node entry walks again at each read. Or drop `lazy` (`{spelled}: {walk}`) to keep what the walk lands on when the node is built ({NOT_REWRITTEN})"
    );
    Some(Diagnostic::error(codes::LAZY_RETIRED, message, span_of(entry)?))
}

//! Whether what landed fits the node a listen states it is
//! (`-[:Requests]-><Payment>`, or the settings form's `payload: <Payment>`):
//! one check, which listen-fire's host calls natively and the TypeScript
//! host through the wasm (`abi.rs` `landing_misfits`), held by both to the
//! cases in packages/engine-contracts/conformance/listen-landings.json.
//!
//! It sits beside the listen judge (crate::listen_judge) because it is the
//! same stage: a check of one arrival's record at the moment it lands, not a
//! static check of the program. The checker has typed the movement against
//! the same node, so a landing that fits is what the movement reads; one that
//! does not runs nothing. It reads only the program's node, enum and import
//! statements.

use std::collections::HashMap;

use movement_parser::ast::{ImportSource, Program, ShapeDeclaration, ShapeNode, Statement};
use serde_json::Value as Json;

/// A listen's stated landing: the node, as a host checks what lands against
/// it before any run.
#[derive(Debug, Clone)]
pub struct DeclaredPayload {
    pub name: String,
    node: PayloadNode,
}

#[derive(Debug, Clone)]
struct PayloadNode {
    fields: Vec<PayloadField>,
    /// A nested node: the key holds an object, or a list of them.
    children: Vec<(String, PayloadNode)>,
}

#[derive(Debug, Clone)]
struct PayloadField {
    name: String,
    kind: ValueKind,
    nullable: bool,
}

/// What JSON a declared field's type takes.
#[derive(Debug, Clone)]
enum ValueKind {
    Text,
    Number,
    Boolean,
    /// One of a declared `type`'s values.
    OneOf(Vec<String>),
    /// `json`, a file, or a type the check does not read the JSON of: any value.
    Any,
}

impl ValueKind {
    fn of(written: &str, enums: &HashMap<String, Vec<String>>) -> ValueKind {
        match written.trim() {
            "text" | "date" | "datetime" => ValueKind::Text,
            "number" => ValueKind::Number,
            "boolean" => ValueKind::Boolean,
            other => enums.get(other.trim_matches('`')).map_or(ValueKind::Any, |options| ValueKind::OneOf(options.clone())),
        }
    }

    fn describe(&self) -> String {
        match self {
            ValueKind::Text => "text".into(),
            ValueKind::Number => "a number".into(),
            ValueKind::Boolean => "a boolean".into(),
            ValueKind::OneOf(options) => format!("one of {}", options.iter().map(|o| format!("\"{o}\"")).collect::<Vec<_>>().join(", ")),
            ValueKind::Any => "any value".into(),
        }
    }

    fn fits(&self, value: &Json) -> bool {
        match (self, value) {
            (ValueKind::Any, _) => true,
            (ValueKind::Text, Json::String(_)) | (ValueKind::Number, Json::Number(_)) | (ValueKind::Boolean, Json::Bool(_)) => true,
            (ValueKind::OneOf(options), Json::String(s)) => options.contains(s),
            _ => false,
        }
    }
}

/// What a JSON value is, as a misfit names it.
fn json_kind(value: &Json) -> &'static str {
    match value {
        Json::String(_) => "text",
        Json::Number(_) => "a number",
        Json::Bool(_) => "a boolean",
        Json::Array(_) => "a list",
        Json::Object(_) => "an object",
        Json::Null => "null",
    }
}

impl PayloadNode {
    fn of(node: &ShapeNode, base: Option<PayloadNode>, enums: &HashMap<String, Vec<String>>) -> PayloadNode {
        let mut out = base.unwrap_or(PayloadNode { fields: Vec::new(), children: Vec::new() });
        for field in &node.fields {
            out.fields.retain(|f| f.name != field.name);
            out.fields.push(PayloadField { name: field.name.clone(), kind: ValueKind::of(&field.type_, enums), nullable: field.nullable == Some(true) });
        }
        for child in &node.children {
            out.children.retain(|(name, _)| *name != child.name);
            out.children.push((child.name.clone(), PayloadNode::of(child, None, enums)));
        }
        out
    }

    fn misfits(&self, value: &Json, path: &str, out: &mut Vec<String>) {
        let Json::Object(object) = value else {
            out.push(format!("{} is {}, not an object", if path.is_empty() { "the body" } else { path }, json_kind(value)));
            return;
        };
        let at = |name: &str| if path.is_empty() { format!("`{name}`") } else { format!("`{path}.{name}`") };
        for field in &self.fields {
            match object.get(&field.name) {
                None | Some(Json::Null) if field.nullable => {}
                None | Some(Json::Null) => out.push(format!("{} is missing ({})", at(&field.name), field.kind.describe())),
                Some(found) if !field.kind.fits(found) => out.push(format!("{} is {}, not {}", at(&field.name), json_kind(found), field.kind.describe())),
                Some(_) => {}
            }
        }
        for (name, child) in &self.children {
            let inner = if path.is_empty() { name.clone() } else { format!("{path}.{name}") };
            match object.get(name) {
                None | Some(Json::Null) => {}
                Some(Json::Array(items)) => items.iter().for_each(|item| child.misfits(item, &inner, out)),
                Some(found) => child.misfits(found, &inner, out),
            }
        }
    }
}

/// What one file declares for reading a stated node: its nodes, its enums,
/// and the names it imports from other files (local name to file and exported
/// name), as the checker's linker resolves them.
pub struct FileScope<'a> {
    shapes: HashMap<String, &'a ShapeDeclaration>,
    enums: HashMap<String, Vec<String>>,
    imports: HashMap<String, (String, String)>,
}

impl<'a> FileScope<'a> {
    pub fn of(program: &'a Program) -> FileScope<'a> {
        let mut scope = FileScope { shapes: HashMap::new(), enums: HashMap::new(), imports: HashMap::new() };
        for statement in &program.statements {
            match statement {
                Statement::Shape(shape) => {
                    scope.shapes.insert(shape.name.clone(), shape);
                }
                Statement::Type(declaration) => {
                    scope.enums.insert(declaration.name.clone(), declaration.options.clone());
                }
                Statement::Import(import) => {
                    if let ImportSource::File { path } = &import.source {
                        for name in &import.names {
                            scope.imports.insert(name.alias.clone().unwrap_or_else(|| name.name.clone()), (path.clone(), name.name.clone()));
                        }
                    }
                }
                _ => {}
            }
        }
        scope
    }

    /// Whether the file imports `name` from another file.
    pub fn imports(&self, name: &str) -> bool {
        self.imports.contains_key(name)
    }

    /// The node `name` as this file means it, and the file that declares it:
    /// its own, or the one it imports it from (through any chain of imports).
    fn shape<'s>(&'s self, name: &str, scopes: &'s HashMap<String, FileScope<'a>>, hops: usize) -> Option<(&'a ShapeDeclaration, &'s FileScope<'a>)> {
        if let Some(shape) = self.shapes.get(name) {
            return Some((shape, self));
        }
        let (path, exported) = self.imports.get(name).filter(|_| hops < 16)?;
        scopes.get(path)?.shape(exported, scopes, hops + 1)
    }
}

impl DeclaredPayload {
    /// The node `name` as `scope` means it, a base it extends folded in;
    /// `scopes` are the other files' by name, for a node it imports. None
    /// when no such node is declared or imported (the checker refuses that
    /// listen).
    pub fn of(name: &str, scope: &FileScope<'_>, scopes: &HashMap<String, FileScope<'_>>) -> Option<DeclaredPayload> {
        fn node(name: &str, scope: &FileScope<'_>, scopes: &HashMap<String, FileScope<'_>>, depth: usize) -> Option<PayloadNode> {
            let (shape, owner) = scope.shape(name, scopes, 0)?;
            let base = shape.extends.as_ref().filter(|_| depth < 16).and_then(|b| node(&b.name, owner, scopes, depth + 1));
            Some(PayloadNode::of(&shape.root, base, &owner.enums))
        }
        let name = name.trim().trim_matches('`');
        Some(DeclaredPayload { name: name.to_string(), node: node(name, scope, scopes, 0)? })
    }

    /// What of `landing` (a record's fields, or a body) does not fit the
    /// node, one line each; empty when it fits.
    pub fn misfits(&self, landing: &Json) -> Vec<String> {
        let mut out = Vec::new();
        self.node.misfits(landing, "", &mut out);
        out
    }
}

/// `node` as the single file `source` declares it (an embedded host's
/// program imports from no other file), and what of `landing` does not fit
/// it. Err for a source that does not parse or declares no such node.
pub fn landing_misfits(source: &str, node: &str, landing: &Json) -> Result<(DeclaredPayload, Vec<String>), String> {
    let program = movement_parser::stmt::parse_program(source, false).map_err(|e| format!("the source does not parse: {}", e.message))?;
    let declared = DeclaredPayload::of(node, &FileScope::of(&program), &HashMap::new()).ok_or_else(|| format!("the source declares no node {node}"))?;
    let misfits = declared.misfits(landing);
    Ok((declared, misfits))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The cases both hosts' checks are held to.
    const CASES: &str = include_str!("../../../packages/engine-contracts/conformance/listen-landings.json");

    #[test]
    fn landing_misfits_matches_the_shared_table_of_cases() {
        let table: Json = serde_json::from_str(CASES).unwrap();
        let cases = table["cases"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["case"].as_str().unwrap();
            let source = table["sources"][case["source"].as_str().unwrap()].as_str().unwrap_or_else(|| panic!("{name}: no such source"));
            let (declared, misfits) = landing_misfits(source, case["node"].as_str().unwrap(), &case["landing"]).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(json!({ "node": declared.name, "misfits": misfits }), json!({ "node": case["named"], "misfits": case["misfits"] }), "{name}");
        }
    }

    #[test]
    fn a_node_imported_from_another_file_is_read_with_its_own_files_base_and_enum() {
        let types = "type Currency = <\"usd\" | \"eur\">\nexport node Charge {\n  id: <text>\n}\nexport node Payment extends Charge {\n  amount: <number>\n  currency: <Currency>\n}\n";
        let hooks = "import { Payment as Paid } from \"types\"\nfunction paid(e: <Paid>) {\n}\n";
        let (types, hooks) = (movement_parser::stmt::parse_program(types, false).unwrap(), movement_parser::stmt::parse_program(hooks, false).unwrap());
        let scopes: HashMap<String, FileScope<'_>> = [("types".to_string(), FileScope::of(&types)), ("hooks".to_string(), FileScope::of(&hooks))].into_iter().collect();
        let paid = DeclaredPayload::of("Paid", &scopes["hooks"], &scopes).unwrap();
        assert_eq!(paid.name, "Paid");
        assert!(paid.misfits(&json!({ "id": "p", "amount": 1, "currency": "usd" })).is_empty());
        assert_eq!(
            paid.misfits(&json!({ "amount": "1", "currency": "gbp" })),
            ["`id` is missing (text)", "`amount` is text, not a number", "`currency` is text, not one of \"usd\", \"eur\""],
        );
        assert!(scopes["hooks"].imports("Paid") && !scopes["types"].imports("Paid"));
        assert!(DeclaredPayload::of("Paid", &scopes["hooks"], &HashMap::new()).is_none(), "an import whose file is not in the set names no node");
    }

    #[test]
    fn a_source_that_does_not_parse_or_declares_no_such_node_is_refused() {
        assert!(landing_misfits("node {", "Payment", &json!({})).unwrap_err().starts_with("the source does not parse: "));
        assert_eq!(landing_misfits("node Charge {\n  id: <text>\n}\n", "Payment", &json!({})).unwrap_err(), "the source declares no node Payment");
    }
}

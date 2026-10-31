//! What lands on an edge typed by a node the write names (`answerShapeFrom`):
//! an edge off the written record may say that one field of the write names
//! a node declared in the program (`Fields: Refund`). Each record landing on
//! that edge then has the node's fields, typed as the node declares them,
//! beside the landing's own, as a TypeScript generic is fixed by its
//! argument. The engine sends the node's fields to the module as the field's
//! value (the `nodeSchema` stamp), so the module serves and checks that
//! shape. Nothing here knows a module or a field by name: the edge names
//! the field.

use serde_json::json;

use movement_parser::ast::ExprSlot;

use super::{Field, edges_off_handle};
use crate::checker::Checker;
use crate::codes;
use crate::scope::{Resolution, ScopeId};
use crate::slots::is_bare_ident;
use crate::types::Ty;
use crate::types::position::Position;

impl Checker<'_> {
    /// The fields of what lands on each edge off the written record whose
    /// shape a field of this write names (the edge's `answerShapeFrom`).
    pub(super) fn apply_answer_shapes(&mut self, handle: Option<Position>, fields: &[Field], scope: ScopeId) -> Option<Position> {
        let Some(Position::Handle(mut handle_position)) = handle else { return handle };
        let Some(edges) = edges_off_handle(&handle_position) else { return Some(Position::Handle(handle_position)) };
        let mut answers = handle_position.answer_fields.as_deref().cloned().unwrap_or_default();
        let mut shaped = false;
        for (edge_name, edge_schema) in edges.iter() {
            let Some(named) = &edge_schema.answer_shape_from else { continue };
            // A write without the field types nothing; a module that needs it
            // declares it required, which the write's own check says.
            let Some(field) = fields.iter().find(|f| f.name == *named) else { continue };
            let Some(node_fields) = self.node_fields_named_by(&field.value, scope) else {
                self.report(
                    codes::ANSWER_SHAPE,
                    format!("'{named}' names the answer's shape: a node declared in this file — `node Refund {{ Approve: <boolean> }}` — then `{named}: Refund`"),
                    field.value.span,
                );
                continue;
            };
            let entries = answers.entry(edge_name.clone()).or_default();
            entries.extend(node_fields.iter().map(|(name, ty)| (vec![name.clone()], Ty::from_schema(ty))));
            self.stamp(field.value.span, crate::answer::StampKind::NodeSchema(json!({ "fields": node_fields })));
            shaped = true;
        }
        if shaped {
            handle_position.answer_fields = Some(std::rc::Rc::new(answers));
        }
        Some(Position::Handle(handle_position))
    }

    /// The fields of the node `value` names: a node declaration, or a
    /// second name for one (`S = Refund`).
    fn node_fields_named_by(&self, value: &ExprSlot, scope: ScopeId) -> Option<movement_parser::catalog::types::JsMap<movement_parser::catalog::types::SchemaFieldType>> {
        let written = value.raw.trim();
        if !is_bare_ident(written) {
            return None;
        }
        let Resolution::Found(id) = self.scopes.resolve(scope, written) else { return None };
        let declared = self.declared_extract_shape(id)?;
        let instance = &declared.instance;
        Some(instance.schema.positions.get(&instance.name)?.properties.clone())
    }

    /// The write field `field` names a node as an answer's shape, so its
    /// value is the node, not a value to check against the field's type.
    pub(super) fn names_answer_shape(&self, handle: Option<&Position>, field: &str, value: &ExprSlot, scope: ScopeId) -> bool {
        let Some(Position::Handle(handle)) = handle else { return false };
        let names_it = edges_off_handle(handle).is_some_and(|edges| edges.values().any(|e| e.answer_shape_from.as_deref() == Some(field)));
        names_it && self.node_fields_named_by(value, scope).is_some()
    }
}

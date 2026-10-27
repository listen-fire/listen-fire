//! A listen's watched field and the value it becomes: a `field`-format key
//! names one field of the record the listen watches (TypeScript's `keyof T`),
//! and a `field-value`-format key is a value of that field (`T[K]`). Both are
//! held against the record the listen's address lands on — the table the
//! platform narrows the event's subject edge to — and say nothing where that
//! record is undescribed.

use indexmap::IndexMap;
use movement_parser::catalog::types::{AdapterSpec, FieldType, InstanceSchema, TriggerConfigFormat};
use movement_parser::lowering::expression::{Expression, ListElement, StaticValue};

use super::event_types::{self, EventRef, Kind};
use super::ConfigRead;
use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::Diagnostic;
use crate::families::values::{EnumDiagnostic, check_enum_literal};
use crate::meta::did_you_mean;
use crate::slots::expression_of_slot;
use crate::types::field::{Ty, describe_field_type, field_assignable, strip_absent};

/// The fields of the record each event the listen fires is about, by name;
/// `None` when no such record is described.
pub(super) fn watched_properties<'s>(schema: &'s InstanceSchema, event_types: &[EventRef]) -> Option<IndexMap<&'s String, &'s FieldType>> {
    let mut known = IndexMap::new();
    let mut described = false;
    for type_ in event_types {
        let landed: Vec<&String> = match &type_.kind {
            Kind::Position => vec![&type_.key],
            Kind::Union { variants } => variants.iter().collect(),
            Kind::Meta => Vec::new(),
        };
        for key in landed {
            let Some(landed) = schema.positions.get(key) else { continue };
            let position = event_types::subject_of(schema, landed).map_or(landed, |(_, _, p)| p);
            if position.undescribed == Some(true) {
                continue;
            }
            described = true;
            for (name, type_) in &position.properties.0 {
                known.entry(name).or_insert(type_);
            }
        }
    }
    described.then_some(known)
}

/// A literal value, or a list of them: what reaches the host's gate as
/// written (anything else reaches it as raw text and never matches).
pub(super) fn literal_value(slot: &movement_parser::ast::ExprSlot) -> Option<Expression> {
    let parsed = expression_of_slot(slot).ok()?;
    let literal = |e: &Expression| matches!(e, Expression::Static { .. });
    match &parsed {
        Expression::Static { .. } => Some(parsed),
        Expression::List { elements } if elements.iter().all(|e| matches!(e, ListElement::Expression(e) if literal(e))) => Some(parsed),
        _ => None,
    }
}

impl Checker<'_> {
    /// The watched field against the record's fields, then the value it
    /// becomes against that field's type.
    pub(super) fn check_watched_field(
        &mut self,
        read: &ConfigRead,
        spec: Option<&AdapterSpec>,
        watched: Option<&IndexMap<&String, &FieldType>>,
    ) {
        if let (Some((key, _, span)), None) = (&read.field_value, &read.field) {
            let field_key = spec
                .and_then(|s| s.trigger_config_formats.as_ref())
                .and_then(|f| f.0.iter().find(|(_, format)| **format == TriggerConfigFormat::Field).map(|(k, _)| k.clone()));
            if let Some(field_key) = field_key {
                self.report(
                    codes::LISTEN_BAD_CONFIG,
                    format!("'{key}' is a value of the field '{field_key}' names, and this listen names none, so it gates nothing — add {field_key}: \"…\""),
                    *span,
                );
            }
            return;
        }
        let (Some((field, field_span)), Some(watched)) = (&read.field, watched) else { return };
        let Some(type_) = watched.get(field) else {
            let mut names: Vec<&String> = watched.keys().copied().collect();
            names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let fields = if names.is_empty() {
                "it has no fields".to_string()
            } else {
                format!("its fields: {}", names.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
            };
            self.report(
                codes::LISTEN_BAD_CONFIG,
                format!("'{field}' is not a field of what this listener watches — {fields}{}", did_you_mean(field, &names)),
                *field_span,
            );
            return;
        };
        let Some((key, value, span)) = &read.field_value else { return };
        let ty = Ty::from_schema(type_);
        let mut found = Vec::new();
        if !hold_value(value, &ty, &mut found) {
            self.report(
                codes::LISTEN_BAD_CONFIG,
                format!("'{key}' is {}, but '{field}' holds {} — write a value of that type", describe_literal(value), describe_field_type(strip_absent(&ty))),
                *span,
            );
            return;
        }
        for EnumDiagnostic { code, message, severity } in found {
            let mut diagnostic = Diagnostic::error(code, message, *span);
            diagnostic.severity = severity;
            self.push(diagnostic);
        }
    }
}

/// Whether a literal fits a field's type; an enum's unknown choices are
/// gathered as they are for any enum literal.
fn hold_value(value: &Expression, ty: &Ty, found: &mut Vec<EnumDiagnostic>) -> bool {
    let ty = strip_absent(ty);
    match (value, ty) {
        (Expression::Static { value: StaticValue::String(s) }, Ty::Enum { .. }) => {
            found.extend(check_enum_literal(s, ty));
            true
        }
        // A date reaches the gate as the source sends it: ISO text.
        (Expression::Static { value: StaticValue::String(_) }, Ty::Date | Ty::Datetime) => true,
        (Expression::Static { value: StaticValue::Null }, _) => false,
        (Expression::Static { value }, _) => field_assignable(&scalar_of(value), ty),
        (Expression::List { elements }, Ty::List { of, .. }) => elements.iter().all(|e| match e {
            ListElement::Expression(e) => hold_value(e, of, found),
            ListElement::Spread(_) => false,
        }),
        _ => false,
    }
}

fn scalar_of(value: &StaticValue) -> Ty {
    match value {
        StaticValue::String(_) => Ty::Text,
        StaticValue::Number(_) => Ty::Number,
        StaticValue::Bool(_) => Ty::Boolean,
        StaticValue::Null => Ty::Absent,
    }
}

fn describe_literal(value: &Expression) -> String {
    match value {
        Expression::Static { value } => describe_field_type(&scalar_of(value)),
        _ => "a list".to_string(),
    }
}

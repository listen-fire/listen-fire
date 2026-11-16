//! Claims: who acted on an event, as its module vouches for it. A claim is a
//! field whose type carries a brand (`text & Brand<"claim:email/address">`);
//! the type is the declaration. 0.16 retires what came before them: the
//! `Actor` field `lf` offered on what lands, and the acting user and actor
//! meta keys (`@user_*`, `@actor_*`).
//!
//! Codes: MOV_ACTOR_RETIRED, MOV_ACTING_USER_RETIRED. Errors with nothing to
//! rewrite: the old values have no exact replacement.

use movement_parser::catalog::types::{Composite, FieldType, PositionSchema};

use crate::codes;
use crate::types::infer::Typing;
use crate::types::position::{Position, describe_position};

/// The field `lf` offered on what lands until 0.15.
pub const ACTOR_FIELD: &str = "Actor";

/// The meta keys 0.16 retired.
const RETIRED_META_KEYS: &[&str] = &["user_email", "user_name", "user_id", "actor_email", "actor_name", "actor_id"];

/// A field of a record that holds a claim.
pub struct ClaimField<'a> {
    pub name: &'a str,
    pub brands: &'a [String],
    pub may_be_absent: bool,
}

/// The brands `field` carries, and whether it may be absent: a claim's
/// field is branded, perhaps under `maybeAbsent`.
fn brands_of(field: &FieldType) -> Option<(&[String], bool)> {
    match field {
        FieldType::Composite(Composite::Branded { brands, .. }) => Some((brands, false)),
        FieldType::Composite(Composite::MaybeAbsent { of }) => brands_of(of).map(|(brands, _)| (brands, true)),
        _ => None,
    }
}

/// Each field of `schema` that holds a claim, in the order it declares them.
pub fn claim_fields(schema: &PositionSchema) -> Vec<ClaimField<'_>> {
    schema
        .properties
        .iter()
        .filter_map(|(name, field)| brands_of(field).map(|(brands, may_be_absent)| ClaimField { name, brands, may_be_absent }))
        .collect()
}

/// `` `User Email`, `Pressed By Email` ``.
pub fn spelled_claims(claims: &[ClaimField]) -> String {
    claims.iter().map(|claim| format!("`{}`", claim.name)).collect::<Vec<_>>().join(", ")
}

/// MOV_ACTOR_RETIRED: a read of `Actor` off a record whose schema declares
/// none. True when it fired.
pub fn report_actor_retired(typing: &mut Typing, position: &Position, schema: &PositionSchema, property: &str) -> bool {
    if property != ACTOR_FIELD || schema.properties.contains_key(ACTOR_FIELD) {
        return false;
    }
    let claims = claim_fields(schema);
    let who = if claims.is_empty() {
        "it carries no claim, so nothing on it says who acted".to_string()
    } else {
        format!("who acted is a claim it carries: {}", spelled_claims(&claims))
    };
    let message = format!(
        "'{ACTOR_FIELD}' is retired in 0.16: listen-fire no longer offers it on what lands, and {} has no field of that name — {who}. Read the claim, and ask a host function who that is (e.g. `team.isMember(m.`User Email`)`)",
        describe_position(position)
    );
    typing.report(codes::ACTOR_RETIRED, message);
    true
}

/// MOV_ACTING_USER_RETIRED for an `@key` read of a retired meta key. True
/// when it fired.
pub fn report_acting_user_retired(typing: &mut Typing, key: &str) -> bool {
    if !RETIRED_META_KEYS.contains(&key) {
        return false;
    }
    let message = format!(
        "'@{key}' is retired in 0.16: who acted is a claim on the event — a branded field of the record the run was fired with (e.g. Slack's m.`User Email`) — and who they are to a host is a host function's answer (e.g. `team.userFor(m.`User Email`)`, imported from plugins)"
    );
    typing.report(codes::ACTING_USER_RETIRED, message);
    true
}

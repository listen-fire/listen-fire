//! The member of a type a hop's WHERE pins. A type whose members a field tells
//! apart (an Affinity record's `List Entries`, one member per list, told apart
//! by `listName`) publishes which value picks which member on its write shape
//! (`discriminated`): the same member set a read narrows over. A WHERE that
//! states `` `<discriminant>` == "<literal>" `` among its conjuncts admits only
//! that member's records, so the hop lands on it — TypeScript's narrowing of a
//! discriminated union by `x.kind === "a"`.
//!
//! The checker types the hop by it and the engine drops another member's
//! record by it, so the two cannot disagree about which member a WHERE chose.
//! A host's own narrowing (`refinements` / `selectedMembers`) answers first.
//!
//! A pin that picks no member leaves the hop on the whole type. A literal the
//! discriminant's values do not include is already refused where it is
//! written (MOV_ENUM_UNKNOWN_VALUE names the values); one they include whose
//! member nobody described is not "no member", and two literals at once is
//! TypeScript's `never` — refused where a field is read off it, not here.

use movement_parser::catalog::types::{DiscriminatedWriteShape, InstanceSchema};
use movement_parser::lowering::expression::Expression;

use super::event_address::conjunct_pins;

/// The position of the member `filter` pins a hop landing on `declared` to.
pub fn pinned_member(schema: &InstanceSchema, declared: &str, filter: &Expression) -> Option<String> {
    let discriminated = discriminated_shape(schema, declared)?;
    let mut literals = conjunct_pins(filter).into_iter().filter(|(key, _)| *key == discriminated.discriminant).map(|(_, literal)| literal);
    let literal = literals.next()?;
    if literals.any(|other| other != literal) {
        return None;
    }
    let member = discriminated.variants.get(&literal)?.position.clone()?;
    schema.positions.contains_key(&member).then_some(member)
}

/// The write shape that says which value picks which member of `position`.
fn discriminated_shape<'a>(schema: &'a InstanceSchema, position: &str) -> Option<&'a DiscriminatedWriteShape> {
    schema
        .writable_roots
        .get(position)
        .or_else(|| schema.create_shapes.as_ref().and_then(|c| c.get(position)))?
        .discriminated
        .as_ref()
}

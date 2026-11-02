//! What an edge walked off a union lands on where the members' edges land on
//! different record types (a Person's `Notes` on a Memo, a Company's on a
//! Remark): one of those landings, TypeScript's `Memo | Remark`, joined by
//! the union rule (`unions`). A read, a walk or a write off it is held to
//! every one of them, as off any value that may be one of several records.
//!
//! 0.13 typed nothing there, so such a read checked clean whatever it named.
//! Since 0.14 one that only some of them offer is refused by
//! `MOV_UNION_MEMBER_ONLY`, which says so and names the narrowing that
//! reaches it: test the record the walk goes through with `is`, then walk
//! from it, as TypeScript narrows `Person | Company` before reading what only
//! a Person has.

use std::rc::Rc;

use movement_parser::surface::phrase::spell_if;

use super::position::{Position, UnionPosition, describe_position, position_ref_in};
use super::unions::join_positions;
use crate::families::names::spell_name;

/// Where a landing of an edge off a union came from: the union walked off,
/// the edge, and the union's members whose edge lands on this record type.
#[derive(Debug)]
pub struct PastUnion {
    pub union: String,
    pub instance: String,
    pub edge: String,
    pub from: Vec<String>,
}

/// `edge` off `union`, whose members (`targets`: each member and where its
/// edge lands) land on different record types: one of those landings.
pub fn joined_landing(union: &UnionPosition, edge: &str, targets: &[(&str, &str)]) -> Option<Position> {
    let described = describe_position(&Position::Union(union.clone()));
    let mut by_target: Vec<(&str, Vec<String>)> = Vec::new();
    for (member, target) in targets {
        match by_target.iter_mut().find(|(t, _)| t == target) {
            Some((_, from)) => from.push(member.to_string()),
            None => by_target.push((target, vec![member.to_string()])),
        }
    }
    let landings: Vec<Position> = by_target
        .into_iter()
        .map(|(target, from)| {
            Some(match position_ref_in(&union.instance, target)? {
                Position::Position(mut record) => {
                    record.past_union =
                        Some(Rc::new(PastUnion { union: described.clone(), instance: union.instance.name.clone(), edge: edge.to_string(), from }));
                    Position::Position(record)
                }
                other => other,
            })
        })
        .collect::<Option<_>>()?;
    join_positions(&landings.iter().collect::<Vec<_>>()).map(|joined| joined.position)
}

/// What a refusal of a step only some members offer says, where a member
/// offering it is a landing of an edge off a union.
pub struct MemberOnly {
    /// `since 0.14, what '-[:Notes]->' off crm.Subject lands is crm.Memo or crm.Remark (0.13 checked nothing there)`.
    pub since: String,
    /// The narrowing that reaches the member, as code.
    pub narrowing: String,
}

/// Why a step only some of `members` offer is refused, where one that
/// offers it (`offers`) is a landing of an edge off a union. None where no
/// member offering it came off a union.
pub fn member_only(members: &[Position], offers: impl Fn(&Position) -> bool) -> Option<MemberOnly> {
    let past = members.iter().filter(|member| offers(member)).find_map(|member| match member {
        Position::Position(record) => record.past_union.clone(),
        _ => None,
    })?;
    let landed = describe_position(&Position::OneOf(members.to_vec()));
    let member = spell_name(&past.from[0]);
    let edge = spell_name(&past.edge);
    Some(MemberOnly {
        since: format!("since 0.14, what '-[:{edge}]->' off {} lands is {landed} (0.13 checked nothing there)", past.union),
        narrowing: format!("`{} {{ x-[:{edge}]-> … }}`", spell_if(&format!("x IS <{}-[:{member}]->>", past.instance))),
    })
}

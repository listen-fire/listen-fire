//! Walking a connection's members through its module's `edgesFrom`, hop by
//! hop from its root, as the platform walks them (`walkHop`,
//! `membersAtPath`): what a hop's WHERE narrows (crate::refinements) and
//! what a position arg may be set to are both read this way.

use std::cell::RefCell;
use std::collections::BTreeMap;

use indexmap::IndexMap;

use crate::json::{Js, Obj};
use crate::obj;

/// `MAX_WALK_PAGES`: how many pages of one hop's edges a walk reads.
const MAX_WALK_PAGES: usize = 100;
/// `META_RECORD_TYPE`: the root a walk starts from.
const META_RECORD_TYPE: &str = "meta";

fn member_label(data: &Js) -> Option<&str> {
    let Js::Obj(data) = data else { return None };
    let named = ["Title", "Name", "name", "title"].iter().find_map(|k| data.get(*k).and_then(Js::as_str).filter(|v| !v.is_empty()));
    named.or_else(|| data.values().find_map(|v| v.as_str().filter(|v| !v.is_empty())))
}

/// One `edgesFrom` call of the connection being described: its answer, or
/// `Js::Null` when it has no edges there (or no `edgesFrom` at all).
pub trait Walk {
    async fn edges_from(&self, position: &Js, cursor: Option<&Js>) -> Result<Js, String>;
}

/// The walks of one connection (`walkHop`, `walkPath`, `membersAtPath`),
/// each hop taken once however many walks pass through it.
pub(crate) struct Walker<'a, W> {
    walk: &'a W,
    adapter_type: &'a str,
    hops: RefCell<BTreeMap<String, Option<Js>>>,
    /// `positionsByName`: the path to each node a hop has handed over, by the
    /// name it is known by, in the order the hops taught them.
    paths: RefCell<IndexMap<String, Js>>,
}

impl<'a, W: Walk> Walker<'a, W> {
    pub(crate) fn new(walk: &'a W, adapter_type: &'a str) -> Self {
        Walker { walk, adapter_type, hops: RefCell::new(BTreeMap::new()), paths: RefCell::new(IndexMap::new()) }
    }

    async fn hop(&self, position: &Js) -> Result<Option<Js>, String> {
        let at = position.to_json();
        if let Some(hop) = self.hops.borrow().get(&at) {
            return Ok(hop.clone());
        }
        let hop = self.drain_hop(position).await?;
        if let Some(hop) = &hop {
            self.file_paths(hop);
        }
        self.hops.borrow_mut().insert(at, hop.clone());
        Ok(hop)
    }

    /// `filePaths`: every hop teaches the paths on from it. A named edge's
    /// node is known by its `targetTypeId`; a polymorphic edge's member by
    /// the label the module minted onto it.
    fn file_paths(&self, hop: &Js) {
        let Some(Js::Obj(positions)) = hop.get("targetPositions") else { return };
        let references = hop.get("descriptor").and_then(|d| d.get("references")).and_then(Js::as_array).unwrap_or_default();
        let target_of = |field_id: &str| {
            references.iter().find(|r| r.get("fieldId").and_then(Js::as_str) == Some(field_id)).and_then(|r| r.get("targetTypeId")).and_then(Js::as_str)
        };
        let mut paths = self.paths.borrow_mut();
        for (field_id, position) in positions {
            if let Some(name) = target_of(field_id).or_else(|| position_label(position)) {
                paths.insert(name.to_string(), position.clone());
            }
        }
    }

    /// `membersOf`: the members of kind `record_type` the walk has been
    /// handed so far, the root walked first, each with its name and data.
    pub(crate) async fn members_of(&self, record_type: &str) -> Result<Vec<(String, Js)>, String> {
        self.root().await?;
        Ok(self
            .paths
            .borrow()
            .iter()
            .filter(|(_, position)| position.get("recordType").and_then(Js::as_str) == Some(record_type))
            .map(|(name, position)| (name.clone(), position_data(position).cloned().unwrap_or(Js::Null)))
            .collect())
    }

    /// `describeType` for a member the walk was handed: one hop along the
    /// path it came with. None when no hop handed it over, or the module has
    /// nothing there.
    pub(crate) async fn describe_member(&self, name: &str) -> Result<Option<Js>, String> {
        self.root().await?;
        let Some(position) = self.paths.borrow().get(name).cloned() else { return Ok(None) };
        Ok(self.hop(&position).await?.and_then(|hop| hop.get("descriptor").cloned()))
    }

    /// The node one of `member`'s edges lands on, the edge named by the type
    /// it targets: one hop along the path the member's own hop handed over.
    pub(crate) async fn describe_member_landing(&self, member: &str, target: &str) -> Result<Option<Js>, String> {
        self.root().await?;
        let Some(at) = self.paths.borrow().get(member).cloned() else { return Ok(None) };
        let Some(hop) = self.hop(&at).await? else { return Ok(None) };
        let references = hop.get("descriptor").and_then(|d| d.get("references")).and_then(Js::as_array).unwrap_or_default();
        let field_id = references.iter().find(|r| r.get("targetTypeId").and_then(Js::as_str) == Some(target)).and_then(|r| r.get("fieldId")).and_then(Js::as_str);
        let Some(position) = field_id.and_then(|id| hop.get("targetPositions").and_then(|p| p.get(id))).cloned() else { return Ok(None) };
        Ok(self.hop(&position).await?.and_then(|hop| hop.get("descriptor").cloned()))
    }

    /// `drainHop`: one hop's every page, merged.
    async fn drain_hop(&self, position: &Js) -> Result<Option<Js>, String> {
        let first = self.walk.edges_from(position, None).await?;
        if first == Js::Null {
            return Ok(None);
        }
        let list = |hop: &Js, key: &str| hop.get("descriptor").and_then(|d| d.get(key)).and_then(Js::as_array).unwrap_or_default().to_vec();
        let map = |hop: &Js, key: &str| match hop.get(key) {
            Some(Js::Obj(map)) => map.clone(),
            _ => Obj::new(),
        };
        let (mut fields, mut references) = (list(&first, "fields"), list(&first, "references"));
        let (mut target_positions, mut target_nodes) = (map(&first, "targetPositions"), map(&first, "targetNodes"));
        let mut cursor = first.get("nextCursor").filter(|c| **c != Js::Null).cloned();
        let mut page = 1;
        while let Some(at) = cursor.take().filter(|_| page < MAX_WALK_PAGES) {
            let next = self.walk.edges_from(position, Some(&at)).await?;
            if next == Js::Null {
                break;
            }
            fields.extend(list(&next, "fields"));
            references.extend(list(&next, "references"));
            target_positions.extend(map(&next, "targetPositions"));
            target_nodes.extend(map(&next, "targetNodes"));
            cursor = next.get("nextCursor").filter(|c| **c != Js::Null).cloned();
            page += 1;
        }
        let mut descriptor = match first.get("descriptor") {
            Some(Js::Obj(descriptor)) => descriptor.clone(),
            _ => Obj::new(),
        };
        descriptor.insert("fields".into(), Js::Arr(fields));
        descriptor.insert("references".into(), Js::Arr(references));
        let mut hop = obj! { "descriptor" => Js::Obj(descriptor), "targetPositions" => Js::Obj(target_positions) };
        if !target_nodes.is_empty() {
            hop.insert("targetNodes".into(), Js::Obj(target_nodes));
        }
        Ok(Some(Js::Obj(hop)))
    }

    async fn root(&self) -> Result<Option<Js>, String> {
        let meta = Js::Obj(obj! {
            "adapterType" => Js::str(self.adapter_type),
            "recordType" => Js::str(META_RECORD_TYPE),
            "identity" => Js::Obj(obj! { "kind" => Js::str("unstable") }),
        });
        self.hop(&meta).await
    }

    /// `membersAtPath` at the root: the data of the members of kind
    /// `record_type` one hop on from it, each named by its edge or its label.
    async fn members_at_root(&self, record_type: &str) -> Result<Vec<Js>, String> {
        let Some(hop) = self.root().await? else { return Ok(Vec::new()) };
        let references = hop.get("descriptor").and_then(|d| d.get("references")).and_then(Js::as_array).unwrap_or_default();
        let edge_named = |field_id: &str| references.iter().any(|r| r.get("fieldId").and_then(Js::as_str) == Some(field_id));
        let Some(Js::Obj(positions)) = hop.get("targetPositions") else { return Ok(Vec::new()) };
        Ok(positions
            .iter()
            .filter(|(_, position)| position.get("recordType").and_then(Js::as_str) == Some(record_type))
            .filter(|(field_id, position)| edge_named(field_id) || position_label(position).is_some())
            .map(|(_, position)| position_data(position).cloned().unwrap_or(Js::Null))
            .collect())
    }
}

pub(crate) fn position_data(position: &Js) -> Option<&Js> {
    position.get("identity").and_then(|i| i.get("data"))
}

/// `positionLabel`.
fn position_label(position: &Js) -> Option<&str> {
    position_data(position).and_then(member_label)
}

/// What each of a module's position args (`base:`) may be set to: the labels
/// of the members of its `optionsFrom` kind one hop from the root of an
/// unpositioned connection, as the platform publishes `constructionArgOptions`.
/// An arg whose kind has no members there publishes nothing.
pub async fn position_arg_options<W: Walk>(walk: &W, adapter_type: &str, args: &[crate::externals::PositionArg]) -> Result<BTreeMap<String, Vec<String>>, String> {
    let walker = Walker::new(walk, adapter_type);
    let mut options = BTreeMap::new();
    for arg in args {
        let members = walker.members_at_root(&arg.options_from).await?;
        let labels: Vec<String> = members.iter().filter_map(member_label).map(str::to_string).collect();
        if !labels.is_empty() {
            options.insert(arg.name.clone(), labels);
        }
    }
    Ok(options)
}

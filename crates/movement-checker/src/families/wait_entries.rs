//! Where a record enters the run, for the waits on it. An `await` on an edge
//! counts what arrived since its record entered the run, so the run opens
//! the wait when the record enters, before the `await` is reached. That is
//! a check on types, made conservatively: the program awaits an edge off
//! records of a type anywhere (in any file it links), so every place a
//! record of that type enters is stamped with the edges awaited off it
//! (`opensWaits`). A wait opened and never reached costs only its row.
//!
//! A record enters at a bound write (just before the write), at a binding
//! whose value reads records, at a traversal block's head, and as a
//! function's parameter. A binding that renames a name (`same = msg`) holds
//! a record that already entered, so nothing enters there.
//!
//! A record's type is its system's adapter with the position's name: one
//! type in every file that connects that adapter, so an `await` in a library
//! stamps the reads of the file that imports it.
//!
//! Separately, a plain `await` on an edge that can also be listed takes the
//! first match already there (`listsFirst`); `await new` never does.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use movement_parser::ast::{AwaitSource, PathHead, PathRoot, RValue, Span};
use movement_parser::catalog::types::EdgeSchema;

use crate::answer::{StampKind, StampSite};
use crate::checker::Checker;
use crate::scope::{Resolution, ScopeId};
use crate::types::Position;
use crate::types::field::{NodeKey, Ty};
use crate::types::position::Instance;
use crate::types::scope_env::SymbolTypes;

/// A record type: the adapter and the position's name.
type RecordType = (String, String);

/// What the walk learns for `opensWaits`, settled after it.
#[derive(Default)]
pub struct WaitEntries {
    /// (adapter, position, edge) for each edge some `await` waits on.
    awaited: BTreeSet<(String, String, String)>,
    /// Each place a record enters, with the types that may enter there, in
    /// the order the walk met them.
    entries: Vec<(StampSite, BTreeSet<RecordType>)>,
}

impl Checker<'_> {
    /// Every edge an `await` in the program, or in a file it links, waits
    /// on: (adapter, position, edge).
    pub fn awaited_edges(&self) -> BTreeSet<(String, String, String)> {
        self.wait_entries.awaited.clone()
    }

    /// An `await` (or `await new`) of a walk the check resolved to one
    /// listenable edge: the edge it waits on, off each type its record may
    /// be; and a plain `await` of an edge that can be listed reads the
    /// listing first.
    pub(crate) fn note_await(&mut self, source: &AwaitSource, walk: Option<&crate::families::walks::HeadWalk>) {
        let AwaitSource::Traversal { head, arrivals_only, span } = source else { return };
        let Some((edge, schema, from)) = awaited_edge(head, walk) else { return };
        for (adapter, position) in record_types_declaring(from, edge) {
            self.wait_entries.awaited.insert((adapter, position, edge.to_string()));
        }
        if crate::families::walks::edge_is_readable(schema) && !arrivals_only {
            self.stamp(*span, StampKind::ListsFirst);
        }
    }

    /// The bound write at `span` hands back `handle`, a record that enters
    /// just before the write.
    pub(crate) fn note_written_entry(&mut self, span: Span, handle: Option<&Position>) {
        let types = handle.map(record_types).unwrap_or_default();
        self.note_entry(span, types);
    }

    /// The binding `name = value` at `span`: what its value reads enters
    /// there. A write is its own entry; a renamed name entered already.
    pub(crate) fn note_bound_entry(&mut self, name: &str, value: &RValue, span: Span, scope: ScopeId) {
        match value {
            RValue::Write { .. } => return,
            RValue::Expr { expr } if crate::slots::expression_of_slot(expr).is_ok_and(|e| crate::types::narrowing::bare_name(&e).is_some()) => return,
            _ => {}
        }
        let types = self.held_record_types(name, scope);
        self.note_entry(span, types);
    }

    /// A traversal block's head: every record its walk lands on enters.
    pub(crate) fn note_block_entry(&mut self, head: &PathHead, walk: Option<&crate::families::walks::HeadWalk>) {
        let Some(walk) = walk else { return };
        let mut types = BTreeSet::new();
        for position in walk.locals.values().flatten().chain(walk.landed.as_ref()) {
            types.extend(record_types(position));
        }
        self.note_entry(head.span, types);
    }

    /// A function's parameter, declared at `span` as `name` in `scope`.
    pub(crate) fn note_parameter_entry(&mut self, name: &str, span: Span, scope: ScopeId) {
        let types = self.held_record_types(name, scope);
        self.note_entry(span, types);
    }

    /// After the walk: each entry where a record of an awaited type enters
    /// opens the waits on the edges awaited off it.
    pub(crate) fn stamp_wait_entries(&mut self) {
        let mut edges_of: BTreeMap<RecordType, BTreeSet<String>> = BTreeMap::new();
        for (adapter, position, edge) in self.awaited_edges() {
            edges_of.entry((adapter, position)).or_default().insert(edge);
        }
        for (site, types) in std::mem::take(&mut self.wait_entries.entries) {
            let edges: BTreeSet<String> = types.iter().filter_map(|t| edges_of.get(t)).flatten().cloned().collect();
            if !edges.is_empty() {
                self.stamp_at(site, StampKind::OpensWaits(edges.into_iter().collect()));
            }
        }
    }

    /// A body walked more than once (to learn what a call returns, then in
    /// its declaration) meets an entry once per walk: one entry, with every
    /// type any walk found.
    fn note_entry(&mut self, span: Span, types: BTreeSet<RecordType>) {
        if types.is_empty() {
            return;
        }
        let site = self.stamp_site(span);
        match self.wait_entries.entries.iter_mut().find(|(at, _)| *at == site) {
            Some((_, known)) => known.extend(types),
            None => self.wait_entries.entries.push((site, types)),
        }
    }

    /// The record types the name `name` holds in `scope`.
    fn held_record_types(&self, name: &str, scope: ScopeId) -> BTreeSet<RecordType> {
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return BTreeSet::new() };
        symbol_record_types(&self.scopes.symbol(id).types)
    }
}

/// The edge an `await` of `head` waits on, its schema, and the record it is
/// walked off: one listenable edge off a record a name holds, else none (the
/// check refuses every other wait).
fn awaited_edge<'w>(head: &PathHead, walk: Option<&'w crate::families::walks::HeadWalk>) -> Option<(&'w str, &'w EdgeSchema, &'w Position)> {
    let Some(PathRoot::Name { .. }) = &head.root else { return None };
    if Checker::head_steps(head)?.len() != 1 {
        return None;
    }
    let walk = walk?;
    let schema = walk.last_edge_schema.as_ref().filter(|schema| schema.listenable == Some(true))?;
    Some((walk.last_edge.as_deref()?, schema, walk.last_source.as_ref()?))
}

/// The record types `from` may be whose schema declares `edge` listenable.
fn record_types_declaring(from: &Position, edge: &str) -> Vec<RecordType> {
    let mut found = Vec::new();
    each_record_type(from, &mut |instance, position| {
        let declares = instance.schema.positions.get(position).and_then(|p| p.edges.get(edge)).is_some_and(|e| e.listenable == Some(true));
        if let (true, Some(adapter)) = (declares, &instance.adapter) {
            found.push((adapter.clone(), position.to_string()));
        }
    });
    found
}

/// The record types a record at `position` may be.
fn record_types(position: &Position) -> BTreeSet<RecordType> {
    let mut found = BTreeSet::new();
    each_record_type(position, &mut |instance, position| {
        if let Some(adapter) = &instance.adapter {
            found.insert((adapter.clone(), position.to_string()));
        }
    });
    found
}

/// Each system record type `position` may be, with its instance: a node a
/// construct builds, an extracted value or a closure is none.
fn each_record_type(position: &Position, found: &mut dyn FnMut(&Instance, &str)) {
    match position {
        Position::Position(record) => found(&record.instance, &record.position),
        Position::Handle(handle) => {
            if let Some(position) = &handle.position {
                found(&handle.instance, position);
            }
        }
        Position::Union(union) => union.variants.iter().for_each(|variant| found(&union.instance, variant)),
        Position::MaybeEmpty(of) => each_record_type(of, found),
        Position::OneOf(members) => members.iter().for_each(|member| each_record_type(member, found)),
        Position::Meta { .. } | Position::Extract { .. } | Position::Closure(_) | Position::Local(_) => {}
    }
}

/// The record types a binding holds: its record, or the records in the
/// value it holds (a list of them, a record or absent, …).
fn symbol_record_types(types: &SymbolTypes) -> BTreeSet<RecordType> {
    let mut found: BTreeSet<RecordType> = types.pos.as_ref().map(record_types).unwrap_or_default();
    if let Some(ty) = &types.field {
        records_in(ty, &mut found, &mut HashSet::new());
    }
    found
}

/// A type shares the nodes it nests (crate::types::field::NodeKey), so each
/// distinct node is visited once: the walk stays linear in the type's size.
fn records_in(ty: &Ty, found: &mut BTreeSet<RecordType>, seen: &mut HashSet<NodeKey>) {
    if let Some(key) = ty.node_key()
        && !seen.insert(key)
    {
        return;
    }
    match ty {
        Ty::Record(Some(position)) => found.extend(record_types(position)),
        _ => ty.children().into_iter().for_each(|member| records_in(member, found, seen)),
    }
}

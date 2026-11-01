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
//! function's or a closure's parameter (`map(crm-[:Deals]->, (d) => …)`
//! reads its records where no name holds them). A binding that renames a
//! name (`same = msg`) holds a record that already entered, so nothing
//! enters there.
//!
//! A record's type is its system's adapter with the type's name: one type in
//! every file that connects that adapter, so an `await` in a library stamps
//! the reads of the file that imports it. A type the program can only write
//! (a writable root, no position) is a record type too: its write is where it
//! enters, and its edges are its writable root's.
//!
//! A record an arrival carries (its `parents`, as the listened edge declares
//! them) enters the run at its delivery, as the trigger does: on the
//! parameter of each function a listen fires, the edges awaited off each
//! record type the listen's arrivals carry are stamped by that type
//! (`carriedAwaits`), so the host opens those waits as it keeps the delivery.
//!
//! Separately, a plain `await` on an edge that can also be listed takes the
//! first match already there (`listsFirst`); `await new` never does.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use movement_parser::ast::{AwaitSource, PathHead, PathRoot, Program, RValue, Span, Statement};
use movement_parser::catalog::types::EdgeSchema;
use movement_parser::listen_plan::ListenPlan;

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

    /// The binding of `value` at `span`, typed `types`: what its value reads
    /// enters there. A write is its own entry; a renamed name entered
    /// already.
    pub(crate) fn note_bound_entry(&mut self, value: &RValue, span: Span, types: &SymbolTypes) {
        match value {
            RValue::Write { .. } => return,
            RValue::Expr { expr } if crate::slots::expression_of_slot(expr).is_ok_and(|e| crate::types::narrowing::bare_name(&e).is_some()) => return,
            _ => {}
        }
        self.note_entry(span, symbol_record_types(types));
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

    /// A function's or a closure's parameter, declared at `span` as `name`
    /// in `scope`.
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

    /// After the walk: on the parameter of the function each of `plans`
    /// fires, the edges awaited off each record type its arrivals carry (the
    /// type its carried hop lands on), by that type. A function fired by
    /// several listens holds what each carries.
    pub(crate) fn stamp_carried_awaits(&mut self, program: &Program, plans: &[ListenPlan]) {
        let mut on_params: Vec<(Span, BTreeMap<String, BTreeSet<String>>)> = Vec::new();
        for plan in plans {
            let fired = program.statements.iter().find_map(|s| match s {
                Statement::Movement(declared) if declared.name == plan.movement => declared.params.first(),
                _ => None,
            });
            let Some(param) = fired else { continue };
            for carried in &plan.carries {
                let Some(hop) = plan.hops.iter().find(|hop| &hop.edge == carried) else { continue };
                let edges: BTreeSet<String> =
                    self.wait_entries.awaited.iter().filter(|(adapter, position, _)| *adapter == plan.adapter && *position == hop.to).map(|(.., edge)| edge.clone()).collect();
                if edges.is_empty() {
                    continue;
                }
                let at = match on_params.iter().position(|(span, _)| *span == param.span) {
                    Some(at) => at,
                    None => {
                        on_params.push((param.span, BTreeMap::new()));
                        on_params.len() - 1
                    }
                };
                on_params[at].1.entry(hop.to.clone()).or_default().extend(edges);
            }
        }
        for (span, by_type) in on_params {
            let by_type = by_type.into_iter().map(|(record_type, edges)| (record_type, edges.into_iter().collect())).collect();
            self.stamp_at(StampSite::in_program(span), StampKind::CarriedAwaits(by_type));
        }
    }

    /// After the walk: a carried record whose waits cannot be keyed by the
    /// edge it was carried for is told so where its listen is written. An
    /// arrival carries one record per edge name, so two hops of that name are
    /// one record, and the waits off it open where the function walks to it,
    /// not at the arrival, as for a record no listen carries.
    pub(crate) fn report_carried_waits_counted_from_the_walk(&mut self) {
        let mut told = Vec::new();
        for (span, plan) in self.listens.written_plans() {
            for carried in &plan.carries {
                let landings: Vec<&str> = plan.hops.iter().filter(|hop| &hop.edge == carried).map(|hop| hop.to.as_str()).collect();
                if landings.len() < 2 {
                    continue;
                }
                let edges: BTreeSet<&str> = self
                    .wait_entries
                    .awaited
                    .iter()
                    .filter(|(adapter, position, _)| *adapter == plan.adapter && landings.contains(&position.as_str()))
                    .map(|(.., edge)| edge.as_str())
                    .collect();
                if edges.is_empty() {
                    continue;
                }
                let edges: Vec<String> = edges.into_iter().map(|edge| format!("`{edge}`")).collect();
                told.push((
                    *span,
                    format!(
                        "the waits on {} off the record this listen's arrivals carry for `{carried}` count from where the function walks to it, not from the arrival: {} of its hops walk `{carried}`, and an arrival carries one record per edge name",
                        edges.join(", "),
                        landings.len()
                    ),
                ));
            }
        }
        for (span, message) in told {
            self.push(crate::diagnostic::Diagnostic { severity: Some(crate::diagnostic::Severity::Warning), ..crate::diagnostic::Diagnostic::error(crate::codes::CARRIED_WAIT_FROM_WALK, message, span) });
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
        let schema = &instance.schema;
        // A type the program can only write declares its edges on its writable root.
        let declared = match schema.positions.get(position) {
            Some(p) => p.edges.get(edge),
            None => schema.writable_roots.get(position).and_then(|root| root.edges.as_ref()).and_then(|edges| edges.get(edge)),
        };
        let declares = declared.is_some_and(|e| e.listenable == Some(true));
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
        Position::Handle(handle) => found(&handle.instance, &handle.written_type),
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

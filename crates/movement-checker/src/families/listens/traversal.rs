//! `listen to <traversal> fire f`: a standing listen is a traversal ending on
//! an edge its module announces arrivals on, checked as a wait's is, and
//! planned for the host: which part of each hop's WHERE the module takes,
//! which the host checks, and how the host honours a filter on a hop before
//! the last (judged on each arrival, or by listing the hop's members).
//!
//! A listen through or onto a union is planned once per member, as
//! TypeScript distributes over a union: each member's traversal is an
//! ordinary one, checked against that member's own edges, and two unions on
//! one path multiply. It is still one listen, with one plan holding its
//! members' traversals.
//!
//! Codes: MOV_LISTEN_EDGE_NOT_LISTENABLE, MOV_LISTEN_HOP_NOT_ITERABLE,
//! MOV_LISTEN_UNWATCHABLE, MOV_LISTEN_IMPURE_WHERE, and
//! for the path form
//! MOV_LISTEN_NOT_INSTANCE, MOV_LISTEN_PARAM_MISMATCH,
//! MOV_LISTEN_DUPLICATE, MOV_LISTEN_ALIAS_DUPLICATE.

use movement_parser::ast::{ListenDeclaration, ParamTypeRef, PathHead, PathRoot, TypeRef};
use movement_parser::catalog::types::{CollectionSchema, Delivery, EdgeSchema, InstanceSchema, PositionSchema};
use movement_parser::listen_plan::{HopJudged, ListenPlan, PlanHop, PlanMember};
use movement_parser::lowering::expression::{EdgeStep, Expression, LogicalOp, TraversalStep};

use crate::checker::Checker;
use crate::codes;
use crate::families::filter_split::{EdgeView, owned_fields, split_hop, spell};
use crate::families::flow::spell_path_head;
use crate::families::names::spell_name;
use crate::families::walks::{alias_reads, is_pure_predicate};
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};
use crate::types::position::{Instance, InstanceRef, Position, describe_position, display_name_of, position_ref_in, positions_match};
use crate::types::unions::join_positions;

/// One hop of the traversal, as its module declares it.
#[derive(Clone, Copy)]
struct Hop<'a> {
    step: &'a EdgeStep,
    /// The record type it leaves; `None` off the connection itself.
    from: Option<&'a str>,
    /// The record type it lands on: one member, where its edge lands on a
    /// union.
    to: &'a str,
    /// The union its edge lands on, when `to` is one member of it.
    member_of: Option<&'a str>,
    edge: Declared<'a>,
}

#[derive(Clone, Copy)]
enum Declared<'a> {
    Collection(&'a CollectionSchema),
    Edge(&'a EdgeSchema),
}

impl Declared<'_> {
    fn readable(&self) -> bool {
        match self {
            Declared::Collection(c) => c.readable != Some(false),
            Declared::Edge(e) => crate::families::walks::edge_is_readable(e),
        }
    }

    fn listenable(&self) -> bool {
        match self {
            Declared::Collection(c) => c.listenable == Some(true),
            Declared::Edge(e) => e.listenable == Some(true),
        }
    }

    fn delivery(&self) -> Option<Delivery> {
        match self {
            Declared::Collection(c) => c.delivery,
            Declared::Edge(e) => e.delivery,
        }
    }

    fn carries(&self) -> &[String] {
        match self {
            Declared::Collection(c) => c.carries.as_deref().unwrap_or_default(),
            Declared::Edge(e) => e.carries.as_deref().unwrap_or_default(),
        }
    }

    /// Whether a listen learns its members changed (`membersChange`): a
    /// filter on it as an earlier hop is then re-resolved.
    fn members_change_learnt(&self) -> bool {
        match self {
            Declared::Collection(c) => c.members_change.is_some(),
            Declared::Edge(e) => e.members_change.is_some(),
        }
    }

    fn view<'v>(&'v self, name: &'v str, module: &'v str) -> EdgeView<'v> {
        match self {
            Declared::Collection(c) => EdgeView::of_collection(name, module, c),
            Declared::Edge(e) => EdgeView::of_edge(name, module, e),
        }
    }
}

impl Checker<'_> {
    /// `listen to <traversal> fire f`, at file level: its root a connection,
    /// every hop but the last one its module lists, the last one it announces
    /// arrivals on, each WHERE read only off the listen's own hops and
    /// literals; then the function it fires, and the plan the host watches it
    /// by.
    pub(super) fn check_listen_traversal(&mut self, statement: &ListenDeclaration, path: &PathHead, scope: ScopeId) {
        let before = self.diagnostics.len();
        self.check_path_head(path, scope);
        let instance = match self.listen_root(statement, path, scope) {
            Some(Position::Meta { instance }) => Some(instance),
            _ => None,
        };
        let lowered = Self::head_steps(path).unwrap_or_default();
        // A walk in a WHERE is refused as the listen's (`foreign_read`), so
        // the wait's walk does not also judge it as a read or a wait.
        let without_walks: Vec<TraversalStep> = lowered.iter().cloned().map(without_walks).collect();
        let steps: Vec<EdgeStep> = lowered
            .iter()
            .filter_map(|step| match step {
                TraversalStep::Edge(edge) => Some(edge.clone()),
                _ => None,
            })
            .collect();
        // A hop judged on each arrival is fetched by nothing, so what its
        // module can filter costs nothing either.
        let edge_places: Vec<usize> = lowered.iter().enumerate().filter(|(_, step)| matches!(step, TraversalStep::Edge(_))).map(|(place, _)| place).collect();
        // Under a union, a hop is fetched by nothing only when no member's
        // plan fetches it.
        let unfetched: Vec<usize> = instance
            .as_ref()
            .and_then(|instance| declared_hops(&instance.schema, &steps))
            .map(|members| (0..steps.len()).filter(|i| members.iter().all(|hops| judging(hops, *i) == Judging::Arrival)).filter_map(|i| edge_places.get(i).copied()).collect())
            .unwrap_or_default();
        let walk = instance.as_ref().and_then(|_| self.walk_listen_steps(path, &without_walks, scope, unfetched));
        // The walk is a wait's, and a listen's WHERE is refused by its own
        // code, not by the wait's.
        let walked = self.diagnostics.split_off(before.min(self.diagnostics.len()));
        self.diagnostics.extend(walked.into_iter().filter(|d| d.code != codes::AWAIT_IMPURE_WHERE));
        let landing = statement.landing.as_ref().and_then(|stated| self.landing_node(stated, scope));
        let stated = landing.and(statement.landing.as_ref()).map(|stated| stated.graph.clone());
        let plan: Option<ListenPlan> = instance
            .as_ref()
            .and_then(|instance| self.plan_listen(statement, path, instance, &steps, scope))
            .map(|plan| ListenPlan { landing: stated.clone(), ..plan });
        if let Some(walk) = &walk {
            // Past a union whose members land on different record types the
            // walk types nothing: what lands is one of each member's landings.
            let members = match (&instance, &walk.landed) {
                (Some(instance), None) => member_landings(instance, path, &steps),
                _ => Vec::new(),
            };
            let joined = join_positions(&members.iter().map(|m| &m.landing).collect::<Vec<_>>()).map(|joined| joined.position);
            let landed = walk.landed.as_ref().map(present).or(joined.as_ref());
            if let (Some(stated), Some(landed)) = (&statement.landing, landed)
                && !untyped(landed)
            {
                let message = format!(
                    "'-[:{}]->' lands what {} describes, so its type is the module's — `<{}>` types only a landing its module leaves untyped (a webhook's body); drop it",
                    steps.last().map(|s| s.edge_type_id.as_str()).unwrap_or_default(),
                    statement.instance,
                    stated.graph
                );
                self.report(codes::LISTEN_SHAPE_MISMATCH, message, stated.span);
            }
            self.check_listen_fires(statement, path, &steps, Landed { landed, members: &members }, landing, scope);
        }
        let identity = match &plan {
            Some(plan) => plan.identity(),
            None => format!("{}::{}", spell_path_head(path), statement.movement),
        };
        if !self.listens.identities.insert(format!("path::{identity}")) {
            self.report(
                codes::LISTEN_DUPLICATE,
                format!("Duplicate listener — an identical 'listen to {}' already fires '{}'", spell_path_head(path), statement.movement),
                statement.span,
            );
        }
        if let Some(alias) = &statement.alias
            && !self.listens.aliases.insert(format!("{}::{alias}", statement.movement))
        {
            self.report(
                codes::LISTEN_ALIAS_DUPLICATE,
                format!("Two lanes of '{}' are both named \"{alias}\" — give each listen a distinct alias", statement.movement),
                statement.span,
            );
        }
        if self.recording() {
            let fires_movement = self.scopes.resolve_function(scope, &statement.movement).is_some_and(|id| self.scopes.symbol(id).kind == SymbolKind::Movement);
            let what = crate::story::What::Listen {
                instance: statement.instance.clone(),
                adapter_type: instance.as_ref().and_then(|i| i.adapter.clone()),
                fires: statement.movement.clone(),
                fires_movement,
                path: spell_path_head(path),
            };
            self.record_node(statement.span, scope, what);
        }
        // A host watches only a listen that checks clean, and a listen that
        // checks clean is watched: one with no plan says why where it is
        // written, never checks clean and then never fires.
        let clean = self.diagnostics[before.min(self.diagnostics.len())..].iter().all(|d| d.severity.is_some());
        if clean && plan.is_none() {
            match &instance {
                Some(described) if !described.schema.collections.is_empty() => {
                    let message = format!("listen-fire can't plan how to watch 'listen to {}' — this is a gap in the checker, so please report it with this program", spell_path_head(path));
                    self.report(codes::LISTEN_UNWATCHABLE, message, path.span);
                }
                _ => {
                    let message = format!(
                        "'{0}' has no description in the catalog, so listen-fire can't tell what this listen watches — it would never fire. The catalog describes it from the system behind '{0}': check that its connection resolves and the system answers, then check again.",
                        statement.instance
                    );
                    self.report(codes::EVENT_UNDESCRIBED, message, path.span);
                }
            }
        }
        match plan.filter(|_| clean) {
            Some(plan) => self.listens.plans.push((statement.span, plan)),
            None => self.listens.unwatched.push(statement.span),
        }
    }

    /// The connection a listen's traversal starts from, as a position.
    fn listen_root(&mut self, statement: &ListenDeclaration, path: &PathHead, scope: ScopeId) -> Option<Position> {
        let Some(PathRoot::Name { name }) = &path.root else { return None };
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return None };
        let symbol = self.scopes.symbol(id);
        match symbol.kind {
            SymbolKind::Instance => self.head_root_type(path, scope),
            // `check_path_head` refuses an adapter as a root.
            SymbolKind::Adapter => None,
            kind => {
                let message = format!(
                    "'{name}' is {} — a listen's traversal starts at a connection (e.g. 'listen to chat-[:Channels]->-[:Messages]-> fire {}')",
                    kind.describe(),
                    statement.movement
                );
                self.report(codes::LISTEN_NOT_INSTANCE, message, path.span);
                None
            }
        }
    }

    /// The hops as the connection's module declares them, once per member
    /// of each union they land on, each refused where a listen cannot take
    /// it, and the listen's one plan when every hop of every member can be
    /// watched: a listen over a union holds each member's hops.
    fn plan_listen(&mut self, statement: &ListenDeclaration, path: &PathHead, instance: &Instance, steps: &[EdgeStep], scope: ScopeId) -> Option<ListenPlan> {
        // The walk reported the edge it does not know.
        let members = declared_hops(&instance.schema, steps)?;
        let before = self.diagnostics.len();
        let mut watchable = true;
        for hops in &members {
            watchable &= self.listenable_hops(instance, hops, path);
        }
        // A WHERE is written once for every member.
        let mut aliases: Vec<&str> = Vec::new();
        for step in steps {
            aliases.extend(step.alias.as_deref());
            let Some(filter) = step.expression_filter.as_deref() else { continue };
            if let Some(name) = self.foreign_read(filter, &aliases, scope) {
                self.report(codes::LISTEN_IMPURE_WHERE, format!("a listen's WHERE reads only its hops and literals — '{name}' is neither"), path.span);
                watchable = false;
            }
        }
        let planned: Option<ListenPlan> = match watchable {
            true => {
                let plans: Vec<Option<ListenPlan>> = members.iter().map(|hops| self.plan_member(statement, path, instance, hops)).collect();
                plans.into_iter().collect::<Option<Vec<ListenPlan>>>().and_then(one_listen)
            }
            false => None,
        };
        // Members share the hops above their union, and say one refusal of
        // one of those once.
        let said = self.diagnostics.split_off(before.min(self.diagnostics.len()));
        let mut kept: Vec<crate::diagnostic::Diagnostic> = Vec::new();
        for diagnostic in said {
            if !kept.contains(&diagnostic) {
                kept.push(diagnostic);
            }
        }
        self.diagnostics.extend(kept);
        planned
    }

    /// Whether every hop of one member's traversal is one a listen can take:
    /// each before the last listed, the last announced. Each that is not is
    /// refused, named by the record type it hangs off.
    fn listenable_hops(&mut self, instance: &Instance, hops: &[Hop], path: &PathHead) -> bool {
        let Some((last, earlier)) = hops.split_last() else { return false };
        let mut watchable = true;
        for hop in earlier {
            if !hop.edge.readable() {
                let message = format!(
                    "'-[:{}]->' on {} can't be listed, so a listen can't pass through it — only a listen's last edge may be one that is only announced",
                    hop.step.edge_type_id,
                    owner(instance, hop.from)
                );
                self.report(codes::LISTEN_HOP_NOT_ITERABLE, message, path.span);
                watchable = false;
            }
        }
        if !last.edge.listenable() {
            let such_as = first_listenable(&instance.schema, last.from).map(|e| format!(", such as '-[:{e}]->'")).unwrap_or_default();
            let message = format!(
                "'-[:{}]->' on {} announces nothing, so a listen on it would never fire — a listen ends on an edge its module announces arrivals on{such_as}",
                last.step.edge_type_id,
                owner(instance, last.from)
            );
            self.report(codes::LISTEN_EDGE_NOT_LISTENABLE, message, path.span);
            watchable = false;
        }
        watchable
    }

    /// The plan of one member's traversal, every hop of which a listen can
    /// take: how the host honours each hop's filter, or a refusal where it
    /// can't.
    fn plan_member(&mut self, statement: &ListenDeclaration, path: &PathHead, instance: &Instance, hops: &[Hop]) -> Option<ListenPlan> {
        let schema: &InstanceSchema = &instance.schema;
        let module = instance.adapter.as_deref().unwrap_or(&instance.name);
        let last = hops.last()?;
        let carries = last.edge.carries();
        let mut planned = Vec::new();
        let mut unwatchable = false;
        for (i, hop) in hops.iter().enumerate() {
            let edge = hop.step.edge_type_id.as_str();
            let target = schema.positions.get(hop.to)?;
            let split = split_hop(hop.step.expression_filter.as_deref(), hop.step.alias.as_deref(), &hop.edge.view(edge, module), target).ok()?;
            let judged = match judging(hops, i) {
                Judging::Arrival => HopJudged::Arrival,
                Judging::Resolved => HopJudged::Resolved,
                Judging::None => HopJudged::None,
                Judging::Unwatchable => {
                    self.report_unwatchable(module, hop, &hops[i + 1..], instance, path);
                    unwatchable = true;
                    HopJudged::None
                }
            };
            let filter = hop.step.expression_filter.as_deref();
            // The judge reads only the records an arrival carries, so a hop
            // judged on it can read no earlier hop the arrival leaves behind.
            if judged == HopJudged::Arrival
                && let Some(read) = filter.and_then(|f| alias_reads(f).into_iter().find_map(|name| hops[..i].iter().position(|h| h.step.alias.as_deref() == Some(name)))).filter(|j| !carried(hops, carries, *j))
            {
                self.report_uncarried_read(module, hop, &hops[read], last, instance, path);
                unwatchable = true;
            }
            // A listed hop is judged only when it is listed again, so a
            // window measured from now would hold a record that has aged out.
            if judged == HopJudged::Resolved && filter.is_some_and(reads_now) {
                self.report_window_listed(hop, last, path);
                unwatchable = true;
            }
            planned.push(PlanHop {
                edge: edge.to_string(),
                from: hop.from.unwrap_or_default().to_string(),
                to: hop.to.to_string(),
                member_of: hop.member_of.map(str::to_string),
                alias: hop.step.alias.clone(),
                owned: owned_fields(&split.taken, target),
                taken: joined(split.taken),
                checked: joined(split.checked),
                judged,
            });
        }
        if unwatchable {
            return None;
        }
        Some(ListenPlan {
            movement: statement.movement.clone(),
            alias: statement.alias.clone(),
            connection: instance.name.clone(),
            adapter: module.to_string(),
            hops: planned,
            carries: carries.to_vec(),
            members: Vec::new(),
            landing: None,
        })
    }

    /// MOV_LISTEN_UNWATCHABLE: `hop`'s filter is neither carried by what
    /// arrives on the last edge nor cheap to re-check by listing. The way
    /// out is a wait, in a run, on one record `hop` lands on.
    fn report_unwatchable(&mut self, module: &str, hop: &Hop, below: &[Hop], instance: &Instance, path: &PathHead) {
        let Some(filter) = hop.step.expression_filter.as_deref() else { return };
        let Some(last) = below.last() else { return };
        let position = crate::types::position::display_name_of(instance, hop.to);
        let alias = hop.step.alias.clone().unwrap_or_else(|| position.chars().next().map_or("x".to_string(), |c| c.to_lowercase().to_string()));
        let rest: String = below[..below.len() - 1].iter().map(|h| format!("-[:{}]->", spell_name(&h.step.edge_type_id))).collect();
        let message = format!(
            "this listen filters '-[:{}]->' with `{}`, but {module}'s arrivals on '-[:{}]->' don't carry the {position} they are under, and listing every {position} to re-check it isn't cheap — filter on what arrives, or wait on one record in a run: `await {}{rest}-[:{}]->`",
            hop.step.edge_type_id,
            spell(filter, hop.step.alias.as_deref()),
            last.step.edge_type_id,
            spell_name(&alias),
            spell_name(&last.step.edge_type_id)
        );
        self.report(codes::LISTEN_UNWATCHABLE, message, path.span);
    }

    /// MOV_LISTEN_UNWATCHABLE: `hop` is judged on each arrival, and its filter
    /// reads `read`, an earlier hop the arrivals on `last` don't carry.
    fn report_uncarried_read(&mut self, module: &str, hop: &Hop, read: &Hop, last: &Hop, instance: &Instance, path: &PathHead) {
        let alias = spell_name(read.step.alias.as_deref().unwrap_or_default());
        let position = crate::types::position::display_name_of(instance, read.to);
        let message = format!(
            "this listen's filter on '-[:{}]->' reads `{alias}`, the {position} it is under, but {module}'s arrivals on '-[:{}]->' don't carry the {position}, so no arrival could be judged by it — compare with a literal, or wait in a run, where the {position} is a record the run holds",
            hop.step.edge_type_id,
            last.step.edge_type_id
        );
        self.report(codes::LISTEN_UNWATCHABLE, message, path.span);
    }

    /// MOV_LISTEN_UNWATCHABLE: `hop` is listed to find what to watch, and is
    /// judged only when it is listed again; `window` measures from now.
    fn report_window_listed(&mut self, hop: &Hop, last: &Hop, path: &PathHead) {
        let message = format!(
            "this listen filters '-[:{}]->' by a window measured from now (`WITHIN`), but that hop is listed to find what to watch, and judged again only when it is listed again, so a record that ages out of the window would keep firing — a window is judged on what arrives: put it on '-[:{}]->', or on a hop its arrivals carry",
            hop.step.edge_type_id,
            last.step.edge_type_id
        );
        self.report(codes::LISTEN_UNWATCHABLE, message, path.span);
    }

    /// A name `filter` reads that is neither one of `aliases` nor a field of
    /// the record its hop lands on, or a construct only a run can evaluate.
    fn foreign_read(&self, filter: &Expression, aliases: &[&str], scope: ScopeId) -> Option<String> {
        let is_alias = |name: &str| aliases.contains(&name);
        match filter {
            Expression::Property { property_type_id: name, field_only: false } | Expression::EdgeProperty { property_type_id: name, field_only: false } => {
                let variable = !is_alias(name) && matches!(self.scopes.resolve(scope, name), Resolution::Found(_));
                variable.then(|| name.clone())
            }
            Expression::AliasRef { name } => (!is_alias(name)).then(|| name.clone()),
            Expression::Traverse { .. } | Expression::Exists { .. } if walk_in(filter).is_some() => walk_in(filter),
            // `b.Name`: a field of another hop's record.
            Expression::Traverse { alias_root: Some(root), .. } if is_alias(root) => None,
            Expression::Traverse { alias_root: Some(root), .. } => Some(root.clone()),
            Expression::Meta { key } => Some(format!("@{key}")),
            Expression::Llm { .. } => Some("AI".to_string()),
            Expression::Exists { .. } => Some("EXISTS".to_string()),
            Expression::Function { fn_, .. } => Some(fn_.clone()),
            _ if !is_pure_predicate(filter) && crate::families::values::sub_expressions(filter).is_empty() => Some(spell(filter, None)),
            _ => crate::families::values::sub_expressions(filter).into_iter().find_map(|e| self.foreign_read(e, aliases, scope)),
        }
    }

    /// The node a listen states its landing is (`-[:Requests]-><Payment>`):
    /// one the program declares, else MOV_UNKNOWN_TYPE_NAME.
    fn landing_node(&mut self, stated: &TypeRef, scope: ScopeId) -> Option<SymbolId> {
        let name = stated.graph.as_str();
        let found = match self.scopes.resolve(scope, name) {
            Resolution::Found(id) => Some(id),
            _ => None,
        };
        if let Some(id) = found.filter(|id| self.declared_node(*id).is_some()) {
            return Some(id);
        }
        let message = if crate::checker::SCALAR_TYPE_NAMES.contains(&name) {
            format!("what lands is a record, not the value type '<{name}>' — declare the fields it carries: `node Payment {{ amount: <number> }}`, then `-[:…]-><Payment>`")
        } else if let Some(id) = found {
            format!("'{name}' is {}, not a node the program declares — a listen types what lands as one: `node {name} {{ … }}`", self.scopes.symbol(id).kind.describe())
        } else {
            format!("no node '{name}' is declared — declare the fields what lands carries: `node {name} {{ amount: <number> }}`")
        };
        self.report(codes::UNKNOWN_TYPE_NAME, message, stated.span);
        None
    }

    /// The function a listen fires takes one parameter, and what lands on
    /// the listen's last edge must be assignable to its type: the node the
    /// listen states it is, where its module leaves it untyped.
    fn check_listen_fires(&mut self, statement: &ListenDeclaration, path: &PathHead, steps: &[EdgeStep], landed: Landed, landing: Option<SymbolId>, scope: ScopeId) {
        let Landed { landed, members } = landed;
        let Some(last) = steps.last().map(|s| s.edge_type_id.as_str()) else { return };
        let Some(id) = self.resolve_reference(&statement.movement, statement.span, scope) else { return };
        let kind = self.scopes.symbol(id).kind;
        if kind == SymbolKind::FileImport {
            return;
        }
        if kind != SymbolKind::Movement {
            let message = format!("'{}' is {}, not a movement — 'fire' names a movement declared in this file", statement.movement, kind.describe());
            self.report(codes::CALL_NOT_MOVEMENT, message, statement.span);
            return;
        }
        let Some(info) = self.listens.movement_info(id) else { return };
        let (written, decl_scope): (Vec<_>, _) = (info.params.clone(), info.decl_scope);
        if written.len() != 1 {
            let message = format!(
                "'{}' takes {} parameters — a function a listen fires takes exactly one, what lands on '-[:{last}]->'",
                statement.movement,
                written.len()
            );
            self.report(codes::LISTEN_PARAM_MISMATCH, message, statement.span);
            return;
        }
        let Some(type_) = &written[0].type_ else { return };
        // What lands is a record of the connection the listen is on, and the
        // run is seeded on the one connection its parameter's type names.
        // A listen that states its landing's node fires with that node,
        // held to the parameter below.
        if let ParamTypeRef::Union(union) = type_
            && landing.is_none()
            && let Some(other) = union.members.iter().find(|member| member.graph != statement.instance)
        {
            let message = format!(
                "'{}' takes '{}: <{}>', but this listen fires with records of '{}' alone, and '<{}>' is another connection's — type every member of the union by '{}'",
                statement.movement,
                written[0].name,
                super::spell_param_type(type_),
                statement.instance,
                super::spell_param_type(&ParamTypeRef::Name(other.clone())),
                statement.instance
            );
            self.report(codes::LISTEN_PARAM_MISMATCH, message, statement.span);
            return;
        }
        if let Some(node) = landing {
            return self.check_listen_payload_param(node, &written[0], type_, decl_scope, statement);
        }
        // A stated type that names no node was refused where it is written.
        if statement.landing.is_some() {
            return;
        }
        if landed.is_some_and(untyped) {
            let message = format!(
                "'{}' takes '{}: <{}>', but what lands on '-[:{last}]->' is untyped — state its type after the traversal: `listen to {}<{}> fire {}`",
                statement.movement,
                written[0].name,
                super::spell_param_type(type_),
                spell_path_head(path),
                super::spell_param_type(type_),
                spell_name(&statement.movement)
            );
            self.report(codes::LISTEN_PARAM_MISMATCH, message, statement.span);
            return;
        }
        let declared = self.movement_declared_params(id).and_then(|p| p.into_iter().next());
        let param = declared.as_ref().and_then(|p| p.plane.pos.as_deref());
        // A listen over a union fires with what lands under each member, so
        // the parameter accepts every member's landing, as TypeScript's
        // parameter accepts every member of a union argument.
        if let Some(param) = param
            && !members.is_empty()
        {
            let refused: Vec<&MemberLanding> = members.iter().filter(|member| positions_match(&member.landing, param) == Some(false)).collect();
            if refused.is_empty() {
                return;
            }
            let lands: Vec<String> = refused.iter().map(|member| format!("'{}' lands {}", member.path, describe_position(&member.landing))).collect();
            let message = format!(
                "'{}' takes '{}: <{}>', but a listen over a union fires with what lands under every member, and {} — the parameter's type must accept {}",
                statement.movement,
                written[0].name,
                super::spell_param_type(type_),
                lands.join(" and "),
                if refused.len() == 1 { "it" } else { "each" }
            );
            self.report(codes::LISTEN_PARAM_MISMATCH, message, statement.span);
            return;
        }
        let fits = match (param, landed) {
            (None, _) => declared.as_ref().is_none_or(|p| p.plane.field.is_none()),
            (Some(param), Some(landed)) => positions_match(landed, param) != Some(false),
            (Some(_), None) => true,
        };
        if fits {
            return;
        }
        let wrote = format!("<{}>", super::spell_param_type(type_));
        let message = format!(
            "'{}' takes '{}: {wrote}', but this listen fires with what lands on '-[:{last}]->' ('<{}>') — the parameter's type must accept it",
            statement.movement,
            written[0].name,
            spell_path_head(path)
        );
        self.report(codes::LISTEN_PARAM_MISMATCH, message, statement.span);
    }
}

/// What a listen fires its function with: the walk's landing, and, past a
/// union whose members land on different record types, each member's.
struct Landed<'a> {
    landed: Option<&'a Position>,
    members: &'a [MemberLanding],
}

/// What lands under one member of a union a listen goes through or onto,
/// and that member's traversal as an author reads it.
struct MemberLanding {
    path: String,
    landing: Position,
}

/// Each member traversal's landing, where the hops go through or onto a
/// union; none where they do not.
fn member_landings(instance: &InstanceRef, path: &PathHead, steps: &[EdgeStep]) -> Vec<MemberLanding> {
    let Some(members) = declared_hops(&instance.schema, steps).filter(|members| members.len() > 1) else { return Vec::new() };
    let root = match &path.root {
        Some(PathRoot::Name { name }) => spell_name(name),
        _ => String::new(),
    };
    let landings: Option<Vec<MemberLanding>> = members
        .iter()
        .map(|hops| {
            let landing = position_ref_in(instance, hops.last()?.to)?;
            let spelled: String = hops
                .iter()
                .map(|hop| {
                    let member = hop.member_of.map(|_| format!("<{}>", display_name_of(instance, hop.to))).unwrap_or_default();
                    format!("-[:{}]->{member}", hop.step.edge_type_id)
                })
                .collect();
            Some(MemberLanding { path: format!("{root}{spelled}"), landing })
        })
        .collect();
    landings.unwrap_or_default()
}

/// The one plan of a listen planned once per member: the member's own where
/// its hops cross no union, else one holding each member's hops. None for
/// no member.
fn one_listen(mut plans: Vec<ListenPlan>) -> Option<ListenPlan> {
    let crosses_a_union = plans.iter().any(|plan| plan.hops.iter().any(|hop| hop.member_of.is_some()));
    if !crosses_a_union {
        return (plans.len() == 1).then(|| plans.pop()).flatten();
    }
    let members = plans.iter_mut().map(|plan| PlanMember { hops: std::mem::take(&mut plan.hops), carries: std::mem::take(&mut plan.carries) }).collect();
    let first = plans.into_iter().next()?;
    Some(ListenPlan { members, ..first })
}

/// Each hop's edge as the schema declares it, from the connection down: one
/// traversal per member of each union a hop lands on, the next hop then
/// declared off that member. None when a hop names nothing the schema
/// declares (the walk said so), or there are no hops.
fn declared_hops<'a>(schema: &'a InstanceSchema, steps: &'a [EdgeStep]) -> Option<Vec<Vec<Hop<'a>>>> {
    let mut members: Vec<Vec<Hop<'a>>> = vec![Vec::new()];
    for step in steps {
        let edge = step.edge_type_id.as_str();
        let mut next = Vec::new();
        for hops in members {
            let from = hops.last().map(|hop| hop.to);
            let (declared, target) = match from {
                None => schema.collections.get(edge).map(|c| (Declared::Collection(c), c.target.as_str())),
                Some(position) => schema.positions.get(position).and_then(|p| p.edges.get(edge)).map(|e| (Declared::Edge(e), e.target.as_str())),
            }?;
            let landings: Vec<(&str, Option<&str>)> = match schema.unions.as_ref().and_then(|unions| unions.get(target)) {
                Some(union) => union.iter().map(|member| (member.as_str(), Some(target))).collect(),
                None => vec![(target, None)],
            };
            for (to, member_of) in landings {
                let mut hops = hops.clone();
                hops.push(Hop { step, from, to, member_of, edge: declared });
                next.push(hops);
            }
        }
        members = next;
    }
    members.iter().all(|hops| !hops.is_empty()).then_some(members)
}

/// How the host honours hop `i`'s filter: judged on each arrival, by listing
/// the hop's members, not at all (no filter), or by neither.
#[derive(Clone, Copy, PartialEq)]
enum Judging {
    Arrival,
    Resolved,
    None,
    Unwatchable,
}

fn judging(hops: &[Hop], i: usize) -> Judging {
    let last = &hops[hops.len() - 1];
    let hop = &hops[i];
    if i == hops.len() - 1 {
        Judging::Arrival
    } else if last.edge.delivery() == Some(Delivery::Scope) {
        // Under a scope the host lists every head to subscribe to it, so it
        // judges their filters as it lists them, whatever listing costs.
        Judging::Resolved
    } else if hop.step.expression_filter.is_none() {
        Judging::None
    } else if last.edge.carries().iter().any(|c| *c == hop.step.edge_type_id) {
        Judging::Arrival
    } else if hops[..=i].iter().all(|h| h.edge.members_change_learnt()) {
        Judging::Resolved
    } else {
        Judging::Unwatchable
    }
}

/// Whether an arrival on the last edge carries hop `j`'s record: the k-th
/// hop on an edge name is the k-th carried record of it, as the judge reads
/// them.
fn carried(hops: &[Hop], carries: &[String], j: usize) -> bool {
    let edge = hops[j].step.edge_type_id.as_str();
    let nth = hops[..j].iter().filter(|h| h.step.edge_type_id == edge).count();
    carries.iter().filter(|c| *c == edge).count() > nth
}

/// Whether `filter` compares anything with a window measured from now
/// (`WITHIN`).
fn reads_now(filter: &Expression) -> bool {
    match filter {
        Expression::Compare { op: movement_parser::lowering::expression::FilterOperator::Within, .. } => true,
        other => crate::families::values::sub_expressions(other).into_iter().any(reads_now),
    }
}

/// Where an edge is declared, as a sentence names it: the connection for a
/// root collection, else `at's Table`.
fn owner(instance: &Instance, from: Option<&str>) -> String {
    match from {
        None => instance.name.clone(),
        Some(position) => format!("{}'s {}", instance.name, crate::types::position::display_name_of(instance, position)),
    }
}

/// The first edge declared beside one a listen cannot end on that it can.
fn first_listenable(schema: &InstanceSchema, from: Option<&str>) -> Option<String> {
    match from {
        None => schema.collections.iter().find(|(_, c)| c.listenable == Some(true)).map(|(name, _)| name.clone()),
        Some(position) => {
            let edges = &schema.positions.get(position).map(|p: &PositionSchema| &p.edges)?;
            edges.iter().find(|(_, e)| e.listenable == Some(true)).map(|(name, _)| name.clone())
        }
    }
}

/// A landing whose fields its module does not list (a webhook's body): a
/// listen states its type.
fn untyped(landed: &Position) -> bool {
    crate::types::position::position_schema_of_ref(landed).is_some_and(|schema| schema.open_properties == Some(true) || schema.undescribed == Some(true))
}

/// The record a landing that may be empty holds when it is not.
fn present(position: &Position) -> &Position {
    match position {
        Position::MaybeEmpty(of) => present(of),
        other => other,
    }
}

/// The first walk `expr` takes, as written (`h-[:Messages]->`): a hop off
/// a record, whatever it starts from, and EXISTS of one. Only a run can
/// take one.
fn walk_in(expr: &Expression) -> Option<String> {
    let spelled = |root: Option<&str>, steps: &[TraversalStep]| {
        Some(match steps.first()? {
            TraversalStep::Edge(step) => format!("{}-[:{}]->", root.unwrap_or_default(), step.edge_type_id),
            _ => spell(expr, None),
        })
    };
    match expr {
        Expression::Traverse { alias_root, steps, expression, .. } => {
            spelled(alias_root.as_deref(), steps).or_else(|| match &**expression {
                // `EXISTS(h-[:E]->)` lowers as EXISTS read off `h`.
                Expression::Exists { steps, .. } => spelled(alias_root.as_deref(), steps),
                inner => walk_in(inner),
            })
        }
        Expression::Exists { steps, .. } => spelled(None, steps),
        other => crate::families::values::sub_expressions(other).into_iter().find_map(walk_in),
    }
}

/// `step` with the conjuncts of its WHERE that walk taken out.
fn without_walks(step: TraversalStep) -> TraversalStep {
    let TraversalStep::Edge(mut edge) = step else { return step };
    if let Some(filter) = edge.expression_filter.take() {
        let kept: Vec<Expression> = crate::types::event_address::conjuncts(&filter).into_iter().filter(|c| walk_in(c).is_none()).cloned().collect();
        edge.expression_filter = joined(kept).map(Box::new);
    }
    TraversalStep::Edge(edge)
}

/// Conjuncts joined back by AND; `None` for none.
fn joined(mut conjuncts: Vec<Expression>) -> Option<Expression> {
    match conjuncts.len() {
        0 => None,
        1 => conjuncts.pop(),
        _ => Some(Expression::Logical { op: LogicalOp::And, operands: conjuncts }),
    }
}

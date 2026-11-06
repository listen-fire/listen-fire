//! Narrowing a hop by its WHERE under listen-fire: lf-platform's
//! `translation_graph/movement/refinements.ts` (`refineInstanceSchema`) and
//! the scan that feeds it (legacy-lang `service/selectors.ts`,
//! `scanInstanceChains`), ported rule for rule. The why of each rule is
//! there; the comments here say only what listen-fire does differently.
//!
//! `pipeline-[b:Base WHERE b.Name == "Pipeline Tracker"]->` lands on one
//! base, not on every base: the WHERE is evaluated over the members the
//! connection's walk handed over, the chosen member is walked to and
//! projected, and the checker finds it under the hop's refinement key, so
//! the base's tables are its edges.
//!
//! Where listen-fire differs:
//!
//! - A WHERE that the members decide and that selects none of them is
//!   recorded under its key with the members there are (`unselected`), and
//!   the checker refuses the hop where it is written. The platform leaves the
//!   hop on the unnarrowed type, so the refusal lands on a later read.
//! - A walk the module fails fails the check, naming the external, as a
//!   failed describe does; the platform notes it and narrows nothing.
//! - Each node the chosen member's edges land on that the schema lacks is
//!   walked to and projected too (one hop each, along the path the member's
//!   own hop handed over), so a write to one of a narrowed base's tables is
//!   checked against its fields. The platform describes those only when the
//!   program names them where its demand scan looks.

use std::collections::{BTreeMap, HashSet};

use indexmap::IndexMap;
use movement_checker::slots::{expression_of_slot, expression_of_text};
use movement_checker::types::event_address::conjuncts;
use movement_parser::ast::{
    ArmExpression, AwaitExpression, AwaitSource, CallArg, CallbackSubject, ClosureExpression, CollectionOpExpression, CombinatorArms, CombinatorExpression,
    ExprSlot, LinkTarget, MovementParam, NodeEntry, NodeLiteral, ParamTypeRef, PathHead, PathRoot, RValue, Statement, TypeRef, UniqueClause, UntilCondition,
    WriteTarget,
};
use movement_parser::lowering::expression::{Expression, ListElement, ObjectMember, TraversalStep};

use crate::json::{Js, Obj};
use crate::member_walk::{Walk, Walker};
use crate::obj;
use crate::secrets::{Construction, construction_of};

/// One hop chain the program walks from a constructed instance
/// (`InstanceChain`), its WHEREs as written.
#[derive(Clone, Debug, PartialEq)]
pub struct InstanceChain {
    pub construction: Construction,
    pub steps: Vec<TraversalStep>,
    /// The position the chain starts at, when it starts at a typed
    /// parameter rather than the connection's root.
    pub start_position: Option<String>,
}

/// `scanInstanceChains`: every hop chain the program walks from a
/// constructed instance, through block aliases, write handles, awaited and
/// lazy landings, parameters typed with a position, and every expression
/// slot. A chain whose root is no name the scan can follow is skipped.
pub fn instance_chains(statements: &[Statement], originals: &BTreeMap<String, String>) -> Vec<InstanceChain> {
    let mut scan = Scan { originals, bindings: BTreeMap::new(), chains: Vec::new() };
    scan.walk(statements, &Scope::new());
    scan.chains
}

/// `AliasGrounding`: the instance a name roots at, and the steps to it.
#[derive(Clone)]
struct Grounding {
    construction: Construction,
    prefix: Vec<TraversalStep>,
    start_position: Option<String>,
}

type Scope = BTreeMap<String, Grounding>;

struct Scan<'a> {
    originals: &'a BTreeMap<String, String>,
    bindings: BTreeMap<String, Construction>,
    chains: Vec<InstanceChain>,
}

/// A path head's hops, read by the expression grammar as the checker reads them.
fn steps_of(head: &PathHead) -> Option<Vec<TraversalStep>> {
    if head.root.is_none() || head.hops_raw.is_empty() {
        return None;
    }
    let probe = format!("__movement_path_root__{}.`__movement_selector_probe__`", head.hops_raw);
    match expression_of_text(&probe).ok()? {
        Expression::Traverse { steps, .. } => Some(steps),
        _ => None,
    }
}

impl Scan<'_> {
    fn ground_root(&self, root: &str, steps: Vec<TraversalStep>, scope: &Scope) -> Option<Grounding> {
        if let Some(construction) = self.bindings.get(root) {
            return Some(Grounding { construction: construction.clone(), prefix: steps, start_position: None });
        }
        let via = scope.get(root)?;
        Some(Grounding { construction: via.construction.clone(), prefix: [via.prefix.clone(), steps].concat(), start_position: via.start_position.clone() })
    }

    fn ground_head(&self, head: &PathHead, scope: &Scope) -> Option<Grounding> {
        let Some(PathRoot::Name { name }) = &head.root else { return None };
        let steps = steps_of(head).filter(|s| !s.is_empty())?;
        self.ground_root(name, steps, scope)
    }

    fn emit(&mut self, grounding: &Grounding) {
        self.chains.push(InstanceChain { construction: grounding.construction.clone(), steps: grounding.prefix.clone(), start_position: grounding.start_position.clone() });
    }

    fn visit_head(&mut self, head: &PathHead, scope: &Scope) {
        if let Some(grounded) = self.ground_head(head, scope) {
            self.emit(&grounded);
        }
    }

    /// `visitLanding`: a traversal that binds its landing.
    fn visit_landing(&mut self, head: &PathHead, scope: &Scope) -> Option<Grounding> {
        let grounded = self.ground_head(head, scope)?;
        self.emit(&grounded);
        Some(grounded)
    }

    fn visit_expression(&mut self, expr: &Expression, scope: &Scope) {
        let filters = |steps: &[TraversalStep]| -> Vec<Expression> {
            steps
                .iter()
                .filter_map(|s| match s {
                    TraversalStep::Edge(edge) => edge.expression_filter.as_deref().cloned(),
                    _ => None,
                })
                .collect()
        };
        match expr {
            Expression::Traverse { alias_root, steps, expression, .. } => {
                let walked: Vec<TraversalStep> = match expression.as_ref() {
                    Expression::Exists { steps: inner, .. } => [steps.clone(), inner.clone()].concat(),
                    _ => steps.clone(),
                };
                if let Some(root) = alias_root
                    && !walked.is_empty()
                    && let Some(grounded) = self.ground_root(root, walked, scope)
                {
                    self.emit(&grounded);
                }
                for filter in filters(steps) {
                    self.visit_expression(&filter, scope);
                }
                self.visit_expression(expression, scope);
            }
            Expression::Exists { steps, where_ } => {
                for filter in filters(steps) {
                    self.visit_expression(&filter, scope);
                }
                if let Some(where_) = where_ {
                    self.visit_expression(where_, scope);
                }
            }
            Expression::ResourceTraverse { expression, .. }
            | Expression::Not { expression }
            | Expression::Negate { expression }
            | Expression::Aggregate { expression, .. } => self.visit_expression(expression, scope),
            Expression::List { elements } => {
                for element in elements {
                    match element {
                        ListElement::Expression(e) => self.visit_expression(e, scope),
                        ListElement::Spread(spread) => self.visit_expression(&spread.expression, scope),
                    }
                }
            }
            Expression::Object { entries } => {
                for entry in entries {
                    match entry {
                        ObjectMember::Entry { value, .. } => self.visit_expression(value, scope),
                        ObjectMember::Spread(spread) => self.visit_expression(&spread.expression, scope),
                    }
                }
            }
            Expression::Arithmetic { left, right, .. } | Expression::Compare { left, right, .. } => {
                self.visit_expression(left, scope);
                self.visit_expression(right, scope);
            }
            Expression::Logical { operands: parts, .. } | Expression::Concat { parts } | Expression::Function { args: parts, .. } | Expression::KgExists { params: parts, .. } => {
                for part in parts {
                    self.visit_expression(part, scope);
                }
            }
            Expression::Conditional { condition, then, else_ } => {
                self.visit_expression(condition, scope);
                self.visit_expression(then, scope);
                self.visit_expression(else_, scope);
            }
            Expression::At { expression, index } => {
                self.visit_expression(expression, scope);
                self.visit_expression(index, scope);
            }
            Expression::Llm { prompt_expression: Some(prompt), .. } => self.visit_expression(prompt, scope),
            _ => {}
        }
    }

    /// An unparseable slot scans nothing: the checker reports it.
    fn visit_slot(&mut self, slot: &ExprSlot, scope: &Scope) {
        if let Ok(parsed) = expression_of_slot(slot) {
            self.visit_expression(&parsed, scope);
        }
    }

    /// `visitWrite`, for a write or a match: its target, its fields, its identity.
    fn visit_write(&mut self, target: &WriteTarget, fields: &[movement_parser::ast::FieldEntry], unique_by: &[UniqueClause], scope: &Scope) {
        match target {
            WriteTarget::Linked { path, .. } => self.visit_head(path, scope),
            WriteTarget::Tuple { paths, .. } => {
                for path in paths {
                    self.visit_head(path, scope);
                }
            }
            WriteTarget::Position { .. } => {}
        }
        for field in fields {
            self.visit_slot(&field.value, scope);
        }
        for clause in unique_by {
            self.visit_slot(&clause.predicate, scope);
        }
    }

    /// `writeHandleGrounding`: a linked write's handle names the record it wrote.
    fn write_handle(&self, target: &WriteTarget, scope: &Scope) -> Option<Grounding> {
        let WriteTarget::Linked { path, .. } = target else { return None };
        self.ground_head(path, scope)
    }

    fn visit_node(&mut self, node: &NodeLiteral, scope: &Scope) {
        for entry in &node.entries {
            match entry {
                NodeEntry::Value { value, .. } => self.visit_slot(value, scope),
                NodeEntry::Traversal { head, mapping, .. } => {
                    self.visit_landing(head, scope);
                    if let Some(mapping) = mapping {
                        let inner = self.block_scope(head, scope);
                        self.visit_node(mapping, &inner);
                    }
                }
                NodeEntry::Nodes { nodes, .. } => {
                    for nested in nodes {
                        self.visit_node(nested, scope);
                    }
                }
                NodeEntry::Declared { .. } => {}
            }
        }
    }

    fn visit_call_arg(&mut self, arg: &CallArg, scope: &Scope) {
        match arg {
            CallArg::Expr { expr, .. } => self.visit_slot(expr, scope),
            CallArg::Write { write, .. } => self.visit_write(&write.target, &write.fields, &write.unique_by, scope),
            CallArg::Call { call, .. } => {
                for nested in &call.args {
                    self.visit_call_arg(nested, scope);
                }
            }
            CallArg::Node { node, .. } => self.visit_node(node, scope),
            CallArg::Closure { closure, .. } => self.walk_closure(closure, scope),
            CallArg::Type { .. } => {}
        }
    }

    /// `walkClosure`: the captured scope, less the names its parameters rebind.
    fn walk_closure(&mut self, closure: &ClosureExpression, scope: &Scope) {
        let mut inner = scope.clone();
        for param in &closure.params {
            self.visit_written_type(param.type_.as_ref());
            match self.param_grounding(param) {
                Some(grounding) => inner.insert(param.name.clone(), grounding),
                None => inner.remove(&param.name),
            };
        }
        self.visit_written_type(closure.return_type.as_ref());
        self.walk(&closure.body, &inner);
    }

    /// `paramGrounding`: a parameter typed with a position roots chains there.
    fn param_grounding(&self, param: &MovementParam) -> Option<Grounding> {
        let Some(ParamTypeRef::Name(type_ref)) = &param.type_ else { return None };
        self.type_grounding(type_ref)
    }

    /// The record type a written type names on a constructed connection.
    fn type_grounding(&self, type_ref: &TypeRef) -> Option<Grounding> {
        let position = type_ref.position.clone()?;
        let construction = self.bindings.get(&type_ref.graph)?;
        Some(Grounding { construction: construction.clone(), prefix: Vec::new(), start_position: Some(position) })
    }

    /// A written type names the record types it holds, each one a chain of
    /// no hops: a type a narrowing makes (`<at-[:\`Candidates Change\`]->>`)
    /// is grafted as when a walk narrows to it.
    fn visit_written_type(&mut self, written: Option<&ParamTypeRef>) {
        let named: Vec<&TypeRef> = match written {
            Some(ParamTypeRef::Name(type_ref)) => vec![type_ref],
            Some(ParamTypeRef::Union(union)) => union.members.iter().collect(),
            Some(ParamTypeRef::Value(_)) | None => Vec::new(),
        };
        for type_ref in named {
            if let Some(grounding) = self.type_grounding(type_ref) {
                self.emit(&grounding);
            }
        }
    }

    /// `blockScope`: a block head grounds each of its hop aliases for the body.
    fn block_scope(&self, head: &PathHead, scope: &Scope) -> Scope {
        let Some(grounded) = self.ground_head(head, scope) else { return scope.clone() };
        let mut inner = scope.clone();
        for (i, step) in grounded.prefix.iter().enumerate() {
            if let TraversalStep::Edge(edge) = step
                && let Some(alias) = &edge.alias
            {
                let prefix = grounded.prefix[..=i].to_vec();
                inner.insert(alias.clone(), Grounding { construction: grounded.construction.clone(), prefix, start_position: grounded.start_position.clone() });
            }
        }
        inner
    }

    fn visit_await(&mut self, awaiting: &AwaitExpression, scope: &Scope) -> Option<Grounding> {
        match &awaiting.source {
            AwaitSource::Sleep { .. } => None,
            AwaitSource::Until { condition, .. } => {
                match condition {
                    UntilCondition::Expr { expr } => self.visit_slot(expr, scope),
                    UntilCondition::Closure { closure } => self.walk_closure(closure, scope),
                }
                None
            }
            AwaitSource::Combinator { combinator, .. } => {
                self.visit_combinator(combinator, scope);
                None
            }
            AwaitSource::Traversal { head, .. } => self.visit_landing(head, scope),
        }
    }

    fn visit_combinator(&mut self, combinator: &CombinatorExpression, scope: &Scope) {
        if let CombinatorArms::Dynamic { expr, .. } = &combinator.arms {
            self.visit_slot(expr, scope);
            return;
        }
        for arm in combinator.arms.written() {
            if let ArmExpression::Closure { closure, .. } = arm {
                self.walk_closure(closure, scope);
            }
        }
    }

    fn visit_collection_op(&mut self, op: &CollectionOpExpression, scope: &Scope) {
        self.visit_slot(&op.source, scope);
        for slot in [&op.init, &op.config].into_iter().flatten() {
            self.visit_slot(slot, scope);
        }
    }

    /// What a binding's or a `return`'s right-hand side walks; the grounding
    /// of the name it binds, when it names one record a hop reached.
    fn visit_value(&mut self, value: &RValue, scope: &Scope) -> Option<Grounding> {
        match value {
            RValue::Construct { .. } | RValue::Members { .. } => None,
            RValue::Block { block } => {
                self.visit_head(&block.head, scope);
                let inner = self.block_scope(&block.head, scope);
                self.walk(&block.body, &inner);
                None
            }
            RValue::Write { write } => {
                self.visit_write(&write.target, &write.fields, &write.unique_by, scope);
                self.write_handle(&write.target, scope)
            }
            RValue::Match { r#match } => {
                self.visit_write(&r#match.target, &r#match.fields, &r#match.unique_by, scope);
                self.write_handle(&r#match.target, scope)
            }
            RValue::Link { link } => match &link.to {
                LinkTarget::Match { r#match, .. } => {
                    self.visit_write(&r#match.target, &r#match.fields, &r#match.unique_by, scope);
                    self.write_handle(&r#match.target, scope)
                }
                LinkTarget::Handle { .. } => None,
            },
            RValue::Expr { expr } => {
                self.visit_slot(expr, scope);
                None
            }
            RValue::Extract { extract } => {
                for slot in &extract.from {
                    self.visit_slot(slot, scope);
                }
                None
            }
            RValue::ExtractCall { extract_call } => {
                self.visit_slot(&extract_call.content, scope);
                None
            }
            RValue::Await { r#await } => self.visit_await(r#await, scope),
            RValue::Combinator { combinator } => {
                self.visit_combinator(combinator, scope);
                None
            }
            RValue::Call { call } => {
                for arg in &call.args {
                    self.visit_call_arg(arg, scope);
                }
                None
            }
            RValue::Node { node } => {
                self.visit_node(node, scope);
                None
            }
            RValue::Collection { collection } => {
                self.visit_collection_op(collection, scope);
                None
            }
            RValue::Lazy { lazy } => {
                let landing = self.visit_landing(&lazy.head, scope);
                match &lazy.mapping {
                    // A mapped walk binds synthesised landings, not the nodes it walked.
                    Some(mapping) => {
                        let inner = self.block_scope(&lazy.head, scope);
                        self.visit_node(mapping, &inner);
                        None
                    }
                    None => landing,
                }
            }
            RValue::InlineBlock { inline_block } => {
                self.walk(&inline_block.body, scope);
                None
            }
            RValue::Closure { closure } => {
                self.walk_closure(closure, scope);
                None
            }
            RValue::Callback { callback } => {
                match &callback.subject {
                    CallbackSubject::Inline { closure, .. } => self.walk_closure(closure, scope),
                    CallbackSubject::Named { args, .. } => {
                        for arg in args {
                            self.visit_call_arg(arg, scope);
                        }
                    }
                }
                None
            }
        }
    }

    fn walk(&mut self, statements: &[Statement], outer: &Scope) {
        let mut scope = outer.clone();
        for statement in statements {
            match statement {
                Statement::Assign(assign) => {
                    if let RValue::Construct { construct } = &assign.value {
                        self.bindings.insert(assign.name.clone(), construction_of(construct, self.originals));
                        continue;
                    }
                    if let Some(grounding) = self.visit_value(&assign.value, &scope) {
                        scope.insert(assign.name.clone(), grounding);
                    }
                }
                Statement::Return(returned) => {
                    self.visit_value(&returned.value, &scope);
                }
                Statement::Block(block) => {
                    self.visit_head(&block.block.head, &scope);
                    let inner = self.block_scope(&block.block.head, &scope);
                    self.walk(&block.block.body, &inner);
                }
                Statement::Write(write) => self.visit_write(&write.write.target, &write.write.fields, &write.write.unique_by, &scope),
                Statement::Match(matching) => self.visit_write(&matching.r#match.target, &matching.r#match.fields, &matching.r#match.unique_by, &scope),
                Statement::Link(link) => {
                    if let LinkTarget::Match { r#match, .. } = &link.link.to {
                        self.visit_write(&r#match.target, &r#match.fields, &r#match.unique_by, &scope);
                    }
                }
                Statement::Call(call) => {
                    for arg in &call.args {
                        self.visit_call_arg(arg, &scope);
                    }
                }
                Statement::Collection(collection) => self.visit_collection_op(&collection.collection, &scope),
                Statement::Movement(movement) => {
                    let mut inner = scope.clone();
                    self.visit_written_type(movement.return_type.as_ref());
                    for param in &movement.params {
                        self.visit_written_type(param.type_.as_ref());
                        if let Some(grounding) = self.param_grounding(param) {
                            inner.insert(param.name.clone(), grounding);
                        }
                    }
                    self.walk(&movement.body, &inner);
                }
                Statement::Await(awaiting) => {
                    self.visit_await(&awaiting.r#await, &scope);
                }
                Statement::Combinator(combinator) => self.visit_combinator(&combinator.combinator, &scope),
                Statement::If(branch) => {
                    for arm in &branch.arms {
                        self.visit_slot(&arm.condition, &scope);
                        self.walk(&arm.body, &scope);
                    }
                    if let Some(otherwise) = &branch.else_arm {
                        self.walk(&otherwise.body, &scope);
                    }
                }
                Statement::Error(error) => self.visit_slot(&error.message, &scope),
                // A listen on a traversal walks its hops as an await does:
                // a WHERE that picks one member of an earlier hop narrows
                // what the later hops land on. A listen in the settings
                // form walks nothing.
                Statement::Listen(listen) => {
                    if let Some(path) = &listen.path {
                        self.visit_landing(path, &scope);
                    }
                }
                Statement::Import(_)
                | Statement::Shape(_)
                | Statement::Type(_)
                | Statement::Unlink(_)
                | Statement::Delete(_)
                | Statement::Refresh(_) => {}
            }
        }
    }
}

/// What a connection's hops are narrowed with.
pub struct Refining<'a, 'w, W> {
    /// The adapter the catalog files the connection under.
    pub adapter: &'a str,
    /// Its `listEntryPoints` answer, for projecting a walked node.
    pub entries: &'a [Js],
    /// What its module lists: whether what lands off a walked node says who acted (crate::actor).
    pub methods: &'a [String],
    pub walker: &'a Walker<'w, W>,
}

/// `refineInstanceSchema`: `schema` with a refined position grafted for each
/// selection the chains make that its members decide, registered under the
/// selection's refinement key (`refinements`, `selectedMembers`), and the
/// fields each type the hops land on narrows by (`narrowBy`). A selection
/// that its members decide and that selects none of them is recorded under
/// its key with the members there are (`unselected`). No chains, and it
/// comes back as it was. A walk the module fails is this call's error.
pub async fn refine_instance_schema<W: Walk>(schema: Js, chains: &[&InstanceChain], input: &Refining<'_, '_, W>) -> Result<Js, String> {
    let Js::Obj(schema) = schema else { return Ok(schema) };
    if chains.is_empty() {
        return Ok(Js::Obj(schema));
    }
    let mut refining = Grafting { input, schema, attempted: HashSet::new(), grafted: IndexMap::new() };
    for chain in chains {
        let mut current = chain.start_position.clone();
        if let Some(named) = &current
            && refining.position(named).is_none()
        {
            refining.ground_named(named).await?;
        }
        for step in &chain.steps {
            let TraversalStep::Edge(edge) = step else { break };
            let target = match &current {
                None => refining.schema.get("collections").and_then(|c| c.get(&edge.edge_type_id)),
                Some(at) => refining.position(at).and_then(|p| p.get("edges")).and_then(|e| e.get(&edge.edge_type_id)),
            };
            let Some(target) = target.and_then(|t| t.get("target")).and_then(Js::as_str).map(str::to_string) else { break };
            let refined = match edge.expression_filter.as_deref() {
                Some(filter) => refining.graft(&target, filter).await?,
                None => None,
            };
            current = Some(refined.unwrap_or(target));
        }
    }
    Ok(Js::Obj(refining.schema))
}

struct Grafting<'a, 'i, 'w, W> {
    input: &'a Refining<'i, 'w, W>,
    schema: Obj,
    attempted: HashSet<String>,
    /// The refined positions this pass grafted, each with the member type it lands.
    grafted: IndexMap<String, String>,
}

impl<W: Walk> Grafting<'_, '_, '_, W> {
    fn position(&self, name: &str) -> Option<&Js> {
        self.schema.get("positions").and_then(|p| p.get(name))
    }

    fn entry(&mut self, map: &str) -> &mut Obj {
        match self.schema.entry(map.to_string()).or_insert_with(|| Js::Obj(Obj::new())) {
            Js::Obj(entries) => entries,
            other => {
                *other = Js::Obj(Obj::new());
                let Js::Obj(entries) = other else { unreachable!() };
                entries
            }
        }
    }

    async fn record_narrow_by(&mut self, type_name: &str) -> Result<(), String> {
        if self.schema.get("narrowBy").and_then(|n| n.get(type_name)).is_some() {
            return Ok(());
        }
        let members = self.input.walker.members_of(type_name).await?;
        let fields = narrow_by_of(&members);
        if !fields.is_empty() {
            self.entry("narrowBy").insert(type_name.to_string(), Js::strings(&fields));
        }
        Ok(())
    }

    /// The refined position `filter` selects on `type_name`, grafted once per key.
    async fn graft(&mut self, type_name: &str, filter: &Expression) -> Result<Option<String>, String> {
        let filter_json = serde_json::to_value(filter).map_err(|e| e.to_string())?;
        let key = movement_parser::catalog::helpers::refinement_key(type_name, &filter_json);
        if let Some(refined) = self.schema.get("refinements").and_then(|r| r.get(&key)).and_then(Js::as_str) {
            return Ok(Some(refined.to_string()));
        }
        if !self.attempted.insert(key.clone()) {
            return Ok(None);
        }
        let failed = |why: String| format!("narrowing {type_name} by its WHERE failed: {why}");
        self.record_narrow_by(type_name).await.map_err(failed)?;

        let members = self.input.walker.members_of(type_name).await.map_err(failed)?;
        let selected = match select_member_for(&members, filter) {
            Selection::Selected(member) => member,
            Selection::NotPolymorphic | Selection::Undecidable => return Ok(None),
            Selection::NoMatch => {
                let names = members.iter().map(|(name, _)| name.as_str());
                self.entry("unselected").insert(key, Js::strings(names));
                return Ok(None);
            }
        };

        let Some(refined_name) = self.graft_member(type_name, &selected, &key).await.map_err(failed)? else { return Ok(None) };
        let member_type = self.grafted.get(&refined_name).cloned().unwrap_or_default();
        self.entry("refinements").insert(key.clone(), Js::str(&refined_name));
        self.entry("selectedMembers").insert(key, Js::str(member_type));
        Ok(Some(refined_name))
    }

    /// `selected`, a member of `type_name`, grafted as its refined position
    /// with the nodes its edges land on, once however many selections or
    /// names reach it. `synthetic` names it to the projection.
    async fn graft_member(&mut self, type_name: &str, selected: &str, synthetic: &str) -> Result<Option<String>, String> {
        let refined_name = format!("{type_name} \"{selected}\"");
        if self.grafted.contains_key(&refined_name) {
            return Ok(Some(refined_name));
        }
        if self.position(&refined_name).is_some() {
            return Ok(None);
        }
        let Some(descriptor) = self.input.walker.describe_member(selected).await? else { return Ok(None) };
        let member_type = descriptor.get("displayName").and_then(Js::as_str).unwrap_or_default().to_string();
        let landings = self.landings_of(selected, &descriptor).await?;
        let projected = project_refined(self.input, &Refined { name: &refined_name, synthetic: &format!("{type_name}::{synthetic}"), descriptor: &descriptor, landings: &landings })?;
        let Some(Js::Obj(mut position)) = projected.position else { return Ok(None) };
        // The member is still one of the type, and the WHERE that picked it
        // ranges over the type: the type's own fields are read as the type
        // types them (`listName != "Portfolio"` against every list's names),
        // beside the member's own surface.
        if let Some(Js::Obj(unnarrowed)) = self.position(type_name).and_then(|p| p.get("properties")).cloned()
            && let Js::Obj(properties) = position.entry("properties".to_string()).or_insert_with(|| Js::Obj(Obj::new()))
        {
            for (name, field) in unnarrowed {
                properties.insert(name, field);
            }
        }
        for (target, landing) in projected.landings {
            positions_mut(&mut self.schema).insert(target, landing);
        }
        for (target, shape) in projected.create_shapes {
            self.entry("createShapes").entry(target).or_insert(shape);
        }

        positions_mut(&mut self.schema).insert(refined_name.clone(), Js::Obj(position));
        self.grafted.insert(refined_name.clone(), member_type);
        Ok(Some(refined_name))
    }

    /// A record type the program names that the schema lacks: one a member
    /// of a type lands on (a table's changes, and the row each change
    /// holds), the member then grafted as a walk narrowed to it would be.
    /// The members searched are those the connection's root hands over; a
    /// name more than one of them lands on is left unknown, as is one none
    /// does, and where it is written the checker says so.
    async fn ground_named(&mut self, named: &str) -> Result<(), String> {
        if !self.attempted.insert(format!("named:{named}")) {
            return Ok(());
        }
        let failed = |why: String| format!("finding the record type {named} failed: {why}");
        let mut landing_on = Vec::new();
        for (member, type_name) in self.input.walker.root_members().await.map_err(failed)? {
            if self.position(&type_name).is_none() {
                continue;
            }
            let Some(descriptor) = self.input.walker.describe_member(&member).await.map_err(failed)? else { continue };
            let landings = self.landings_of(&member, &descriptor).await.map_err(failed)?;
            if landings.iter().any(|(target, _)| target == named) {
                landing_on.push((member, type_name));
            }
        }
        if let [(member, type_name)] = landing_on.as_slice() {
            self.graft_member(type_name, member, &format!("named:{named}")).await.map_err(failed)?;
        }
        Ok(())
    }

    /// The nodes the member's edges land on that the schema has no position
    /// for, each walked to along the path the hop before it handed over, by
    /// the name its edge targets; and on from each landing the same way, so
    /// a landing's own edges land too (a table's changes, and the row each
    /// change holds).
    async fn landings_of(&self, member: &str, descriptor: &Js) -> Result<Vec<(String, Js)>, String> {
        let mut landings: Vec<(String, Js)> = Vec::new();
        let mut to_walk: Vec<(String, Js)> = vec![(member.to_string(), descriptor.clone())];
        while let Some((from, descriptor)) = to_walk.pop() {
            for reference in descriptor.get("references").and_then(Js::as_array).unwrap_or_default() {
                let Some(target) = reference.get("targetTypeId").and_then(Js::as_str) else { continue };
                if self.position(target).is_some() || landings.iter().any(|(t, _)| t == target) {
                    continue;
                }
                if let Some(landing) = self.input.walker.describe_member_landing(&from, target).await? {
                    landings.push((target.to_string(), landing.clone()));
                    to_walk.push((target.to_string(), landing));
                }
            }
        }
        Ok(landings)
    }
}

fn positions_mut(schema: &mut Obj) -> &mut Obj {
    match schema.entry("positions".to_string()).or_insert_with(|| Js::Obj(Obj::new())) {
        Js::Obj(positions) => positions,
        other => {
            *other = Js::Obj(Obj::new());
            let Js::Obj(positions) = other else { unreachable!() };
            positions
        }
    }
}

/// A walked member to project, and the nodes its edges land on.
struct Refined<'a> {
    name: &'a str,
    synthetic: &'a str,
    descriptor: &'a Js,
    landings: &'a [(String, Js)],
}

struct Projected {
    position: Option<Js>,
    landings: Vec<(String, Js)>,
    /// What a write along the member's edges creates, by landing.
    create_shapes: Vec<(String, Js)>,
}

/// `projectRefinedPosition`: the walked member as a position under its
/// refined name, projected with the nodes its edges land on, each under its
/// own name.
fn project_refined<W>(input: &Refining<'_, '_, W>, refined: &Refined) -> Result<Projected, String> {
    let entry = |type_id: &str, name: &str| Js::Obj(obj! { "typeId" => Js::str(type_id), "displayName" => Js::str(name), "readable" => Js::Bool(true), "writable" => Js::Bool(false) });
    let mut entries = input.entries.to_vec();
    entries.push(entry(refined.synthetic, refined.name));
    let mut descriptors: IndexMap<String, Js> = [(refined.synthetic.to_string(), refined.descriptor.clone())].into_iter().collect();
    for (target, descriptor) in refined.landings {
        entries.push(entry(target, target));
        descriptors.insert(target.clone(), descriptor.clone());
    }
    // A walked edge's landing is described only here, so what lands on it is offered here.
    let crate::actor::Offered { reached, descriptors, .. } = crate::actor::with_actor_descriptors(&crate::actor::Introspection { entries: &entries, descriptors: &descriptors, methods: input.methods });
    let projected = crate::schema::instance_schema_from_descriptors(&crate::schema::ProjectionInput {
        adapter_type: input.adapter,
        entries: &entries,
        reached: &reached,
        descriptors: &descriptors,
        meta_descriptor: None,
        supports_in_place_update: false,
        edges_carry_properties: false,
        all_entries: None,
        lazily_walked: false,
    });
    let of = |map: &str, name: &str| projected.schema.get(map).and_then(|m| m.get(name)).cloned();
    Ok(Projected {
        position: of("positions", refined.name),
        landings: refined.landings.iter().filter_map(|(target, _)| Some((target.clone(), of("positions", target)?))).collect(),
        create_shapes: refined.landings.iter().filter_map(|(target, _)| Some((target.clone(), of("createShapes", target)?))).collect(),
    })
}

/// Which member a WHERE selects, or why it selects none.
#[derive(Debug, PartialEq)]
enum Selection {
    Selected(String),
    /// The walk handed over no members of the type.
    NotPolymorphic,
    /// No member can answer any part of the WHERE while typing.
    Undecidable,
    /// The members answer it, and none of them is it.
    NoMatch,
}

/// `selectMemberFor`, over the members the walk handed over.
fn select_member_for(members: &[(String, Js)], filter: &Expression) -> Selection {
    if members.is_empty() {
        return Selection::NotPolymorphic;
    }
    if !members.iter().any(|(_, data)| matches!(data, Js::Obj(data) if !decidable_conjuncts(filter, data).is_empty())) {
        return Selection::Undecidable;
    }
    match select_member(members, filter) {
        Some(member) => Selection::Selected(member),
        None => Selection::NoMatch,
    }
}

/// `decidableConjuncts`: the parts of `filter` a member's own data answers.
fn decidable_conjuncts<'f>(filter: &'f Expression, data: &Obj) -> Vec<&'f Expression> {
    conjuncts(filter)
        .into_iter()
        .filter(|conjunct| movement_engine::filter::pure_leaf_keys(conjunct).is_some_and(|keys| keys.iter().all(|key| data.contains_key(key))))
        .collect()
}

/// `selectMember`: the first member every decidable part of `filter` holds of.
fn select_member(members: &[(String, Js)], filter: &Expression) -> Option<String> {
    members.iter().find_map(|(name, data)| {
        let Js::Obj(data) = data else { return None };
        let decidable = decidable_conjuncts(filter, data);
        if decidable.is_empty() {
            return None;
        }
        let read = |key: &str| movement_engine::env::js_of_json(&crate::wire::json_of_js(data.get(key).unwrap_or(&Js::Null)));
        let holds = decidable.iter().all(|c| matches!(movement_engine::filter::evaluate_predicate(c, &read), Ok(movement_engine::js::Js::Bool(true))));
        holds.then(|| name.clone())
    })
}

/// `narrowByOf`: every key the members were labelled with.
fn narrow_by_of(members: &[(String, Js)]) -> Vec<String> {
    let mut fields: Vec<String> = Vec::new();
    for (_, data) in members {
        if let Js::Obj(data) = data {
            for key in data.keys() {
                if !fields.contains(key) {
                    fields.push(key.clone());
                }
            }
        }
    }
    fields
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    /// A workspace of two spreadsheets as a walk sees it: the root's
    /// `Spreadsheet` members, labelled with their data; each sheet's hop its
    /// own tables; each table its fields. A record of every hop asked.
    struct Sheets {
        asked: RefCell<Vec<String>>,
        failing: bool,
    }

    fn member(kind: &str, id: &str, data: Js) -> Js {
        Js::Obj(obj! { "adapterType" => Js::str("sheets"), "recordType" => Js::str(kind), "identity" => Js::Obj(obj! { "kind" => Js::str("stable"), "recordId" => Js::str(id), "data" => data }) })
    }

    fn descriptor(name: &str, fields: Vec<Js>, references: Vec<Js>) -> Js {
        Js::Obj(obj! { "typeId" => Js::str(name), "displayName" => Js::str(name), "fields" => Js::Arr(fields), "references" => Js::Arr(references) })
    }

    fn text_field(name: &str) -> Js {
        Js::Obj(obj! { "fieldId" => Js::str(name), "displayName" => Js::str(name), "kind" => Js::str("string"), "writable" => Js::Bool(true) })
    }

    fn table_edge(id: &str, name: &str) -> Js {
        Js::Obj(obj! { "fieldId" => Js::str(id), "name" => Js::str(name), "targetTypeId" => Js::str(name), "cardinality" => Js::str("many"), "writable" => Js::Bool(true) })
    }

    impl Walk for Sheets {
        async fn edges_from(&self, position: &Js, _: Option<&Js>) -> Result<Js, String> {
            let kind = position.get("recordType").and_then(Js::as_str).unwrap_or_default().to_string();
            let id = position.get("identity").and_then(|i| i.get("recordId")).and_then(Js::as_str).unwrap_or_default().to_string();
            self.asked.borrow_mut().push(format!("{kind}:{id}"));
            if self.failing && kind == "Spreadsheet" {
                return Err("the sheet is gone".into());
            }
            let data = |title: &str, owner: &str| Js::Obj(obj! { "Title" => Js::str(title), "Owner" => Js::str(owner) });
            Ok(match (kind.as_str(), id.as_str()) {
                ("meta", _) => Js::Obj(obj! {
                    "descriptor" => descriptor("meta", vec![], vec![Js::Obj(obj! { "fieldId" => Js::str("Spreadsheet"), "name" => Js::str("Spreadsheet"), "targetTypeId" => Js::str("Spreadsheet") })]),
                    "targetPositions" => Js::Obj(obj! {
                        "sh1" => member("Spreadsheet", "sh1", data("Pipeline Sheet", "ops")),
                        "sh2" => member("Spreadsheet", "sh2", data("Other Sheet", "sales")),
                    }),
                }),
                ("Spreadsheet", "sh1") => Js::Obj(obj! {
                    "descriptor" => descriptor("Sheet — Pipeline Sheet", vec![], vec![table_edge("tblC", "Companies")]),
                    "targetPositions" => Js::Obj(obj! { "tblC" => member("Table", "tblC", Js::Obj(obj! { "Name" => Js::str("Companies") })) }),
                }),
                ("Spreadsheet", "sh2") => Js::Obj(obj! {
                    "descriptor" => descriptor("Sheet — Other Sheet", vec![], vec![table_edge("tblD", "Deals")]),
                    "targetPositions" => Js::Obj(obj! { "tblD" => member("Table", "tblD", Js::Obj(obj! { "Name" => Js::str("Deals") })) }),
                }),
                // A company's notes, each by its author: two levels on from the table.
                ("Table", "tblC") => Js::Obj(obj! {
                    "descriptor" => descriptor("Companies", vec![text_field("Name"), text_field("Stage")], vec![table_edge("Notes", "Company Note")]),
                    "targetPositions" => Js::Obj(obj! { "Notes" => member("Note", "tblC", Js::Obj(Obj::new())) }),
                }),
                ("Note", "tblC") => Js::Obj(obj! {
                    "descriptor" => descriptor("Company Note", vec![text_field("Text")], vec![table_edge("Author", "Person")]),
                    "targetPositions" => Js::Obj(obj! { "Author" => member("Person", "p1", Js::Obj(Obj::new())) }),
                }),
                ("Person", "p1") => Js::Obj(obj! { "descriptor" => descriptor("Person", vec![text_field("Email")], vec![]) }),
                ("Table", "tblD") => Js::Obj(obj! { "descriptor" => descriptor("Deals", vec![text_field("Amount")], vec![]) }),
                _ => Js::Null,
            })
        }
    }

    /// The unnarrowed connection: one `Spreadsheet` collection whose type
    /// carries only its title.
    fn schema() -> Js {
        Js::parse(br#"{"positions":{"Spreadsheet":{"properties":{"Title":"text"},"edges":{}}},"collections":{"Spreadsheet":{"target":"Spreadsheet"}},"writableRoots":{}}"#).unwrap()
    }

    fn program(body: &str) -> String {
        format!("import {{ sheets }} from adapters\ns = connect sheets\n\nfunction m() {{\n{body}\n}}\n")
    }

    fn chains(source: &str) -> Vec<InstanceChain> {
        let program = crate::check::parse(source).map_err(|e| e.message).unwrap();
        instance_chains(&program.statements, &BTreeMap::new())
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
    }

    fn refined_with(walk: &Sheets, source: &str) -> Result<Js, String> {
        let walker = Walker::new(walk, "sheets");
        let found = chains(source);
        block_on(refine_instance_schema(schema(), &found.iter().collect::<Vec<_>>(), &Refining { adapter: "sheets", entries: &[], methods: &[], walker: &walker }))
    }

    fn refined(source: &str) -> (Js, Vec<String>) {
        let walk = Sheets { asked: RefCell::new(Vec::new()), failing: false };
        let schema = refined_with(&walk, source).expect("the walk answers");
        (schema, walk.asked.into_inner())
    }

    fn map(schema: &Js, name: &str) -> Vec<(String, String)> {
        match schema.get(name) {
            Some(Js::Obj(entries)) => entries.iter().map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_json()))).collect(),
            _ => Vec::new(),
        }
    }

    /// What `listen-fire check` says of `source` against the refined schema:
    /// each diagnostic's code and message.
    fn checked(schema: &Js, source: &str) -> Vec<(String, String)> {
        let catalog = format!(
            r#"{{"adapters":{{"sheets":{{"canFire":false,"constructionArgs":[],"schemas":{{"":{}}}}}}},"credentials":{{}},"plugins":{{}}}}"#,
            schema.to_json()
        );
        let catalog = movement_parser::catalog::types::CatalogSnapshot::load(&catalog).unwrap();
        let options = movement_checker::CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
        movement_checker::check_source(source, &catalog, options)
            .unwrap()
            .into_iter()
            .filter(|d| d.severity.is_none())
            .map(|d| (d.code, d.message))
            .collect()
    }

    /// A walked edge's landing is described only by the walk, so it is offered
    /// who acted there, or a filter narrowed to it could not read it.
    #[test]
    fn what_lands_on_a_walked_edge_may_say_who_acted_when_its_module_reports_it() {
        let walk = Sheets { asked: RefCell::new(Vec::new()), failing: false };
        let walker = Walker::new(&walk, "sheets");
        let member = Js::parse(br#"{"typeId":"t","displayName":"Table","fields":[],"references":[{"fieldId":"Changes","name":"Changes","targetTypeId":"Change","listenable":true}]}"#).unwrap();
        let landing = Js::parse(br#"{"typeId":"Change","displayName":"Change","fields":[],"references":[]}"#).unwrap();
        let landings = [("Change".to_string(), landing)];
        let refined = Refined { name: "Base \"x\"", synthetic: "Base::x", descriptor: &member, landings: &landings };
        let actor_of = |methods: &[String]| {
            let input = Refining { adapter: "sheets", entries: &[], methods, walker: &walker };
            let projected = project_refined(&input, &refined).unwrap();
            projected.landings[0].1.get("properties").and_then(|p| p.get("Actor")).map(Js::to_json)
        };
        assert_eq!(actor_of(&["extractActor".to_string()]).as_deref(), Some(r#"{"kind":"maybeAbsent","of":{"kind":"record","position":{"kind":"position","position":"ListenFireActor"}}}"#));
        assert_eq!(actor_of(&[]), None);
    }

    const SELECT: &str = "  sheet = only(s-[x:Spreadsheet WHERE x.Title == \"Pipeline Sheet\"]->)\n  if (sheet == null) { fail(\"none\") }";

    #[test]
    fn a_selection_grafts_the_member_it_selects_under_the_key_the_checker_looks_up() {
        let source = program(&format!("{SELECT}\n  write sheet-[:Companies]-> {{ Name: \"Acme\" }}"));
        let (schema, asked) = refined(&source);
        let refinements = map(&schema, "refinements");
        assert_eq!(refinements.iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>(), [r#"Spreadsheet "Pipeline Sheet""#]);
        assert_eq!(map(&schema, "selectedMembers").iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>(), ["Sheet — Pipeline Sheet"], "the TYPE the member lands, not its addressing name");
        assert_eq!(schema.get("narrowBy").map(Js::to_json).as_deref(), Some(r#"{"Spreadsheet":["Title","Owner"]}"#));
        // The root, the selected sheet, its one table: never the sheet it did not select.
        assert_eq!(asked, ["meta:", "Spreadsheet:sh1", "Table:tblC", "Note:tblC", "Person:p1"]);
        assert_eq!(checked(&schema, &source), Vec::<(String, String)>::new());

        let misspelled = program(&format!("{SELECT}\n  write sheet-[:Companies]-> {{ Nmae: \"Acme\" }}"));
        let found = checked(&refined(&misspelled).0, &misspelled);
        assert_eq!(found.iter().map(|(c, _)| c.as_str()).collect::<Vec<_>>(), ["MOV_WRITE_UNKNOWN_FIELD"], "{found:?}");
        let elsewhere = program(&format!("{SELECT}\n  write sheet-[:Deals]-> {{ Amount: \"1\" }}"));
        let found = checked(&refined(&elsewhere).0, &elsewhere);
        assert_eq!(found.iter().map(|(c, _)| c.as_str()).collect::<Vec<_>>(), ["MOV_LINKED_UNKNOWN_EDGE"], "the other sheet's table: {found:?}");
    }

    #[test]
    fn a_landing_s_own_edges_land_too() {
        let source = program(&format!("{SELECT}\n  write sheet-[:Companies]-> {{ Name: \"Acme\" }}"));
        let (schema, _) = refined(&source);
        let target = |position: &str, edge: &str| schema.get("positions").and_then(|p| p.get(position)).and_then(|p| p.get("edges")).and_then(|e| e.get(edge)).and_then(|e| e.get("target")).map(Js::to_json);
        assert_eq!(target("Companies", "Company Note").as_deref(), Some(r#""Company Note""#), "{}", schema.to_json());
        assert_eq!(target("Company Note", "Person").as_deref(), Some(r#""Person""#));
        let email = schema.get("positions").and_then(|p| p.get("Person")).and_then(|p| p.get("properties")).and_then(|p| p.get("Email"));
        assert!(email.is_some(), "the second level's fields: {}", schema.to_json());
    }

    /// The stamps the check hands the run for `source` against the schema.
    fn stamps(schema: &Js, source: &str) -> Vec<serde_json::Value> {
        let catalog = format!(
            r#"{{"adapters":{{"sheets":{{"canFire":false,"constructionArgs":[],"schemas":{{"":{}}}}}}},"credentials":{{}},"plugins":{{}}}}"#,
            schema.to_json()
        );
        let catalog = movement_parser::catalog::types::CatalogSnapshot::load(&catalog).unwrap();
        let options = movement_checker::CheckOptions { upgrading_from: None, zones: &movement_checker::host::native::NativeZones };
        let program = crate::check::parse(source).map_err(|e| e.message).unwrap();
        movement_checker::answer::check_answer(&program, &catalog, options).stamps
    }

    #[test]
    fn a_write_off_the_member_hands_the_run_the_type_the_check_resolved() {
        // The record the WHERE chose carries only its type (`Spreadsheet`),
        // which has no `Companies` edge: the run creates what the check
        // resolved off the member.
        let source = program(&format!("{SELECT}\n  write sheet-[:Companies]-> {{ Name: \"Acme\" }}"));
        let (schema, _) = refined(&source);
        assert_eq!(stamps(&schema, &source), [serde_json::json!({ "path": "/statements/2/body/2/write/target", "writtenType": "Companies" })]);
        let named = program(&format!("{SELECT}\n  write sheet-[:Companies]-><Companies> {{ Name: \"Acme\" }}"));
        assert_eq!(stamps(&refined(&named).0, &named), Vec::<serde_json::Value>::new(), "a type the write names is the run's already");
    }

    #[test]
    fn a_conjunction_a_field_that_names_no_type_and_a_second_spelling_each_narrow() {
        for (where_, sheet) in [
            ("x.Title == \"Pipeline Sheet\" AND x.Owner == \"ops\"", "Pipeline Sheet"),
            ("x.Owner == \"sales\"", "Other Sheet"),
            ("x.Title == \"Pipeline Sheet\" AND x.Rows >= 5", "Pipeline Sheet"),
        ] {
            let (schema, _) = refined(&program(&format!("  y = s-[x:Spreadsheet WHERE {where_}]->")));
            assert_eq!(map(&schema, "refinements").iter().map(|(_, v)| v.clone()).collect::<Vec<_>>(), [format!("Spreadsheet \"{sheet}\"")], "{where_}");
        }
        let (schema, asked) = refined(&program("  a = s-[x:Spreadsheet WHERE x.Title == \"Pipeline Sheet\"]->\n  b = s-[x:Spreadsheet WHERE \"Pipeline Sheet\" == x.Title]->"));
        assert_eq!(map(&schema, "refinements").len(), 2, "two keys");
        assert!(map(&schema, "refinements").iter().all(|(_, v)| v == r#"Spreadsheet "Pipeline Sheet""#), "one position");
        assert_eq!(asked.iter().filter(|a| a.starts_with("Spreadsheet:")).count(), 1, "one walk");
    }

    #[test]
    fn a_where_the_members_cannot_decide_leaves_the_type_as_it_was() {
        for where_ in ["x.Missing == \"x\"", "x.Title == \"Pipeline Sheet\" OR x.Missing == \"x\"", "x.Title == AI(\"which sheet?\")"] {
            let (schema, _) = refined(&program(&format!("  y = s-[x:Spreadsheet WHERE {where_}]->")));
            assert!(schema.get("refinements").is_none() && schema.get("unselected").is_none(), "{where_}: {}", schema.to_json());
            assert!(schema.get("narrowBy").is_some(), "{where_}: how the type narrows is recorded all the same");
        }
    }

    #[test]
    fn a_where_the_members_decide_and_none_satisfies_is_refused_where_it_is_written() {
        let source = program("  sheet = only(s-[x:Spreadsheet WHERE x.Title == \"Pipeline Shet\"]->)\n  if (sheet == null) { fail(\"none\") }\n  write sheet-[:Companies]-> { Name: \"Acme\" }");
        let (schema, _) = refined(&source);
        assert!(schema.get("refinements").is_none());
        assert_eq!(map(&schema, "unselected").iter().map(|(_, v)| v.as_str()).collect::<Vec<_>>(), [r#"["Pipeline Sheet","Other Sheet"]"#]);
        let found = checked(&schema, &source);
        assert_eq!(
            found,
            [("MOV_UNKNOWN_POSITION".to_string(), "'s' has no Spreadsheet whose Title is \"Pipeline Shet\" — it has: \"Pipeline Sheet\", \"Other Sheet\" — did you mean 'Pipeline Sheet'?".to_string())]
        );
    }

    #[test]
    fn a_walk_the_module_fails_fails_the_refinement() {
        let walk = Sheets { asked: RefCell::new(Vec::new()), failing: true };
        let failed = refined_with(&walk, &program(SELECT)).unwrap_err();
        assert!(failed.contains("the sheet is gone"), "{failed}");
    }

    #[test]
    fn chains_are_found_through_bindings_blocks_handles_and_typed_parameters() {
        let source = "import { sheets } from adapters\ns = connect sheets\n\nfunction m() {\n  a = only(s-[x:Spreadsheet WHERE x.Title == \"A\"]->)\n  s-[y:Spreadsheet WHERE y.Title == \"B\"]-> {\n    write y-[:Companies]-> { Name: \"n\" }\n  }\n  h = write s-[:Spreadsheet]-> { Title: \"C\" }\n  z = h-[:Companies]->\n}\n\nfunction n(t: <s-[:Spreadsheet]->>) {\n  w = t-[:Companies]->\n}\n";
        let found: Vec<(Vec<String>, Option<String>)> = chains(source)
            .into_iter()
            .map(|c| {
                let steps = c.steps.iter().map(|s| match s {
                    TraversalStep::Edge(edge) => format!("{}{}", edge.edge_type_id, if edge.expression_filter.is_some() { "?" } else { "" }),
                    _ => "·".into(),
                });
                (steps.collect(), c.start_position)
            })
            .collect();
        let chain = |steps: &[&str], start: Option<&str>| (steps.iter().map(|s| s.to_string()).collect::<Vec<_>>(), start.map(str::to_string));
        assert_eq!(
            found,
            [
                chain(&["Spreadsheet?"], None),
                chain(&["Spreadsheet?"], None),
                chain(&["Spreadsheet?", "Companies"], None),
                chain(&["Spreadsheet"], None),
                chain(&["Spreadsheet", "Companies"], None),
                // The parameter's type names its record type, walked or not.
                chain(&[], Some("Spreadsheet")),
                chain(&["Companies"], Some("Spreadsheet")),
            ]
        );
    }

    /// A type the program names that only a member's edges land on (a
    /// sheet's table's notes) is grafted as a walk narrowed to that member
    /// would graft it, with nothing in the program walking there.
    #[test]
    fn a_type_named_only_by_a_parameter_grounds_the_member_it_lands_under() {
        let source = "import { sheets } from adapters\ns = connect sheets\n\nfunction g(n: <s-[:`Company Note`]->>) {\n  return n.Text\n}\n";
        let (schema, asked) = refined(source);
        assert_eq!(checked(&schema, source), Vec::<(String, String)>::new(), "{}", schema.to_json());
        assert!(schema.get("positions").and_then(|p| p.get("Spreadsheet \"Pipeline Sheet\"")).is_some(), "{}", schema.to_json());
        assert_eq!(map(&schema, "refinements"), Vec::<(String, String)>::new(), "no WHERE selected it");
        assert_eq!(asked, ["meta:", "Spreadsheet:sh1", "Table:tblC", "Note:tblC", "Person:p1", "Spreadsheet:sh2", "Table:tblD"]);
        let misspelled = source.replace("n.Text", "n.Txt");
        let found = checked(&refined(&misspelled).0, &misspelled);
        assert_eq!(found.iter().map(|(c, _)| c.as_str()).collect::<Vec<_>>(), ["MOV_UNKNOWN_PROPERTY"], "{found:?}");
        let nowhere = source.replace("Company Note", "Company Nte");
        let found = checked(&refined(&nowhere).0, &nowhere);
        assert_eq!(found.iter().map(|(c, _)| c.as_str()).collect::<Vec<_>>(), ["MOV_UNKNOWN_POSITION"], "{found:?}");
    }

    #[test]
    fn a_listen_on_a_traversal_walks_its_hops_and_one_in_the_settings_form_walks_none() {
        let source = "import { sheets } from adapters\ns = connect sheets\n\nfunction f(c: <s-[:Company]->>) {\n  return c\n}\n\nlisten to s-[x:Spreadsheet WHERE x.Title == \"A\"]->-[:Companies]-> fire f\nlisten to s { events: [\"row.created\"] } fire f\n";
        let found: Vec<Vec<String>> = chains(source)
            .into_iter()
            .map(|c| {
                c.steps
                    .iter()
                    .map(|s| match s {
                        TraversalStep::Edge(edge) => format!("{}{}", edge.edge_type_id, if edge.expression_filter.is_some() { "?" } else { "" }),
                        _ => "·".into(),
                    })
                    .collect()
            })
            .collect();
        assert_eq!(found, [vec![], vec!["Spreadsheet?".to_string(), "Companies".to_string()]], "the parameter's type, then the listen's hops");
    }
}

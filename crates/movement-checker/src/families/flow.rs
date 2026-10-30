//! The flow family: what an `await` parks on, and what an `until` condition
//! may do. Its codes (PORT.md has where the TypeScript raises each):
//!
//! - MOV_AWAIT_BAD_DURATION
//! - MOV_AWAIT_BARE_WALK
//! - MOV_AWAIT_IMPURE_CONDITION
//! - MOV_AWAIT_NEEDS_CADENCE (raised by nothing since 0.13: see `check_awaitable`)
//! - MOV_AWAIT_NOT_AWAITABLE
//! - MOV_AWAIT_UNORDERED
//! - MOV_HEAD_NEEDS_A_NAME
//! - MOV_IF_WITHOUT_ELSE
//! - MOV_UNTIL_CADENCE_TOO_SHORT
//! - MOV_UNTIL_EDGE_WATCHABLE
//! - MOV_WAIT_NOT_RESUMABLE

use movement_parser::ast::{DurationLiteral, PathHead, PathRoot, RValue, Span, Statement};
use movement_parser::stmt::AWAIT_ARRIVALS_WORD;

use crate::checker::Checker;
use crate::scope::{ScopeId, SymbolId};
use crate::codes;

/// An `until` condition is re-evaluated on a timer: it may not re-check
/// faster than this.
const UNTIL_CADENCE_FLOOR_MS: u64 = 60_000;

/// `durationToMs`, `None` for a text that is not a duration (`isValidDuration`:
/// one or more `<digits><unit>` runs, units s/m/h/d/w).
pub fn duration_ms(raw: &str) -> Option<u64> {
    let (mut total, mut digits, mut any) = (0u64, String::new(), false);
    for c in raw.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let unit = match c {
            's' => 1_000,
            'm' => 60_000,
            'h' => 3_600_000,
            'd' => 86_400_000,
            'w' => 604_800_000,
            _ => return None,
        };
        if digits.is_empty() {
            return None;
        }
        total = total.saturating_add(digits.parse::<u64>().unwrap_or(u64::MAX).saturating_mul(unit));
        digits.clear();
        any = true;
    }
    (any && digits.is_empty()).then_some(total)
}

/// `spellPathHead`: a path head as the author wrote it.
pub fn spell_path_head(head: &PathHead) -> String {
    let root = match &head.root {
        Some(PathRoot::Name { name }) => crate::families::names::spell_name(name),
        Some(PathRoot::Expression { expr }) => expr.raw.clone(),
        None => String::new(),
    };
    format!("{root}{}", head.hops_raw)
}

fn rvalue_kind(value: &RValue) -> &'static str {
    match value {
        RValue::Construct { .. } => "construct",
        RValue::Call { .. } => "call",
        RValue::Write { .. } => "write",
        RValue::Match { .. } => "match",
        RValue::Link { .. } => "link",
        RValue::Extract { .. } => "extract",
        RValue::ExtractCall { .. } => "extractCall",
        RValue::Block { .. } => "block",
        RValue::Await { .. } => "await",
        RValue::Combinator { .. } => "combinator",
        RValue::Collection { .. } => "collection",
        RValue::Members { .. } => "members",
        RValue::InlineBlock { .. } => "inlineBlock",
        RValue::Callback { .. } => "callback",
        RValue::Closure { .. } => "closure",
        RValue::Node { .. } => "node",
        RValue::Lazy { .. } => "lazy",
        RValue::Expr { .. } => "expr",
    }
}

impl Checker<'_> {
    /// `await sleep(<duration>)`.
    pub fn check_sleep_duration(&mut self, duration: &DurationLiteral) {
        if duration_ms(&duration.raw).is_none() {
            self.report(
                codes::AWAIT_BAD_DURATION,
                format!("'{}' is not a valid duration — use unit-suffixed literals like 4h, 2d, 90m, 1h30m", duration.raw),
                duration.span,
            );
        }
    }

    /// `checkUntil`'s cadence.
    pub fn check_until_cadence(&mut self, every: &DurationLiteral) {
        match duration_ms(&every.raw) {
            None => self.report(
                codes::AWAIT_BAD_DURATION,
                format!("'{}' is not a valid cadence — use unit-suffixed literals like 5m, 1h, 2d", every.raw),
                every.span,
            ),
            Some(ms) if ms < UNTIL_CADENCE_FLOOR_MS => self.report(
                codes::UNTIL_CADENCE_TOO_SHORT,
                format!("'{}' re-checks faster than the 1m floor — an 'until' condition is re-evaluated on a timer, so its cadence must be at least 1m. Use a longer interval (5m, 1h).", every.raw),
                every.span,
            ),
            Some(_) => {}
        }
    }

    /// The walk an `await` parks on: a parked run finds its record again by
    /// name.
    pub fn check_awaited_head(&mut self, head: &PathHead) {
        if let Some(PathRoot::Expression { expr }) = &head.root {
            self.report(
                codes::HEAD_NEEDS_A_NAME,
                format!(
                    "'await' parks on the record it waits at, and a parked run finds that record again by NAME — so this one is bound first: 'waiting = {}', then 'await waiting{}'.",
                    expr.raw, head.hops_raw
                ),
                head.span,
            );
        }
    }

    /// `await` parks on one record, under one key: a name holding a list of
    /// them has no one record to park on.
    pub fn report_await_on_list(&mut self, head: &PathHead, scope: crate::scope::ScopeId) {
        let Some(PathRoot::Name { name }) = &head.root else { return };
        let crate::scope::Resolution::Found(id) = self.scopes.resolve(scope, name) else { return };
        let types = &self.scopes.symbol(id).types;
        // A block's collected records (`plural`), or a value holding a list.
        let list = types.plural.is_some() || crate::types::field::is_list(types.field.as_ref().map(crate::types::field::strip_absent));
        if !list {
            return;
        }
        let shown = crate::families::names::spell_name(name);
        self.report(
            codes::AWAIT_ON_LIST,
            format!(
                "'await' parks on one record, under one key, and '{shown}' holds a list of records, so there is no one record to wait at — waiting on many records is {}(…) over them",
                movement_parser::ast::CombinatorKind::All.word()
            ),
            head.span,
        );
    }

    /// What an awaited walk waits on: one edge, off a record a name holds,
    /// whose module announces arrivals on it (listenable). A plain `await`
    /// takes the first match already on an edge that can be listed, so that
    /// edge must declare its order; `await new` waits only for what arrives.
    /// An undescribed edge claims nothing. (MOV_AWAIT_NEEDS_CADENCE was an
    /// edge that resolved but announced nothing; `listenable` is both facts
    /// at once, so no catalog can say that any more.)
    pub fn check_awaitable(&mut self, head: &PathHead, walk: Option<&crate::families::walks::HeadWalk>, arrivals_only: bool) {
        let path = spell_path_head(head);
        if Self::head_steps(head).is_some_and(|steps| steps.len() > 1) {
            self.report(
                codes::AWAIT_BARE_WALK,
                format!(
                    "'await {path}' walks more than one edge, and 'await' waits on one edge of a record a name holds — bind the record the last edge leaves from to a name, then await that edge off it"
                ),
                head.span,
            );
            return;
        }
        let Some(walk) = walk else { return };
        let (Some(edge), Some(name)) = (walk.last_edge_schema.as_ref(), walk.last_edge.as_deref()) else { return };
        if head.root.is_none() {
            return;
        }
        let owner = walk.last_source.as_ref().map_or_else(|| "its record".to_string(), crate::families::walks::describe_edge_owner);
        if edge.listenable != Some(true) {
            self.report(
                codes::AWAIT_NOT_AWAITABLE,
                format!(
                    "'-[:{name}]->' on {owner} announces nothing, so 'await' has nothing to wait for — only an edge its module announces arrivals on can be awaited. Read it without 'await', or wait on a condition: `await until(() => {{ return exists({path}) }}, {{ every: 15m }})`"
                ),
                head.span,
            );
            return;
        }
        let listed = edge.readable != Some(false);
        if listed && edge.sequenced.is_none() && !arrivals_only {
            self.report(
                codes::AWAIT_UNORDERED,
                format!(
                    "'await' takes the first match already on '-[:{name}]->', and {owner} declares no order for it, so 'first' would be a guess. Write `await {AWAIT_ARRIVALS_WORD} {path}` to wait only for what arrives"
                ),
                head.span,
            );
        }
    }

    /// `checkUntilPurity`: an `until` condition's body may only read. Whether
    /// it flagged anything.
    pub fn check_until_purity(&mut self, body: &[Statement]) -> bool {
        let mut impure = false;
        for statement in body {
            match statement {
                Statement::Refresh(_) | Statement::Return(_) => {}
                Statement::Assign(assign) => {
                    if !matches!(assign.value, RValue::Expr { .. } | RValue::InlineBlock { .. }) {
                        self.report_impure_condition(rvalue_kind(&assign.value), assign.span);
                        impure = true;
                    }
                }
                Statement::If(s) => {
                    for arm in &s.arms {
                        impure = self.check_until_purity(&arm.body) || impure;
                    }
                    if let Some(else_arm) = &s.else_arm {
                        impure = self.check_until_purity(&else_arm.body) || impure;
                    }
                }
                other => {
                    if let Some(span) = statement_span(other) {
                        self.report_impure_condition(other.kind(), span);
                    }
                    impure = true;
                }
            }
        }
        impure
    }

    fn report_impure_condition(&mut self, what: &str, span: Span) {
        self.report(
            codes::AWAIT_IMPURE_CONDITION,
            format!("an 'until' condition is re-evaluated on a timer, so it must be read-only — a '{what}' here would act every tick. Keep the condition to reads and 'refresh'; do the effect after the await resolves."),
            span,
        );
    }

    /// An `until` condition's parameters: the clock supplies none.
    pub fn check_until_params(&mut self, closure: &movement_parser::ast::ClosureExpression) {
        if let Some(param) = closure.params.first() {
            self.report(
                codes::AWAIT_IMPURE_CONDITION,
                format!(
                    "an 'until' condition is called by the clock, so nothing can supply '{}' — write it with no parameters: 'until(() => {{ … }}, {{ every: … }})'",
                    param.name
                ),
                param.span,
            );
        }
    }

    /// A movement deferred by name schedules the run a call would: what it
    /// does is this movement's, and it may not wait.
    pub fn check_callback_suspends(&mut self, movement: &str, name_span: Span, scope: ScopeId) {
        let callee = movement.to_string();
        let crate::scope::Resolution::Found(id) = self.scopes.resolve(scope, &callee) else { return };
        if self.scopes.symbol(id).kind != crate::scope::SymbolKind::Movement {
            return;
        }
        let suspends = self.movement_suspends(id);
        self.absorb_suspend(suspends);
        if suspends {
            self.refuse_unresumable_wait(&format!("'{movement}', run as a callback"), name_span);
        }
    }

    /// `refuseUnresumableWait`: a wait where the run cannot come back to it.
    pub fn refuse_unresumable_wait(&mut self, where_: &str, span: Span) {
        self.report(
            codes::WAIT_NOT_RESUMABLE,
            format!(
                "{where_} may wait ('await', or a call to a function that awaits), and a run cannot be resumed there — it would park and never come back. Do the waiting in the movement itself, before or after this, and keep the callback body or condition to work that finishes without waiting."
            ),
            span,
        );
    }
}

/// Every statement carries its span under one name; the tree is the one
/// place that says so for all of them.
pub(crate) fn statement_span(statement: &Statement) -> Option<Span> {
    let tree = serde_json::to_value(statement).ok()?;
    serde_json::from_value(tree.get("span")?.clone()).ok()
}

/// What the open function bodies may do, as far as parking goes: a body that
/// may wait (`await`, a combinator, or a call to a function that waits)
/// suspends. The rest of the TypeScript's effect row (reads, writes, `ai`,
/// `now`) is not modelled.
#[derive(Default)]
pub struct Effects {
    /// One flag per function body being walked, innermost last.
    frames: Vec<bool>,
    /// Whether each closure bound to a name may wait when called.
    pub closures: std::collections::HashMap<SymbolId, bool>,
    /// While an `until` condition is checked: the edges it reads bare that
    /// their source would announce (`polledWatchableEdges`), in first-read order.
    polled_watchable: Option<Vec<String>>,
}

impl Effects {
    pub fn note_watchable_reads(&mut self, edges: &[String]) {
        let Some(polled) = self.polled_watchable.as_mut() else { return };
        for edge in edges {
            if !polled.contains(edge) {
                polled.push(edge.clone());
            }
        }
    }
}

impl Checker<'_> {
    /// `checkUntil`'s bracket: `check` checks the condition, and an edge it
    /// polls that its source announces is worth a nudge (a warning — the
    /// rewrite is the author's: an adapter growing webhooks must not quietly
    /// change when a saved movement wakes).
    pub fn check_until_watching<T>(&mut self, condition_span: Span, check: impl FnOnce(&mut Self) -> T) -> T {
        let outer = self.effects.polled_watchable.replace(Vec::new());
        let checked = check(self);
        let watchable = std::mem::replace(&mut self.effects.polled_watchable, outer).unwrap_or_default();
        if watchable.is_empty() {
            return checked;
        }
        let edges = watchable.iter().map(|edge| format!("'-[:{edge}]->'")).collect::<Vec<_>>().join(", ");
        let mut warning = crate::diagnostic::Diagnostic::error(
            codes::UNTIL_EDGE_WATCHABLE,
            format!("{edges} now arrives as it happens, so this doesn't have to be checked on a timer — 'await' on it waits without polling."),
            condition_span,
        );
        warning.severity = Some(crate::diagnostic::Severity::Warning);
        self.push(warning);
        checked
    }

    /// `withEffectFrame`'s opening half: a body whose effects are its own.
    pub fn open_effect_frame(&mut self) {
        self.effects.frames.push(false);
    }

    /// Whether the body walked since the matching open may wait.
    pub fn close_effect_frame(&mut self) -> bool {
        self.effects.frames.pop().unwrap_or(false)
    }

    /// The run may park here (`flag('suspend')`).
    pub fn flag_suspend(&mut self) {
        if let Some(top) = self.effects.frames.last_mut() {
            *top = true;
        }
    }

    /// What a called or scheduled function does is the caller's too.
    pub fn absorb_suspend(&mut self, suspends: bool) {
        if suspends {
            self.flag_suspend();
        }
    }

    /// Whether calling the closure a name holds may wait.
    pub fn closure_suspends(&self, id: SymbolId) -> bool {
        self.effects.closures.get(&id).copied().unwrap_or(false)
    }
}

//! The flow family: what an `await` parks on, and what an `until` condition
//! may do. Its codes (PORT.md has where the TypeScript raises each):
//!
//! - MOV_AWAIT_BAD_DURATION
//! - MOV_AWAIT_BARE_WALK
//! - MOV_AWAIT_IMPURE_CONDITION
//! - MOV_AWAIT_MAY_HANG (a warning, on a check for an upgrade only)
//! - MOV_AWAIT_NEEDS_CADENCE (raised by nothing since 0.13: see `check_awaitable`)
//! - MOV_AWAIT_NOT_AWAITABLE
//! - MOV_AWAIT_UNORDERED
//! - MOV_AWAIT_VALUE_CAPTURED (a warning, on a check for an upgrade only)
//! - MOV_HEAD_NEEDS_A_NAME
//! - MOV_IF_WITHOUT_ELSE
//! - MOV_UNTIL_CADENCE_TOO_SHORT
//! - MOV_UNTIL_EDGE_WATCHABLE
//! - MOV_WAIT_NOT_RESUMABLE

use movement_parser::ast::{DurationLiteral, PathHead, PathRoot, RValue, Span, Statement};
use movement_parser::lowering::captures::{Scoped, capture_holes, rooted_reads};
use movement_parser::lowering::expression::{Expression, TraversalStep};
use movement_parser::stmt::AWAIT_ARRIVALS_WORD;
use movement_parser::version::{Standing, standing};

use crate::checker::Checker;
use crate::families::names::spell_name;
use crate::scope::{Resolution, ScopeId, SymbolId, SymbolKind};
use crate::codes;

/// An `until` condition is re-evaluated on a timer: it may not re-check
/// faster than this.
const UNTIL_CADENCE_FLOOR_MS: u64 = 60_000;

/// The release from which a wait's WHERE reads a run record's field once,
/// when the wait is reached; under an older pin it read it again at every
/// check.
const CAPTURED_SINCE: &str = "0.13.0";

/// The release from which a wait whose record is deleted never ends; under
/// an older pin the code after it was skipped.
const DELETED_WAITS_HANG_SINCE: &str = "0.13.0";

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

/// A hop chain as written, split before its last hop: everything before it
/// (trimmed), and the last hop. A `-[` opens a hop only outside brackets and
/// quotes, so a WHERE's own `[…]` or text stays inside its hop.
fn split_last_hop(hops_raw: &str) -> (&str, &str) {
    let (mut depth, mut quote, mut last) = (0usize, None::<char>, 0usize);
    let mut chars = hops_raw.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), '\\') => {
                chars.next();
            }
            (Some(_), _) => {}
            (None, '"' | '\'' | '`') => quote = Some(c),
            (None, '-') if depth == 0 && chars.peek().is_some_and(|(_, n)| *n == '[') => last = at,
            (None, '[') => depth += 1,
            (None, ']') => depth = depth.saturating_sub(1),
            (None, _) => {}
        }
    }
    (hops_raw[..last].trim_end(), &hops_raw[last..])
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
        // An expression root is MOV_HEAD_NEEDS_A_NAME's, and a rootless walk
        // MOV_WALK_ROOTLESS's.
        let Some(PathRoot::Name { name: root }) = &head.root else { return };
        let path = spell_path_head(head);
        if Self::head_steps(head).is_some_and(|steps| steps.len() > 1) {
            let (before, last) = split_last_hop(&head.hops_raw);
            let root = crate::families::names::spell_name(root);
            self.report(
                codes::AWAIT_BARE_WALK,
                format!(
                    "'await {path}' walks more than one edge, and 'await' waits on one edge of a record a name holds — bind that record first: `one = only({root}{before})`, then `await one{last}`"
                ),
                head.span,
            );
            return;
        }
        let Some(walk) = walk else { return };
        let (Some(edge), Some(name)) = (walk.last_edge_schema.as_ref(), walk.last_edge.as_deref()) else { return };
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
        if crate::families::walks::edge_is_readable(edge) && edge.sequenced.is_none() && !arrivals_only {
            self.report(
                codes::AWAIT_UNORDERED,
                format!(
                    "'await' takes the first match already on '-[:{name}]->', and {owner} declares no order for it, so 'first' would be a guess. Write `await {AWAIT_ARRIVALS_WORD} {path}` to wait only for what arrives"
                ),
                head.span,
            );
        }
    }

    /// On a check for an upgrade from before 0.13: each part of the awaited
    /// hop's WHERE that reads fields of records the run holds, which the wait
    /// now reads once, when it is reached (`capture_holes`), where the old pin
    /// read them again at every check. A warning with nothing to rewrite,
    /// naming every such field the part reads.
    pub fn report_captured_values(&mut self, head: &PathHead, scope: ScopeId) {
        let Some(pin) = self.upgrading_from else { return };
        if standing(pin, CAPTURED_SINCE) != Standing::OlderKey {
            return;
        }
        let Some(steps) = Self::head_steps(head) else { return };
        // A wait on more than one edge is MOV_AWAIT_BARE_WALK's.
        let [TraversalStep::Edge(step)] = steps.as_slice() else { return };
        let Some(filter) = step.expression_filter.as_deref() else { return };
        let scoped = |name: &str| match self.scopes.resolve(scope, name) {
            Resolution::Found(id) if self.scopes.symbol(id).kind == SymbolKind::Instance => Scoped::Connection,
            Resolution::Found(_) => Scoped::Run,
            _ => Scoped::Free,
        };
        let told: Vec<(Vec<String>, Vec<String>)> = capture_holes(filter, step.alias.as_deref(), &scoped)
            .iter()
            .map(|hole| {
                let (mut reads, mut roots) = (Vec::new(), Vec::new());
                for (root, read) in rooted_reads(&hole.expression).into_iter().filter(|(root, _)| self.holds_record(root, scope)) {
                    let (read, root) = (spell_read(read).unwrap_or_else(|| spell_name(root)), spell_name(root));
                    if !reads.contains(&read) {
                        reads.push(read);
                    }
                    if !roots.contains(&root) {
                        roots.push(root);
                    }
                }
                (reads, roots)
            })
            .filter(|(reads, _)| !reads.is_empty())
            .collect();
        for (reads, roots) in told {
            let (is, was) = if reads.len() == 1 { ("is", "it was") } else { ("are", "they were") };
            let reads = joined(reads.iter().map(|r| format!("'{r}'")));
            let refreshes = joined(roots.iter().map(|r| format!("`refresh({r})`")));
            let mut note = crate::diagnostic::Diagnostic::error(
                codes::AWAIT_VALUE_CAPTURED,
                format!(
                    "{reads} in this wait's WHERE {is} read once, when the wait is reached (0.13); under {pin} {was} read again at every check, so a change while the run waited changed what the wait accepted. Nothing to rewrite unless the wait should follow the live value: then test it after the wait against {refreshes}"
                ),
                head.span,
            );
            note.severity = Some(crate::diagnostic::Severity::Warning);
            note.upgrade = Some(true);
            self.push(note);
        }
    }

    /// A `race` opens: its number, which its arms are walked under.
    pub fn open_race(&mut self) -> usize {
        self.races.opened += 1;
        self.races.opened - 1
    }

    /// `check` walks arm `arm` of race `race`.
    pub fn in_race_arm<T>(&mut self, race: usize, arm: usize, check: impl FnOnce(&mut Self) -> T) -> T {
        self.races.arms.push((race, arm));
        let checked = check(self);
        self.races.arms.pop();
        checked
    }

    /// A `race` ends, `sleeps` saying of each arm whether it may sleep. An
    /// await inside an arm whose sibling sleeps is raced; one not raced, and
    /// in no race around this one, is told now.
    pub fn close_race(&mut self, race: usize, sleeps: &[bool]) {
        let raced = |arm: usize| sleeps.iter().enumerate().any(|(other, sleeps)| other != arm && *sleeps);
        let mut untold = Vec::new();
        self.races.awaits.retain(|waiting| {
            let Some(&(_, arm)) = waiting.arms.iter().find(|(around, _)| *around == race) else { return true };
            if raced(arm) {
                return false;
            }
            if waiting.arms.first().is_some_and(|(outermost, _)| *outermost == race) {
                untold.push((waiting.span, waiting.written.clone()));
                return false;
            }
            true
        });
        for (span, text) in untold {
            self.tell_await_may_hang(span, &text);
        }
    }

    /// On a check for an upgrade from before 0.13: an `await` on a record's
    /// edge (`text` as written), which waits forever once its record is
    /// deleted unless a sibling arm of a race around it sleeps. Told when
    /// the races around it say it is not raced.
    pub fn report_await_may_hang(&mut self, span: Span, text: String) {
        let Some(pin) = self.upgrading_from else { return };
        if self.type_only > 0 || standing(pin, DELETED_WAITS_HANG_SINCE) != Standing::OlderKey {
            return;
        }
        if self.races.arms.is_empty() {
            self.tell_await_may_hang(span, &text);
        } else {
            let arms = self.races.arms.clone();
            self.races.awaits.push(AwaitInRace { span, written: text, arms });
        }
    }

    fn tell_await_may_hang(&mut self, span: Span, text: &str) {
        let Some(pin) = self.upgrading_from else { return };
        if self.races.told.contains(&span) {
            return;
        }
        self.races.told.push(span);
        let mut note = crate::diagnostic::Diagnostic::error(
            codes::AWAIT_MAY_HANG,
            format!(
                "'{text}' is not in a `race` with a `sleep`: from 0.13 a wait whose record is deleted never ends (under {pin} the code after it was skipped), so this run can wait forever. Race it: `race(() => {{ return {text} }}, () => {{ await sleep(1d) }})` — reviews#deleted-records"
            ),
            span,
        );
        note.severity = Some(crate::diagnostic::Severity::Warning);
        note.upgrade = Some(true);
        self.push(note);
    }

    /// Whether `name` holds a record the run read or wrote (not a connection).
    fn holds_record(&self, name: &str, scope: ScopeId) -> bool {
        let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return false };
        let symbol = self.scopes.symbol(id);
        symbol.kind != SymbolKind::Instance && (symbol.types.pos.is_some() || symbol.types.is_record)
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

    /// `refuseUnresumableWait`: a wait where the run cannot come back to it.
    pub fn refuse_unresumable_wait(&mut self, where_: &str, span: Span) {
        self.report(
            codes::WAIT_NOT_RESUMABLE,
            format!(
                "{where_} may wait ('await', or a call to a function that awaits), and a run cannot be resumed there — it would park and never come back. Do the waiting in the movement itself, before or after this, and keep the condition to work that finishes without waiting."
            ),
            span,
        );
    }
}

/// `a`, `a and b`, `a, b and c`.
fn joined(items: impl Iterator<Item = String>) -> String {
    let items: Vec<String> = items.collect();
    match items.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => items.concat(),
    }
}

/// A member read off a root as written (`founder.Email`, `a.b.c`); none
/// for a walk.
fn spell_read(read: &Expression) -> Option<String> {
    match read {
        Expression::Property { property_type_id, .. } | Expression::EdgeProperty { property_type_id, .. } => Some(spell_name(property_type_id)),
        Expression::Traverse { alias_root: Some(root), steps, expression } if steps.is_empty() => {
            Some(format!("{}.{}", spell_name(root), spell_read(expression)?))
        }
        _ => None,
    }
}

/// Every statement carries its span under one name; the tree is the one
/// place that says so for all of them.
pub(crate) fn statement_span(statement: &Statement) -> Option<Span> {
    let tree = serde_json::to_value(statement).ok()?;
    serde_json::from_value(tree.get("span")?.clone()).ok()
}

/// What a function body may do, as far as parking goes. The rest of the
/// TypeScript's effect row (reads, writes, `ai`, `now`) is not modelled.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EffectRow {
    /// It may wait: an `await`, a combinator, or a call to a function that
    /// waits.
    pub suspends: bool,
    /// It may `await sleep(…)`, directly or through a function it calls.
    pub sleeps: bool,
}

impl EffectRow {
    /// What either may do.
    pub fn with(self, other: EffectRow) -> EffectRow {
        EffectRow { suspends: self.suspends || other.suspends, sleeps: self.sleeps || other.sleeps }
    }
}

/// The `race` arms around the walk, and the awaits on a record's edge
/// inside them, for `MOV_AWAIT_MAY_HANG`: an await is raced when an arm
/// around it has a sibling that sleeps, which only the race's end can tell.
#[derive(Default)]
pub struct Races {
    /// The arms being walked, outermost first.
    arms: Vec<RaceArm>,
    /// How many races the walk has opened.
    opened: usize,
    /// Awaits inside a race not yet ended.
    awaits: Vec<AwaitInRace>,
    /// Awaits already told, so a body walked twice tells once.
    told: Vec<Span>,
}

/// One arm of a race being walked: the race's number, and the arm's index.
type RaceArm = (usize, usize);

/// An await inside a race not yet ended: where, as written, and the arms
/// around it, outermost first.
struct AwaitInRace {
    span: Span,
    written: String,
    arms: Vec<RaceArm>,
}

/// What the open function bodies may do.
#[derive(Default)]
pub struct Effects {
    /// One row per function body being walked, innermost last.
    frames: Vec<EffectRow>,
    /// What each closure bound to a name may do when called.
    pub closures: std::collections::HashMap<SymbolId, EffectRow>,
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
        self.effects.frames.push(EffectRow::default());
    }

    /// What the body walked since the matching open may do.
    pub fn close_effect_frame(&mut self) -> EffectRow {
        self.effects.frames.pop().unwrap_or_default()
    }

    /// The run may park here (`flag('suspend')`).
    pub fn flag_suspend(&mut self) {
        if let Some(top) = self.effects.frames.last_mut() {
            top.suspends = true;
        }
    }

    /// The run may sleep here.
    pub fn flag_sleep(&mut self) {
        if let Some(top) = self.effects.frames.last_mut() {
            top.sleeps = true;
        }
    }

    /// A call that may wait, as a plugin's declared effects say.
    pub fn absorb_suspend(&mut self, suspends: bool) {
        self.absorb(EffectRow { suspends, sleeps: false });
    }

    /// What a called or scheduled function does is the caller's too.
    pub fn absorb(&mut self, row: EffectRow) {
        if let Some(top) = self.effects.frames.last_mut() {
            *top = top.with(row);
        }
    }

    /// What calling the closure a name holds may do.
    pub fn closure_row(&self, id: SymbolId) -> EffectRow {
        self.effects.closures.get(&id).copied().unwrap_or_default()
    }
}

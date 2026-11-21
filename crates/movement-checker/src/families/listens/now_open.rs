//! A listen a host may have limited to registered senders until its module's
//! `listensLimitedBefore` (Slack's 0.16.0): from that release only the
//! listen's filter decides who sets it off, and the app's own messages reach
//! it too. On an upgrade from an older key, each listen whose filter calls no
//! pure function taking a claim is told so, naming the claims the event
//! carries. A file written under the new release is told nothing: what it
//! says is what it means.
//!
//! Code: MOV_LISTEN_NOW_OPEN. A warning that holds the pin until the author
//! has checked it. The language knows no function that limits a listen, so
//! the check is offered as a fix only when the host names one
//! (`CheckOptions.limiting_function`), and never as a safe one: it changes
//! who sets the listen off.

use std::borrow::Cow;

use movement_parser::ast::{Loc, PathHead, Span};
use movement_parser::catalog::packages::program_name_of;
use movement_parser::catalog::types::{Composite, FieldType, PositionSchema};
use movement_parser::lowering::expression::{EdgeStep, Expression, LogicalOp};
use movement_parser::surface::table::plugin_name;
use movement_parser::version::{Standing, standing};
use serde_json::json;

use crate::checker::Checker;
use crate::codes;
use crate::diagnostic::{Diagnostic, Severity};
use crate::families::claims::{ClaimField, claim_fields, spelled_claims};
use crate::families::flow::spell_path_head;
use crate::families::values::{quote_name, sub_expressions};
use crate::scope::{Resolution, ScopeId};
use crate::types::position::{Instance, Position, position_schema_of_ref};

/// The field Slack marks the app's own messages and reactions with: the
/// registered sender gate dropped them, so a listen that should not hear
/// them now says so. Named only where the landing declares it.
const SENT_BY_THIS_APP: &str = "Sent By This App";

/// What the warning and its fix say of the event a listen lands.
struct Landing<'a> {
    claims: Vec<ClaimField<'a>>,
    sent_by_this_app: bool,
}

impl Checker<'_> {
    /// MOV_LISTEN_NOW_OPEN for a listen on `instance`, landing `landed`.
    pub(super) fn report_listen_now_open(&mut self, path: &PathHead, instance: &Instance, steps: &[EdgeStep], landed: &Position, scope: ScopeId) {
        let Some(pin) = self.upgrading_from else { return };
        let spec = instance.adapter.as_deref().and_then(|adapter| self.catalog.adapter(adapter));
        let Some(release) = spec.and_then(|spec| spec.listens_limited_before.as_deref()) else { return };
        if standing(pin, release) != Standing::OlderKey {
            return;
        }
        if steps.iter().filter_map(|step| step.expression_filter.as_deref()).any(|filter| self.limits_senders(filter, scope)) {
            return;
        }
        let schemas = landed_schemas(landed);
        let landing = Landing {
            claims: schemas.first().map(|schema| claim_fields(schema)).unwrap_or_default(),
            sent_by_this_app: schemas.iter().any(|schema| schema.properties.contains_key(SENT_BY_THIS_APP)),
        };
        let alias = steps.last().and_then(|step| step.alias.clone()).unwrap_or_else(|| "m".to_string());
        let claims = if landing.claims.is_empty() { "none".to_string() } else { spelled_claims(&landing.claims) };
        let own = if landing.sent_by_this_app {
            format!(", and `NOT {alias}.{}` keeps out the app's own messages", quote_name(SENT_BY_THIS_APP))
        } else {
            String::new()
        };
        let message = format!(
            "before {release} a host may have let only registered senders set this listen off; under {release} only its filter decides, and the app's own messages reach it too. To limit it, call a host function on a claim the event carries in its WHERE (its claims: {claims}){own}; if anyone may set it off, it stays as it is"
        );
        let mut diagnostic = Diagnostic::error(codes::LISTEN_NOW_OPEN, message, path.span);
        diagnostic.severity = Some(Severity::Warning);
        diagnostic.upgrade = Some(true);
        if self.imports.current_path().is_none() {
            diagnostic.fix = self.limiting_fix(path, steps, &landing, scope);
        }
        self.push(diagnostic);
    }

    /// Whether `filter` calls a pure plugin that takes a claim: a host
    /// function that limits who sets the listen off.
    fn limits_senders(&self, filter: &Expression, scope: ScopeId) -> bool {
        let takes_claim = |name: &str| {
            let Resolution::Found(id) = self.scopes.resolve(scope, name) else { return false };
            let spec = self.plugin_spec_of(id, name);
            spec.is_some_and(|spec| spec.pure() && spec.arg_types.as_ref().is_some_and(|types| types.values().any(|ty| !brands_asked(ty).is_empty())))
        };
        let calls = matches!(filter, Expression::Function { fn_, .. } if self.plugin_purity(fn_, scope) == Some(true) && takes_claim(fn_));
        calls || sub_expressions(filter).into_iter().any(|e| self.limits_senders(e, scope))
    }

    /// The host's limiting function's check on the listen's last hop, and
    /// its import when the program has none: the claim it is called on is
    /// the event's field whose brands its parameter asks for.
    fn limiting_fix(&self, path: &PathHead, steps: &[EdgeStep], landing: &Landing, scope: ScopeId) -> Option<serde_json::Value> {
        let key = self.limiting_function?;
        let spec = self.catalog.plugin(key)?;
        let parameter = spec.args.first()?;
        let asked = spec.arg_types.as_ref().and_then(|types| types.get(parameter)).map(brands_asked)?;
        // Several fields may fit; the one fitting the union's first member
        // wins, so the order the host wrote the parameter in is the order of
        // preference.
        let claim = asked.iter().find_map(|brands| landing.claims.iter().find(|claim| brands.iter().all(|brand| claim.brands.contains(brand))))?;
        let last = steps.last()?;
        if last.cardinality.is_some() {
            return None;
        }
        let (callee, import) = match self.imported_as(key, scope) {
            Some(callee) => (callee, None),
            None => {
                let package = spec.package.as_deref()?;
                let member = plugin_name(program_name_of(key, spec));
                let local = package.rsplit('/').next().filter(|local| !local.is_empty()).unwrap_or("host");
                let local = self.fresh_name(local, scope);
                let import = format!("import {{ `{package}` as {local} }} from plugins");
                (format!("{local}.{}", quote_name(&member)), Some(import))
            }
        };
        let alias = match &last.alias {
            Some(alias) => alias.clone(),
            None => self.fresh_name("m", scope),
        };
        let read = |field: &str| format!("{alias}.{}", quote_name(field));
        let mut checks = Vec::new();
        if claim.may_be_absent {
            checks.push(format!("{} != null", read(claim.name)));
        }
        checks.push(format!("{callee}({})", read(claim.name)));
        if landing.sent_by_this_app {
            checks.push(format!("NOT {}", read(SENT_BY_THIS_APP)));
        }
        let wraps = matches!(last.expression_filter.as_deref(), Some(Expression::Logical { op: LogicalOp::Or, .. }));
        let hops = with_checks(&path.hops_raw, &Insert { alias: last.alias.is_none().then_some(alias.as_str()), checks: &checks.join(" AND "), wraps })?;
        let root = spell_path_head(path);
        let root = &root[..root.len() - path.hops_raw.len()];
        let mut edits = vec![json!({ "span": path.span, "text": format!("{root}{hops}") })];
        if let Some(import) = import {
            let edit = match self.last_import {
                Some(after) => json!({ "span": Span { start: after.end, end: after.end }, "text": format!("\n{import}") }),
                None => {
                    let start = Loc { line: 1, col: 1 };
                    json!({ "span": Span { start, end: start }, "text": format!("{import}\n") })
                }
            };
            edits.insert(0, edit);
        }
        Some(json!({ "edits": edits, "safe": false }))
    }

    /// The name this program calls the plugin `key` by, when it imports it.
    fn imported_as(&self, key: &str, scope: ScopeId) -> Option<String> {
        let found = self.scopes.scope(scope).symbols.iter().find(|(_, id)| self.scopes.symbol(**id).imported_name.as_deref() == Some(key));
        found.map(|(name, _)| name.clone()).filter(|name| self.plugin_purity(name, scope).is_some())
    }

    /// `wanted`, or `wanted2`, `wanted3`, … : the first that names nothing here.
    fn fresh_name(&self, wanted: &str, scope: ScopeId) -> String {
        let free = |name: &str| !matches!(self.scopes.resolve(scope, name), Resolution::Found(_));
        if free(wanted) {
            return wanted.to_string();
        }
        (2..).map(|n| format!("{wanted}{n}")).find(|name| free(name)).unwrap_or_else(|| wanted.to_string())
    }
}

/// The schemas of the record types a listen lands.
fn landed_schemas(landed: &Position) -> Vec<Cow<'_, PositionSchema>> {
    match landed {
        Position::MaybeEmpty(of) => landed_schemas(of),
        Position::Union(union) => union.variants.iter().filter_map(|variant| union.instance.schema.positions.get(variant)).map(Cow::Borrowed).collect(),
        other => position_schema_of_ref(other).into_iter().collect(),
    }
}

/// The brands a parameter of `ty` asks for: one set per member of its union
/// (through `| null`), in the order written. A value fits a member when it
/// carries all of that member's brands.
fn brands_asked(ty: &FieldType) -> Vec<&[String]> {
    match ty {
        FieldType::Composite(Composite::Branded { brands, .. }) => vec![brands.as_slice()],
        FieldType::Composite(Composite::MaybeAbsent { of }) => brands_asked(of),
        FieldType::Composite(Composite::Union { of }) => of.iter().flat_map(brands_asked).collect(),
        _ => Vec::new(),
    }
}

/// What the fix adds to the last hop.
struct Insert<'a> {
    /// The alias to name the hop by, when it has none.
    alias: Option<&'a str>,
    /// `m.`User Email` != null AND team.isMember(m.`User Email`)`.
    checks: &'a str,
    /// Whether the hop's filter is an OR, so the checks AND the whole of it.
    wraps: bool,
}

/// `hops` with `insert` made in its last hop, as written. None when the last
/// hop is not written as the scan expects.
fn with_checks(hops: &str, insert: &Insert) -> Option<String> {
    let last = last_hop_start(hops)?;
    let hop = &hops[last..];
    let scanned = scan_hop(hop)?;
    let mut text = hop.to_string();
    // Back to front, so each place stays where the scan found it.
    match scanned.filter {
        Some((from, to)) => {
            text.insert_str(to, &format!(" AND {}", insert.checks));
            if insert.wraps {
                text.insert(to, ')');
                text.insert(from, '(');
            }
        }
        None => text.insert_str(scanned.close, &format!(" WHERE {}", insert.checks)),
    }
    if let Some(alias) = insert.alias {
        text.insert_str(scanned.colon, alias);
    }
    Some(format!("{}{text}", &hops[..last]))
}

/// Where a hop's parts are, as byte offsets into it: its `:`, its filter's
/// text (after `WHERE`, trimmed), and the `]` that closes it.
struct ScannedHop {
    colon: usize,
    filter: Option<(usize, usize)>,
    close: usize,
}

/// Each byte of `text` outside quotes, with the depth of `[` it is at.
fn unquoted(text: &str) -> Vec<(usize, char, usize)> {
    let (mut depth, mut quote, mut out) = (0usize, None::<char>, Vec::new());
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        match (quote, c) {
            (Some(q), _) if c == q => quote = None,
            (Some(_), '\\') => {
                chars.next();
            }
            (Some(_), _) => {}
            (None, '"' | '\'' | '`') => quote = Some(c),
            (None, '[') => {
                depth += 1;
                out.push((at, c, depth));
            }
            (None, ']') => {
                out.push((at, c, depth));
                depth = depth.saturating_sub(1);
            }
            (None, _) => out.push((at, c, depth)),
        }
    }
    out
}

/// Where the last `-[` of a hop chain opens, outside brackets and quotes.
fn last_hop_start(hops: &str) -> Option<usize> {
    let scanned = unquoted(hops);
    scanned.windows(2).rev().find(|pair| pair[0].1 == '-' && pair[0].2 == 0 && pair[1].1 == '[').map(|pair| pair[0].0)
}

fn scan_hop(hop: &str) -> Option<ScannedHop> {
    let scanned = unquoted(hop);
    let colon = scanned.iter().find(|(_, c, depth)| *c == ':' && *depth == 1)?.0;
    let close = scanned.iter().find(|(_, c, depth)| *c == ']' && *depth == 1)?.0;
    let is_word = |at: usize| hop.as_bytes().get(at).is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
    let keyword = scanned
        .iter()
        .filter(|(at, _, depth)| *depth == 1 && *at > colon && *at < close)
        .map(|(at, _, _)| *at)
        .find(|at| hop.get(*at..*at + 5).is_some_and(|word| word.eq_ignore_ascii_case("where")) && !is_word(at.wrapping_sub(1)) && !is_word(at + 5));
    let filter = keyword.map(|at| {
        let body = &hop[at + 5..close];
        let from = at + 5 + (body.len() - body.trim_start().len());
        let to = close - (body.len() - body.trim_end().len());
        (from, to)
    });
    Some(ScannedHop { colon, filter, close })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checked(hops: &str, alias: Option<&str>, wraps: bool) -> Option<String> {
        with_checks(hops, &Insert { alias, checks: "t.f(m.x)", wraps })
    }

    #[test]
    fn the_checks_join_the_last_hops_filter() {
        assert_eq!(checked("-[c:Channels WHERE c.Name == \"]\"]->-[m:Messages WHERE m.A == 1]->", None, false).as_deref(), Some("-[c:Channels WHERE c.Name == \"]\"]->-[m:Messages WHERE m.A == 1 AND t.f(m.x)]->"));
        assert_eq!(checked("-[m:Messages WHERE m.A == 1 OR m.B == 2 ]->", None, true).as_deref(), Some("-[m:Messages WHERE (m.A == 1 OR m.B == 2) AND t.f(m.x) ]->"));
        assert_eq!(checked("-[:Messages]->", Some("m"), false).as_deref(), Some("-[m:Messages WHERE t.f(m.x)]->"));
        assert_eq!(checked("-[m:`Where Things`]->", None, false).as_deref(), Some("-[m:`Where Things` WHERE t.f(m.x)]->"));
        assert_eq!(checked("-[m:Messages where m.A IN [1, 2]]->", None, false).as_deref(), Some("-[m:Messages where m.A IN [1, 2] AND t.f(m.x)]->"));
    }
}

//! `listen-fire upgrade`: the project's movement files rewritten into the language of
//! this release, by the Rust checker's own fixes (the
//! loop of lf-platform's packages/legacy-lang/checker/upgrade.ts). Check, take the fixes that do
//! not overlap, apply them, check again, until nothing fixable is left. Only
//! fixes marked safe are applied unless `--all`; the rest are listed with their
//! rewrite. Only the rewritten spans change, so comments and layout survive.
//! The pin moves only when nothing is left to fix and no warning says the
//! rewrite may have changed what the program does, unless `--all`.

use std::io::Write;
use std::path::Path;

use movement_checker::host::native::NativeZones;
use movement_checker::{CheckOptions, Diagnostic, Severity};
use movement_parser::catalog::types::CatalogSnapshot;
use movement_parser::util::form::{external_text, read_json_text};
use serde_json::Value;

use crate::check::{Opened, open_checking, parse};
use crate::json::Js;
use crate::movements_slot::{self, WriteError, Written};
use crate::project::{PROJECT_FILE, Project};
use crate::sources::{MOVEMENT_EXTENSION, MovementFile};
use movement_parser::version::LANGUAGE_VERSION;

/// One pass per level of fix nesting; a well-behaved upgrade settles in a few.
const MAX_PASSES: usize = 16;

type Loc = (u64, u64);

struct Edit {
    start: Loc,
    end: Loc,
    text: String,
}

struct Fix {
    edits: Vec<Edit>,
    safe: bool,
    /// The edits as JSON, the identity two diagnostics offering one repair share.
    key: Value,
}

impl Fix {
    fn of(diagnostic: &Diagnostic) -> Option<Fix> {
        let fix = diagnostic.fix.as_ref()?;
        let loc = |v: &Value| Some((v.get("line")?.as_u64()?, v.get("col")?.as_u64()?));
        let edits_json = fix.get("edits")?;
        let edits = edits_json
            .as_array()?
            .iter()
            .map(|e| Some(Edit { start: loc(e.get("span")?.get("start")?)?, end: loc(e.get("span")?.get("end")?)?, text: external_text(e.get("text")?.as_str()?).into_owned() }))
            .collect::<Option<Vec<_>>>()?;
        Some(Fix { edits, safe: fix.get("safe") == Some(&Value::Bool(true)), key: edits_json.clone() })
    }

    fn extent(&self) -> (Loc, Loc) {
        let start = self.edits.iter().map(|e| e.start).min().unwrap_or((0, 0));
        let end = self.edits.iter().map(|e| e.end).max().unwrap_or((0, 0));
        (start, end)
    }
}

/// Two edits touch the same text, or insert at the same place (their order would be a guess).
fn edits_overlap(a: &Edit, b: &Edit) -> bool {
    if (a.start == a.end || b.start == b.end) && a.start == b.start {
        return true;
    }
    a.start < b.end && b.start < a.end
}

/// A diagnostic that stands between a text and the target version: an
/// error, or an upgrade note with a rewrite to take. An upgrade note with no
/// rewrite says what changed meaning: it is listed, and holds the pin until
/// the author has checked it (`--all`).
fn stands(d: &Diagnostic) -> bool {
    d.is_error() || (d.upgrade == Some(true) && d.fix.is_some())
}

fn is_note(d: &Diagnostic) -> bool {
    d.upgrade == Some(true) && d.fix.is_none()
}

fn fixes_to_apply(diagnostics: &[Diagnostic], all: bool) -> Vec<Fix> {
    let mut offered: Vec<Fix> = diagnostics
        .iter()
        .filter(|d| stands(d))
        .filter_map(Fix::of)
        .filter(|fix| !fix.edits.is_empty() && (all || fix.safe))
        .collect();
    // Outermost first: earliest start, then widest.
    offered.sort_by(|a, b| {
        let (x, y) = (a.extent(), b.extent());
        x.0.cmp(&y.0).then(y.1.cmp(&x.1))
    });
    let mut taken: Vec<Fix> = Vec::new();
    for fix in offered {
        if taken.iter().any(|t| t.key == fix.key) {
            continue;
        }
        if taken.iter().any(|t| t.edits.iter().any(|a| fix.edits.iter().any(|b| edits_overlap(a, b)))) {
            continue;
        }
        taken.push(fix);
    }
    taken
}

/// The edits applied the way `applyFix` applies them: columns count UTF-16 code units.
fn apply(source: &str, fixes: &[Fix]) -> String {
    let units: Vec<u16> = source.encode_utf16().collect();
    let mut line_starts = vec![0usize];
    for (i, u) in units.iter().enumerate() {
        if *u == u16::from(b'\n') {
            line_starts.push(i + 1);
        }
    }
    let offset = |(line, col): Loc| {
        let base = line_starts.get((line as usize).wrapping_sub(1)).copied().unwrap_or(units.len());
        (base + col as usize).saturating_sub(1)
    };
    let mut edits: Vec<&Edit> = fixes.iter().flat_map(|f| f.edits.iter()).collect();
    // Back to front, so an edit never shifts the offsets of one still to apply.
    edits.sort_by_key(|e| std::cmp::Reverse(offset(e.start)));
    let mut result = units.clone();
    for edit in edits {
        let (from, to) = (offset(edit.start).min(result.len()), offset(edit.end).min(result.len()));
        result.splice(from..to.max(from), edit.text.encode_utf16());
    }
    String::from_utf16_lossy(&result)
}

/// Every diagnostic a check of `source` reports, as a move up from `from_pin`
/// when given.
fn check_text(source: &str, catalog: &CatalogSnapshot, from_pin: Option<&str>) -> Vec<Diagnostic> {
    let parse_refusal = |message: String, line: usize, col: usize| {
        let at = movement_parser::ast::Loc { line, col };
        vec![Diagnostic::error("MOV_PARSE", message, movement_parser::ast::Span { start: at, end: at })]
    };
    if let Err(refused) = parse(source) {
        return parse_refusal(refused.message, refused.line, refused.column);
    }
    let options = CheckOptions { upgrading_from: from_pin, zones: &NativeZones };
    match movement_checker::check_source(source, catalog, options) {
        Ok(diagnostics) => diagnostics,
        Err(refusal) => parse_refusal(refusal.message, 1, 1),
    }
}

struct Upgraded {
    source: String,
    /// What stands between the text and this release (`stands`).
    remaining: Vec<Diagnostic>,
    /// Upgrade notes with nothing to rewrite: each says a construct may now
    /// behave otherwise, and holds the pin until checked.
    notes: Vec<Diagnostic>,
    settled: bool,
    /// The errors the rewrite would have left that the text did not have:
    /// when any, nothing is rewritten.
    withheld: Vec<Diagnostic>,
}

impl Upgraded {
    fn of(source: String, diagnostics: Vec<Diagnostic>, settled: bool) -> Self {
        let (remaining, rest): (Vec<_>, Vec<_>) = diagnostics.into_iter().partition(stands);
        Upgraded { source, remaining, notes: rest.into_iter().filter(is_note).collect(), settled, withheld: Vec::new() }
    }
}

fn upgrade_source(source: &str, catalog: &CatalogSnapshot, all: bool, from_pin: &str) -> Upgraded {
    let mut text = source.to_string();
    for _ in 0..MAX_PASSES {
        let diagnostics = check_text(&text, catalog, Some(from_pin));
        let fixes = fixes_to_apply(&diagnostics, all);
        let rewritten = apply(&text, &fixes);
        // A fix that rewrites to the same text would loop forever.
        if fixes.is_empty() || rewritten == text {
            return Upgraded::of(text, diagnostics, true);
        }
        text = rewritten;
    }
    let diagnostics = check_text(&text, catalog, Some(from_pin));
    Upgraded::of(text, diagnostics, false)
}

/// The rewrite checked once more before it is kept: one that leaves an
/// error the text did not have is not written, and the text's own
/// diagnostics stand.
fn kept_only_if_no_worse(source: &str, upgraded: Upgraded, catalog: &CatalogSnapshot, from_pin: &str) -> Upgraded {
    if upgraded.source == source {
        return upgraded;
    }
    let before = check_text(source, catalog, Some(from_pin));
    let withheld = introduced_errors(&before, &upgraded.remaining);
    if withheld.is_empty() {
        return upgraded;
    }
    Upgraded { withheld, ..Upgraded::of(source.to_string(), before, upgraded.settled) }
}

/// The errors in `after` beyond what `before` had of each code.
fn introduced_errors(before: &[Diagnostic], after: &[Diagnostic]) -> Vec<Diagnostic> {
    let mut had: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for d in before.iter().filter(|d| d.is_error()) {
        *had.entry(d.code.as_str()).or_default() += 1;
    }
    after
        .iter()
        .filter(|d| d.is_error())
        .filter(|d| match had.get_mut(d.code.as_str()) {
            Some(left) if *left > 0 => {
                *left -= 1;
                false
            }
            _ => true,
        })
        .cloned()
        .collect()
}

/// A unified diff of two texts, by line; empty when they are the same.
fn unified_diff(before: &str, after: &str, path: &str) -> String {
    if before == after {
        return String::new();
    }
    let lines_of = |text: &str| text.strip_suffix('\n').unwrap_or(text).split('\n').map(str::to_string).collect::<Vec<_>>();
    let (a, b) = (lines_of(before), lines_of(after));
    let context = 3usize;
    let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    // (kind, text, lines of a before it, lines of b before it)
    let mut lines: Vec<(char, &str, usize, usize)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            lines.push((' ', &a[i], i, j));
            i += 1;
            j += 1;
        } else if i < a.len() && (j == b.len() || lcs[i + 1][j] >= lcs[i][j + 1]) {
            lines.push(('-', &a[i], i, j));
            i += 1;
        } else {
            lines.push(('+', &b[j], i, j));
            j += 1;
        }
    }
    let shown = path.trim_start_matches('/');
    let mut out = vec![format!("--- a/{shown}"), format!("+++ b/{shown}")];
    let mut k = 0;
    while k < lines.len() {
        if lines[k].0 == ' ' {
            k += 1;
            continue;
        }
        // A hunk: this change and every one within 2×context lines of it.
        let mut last_change = k;
        let mut n = k;
        while n < lines.len() && n - last_change <= 2 * context {
            if lines[n].0 != ' ' {
                last_change = n;
            }
            n += 1;
        }
        let hunk = &lines[k.saturating_sub(context)..(last_change + context + 1).min(lines.len())];
        let a_count = hunk.iter().filter(|l| l.0 != '+').count();
        let b_count = hunk.iter().filter(|l| l.0 != '-').count();
        let first = hunk[0];
        out.push(format!("@@ -{},{a_count} +{},{b_count} @@", first.2 + usize::from(a_count > 0), first.3 + usize::from(b_count > 0)));
        for l in hunk {
            out.push(format!("{}{}", l.0, l.1));
        }
        k = last_change + context + 1;
    }
    out.push(String::new());
    out.join("\n")
}

/// `file:line:col severity CODE message`.
fn listed(shown: &str, d: &Diagnostic) -> String {
    format!("{shown}:{}:{} {} {} {}", d.span.start.line, d.span.start.col, severity_word(d), d.code, external_text(&d.message))
}

fn severity_word(d: &Diagnostic) -> &'static str {
    match d.severity {
        None => "error",
        Some(Severity::Warning) => "warning",
        Some(Severity::Info) => "info",
    }
}

/// `lf.yaml`'s text with its top-level `engine:` line set to `to`, comments
/// and layout kept; none when the line already says it.
fn with_engine_pin(text: &str, to: &str) -> Result<Option<String>, String> {
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    let at = lines.iter().position(|l| l.strip_prefix("engine:").is_some()).ok_or("lf.yaml has no top-level `engine:` line to set")?;
    let line = format!("engine: {to}");
    if lines[at].trim_end() == line {
        return Ok(None);
    }
    lines[at] = line;
    Ok(Some(lines.join("\n")))
}

enum PinStep {
    /// The project already pins the current release.
    Current,
    /// The project validates clean under the current release: its `lf.yaml` with the new pin.
    Set(String),
    /// Fixes remain for the author, or warnings that a rewrite may have changed
    /// what the program does: the movements still read as the old release.
    Held { remaining: usize, unchecked: usize },
}

/// The pin moves only when the rewritten project validates clean under the
/// current release; otherwise a later `listen-fire run` would read movements the
/// current release still refuses. It also holds while a warning stands that
/// the program may now do something else, since moving it is what puts the
/// program live under the new meaning; `unchecked` counts those, and is 0 once
/// the author has said (`--all`) they were checked.
fn pin_step(lf_yaml: &str, remaining: usize, unchecked: usize) -> Result<PinStep, String> {
    let Some(repinned) = with_engine_pin(lf_yaml, LANGUAGE_VERSION)? else { return Ok(PinStep::Current) };
    Ok(if remaining == 0 && unchecked == 0 { PinStep::Set(repinned) } else { PinStep::Held { remaining, unchecked } })
}

pub async fn run(project: &Project, options: UpgradeOptions, out: &mut impl Write) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    let mut checking = match open_checking(project).await? {
        Opened::MissingCredentials(missing) => {
            for m in &missing {
                writeln!(out, "{}", crate::check::missing_line(m)).map_err(io)?;
            }
            writeln!(out, "{} error(s)", missing.len()).map_err(io)?;
            return Ok(1);
        }
        Opened::Ready(checking) => checking,
    };
    let load = |catalog: &Js| CatalogSnapshot::load(&read_json_text(&catalog.to_json())).map_err(|e| format!("the catalog does not load: {e}"));
    let mut held = checking.catalog.to_json();
    let mut catalog = load(&checking.catalog)?;
    let store = movements_slot::of_project(project, &std::env::vars().collect::<Vec<_>>())?;
    let (mut changed, mut left, mut warned) = (0usize, 0usize, 0usize);
    for file in &checking.files.clone() {
        let mut result = upgrade_source(&file.source, &catalog, options.all, &project.engine);
        // A rewrite walks hops the files did not (a listen's table, narrowed by
        // its WHERE): the catalog is narrowed by them too, and the file upgraded
        // again against it, until the narrowing settles.
        for _ in 0..MAX_PASSES {
            // A rewrite the catalog was not narrowed for is withheld, and says
            // the traversal it would walk: the catalog is narrowed by it too.
            let unchecked: String = result.remaining.iter().filter_map(|d| d.walks.as_deref()).map(|path| format!("\nlisten to {path} fire __upgrade_probe__\n")).collect();
            if result.source == file.source && unchecked.is_empty() {
                break;
            }
            let rewritten = MovementFile { source: format!("{}{unchecked}", result.source), version: None, ..file.clone() };
            let narrowed = crate::check::catalog_with(&mut checking, &[rewritten]).await?;
            if narrowed.to_json() == held {
                break;
            }
            held = narrowed.to_json();
            catalog = load(&narrowed)?;
            result = upgrade_source(&file.source, &catalog, options.all, &project.engine);
        }
        let result = kept_only_if_no_worse(&file.source, result, &catalog, &project.engine);
        let shown = relative(&project.root, &file.path);
        for d in &result.withheld {
            writeln!(out, "{shown}: not rewritten, because the rewrite would leave {}", listed(&shown, d)).map_err(io)?;
        }
        if result.source != file.source {
            if options.check_only {
                changed += 1;
                writeln!(out, "{}", unified_diff(&file.source, &result.source, &shown).trim_end()).map_err(io)?;
            } else {
                // Written at the version listen-fire read, so a file edited since is reported, not overwritten.
                match store.write(&format!("{}{MOVEMENT_EXTENSION}", file.name), &result.source, file.version.as_deref()) {
                    Ok(Written::Written { .. }) => changed += 1,
                    Ok(Written::Conflict { .. }) => {
                        left += 1;
                        writeln!(out, "{shown}: changed since listen-fire read it; nothing written (run `listen-fire upgrade` again)").map_err(io)?;
                    }
                    Err(refused @ WriteError::ReadOnly { .. }) => {
                        eprintln!("listen-fire: {}", refused.refusal());
                        return Ok(2);
                    }
                    Err(WriteError::Failed(message)) => return Err(message),
                }
            }
        }
        for d in &result.remaining {
            left += 1;
            writeln!(out, "{}", listed(&shown, d)).map_err(io)?;
            // A fix not proved to keep the meaning: shown, applied only with --all.
            if let Some(fix) = Fix::of(d).filter(|f| !f.edits.is_empty()) {
                let texts: Vec<String> = fix.edits.iter().map(|e| serde_json::to_string(&e.text).unwrap_or_default()).collect();
                writeln!(out, "  fix (not applied, may change meaning; --all applies it): {}", texts.join(", ")).map_err(io)?;
            }
        }
        for d in &result.notes {
            writeln!(out, "{}", listed(&shown, d)).map_err(io)?;
            if !options.all {
                warned += 1;
                writeln!(out, "  holds the pin: check it as the message says; `listen-fire upgrade --all` moves the pin once it is checked").map_err(io)?;
            }
        }
        if !result.settled {
            left += 1;
            writeln!(out, "{shown}: the rewrite did not settle — a fix keeps rewriting its own output (a bug; please report it)").map_err(io)?;
        }
    }
    let pin_file = project.root.join(PROJECT_FILE);
    let pinned = std::fs::read_to_string(&pin_file).map_err(|e| format!("{}: {e}", pin_file.display()))?;
    match pin_step(&pinned, left, warned)? {
        PinStep::Current => {}
        PinStep::Set(_) if options.check_only => {
            writeln!(out, "{PROJECT_FILE}: would set engine: {LANGUAGE_VERSION} (the pin is {})", project.engine).map_err(io)?;
        }
        PinStep::Set(repinned) => {
            std::fs::write(&pin_file, repinned).map_err(|e| format!("{}: {e}", pin_file.display()))?;
            writeln!(out, "{PROJECT_FILE}: engine: {LANGUAGE_VERSION} (was {})", project.engine).map_err(io)?;
        }
        PinStep::Held { remaining, unchecked } => {
            let fixes = format!("until the {remaining} remaining diagnostic(s) are fixed; run `listen-fire upgrade` again");
            let checks = format!("until the {unchecked} warning(s) are checked: a rewrite may have changed what the program does, and `listen-fire upgrade --all` moves the pin once they are checked");
            let held = match (remaining, unchecked) {
                (_, 0) => fixes,
                (0, _) => checks,
                _ => format!("{fixes}, then {checks}"),
            };
            writeln!(out, "{PROJECT_FILE}: engine: left at {} {held}", project.engine).map_err(io)?;
        }
    }
    let verb = if options.check_only { "would be rewritten" } else { "rewritten" };
    let to_check = if warned > 0 { format!(", {warned} warning(s) to check") } else { String::new() };
    writeln!(out, "{} file(s), {changed} {verb}, {left} left to change by hand{to_check}", checking.files.len()).map_err(io)?;
    Ok(if left > 0 || warned > 0 || (options.check_only && changed > 0) { 1 } else { 0 })
}

pub struct UpgradeOptions {
    pub check_only: bool,
    pub all: bool,
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pin_is_set_on_the_engine_line_and_nothing_else_moves() {
        let text = "# the project\nengine: 0.12.13\nmovements: movements\n";
        assert_eq!(with_engine_pin(text, "0.13.0").unwrap().unwrap(), "# the project\nengine: 0.13.0\nmovements: movements\n");
        assert_eq!(with_engine_pin("engine: 0.13.0\n", "0.13.0").unwrap(), None);
        assert!(with_engine_pin("movements: m\n", "0.13.0").is_err());
    }

    #[test]
    fn the_pin_moves_only_when_nothing_is_left_to_fix() {
        let old = "engine: 0.11.0\nmovements: m\n";
        let PinStep::Set(text) = pin_step(old, 0, 0).unwrap() else { panic!("a clean project is repinned") };
        assert_eq!(text, format!("engine: {LANGUAGE_VERSION}\nmovements: m\n"));
        assert!(matches!(pin_step(old, 3, 0).unwrap(), PinStep::Held { remaining: 3, unchecked: 0 }));
        assert!(matches!(pin_step(&text, 3, 0).unwrap(), PinStep::Current));
    }

    #[test]
    fn the_pin_is_held_while_a_warning_is_unchecked() {
        let old = "engine: 0.11.0\nmovements: m\n";
        assert!(matches!(pin_step(old, 0, 2).unwrap(), PinStep::Held { remaining: 0, unchecked: 2 }));
        assert!(matches!(pin_step(old, 1, 2).unwrap(), PinStep::Held { remaining: 1, unchecked: 2 }));
    }

    const CATALOG: &str = r#"{"adapters":{
      "crm":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
        "Person":{"properties":{"Email":"text"},"edges":{}}},
        "collections":{"People":{"target":"Person"}},"writableRoots":{}}}},
      "mail":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
        "Message":{"properties":{"To":"text","From":"text","Sent":"text"},"edges":{
          "Replies":{"target":"Message","listenable":true,"sequenced":"chronological","identity":"Sent"}}}},
        "collections":{"Messages":{"target":"Message"}},
        "writableRoots":{"Message":{"fields":{"To":"text"},"resultShape":{"externalId":"text"}}}}}}
    },"credentials":{},"plugins":{}}"#;

    #[test]
    fn a_fixless_upgrade_note_is_listed_and_holds_the_pin() {
        let source = "import { crm as crm_module, mail as mail_module } from adapters\ncrm = connect crm_module\nmail = connect mail_module\nfunction go(t: <text>) {\n  founder = only(crm-[:People]->)\n  m = write mail-[:Messages]-> { To: t }\n  r = await m-[x:Replies WHERE x.From == founder?.Email]->\n}\n";
        let catalog = CatalogSnapshot::load(CATALOG).unwrap();
        let upgraded = upgrade_source(source, &catalog, false, "0.12.13");
        assert_eq!(upgraded.source, source);
        assert!(upgraded.remaining.is_empty(), "{:?}", upgraded.remaining);
        let notes: Vec<String> = upgraded.notes.iter().map(|d| listed("go.mvt", d)).collect();
        // Two notes, neither with a rewrite: the WHERE's captured value, and
        // the wait no `sleep` races.
        assert_eq!(notes.len(), 2, "{notes:?}");
        assert!(notes.iter().any(|n| n.starts_with("go.mvt:7:13 warning MOV_AWAIT_VALUE_CAPTURED 'founder?.Email' in this wait's WHERE is read once")), "{notes:?}");
        assert!(notes.iter().any(|n| n.starts_with("go.mvt:7:7 warning MOV_AWAIT_MAY_HANG 'await m-[x:Replies WHERE x.From == founder?.Email]->' is not in a `race` with a `sleep`")), "{notes:?}");
        assert!(matches!(pin_step("engine: 0.12.13\n", upgraded.remaining.len(), upgraded.notes.len()).unwrap(), PinStep::Held { remaining: 0, unchecked: 2 }));
        assert!(matches!(pin_step("engine: 0.12.13\n", upgraded.remaining.len(), 0).unwrap(), PinStep::Set(_)));
        // Under this release's own pin there is nothing to say.
        assert!(upgrade_source(source, &catalog, false, LANGUAGE_VERSION).notes.is_empty());
    }

    const GH: &str = r#"{"adapters":{
      "gh":{"canFire":true,"constructionArgs":[],
        "listenSettingsBecome":{"path":["Notifications"],"aliases":["n"],"paramFrom":"Notification",
          "keys":{"events":{"hop":0,"field":"Reason","op":"in"}}},
        "schemas":{"":{"positions":{"Notification":{"properties":{"Reason":"text"},"edges":{}}},
          "collections":{"Notifications":{"target":"Notification","listenable":true,"identity":"Id","delivery":"polled","pollEverySeconds":60}},
          "writableRoots":{}}}}
    },"credentials":{},"plugins":{}}"#;

    const SETTINGS: &str = "import { gh as gh_module } from adapters\ngh = connect gh_module\nfunction triage(n: <gh-[:Notification]->>) {\n  return n.Reason\n}\n\n# Mentions and assignments.\nlisten to gh { events: [\"mention\", \"assign\"] } fire triage\n";

    #[test]
    fn a_settings_listen_and_its_parameter_are_rewritten_and_a_second_pass_changes_nothing() {
        let catalog = CatalogSnapshot::load(GH).unwrap();
        let upgraded = upgrade_source(SETTINGS, &catalog, false, "0.12.13");
        assert!(upgraded.remaining.is_empty(), "{:?}", upgraded.remaining);
        let traversal = "listen to gh-[n:Notifications WHERE n.Reason IN [\"mention\", \"assign\"]]-> fire triage";
        assert_eq!(
            upgraded.source,
            SETTINGS.replace("<gh-[:Notification]->>", "<gh-[:Notifications]->>").replace("listen to gh { events: [\"mention\", \"assign\"] } fire triage", traversal)
        );
        assert_eq!(upgrade_source(&upgraded.source, &catalog, false, "0.12.13").source, upgraded.source);
    }

    /// A file pinned to this release that still holds a settings listen
    /// (written by hand, or pinned by an edit): its refusal is an error, and
    /// the error's rewrite is applied as it is from an older pin.
    #[test]
    fn a_settings_listen_under_this_releases_pin_is_rewritten() {
        let catalog = CatalogSnapshot::load(GH).unwrap();
        let held = check_text(SETTINGS, &catalog, Some(LANGUAGE_VERSION));
        assert!(held.iter().any(|d| d.code == "MOV_LISTEN_SETTINGS_RETIRED" && d.is_error()), "{held:?}");
        let upgraded = upgrade_source(SETTINGS, &catalog, false, LANGUAGE_VERSION);
        assert!(upgraded.remaining.is_empty(), "{:?}", upgraded.remaining);
        assert!(upgraded.source.contains("listen to gh-[n:Notifications WHERE n.Reason IN [\"mention\", \"assign\"]]-> fire triage\n"), "{}", upgraded.source);
    }

    #[test]
    fn two_settings_listens_firing_one_function_settle_and_its_parameter_is_edited_once() {
        let catalog = CatalogSnapshot::load(GH).unwrap();
        let source = format!("{SETTINGS}listen to gh {{ events: [\"review_requested\"] }} fire triage\n");
        let upgraded = upgrade_source(&source, &catalog, false, "0.12.13");
        assert!(upgraded.settled);
        assert!(upgraded.remaining.is_empty(), "{:?}", upgraded.remaining);
        assert_eq!(upgraded.source.matches("<gh-[:Notifications]->>").count(), 1, "{}", upgraded.source);
        assert!(upgraded.source.contains("listen to gh-[n:Notifications WHERE n.Reason IN [\"mention\", \"assign\"]]-> fire triage\n"), "{}", upgraded.source);
        assert!(upgraded.source.contains("listen to gh-[n:Notifications WHERE n.Reason IN [\"review_requested\"]]-> fire triage\n"), "{}", upgraded.source);
        assert_eq!(upgrade_source(&upgraded.source, &catalog, false, "0.12.13").source, upgraded.source);
    }

    #[test]
    fn a_settings_rewrite_that_changes_meaning_holds_the_pin_until_all() {
        let catalog = CatalogSnapshot::load(GH).unwrap();
        let source = SETTINGS.replace("] }", "], suppress_self: true }");
        let held = upgrade_source(&source, &catalog, false, "0.12.13");
        assert_eq!(held.source, source);
        assert_eq!(held.remaining.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_LISTEN_SETTINGS_RETIRED"]);
        let all = upgrade_source(&source, &catalog, true, "0.12.13");
        assert!(all.remaining.is_empty(), "{:?}", all.remaining);
        assert!(all.source.contains("listen to gh-[n:Notifications WHERE n.Reason IN [\"mention\", \"assign\"]]-> fire triage\n"), "{}", all.source);
        // A key the module does not map has no rewrite at all: listed, holding the pin.
        let unmapped = upgrade_source(&SETTINGS.replace("] }", "], participating: true }"), &catalog, true, "0.12.13");
        assert_eq!(unmapped.remaining.len(), 1, "{:?}", unmapped.remaining);
        assert!(unmapped.remaining[0].fix.is_none());
    }

    #[test]
    fn an_upgrade_note_with_a_rewrite_stands_and_one_without_is_only_listed() {
        let at = movement_parser::ast::Loc { line: 1, col: 1 };
        let span = movement_parser::ast::Span { start: at, end: at };
        let note = Diagnostic { severity: Some(Severity::Warning), upgrade: Some(true), ..Diagnostic::error("MOV_X", "x", span) };
        assert!(!stands(&note) && is_note(&note));
        let fixable = Diagnostic { fix: Some(serde_json::json!({ "edits": [] })), ..note.clone() };
        assert!(stands(&fixable) && !is_note(&fixable));
        assert!(stands(&Diagnostic::error("MOV_X", "x", span)));
    }

    #[test]
    fn a_diff_marks_the_changed_line_with_context() {
        let diff = unified_diff("a\nb\nc\n", "a\nB\nc\n", "x.mvt");
        assert_eq!(diff, "--- a/x.mvt\n+++ b/x.mvt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    }

    #[test]
    fn edits_apply_by_utf16_columns_back_to_front() {
        let fix = |l, c0, c1, t: &str| Fix { edits: vec![Edit { start: (l, c0), end: (l, c1), text: t.into() }], safe: true, key: Value::Null };
        // "é😀" is 3 UTF-16 units; the edit after it starts at column 4.
        assert_eq!(apply("é😀xy\nz", &[fix(1, 4, 5, "X"), fix(2, 1, 1, ">")]), "é😀Xy\n>z");
    }

    const STORE: &str = r#"{"adapters":{
      "store":{"canFire":false,"constructionArgs":[],"schemas":{"":{"positions":{
        "Table":{"properties":{"Name":"text"},"edges":{"History":{"target":"Change"}}},
        "Change":{"properties":{"Id":"text","Kind":"text"},"edges":{}}},
        "collections":{"Tables":{"target":"Table"}},"writableRoots":{}}}}
    },"credentials":{},"plugins":{}}"#;

    const LAZY: &str = "import { store } from adapters\ns = connect store\n\nfunction kept() {\n  return lazy s-[t:Tables]->\n}\n\nfunction lz() {\n  tables = lazy s-[t:Tables]->\n  labelled = lazy s-[t:Tables]-> node { label: t.Name }\n  past = tables-[c:History WHERE c.Id == \"A\"]-> {\n    return c.Kind\n  }\n  return { n: count(tables), names: tables.Name, labels: labelled.label, past: past, kept: kept().Name }\n}\n";

    const CLOSURES: &str = "import { store } from adapters\ns = connect store\n\nfunction kept() {\n  return s-[t:Tables]->\n}\n\nfunction lz() {\n  tables = () => s-[t:Tables]->\n  labelled = () => {\n    return s-[t:Tables]-> {\n      return node { label: t.Name }\n    }\n  }\n  past = tables()-[c:History WHERE c.Id == \"A\"]-> {\n    return c.Kind\n  }\n  return { n: count(tables()), names: tables().Name, labels: labelled().label, past: past, kept: kept().Name }\n}\n";

    #[test]
    fn lazy_is_rewritten_to_closures_that_check_clean_and_the_pin_moves() {
        let catalog = CatalogSnapshot::load(STORE).unwrap();
        let held = check_text(LAZY, &catalog, Some("0.13.0"));
        assert_eq!(held.iter().filter(|d| d.code == "MOV_LAZY_RETIRED" && d.is_error()).count(), 3, "{held:?}");
        let upgraded = kept_only_if_no_worse(LAZY, upgrade_source(LAZY, &catalog, false, "0.13.0"), &catalog, "0.13.0");
        assert!(upgraded.withheld.is_empty() && upgraded.remaining.is_empty(), "{:?} {:?}", upgraded.withheld, upgraded.remaining);
        assert_eq!(upgraded.source, CLOSURES);
        assert!(check_text(&upgraded.source, &catalog, Some(LANGUAGE_VERSION)).iter().all(|d| !d.is_error()));
        assert!(matches!(pin_step("engine: 0.13.0\n", upgraded.remaining.len()).unwrap(), PinStep::Set(_) | PinStep::Current));
        assert_eq!(upgrade_source(&upgraded.source, &catalog, false, "0.13.0").source, upgraded.source);
    }

    #[test]
    fn a_lazy_node_entry_holds_the_pin_until_all_drops_lazy() {
        let catalog = CatalogSnapshot::load(STORE).unwrap();
        let source = "import { store } from adapters\ns = connect store\n\nfunction lz() {\n  g = node { tabs: lazy s-[t:Tables]-> }\n  return count(g-[:tabs]->)\n}\n";
        let held = upgrade_source(source, &catalog, false, "0.13.0");
        assert_eq!(held.source, source);
        assert_eq!(held.remaining.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_LAZY_RETIRED"]);
        let all = kept_only_if_no_worse(source, upgrade_source(source, &catalog, true, "0.13.0"), &catalog, "0.13.0");
        assert!(all.remaining.is_empty() && all.withheld.is_empty(), "{:?}", all.remaining);
        assert_eq!(all.source, source.replace("lazy ", ""));
    }

    #[test]
    fn a_lazy_binding_passed_to_a_function_is_left_for_the_author() {
        let catalog = CatalogSnapshot::load(STORE).unwrap();
        let source = "import { store } from adapters\ns = connect store\n\nfunction named(t: <s-[:Tables]->>) {\n  return t.Name\n}\n\nfunction lz() {\n  tables = lazy s-[t:Tables]->\n  return named(tables)\n}\n";
        let upgraded = upgrade_source(source, &catalog, true, "0.13.0");
        assert_eq!(upgraded.source, source);
        assert_eq!(upgraded.remaining.len(), 1, "{:?}", upgraded.remaining);
        assert!(upgraded.remaining[0].fix.is_none());
    }

    /// A rewrite that leaves an error its text did not have is not kept:
    /// the text stands as it was, with its own diagnostics.
    #[test]
    fn a_rewrite_that_leaves_a_new_error_is_not_kept() {
        let catalog = CatalogSnapshot::load(STORE).unwrap();
        let source = "import { store } from adapters\ns = connect store\n\nfunction lz() {\n  return count(s-[:Tables]->)\n}\n";
        let worse = source.replace("count(s-[:Tables]->)", "count(nowhere)");
        let attempted = Upgraded::of(worse.clone(), check_text(&worse, &catalog, Some("0.13.0")), true);
        let kept = kept_only_if_no_worse(source, attempted, &catalog, "0.13.0");
        assert_eq!(kept.source, source);
        assert_eq!(kept.withheld.iter().map(|d| d.code.as_str()).collect::<Vec<_>>(), ["MOV_NAME_UNRESOLVED"]);
        assert!(kept.remaining.is_empty(), "{:?}", kept.remaining);
    }
}

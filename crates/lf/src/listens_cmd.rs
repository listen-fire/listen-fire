//! `listen-fire listens`: one line per listen on a traversal, saying what it
//! is watched by and where it stands; `listen-fire listens resume
//! <file>:<movement>`: let a paused listen fire again.

use std::io::Write;

use movement_checker::families::filter_split::spell;
use movement_checker::families::names::spell_name;
use movement_parser::listen_plan::{HopJudged, ListenPlan};

use crate::json::Js;
use crate::resolve::{ListenState, counted, position_of};
use crate::routing::Listen;
use crate::runs::{FileSet, Session};

/// The command, its arguments after `listens`.
pub fn command(session: &Session, rest: &[String], out: &mut impl Write) -> Result<i32, String> {
    let set = session.file_set();
    match rest.first().map(String::as_str) {
        None => {
            let now = crate::limiter::now_ms();
            for listen in set.listens.iter().filter(|l| l.plan.is_some()) {
                let state = session.store.listen_state(&listen.pipeline()).map_err(|e| e.to_string())?;
                let cadence = if crate::resolve::resolved_at_open_only(session, &set, listen) { Cadence::AtOpenOnly } else { Cadence::Kept };
                writeln!(out, "{}", line(&set, listen, state.as_ref(), cadence, now)).map_err(|e| e.to_string())?;
            }
            Ok(0)
        }
        Some("resume") => {
            let Some(named) = rest.get(1) else {
                eprintln!("listen-fire listens resume needs a listen: <file>:<movement>");
                return Ok(2);
            };
            let named_by = |l: &&Listen| l.plan.is_some() && format!("{}:{}", l.file, l.movement_name) == *named;
            let listens: Vec<&Listen> = set.listens.iter().filter(named_by).collect();
            if listens.is_empty() {
                eprintln!("listen-fire: no listen on a traversal fires {named}: `listen-fire listens` names each as <file>:<movement>");
                return Ok(2);
            }
            for listen in listens {
                let pipeline = listen.pipeline();
                let state = session.store.listen_state(&pipeline).map_err(|e| e.to_string())?;
                match state {
                    Some(state) if state.paused.is_some() => {
                        session.store.set_listen_paused(&pipeline, None).map_err(|e| e.to_string())?;
                        writeln!(out, "{named}: resumed; it fires again").map_err(|e| e.to_string())?;
                    }
                    _ => writeln!(out, "{named}: not paused").map_err(|e| e.to_string())?,
                }
            }
            Ok(0)
        }
        Some(other) => {
            eprintln!("listen-fire listens: no subcommand \"{other}\" (listens, or listens resume <file>:<movement>)");
            Ok(2)
        }
    }
}

/// When a listen's heads are listed again.
#[derive(Clone, Copy, PartialEq)]
enum Cadence {
    /// On a clock, or as its parents report changes (crate::resolve).
    Kept,
    /// Only as listen-fire opens (crate::resolve::at_open_only).
    AtOpenOnly,
}

/// `{file}:{movement}{ as "alias"} — {path} — {judged per hop} — {watching}
/// — {standing}{; loops}`.
fn line(set: &FileSet, listen: &Listen, state: Option<&ListenState>, cadence: Cadence, now_ms: i64) -> String {
    let Some(plan) = &listen.plan else { return String::new() };
    let alias = plan.alias.as_ref().map(|a| format!(" as \"{a}\"")).unwrap_or_default();
    let path = path_of(plan);
    let judged: Vec<&str> = plan
        .hops
        .iter()
        .map(|hop| match hop.judged {
            HopJudged::Arrival => "arrival",
            HopJudged::Resolved => "resolved",
            HopJudged::None => "unfiltered",
        })
        .collect();
    let resolved = state.map(|state| &state.resolution);
    let watching = match (crate::edge_polls::resolves(listen), resolved.and_then(|r| r.resolved_at.as_deref())) {
        (false, _) => format!("watching all of {}", plan.connection),
        (true, None) => format!("watching {}, never resolved", counted(resolved.map_or(0, |r| r.heads.len()), &position_of(listen))),
        (true, Some(at)) => {
            let heads = counted(resolved.map_or(0, |r| r.heads.len()), &position_of(listen));
            match cadence {
                Cadence::Kept => format!("watching {heads}, resolved {}", ago(at, now_ms)),
                Cadence::AtOpenOnly => format!("watching {heads}, resolved at open only ({})", ago(at, now_ms)),
            }
        }
    };
    let standing: Vec<String> = state.into_iter().flat_map(|s| [s.resolution.failure.clone(), s.paused.as_ref().map(|p| format!("paused: {p}"))]).flatten().collect();
    let standing = if standing.is_empty() { "ok".to_string() } else { standing.join("; ") };
    let unprotected = match attributable(set, listen) {
        true => String::new(),
        false => format!("; can't be protected from loops: its arrivals name no record they are about, and no write to {} makes what they land on", listen.adapter),
    };
    let resent = match reads_back(set, &listen.adapter) {
        Some(true) | None => String::new(),
        Some(false) => format!("; a write to {} that changes nothing is still sent (it lists no readRecord), so a two-way sync's echo runs again", listen.adapter),
    };
    format!("{}:{}{alias} — {path} — {} — {watching} — {standing}{unprotected}{resent}", listen.file, listen.movement_name, judged.join(", "))
}

/// The listen's traversal as its plan holds it, each hop's WHERE whole
/// (`f-[b:Boards WHERE b.Name == "Ops"]->-[n:Notes]->`).
fn path_of(plan: &ListenPlan) -> String {
    let hops = plan.hops.iter().map(|hop| {
        let alias = hop.alias.as_deref();
        let filter = hop.filter().map(|filter| format!(" WHERE {}", spell(&filter, alias))).unwrap_or_default();
        format!("-[{}:{}{filter}]->", alias.map(spell_name).unwrap_or_default(), spell_name(&hop.edge))
    });
    format!("{}{}", spell_name(&plan.connection), hops.collect::<String>())
}

/// Whether the loop breaker can match the listen's arrivals to the writes
/// that caused them (crate::loop_breaker): its edge declares `attributes`
/// (each names the record it is about), or what it lands on is a record a
/// write to its module makes.
fn attributable(set: &FileSet, listen: &Listen) -> bool {
    let Some(last) = listen.plan.as_ref().and_then(|plan| plan.hops.last()) else { return false };
    if crate::edge_polls::hop_schema(set, listen, last).is_some_and(|edge| Js::is_true(edge.get("attributes"))) {
        return true;
    }
    let schemas = set.catalog.get("adapters").and_then(|a| a.get(&listen.adapter)).and_then(|a| a.get("schemas"));
    let Some(Js::Obj(schemas)) = schemas else { return false };
    let written = |schema: &Js| ["writableRoots", "createShapes"].iter().any(|key| schema.get(key).and_then(|types| types.get(&last.to)).is_some());
    schemas.values().any(written)
}

/// Whether the module reads a record back (`readRecord`), so the engine
/// sends no write that would change nothing; None for one listen-fire
/// builds in (cron, manual), which nothing writes to.
fn reads_back(set: &FileSet, adapter: &str) -> Option<bool> {
    let running = set.running.iter().find(|r| !r.is_plugin() && r.external.manifest.name == adapter)?;
    Some(running.methods.iter().any(|m| m == "readRecord"))
}

/// How long ago `at` was, as a person reads it.
fn ago(at: &str, now_ms: i64) -> String {
    let Some(then) = crate::units::ms_of(at) else { return format!("at {at}") };
    let seconds = (now_ms - then).max(0) / 1000;
    match seconds {
        s if s < 60 => format!("{s}s ago"),
        s if s < 3_600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3_600),
        s => format!("{}d ago", s / 86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_time_is_said_as_how_long_ago_it_was() {
        let now = crate::units::ms_of("2026-10-31T10:00:00.000Z").unwrap();
        assert_eq!(ago("2026-10-31T09:59:30.000Z", now), "30s ago");
        assert_eq!(ago("2026-10-31T09:55:00.000Z", now), "5m ago");
        assert_eq!(ago("2026-10-31T07:00:00.000Z", now), "3h ago");
        assert_eq!(ago("2026-10-29T10:00:00.000Z", now), "2d ago");
        assert_eq!(ago("soon", now), "at soon");
    }

    /// The path is said from the plan, each hop's WHERE whole again (the
    /// part its module takes, then the part checked).
    #[test]
    fn a_listens_path_is_said_from_its_plan() {
        let compare = |field: &str, value: &str| format!(r#"{{"type":"compare","op":"eq","left":{{"type":"property","propertyTypeId":"{field}","fieldOnly":true}},"right":{{"type":"static","value":"{value}"}}}}"#);
        let plan = format!(
            r#"{{"movement":"a","connection":"f","adapter":"feed","hops":[{{"edge":"Boards","from":"","to":"Board","alias":"b","taken":{},"checked":{},"judged":"resolved"}},{{"edge":"Open Notes","from":"Board","to":"Note","judged":"arrival"}}]}}"#,
            compare("Name", "Ops"),
            compare("Kind", "team")
        );
        let plan: ListenPlan = serde_json::from_str(&plan).unwrap();
        assert_eq!(path_of(&plan), r#"f-[b:Boards WHERE b.Name == "Ops" AND b.Kind == "team"]->-[:`Open Notes`]->"#);
    }
}

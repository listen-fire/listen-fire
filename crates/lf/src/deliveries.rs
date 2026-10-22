//! `lf deliveries`: the receipts the doors keep. Listing and showing read the
//! store; a replay writes a new receipt of the same events, queued as fresh
//! work for the drain to route against the project as it is now. No session
//! or external is started: the store is all it touches.

use std::io::Write;

use crate::backend::RunHostStore;
use crate::doors::fire_event_work;
use crate::json::Js;
use crate::lfjson;
use crate::store::{DeliveryQuery, DeliveryRow, DeliverySource, NewDelivery, NewWork, iso};

const LISTED: i64 = 50;
const USAGE: &str = "usage: lf deliveries [--subscription <id>] [--since <ISO instant | <n>h | <n>d>] [--json]\n       lf deliveries show <id>\n       lf deliveries replay <id>";

pub struct Request<'a> {
    pub rest: &'a [String],
    pub subscription: Option<&'a str>,
    pub since: Option<&'a str>,
    pub json: bool,
}

pub fn command(store: &dyn RunHostStore, request: &Request<'_>, out: &mut impl Write) -> Result<i32, String> {
    let io = |e: std::io::Error| e.to_string();
    match request.rest.first().map(String::as_str) {
        None => {
            let since = request.since.map(since_of).transpose()?;
            let query = DeliveryQuery { subscription_id: request.subscription, since: since.as_deref(), limit: LISTED };
            let rows = store.deliveries(&query).map_err(|e| e.to_string())?;
            if request.json {
                return lfjson::emit(out, &lfjson::deliveries_list_doc(&rows), 0);
            }
            for row in &rows {
                writeln!(out, "{}", line_of(row)).map_err(io)?;
            }
            Ok(0)
        }
        Some("show") => {
            let Some(id) = request.rest.get(1) else { return needs_an_id("show") };
            let row = kept(store, id)?;
            let doc = lfjson::delivery_show_doc(&row);
            if request.json {
                return lfjson::emit(out, &doc, 0);
            }
            writeln!(out, "{}", serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?).map_err(io)?;
            Ok(0)
        }
        Some("replay") => {
            let Some(id) = request.rest.get(1) else { return needs_an_id("replay") };
            let (new_id, queued) = replay(store, &kept(store, id)?)?;
            if request.json {
                return lfjson::emit(out, &lfjson::delivery_replay_doc(&new_id, id, queued), 0);
            }
            writeln!(out, "delivery {new_id} replays {id}: {queued} event(s) queued; lf serve or lf drain runs them").map_err(io)?;
            Ok(0)
        }
        Some(other) => {
            eprintln!("unknown deliveries command \"{other}\"\n{USAGE}");
            Ok(2)
        }
    }
}

fn needs_an_id(command: &str) -> Result<i32, String> {
    eprintln!("lf deliveries {command} needs a delivery id");
    Ok(2)
}

fn kept(store: &dyn RunHostStore, id: &str) -> Result<DeliveryRow, String> {
    store.delivery(id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no delivery {id}"))
}

fn line_of(row: &DeliveryRow) -> String {
    let inline = if row.inline { " inline" } else { "" };
    let replay = row.replay_of.as_deref().map(|of| format!(" replay of {of}")).unwrap_or_default();
    format!(
        "{} {} {} {}{inline}{replay} {} event(s) {} run(s)",
        row.id,
        row.received_at,
        row.subscription_id,
        row.source.wire(),
        row.event_count,
        row.runs.len()
    )
}

/// The delivery's events, kept anew under a delivery of their own and queued
/// for the drain. Returns the new delivery's id and how many events it holds.
fn replay(store: &dyn RunHostStore, original: &DeliveryRow) -> Result<(String, usize), String> {
    let events = original.events.clone().unwrap_or_default();
    let new_id = uuid::Uuid::new_v4().to_string();
    let work: Vec<NewWork> = events
        .iter()
        .map(|kept| match (kept.get("external").and_then(Js::as_str), kept.get("event")) {
            (Some(external), Some(event)) => Ok(fire_event_work(external, event.clone(), &new_id)),
            _ => Err(format!("delivery {} holds an event without an external or an event; it cannot be replayed", original.id)),
        })
        .collect::<Result<_, _>>()?;
    let replayed = NewDelivery {
        id: new_id.clone(),
        external_id: None,
        received_at: iso(0),
        source: DeliverySource::Cli,
        inline: false,
        replay_of: Some(original.id.clone()),
        events,
    };
    if !store.keep_delivery(&original.subscription_id, None, &replayed, &work).map_err(|e| e.to_string())? {
        return Err(format!("delivery {new_id} was not kept: the store took it for a duplicate"));
    }
    crate::wake::queued_rows(&work);
    Ok((new_id, work.len()))
}

/// `--since`: an ISO instant, or `<n>h` / `<n>d` before now, as the store's
/// instants are written (they compare as text).
fn since_of(text: &str) -> Result<String, String> {
    let unit_ms = |digits: &str, unit: i64| digits.parse::<i64>().ok().filter(|n| *n >= 0).and_then(|n| n.checked_mul(unit));
    let ago = match text.split_at_checked(text.len().saturating_sub(1)) {
        Some((digits, "h")) => unit_ms(digits, 3_600_000),
        Some((digits, "d")) => unit_ms(digits, 86_400_000),
        _ => None,
    };
    if let Some(ms) = ago {
        return Ok(iso(-ms));
    }
    crate::units::ms_of(text).map(crate::units::iso_of).ok_or_else(|| format!("--since {text}: an ISO instant, or a number of hours or days before now (e.g. 6h, 2d)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn since_reads_an_instant_or_an_age() {
        assert_eq!(since_of("2026-10-20T00:00:00Z"), Ok("2026-10-20T00:00:00.000Z".to_string()));
        assert!(since_of("6h").unwrap() < iso(0));
        assert!(since_of("2d").unwrap() < since_of("6h").unwrap());
        for bad in ["", "h", "-2d", "soon", "2w"] {
            assert!(since_of(bad).unwrap_err().contains("--since"), "{bad}");
        }
    }
}

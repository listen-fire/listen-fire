//! `listen-fire deliveries`: the receipts the doors keep. Listing and showing
//! read the store; no session or external is started. A kept delivery is put
//! through a listen again by `listen-fire listens replay` (crate::listen_replay).

use std::io::Write;

use crate::backend::RunHostStore;
use crate::lfjson;
use crate::store::{DeliveryQuery, DeliveryRow, iso};

const LISTED: i64 = 50;
const USAGE: &str = "usage: listen-fire deliveries [--subscription <id>] [--since <ISO instant | <n>h | <n>d>] [--json]\n       listen-fire deliveries show <id> [--request]";

pub struct Request<'a> {
    pub rest: &'a [String],
    pub subscription: Option<&'a str>,
    pub since: Option<&'a str>,
    pub json: bool,
    /// `show --request`: print the request the delivery was received as,
    /// which is sensitive and never printed otherwise.
    pub with_request: bool,
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
            let doc = lfjson::delivery_show_doc(&row, request.with_request);
            if request.json {
                return lfjson::emit(out, &doc, 0);
            }
            writeln!(out, "{}", serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?).map_err(io)?;
            Ok(0)
        }
        // Retired in 0.13: a delivery brings arrivals, and an arrival is put
        // through again by the listen that holds its receipt.
        Some("replay") => {
            eprintln!("listen-fire deliveries replay is retired: put a kept delivery through a listen again with `listen-fire listens replay <file>:<movement> --delivery <id>`");
            Ok(2)
        }
        Some(other) => {
            eprintln!("unknown deliveries command \"{other}\"\n{USAGE}");
            Ok(2)
        }
    }
}

fn needs_an_id(command: &str) -> Result<i32, String> {
    eprintln!("listen-fire deliveries {command} needs a delivery id");
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

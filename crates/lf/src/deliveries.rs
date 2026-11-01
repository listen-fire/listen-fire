//! `listen-fire deliveries`: the receipts the doors keep. Listing and showing read the
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
const USAGE: &str = "usage: listen-fire deliveries [--subscription <id>] [--since <ISO instant | <n>h | <n>d>] [--json]\n       listen-fire deliveries show <id> [--request]\n       listen-fire deliveries replay <id>";

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
        Some("replay") => {
            let Some(id) = request.rest.get(1) else { return needs_an_id("replay") };
            let (new_id, queued) = replay(store, &kept(store, id)?)?;
            if request.json {
                return lfjson::emit(out, &lfjson::delivery_replay_doc(&new_id, id, queued), 0);
            }
            writeln!(out, "delivery {new_id} replays {id}: {queued} event(s) queued; listen-fire serve or listen-fire drain runs them").map_err(io)?;
            Ok(0)
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

/// The delivery's events, kept anew under a delivery of their own and queued
/// for the drain. Returns the new delivery's id and how many events it holds.
fn replay(store: &dyn RunHostStore, original: &DeliveryRow) -> Result<(String, usize), String> {
    let events = original.events.clone().unwrap_or_default();
    // A delivery of arrivals queues nothing here: a listen's receipt is the
    // record that it ran an arrival, so it is replayed through that listen.
    if events.is_empty() {
        return Err(arrivals_replayed_by_a_listen(&original.id));
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    // The original's arrivals were logged when it was kept: the replay's runs
    // read their triggers' waits from now on.
    let mark = store.arrival_mark().map_err(|e| e.to_string())?;
    let work: Vec<NewWork> = events
        .iter()
        .map(|kept| match (kept.get("external").and_then(Js::as_str), kept.get("event")) {
            (Some(external), Some(event)) => {
                Ok(fire_event_work(external, event.clone(), crate::runs::Delivered { arrival_mark: Some(mark), ..crate::runs::Delivered::of_row(kept, Some(&new_id)) }))
            }
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
        request: None,
    };
    if store.keep_delivery(&original.subscription_id, None, &replayed, &work, None, &[], &[]).map_err(|e| e.to_string())?.is_none() {
        return Err(format!("delivery {new_id} was not kept: the store took it for a duplicate"));
    }
    crate::wake::queued_rows(&work);
    Ok((new_id, work.len()))
}

/// Why `deliveries replay` refuses a delivery with no events to queue.
fn arrivals_replayed_by_a_listen(id: &str) -> String {
    format!("delivery {id} kept no events to queue: what it brought is replayed through a listen, `listen-fire listens replay <file>:<movement> --delivery {id}` (--force to run an arrival the listen ran before)")
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

    /// A replay's runs read their triggers' waits from the replay: its fire
    /// rows carry the mark taken then, after everything logged before it
    /// (the original's own arrivals among them).
    #[test]
    fn a_replay_marks_its_fire_rows_with_the_mark_at_the_replay() {
        use crate::backend::RunHostStore;
        use crate::store::{ClaimDue, Store};
        let dir = std::env::temp_dir().join(format!("lf-replay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("state.db")).unwrap();
        let event = Js::Obj(crate::obj! { "external" => Js::str("inbox"), "event" => Js::Obj(crate::obj! { "type" => Js::str("note.created") }) });
        let original = NewDelivery { id: "d-1".into(), external_id: None, received_at: iso(0), source: DeliverySource::Webhook, inline: true, replay_of: None, events: vec![event], request: None };
        assert!(store.keep_delivery("inbox", None, &original, &[], None, &[], &[]).unwrap().is_some());
        let arrival = crate::waits::NewArrival { edge: "Comments".into(), key: "thread:n-1".into(), identity: Some("k1".into()), version: None, landing: None, gone: false };
        store.log_now(crate::check::LOCAL_TENANT, "inbox", &[arrival]).unwrap();
        let mark = store.arrival_mark().unwrap();
        assert_eq!(mark, 1);
        let kept = RunHostStore::delivery(&store, "d-1").unwrap().unwrap();
        replay(&store, &kept).unwrap();
        let rows = store.claim_due(&ClaimDue { limit: 10, lease_ms: 60_000, due_by: None, kinds: None }).unwrap();
        let marks: Vec<Option<&Js>> = rows.iter().filter(|r| r.kind == "fire_event").map(|r| r.payload.get("arrivalMark")).collect();
        assert_eq!(marks, [Some(&Js::Num(mark.into()))]);
    }

    /// A delivery of arrivals is replayed through a listen, which holds the
    /// receipt of each it ran: `deliveries replay` keeps nothing for it and
    /// says which command does.
    #[test]
    fn a_delivery_of_arrivals_is_refused_naming_listens_replay() {
        use crate::backend::RunHostStore;
        use crate::store::Store;
        let dir = std::env::temp_dir().join(format!("lf-replay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::open(&dir.join("state.db")).unwrap();
        let original = NewDelivery { id: "d-2".into(), external_id: None, received_at: iso(0), source: DeliverySource::Webhook, inline: true, replay_of: None, events: vec![], request: None };
        assert!(store.keep_delivery("inbox", None, &original, &[], None, &[], &[]).unwrap().is_some());
        let kept = RunHostStore::delivery(&store, "d-2").unwrap().unwrap();
        assert_eq!(
            replay(&store, &kept).unwrap_err(),
            "delivery d-2 kept no events to queue: what it brought is replayed through a listen, `listen-fire listens replay <file>:<movement> --delivery d-2` (--force to run an arrival the listen ran before)"
        );
        assert_eq!(store.deliveries(&DeliveryQuery { subscription_id: None, since: None, limit: 10 }).unwrap().len(), 1, "no replay kept");
    }

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

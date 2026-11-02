//! `listen-fire runs show <run-id>` as text: what an agent reads to fix a run,
//! each fact once. Its status and error; the event, as the records that
//! arrived (the landing and each carried parent), each with its record type's
//! first sentence (what its values are, as the catalog says it: Stripe's
//! amounts in major units) and the fields its record type declares; one line
//! per write and per trace entry; what it is parked on; its earlier attempts.
//! `--json` is the whole document (crate::lfjson).
//!
//! A module puts its raw fields on an arrival beside the typed ones
//! (adapter protocol, Reporting arrivals), and only its schema tells them
//! apart. So the event's own module, and no other, is started and described;
//! when it cannot be, the text says why and shows every field.

use std::collections::BTreeMap;
use std::io::Write;

use crate::catalog::{connections_of, unit_schema};
use crate::check::{LOCAL_TENANT, describe_as};
use crate::externals::{scan_externals, start_externals};
use crate::json::{Js, Obj};
use crate::project::Project;
use crate::secrets::Secrets;

/// A value longer than this, as JSON, is cut in the text.
const VALUE_CHARS: usize = 300;

/// A record type as its module declares it.
#[derive(Default)]
struct Declared {
    /// Its description's first sentence, as the catalog text shows it.
    about: Option<String>,
    /// Each field, with the key its module puts it under on an arrival (its
    /// field id, where that is not its name).
    fields: Vec<(String, String)>,
}

/// The record types the event's records are, by name; or why they could not be read.
type Typing = Result<BTreeMap<String, Declared>, String>;

pub async fn command(project: &Project, doc: &Js, out: &mut impl Write) -> Result<i32, String> {
    let run = doc.get("run").cloned().unwrap_or(Js::Null);
    let typing = match run.get("event").and_then(|e| e.get("arrival")) {
        Some(arrival) => declared_fields(project, arrival).await,
        None => Ok(BTreeMap::new()),
    };
    writeln!(out, "{}", text(&run, &typing)).map_err(|e| e.to_string())?;
    Ok(0)
}

/// The fields each record type on the arrival declares, read from its module.
async fn declared_fields(project: &Project, arrival: &Js) -> Typing {
    let adapter = arrival.get("adapterType").and_then(Js::as_str).ok_or("the arrival names no module")?;
    let records = records_of(arrival);
    let wanted: Vec<&str> = records.iter().filter_map(|(record, _)| record.get("recordType").and_then(Js::as_str)).collect();
    let externals = scan_externals(project)?;
    if let Some(unit) = crate::units::unit_named(adapter, externals.iter().map(|e| e.manifest.name.as_str())) {
        return Ok(declared_in(&unit_schema(unit), &wanted));
    }
    let external = externals.into_iter().find(|e| e.manifest.name == adapter).ok_or_else(|| format!("no module \"{adapter}\" is installed here"))?;
    let secrets = Secrets::open(project, &crate::connect::process_env())?;
    let credentials = secrets.credentials();
    let running = start_externals(project, std::slice::from_ref(&external), credentials, LOCAL_TENANT).await?;
    let running = running.first().ok_or_else(|| format!("module \"{adapter}\" did not answer its manifest"))?;
    let connections = connections_of(running, credentials);
    // Every connection the module can make, credential-free first: one
    // connection's types may not be another's (two workspaces).
    let tries = (!connections.credential_required).then_some(None).into_iter().chain(connections.credentials.iter().map(|c| Some(*c)));
    let mut found = BTreeMap::new();
    let mut refused = None;
    for credential in tries {
        match describe_as(running, credentials, credential, None).await {
            Ok((_, schema)) => {
                for (name, declared) in declared_in(&schema, &wanted) {
                    found.entry(name).or_insert(declared);
                }
            }
            Err(why) => refused = Some(why),
        }
        if wanted.iter().all(|w| found.contains_key(*w)) {
            break;
        }
    }
    match refused {
        Some(why) if found.is_empty() => Err(why.lines().next().unwrap_or_default().to_string()),
        _ => Ok(found),
    }
}

/// What the schema's positions named `wanted` declare.
fn declared_in(schema: &Js, wanted: &[&str]) -> BTreeMap<String, Declared> {
    let mut declared = BTreeMap::new();
    for name in wanted {
        let Some(position) = schema.get("positions").and_then(|p| p.get(name)) else { continue };
        let ids = position.get("fieldIds");
        let fields = match position.get("properties") {
            Some(Js::Obj(properties)) => properties.keys().map(|field| (field.clone(), ids.and_then(|i| i.get(field)).and_then(Js::as_str).unwrap_or(field).to_string())).collect(),
            _ => Vec::new(),
        };
        let about = position.get("description").and_then(Js::as_str).map(crate::modules::first_sentence);
        declared.insert(name.to_string(), Declared { about, fields });
    }
    declared
}

/// The landing and each parent it carries, with how the text introduces each.
fn records_of(arrival: &Js) -> Vec<(Js, &'static str)> {
    let landing = arrival.get("landing").cloned().into_iter().map(|l| (l, "landed"));
    let parents = arrival.get("parents").and_then(Js::as_array).unwrap_or_default().iter().filter(|p| !matches!(p, Js::Null)).cloned().map(|p| (p, "carried"));
    landing.chain(parents).collect()
}

// ── The text ────────────────────────────────────────────────────────────────

fn text(run: &Js, typing: &Typing) -> String {
    let field = |key: &str| run.get(key).filter(|v| !matches!(v, Js::Null));
    let word = |key: &str| field(key).map(plain).unwrap_or_default();
    let mut out = Vec::new();
    let mut cut = false;

    let attempt = match field("attempt").and_then(|a| match a {
        Js::Num(n) => n.as_u64(),
        _ => None,
    }) {
        Some(n) if n > 1 => format!(" (attempt {n})"),
        _ => String::new(),
    };
    out.push(format!("run {}: {}:{} {}{attempt}", word("runId"), word("file"), word("movement"), word("status")));
    let mut when = vec![format!("started {}", word("startedAt"))];
    if let Some(finished) = field("finishedAt") {
        when.push(format!("finished {}", plain(finished)));
    }
    if let Some(delivery) = field("deliveryId") {
        when.push(format!("delivery {}", plain(delivery)));
    }
    if let Some(version) = field("languageVersion") {
        when.push(format!("language {}", plain(version)));
    }
    out.push(when.join(", "));
    if let Some(error) = field("error") {
        out.push(format!("error: {}", plain(error)));
    }
    if let Some(returned) = field("returned") {
        out.push(format!("returned: {}", value(returned.get("value").unwrap_or(returned), &mut cut)));
    }
    if Js::is_true(field("cancelRequested")) {
        out.push(format!("cancel requested{}", field("cancelReason").map(|r| format!(": {}", plain(r))).unwrap_or_default()));
    }
    if let Some(chain) = field("chain").and_then(Js::as_array).filter(|c| !c.is_empty()) {
        out.push(format!("caused by the writes of runs: {}", chain.iter().map(plain).collect::<Vec<_>>().join(", ")));
    }

    match field("event") {
        Some(event) => match event.get("arrival") {
            Some(arrival) => event_lines(event, arrival, typing, &mut out, &mut cut),
            None => out.push(format!("event: {}", value(event, &mut cut))),
        },
        None => out.push("event: none".into()),
    }

    match field("writeRecords").and_then(Js::as_array) {
        Some(writes) if !writes.is_empty() => {
            out.push(format!("writes ({}):", word("writes")));
            for write in writes {
                let get = |k: &str| write.get(k).map(plain).unwrap_or_default();
                let rehearsed = if Js::is_false(write.get("committed")) { " (not committed)" } else { "" };
                let values = write.get("values").map(|v| format!(": {}", value(v, &mut cut))).unwrap_or_default();
                out.push(format!("  {} {} {} {}{rehearsed}{values}", get("action"), get("adapter"), get("recordType"), get("recordId")));
            }
        }
        _ => out.push(format!("writes: {}", field("writes").map(plain).unwrap_or_else(|| "0".into()))),
    }

    match field("trace").and_then(Js::as_array) {
        Some(trace) if !trace.is_empty() => {
            out.push(format!("trace ({}):", trace.len()));
            for entry in trace {
                out.push(format!("  {}", trace_line(entry, &mut cut)));
            }
        }
        Some(_) => out.push("trace: empty".into()),
        None => out.push(format!("trace: {} entries, which this store does not hand back", word("traceEntries"))),
    }

    for leaf in field("parked").and_then(Js::as_array).unwrap_or_default() {
        let get = |k: &str| leaf.get(k).filter(|v| !matches!(v, Js::Null)).map(plain);
        out.push(format!("parked: {} on {}{}", get("address").unwrap_or_default(), get("reason").unwrap_or_default(), get("wakeAt").map(|w| format!(" until {w}")).unwrap_or_default()));
    }
    for wait in field("stranded").and_then(Js::as_array).unwrap_or_default() {
        out.push(format!("stranded: {}", wait.get("says").map(plain).unwrap_or_default()));
    }

    let attempts = field("attempts").and_then(Js::as_array).unwrap_or_default();
    if attempts.len() > 1 {
        out.push("attempts:".into());
        for attempt in attempts {
            let get = |k: &str| attempt.get(k).filter(|v| !matches!(v, Js::Null)).map(plain);
            let error = get("error").map(|e| format!(": {e}")).unwrap_or_default();
            out.push(format!("  {} {}, started {}, {} writes{error}", get("attempt").unwrap_or_default(), get("status").unwrap_or_default(), get("startedAt").unwrap_or_default(), get("writes").unwrap_or_else(|| "0".into())));
        }
    }
    if cut {
        out.push(format!("(a value over {VALUE_CHARS} characters is cut; --json shows it whole)"));
    }
    out.join("\n")
}

fn event_lines(event: &Js, arrival: &Js, typing: &Typing, out: &mut Vec<String>, cut: &mut bool) {
    let get = |js: &Js, k: &str| js.get(k).filter(|v| !matches!(v, Js::Null)).map(plain);
    let occurred = get(event, "occurredAt").map(|at| format!(", occurred {at}")).unwrap_or_default();
    out.push(format!("event: an arrival on {} of {}{occurred}", get(arrival, "edge").unwrap_or_default(), get(arrival, "adapterType").unwrap_or_default()));
    if let Some(about) = arrival.get("about").filter(|a| !matches!(a, Js::Null)) {
        out.push(format!("  about: {} {}", get(about, "recordType").unwrap_or_default(), get(about, "externalId").unwrap_or_default()));
    }
    if let Some(actor) = arrival.get("actor").filter(|a| !matches!(a, Js::Null)) {
        out.push(format!("  actor: {}", value(actor, cut)));
    }
    if let Err(why) = typing {
        out.push(format!("  (every field shown, raw and typed: the module could not say which its record types declare: {why})"));
    }
    for (record, how) in records_of(arrival) {
        let record_type = get(&record, "recordType").unwrap_or_default();
        let declared = typing.as_ref().map(|types| types.get(&record_type));
        let about = match &declared {
            Ok(Some(Declared { about: Some(about), .. })) => format!(" {about}"),
            _ => String::new(),
        };
        out.push(format!("  {how} {record_type} {}:{about}", get(&record, "recordId").unwrap_or_default()));
        let fields = match record.get("fields") {
            Some(Js::Obj(fields)) => fields.clone(),
            _ => Obj::new(),
        };
        let shown: Vec<(String, &Js)> = match declared {
            Ok(Some(declared)) => declared.fields.iter().filter_map(|(name, key)| fields.get(key).or_else(|| fields.get(name)).map(|v| (name.clone(), v))).collect(),
            Ok(None) => {
                out.push(format!("    (every field shown: its module declares no record type {record_type})"));
                fields.iter().map(|(k, v)| (k.clone(), v)).collect()
            }
            Err(_) => fields.iter().map(|(k, v)| (k.clone(), v)).collect(),
        };
        for (name, field) in shown {
            out.push(format!("    {name}: {}", value(field, cut)));
        }
        if let Some(unknown) = record.get("unknown").and_then(Js::as_array).filter(|u| !u.is_empty()) {
            out.push(format!("    unknown (its module could not read them): {}", unknown.iter().map(plain).collect::<Vec<_>>().join(", ")));
        }
    }
}

/// One trace entry: its kind, then what it says.
fn trace_line(entry: &Js, cut: &mut bool) -> String {
    let get = |k: &str| entry.get(k).filter(|v| !matches!(v, Js::Null)).map(plain).unwrap_or_default();
    match entry.get("kind").and_then(Js::as_str).unwrap_or("?") {
        "gate" => format!("if: {}", get("outcome")),
        "block" => format!("block {}: {} landings", get("root"), get("positions")),
        "warning" => format!("warning {}: {}", get("code"), get("message")),
        "field_miss" => format!("field miss: {}.{} read null; the record has {}", get("binding"), get("field"), entry.get("available").and_then(Js::as_array).unwrap_or_default().iter().map(plain).collect::<Vec<_>>().join(", ")),
        "ai" => {
            let answered = if Js::is_true(entry.get("hasValue")) { "answered" } else { "no answer" };
            format!("AI {} ({answered}): {}", get("model"), value(entry.get("prompt").unwrap_or(&Js::Null), cut))
        }
        // An entry this text does not know by kind (a plugin's, an
        // extraction's) shows its members as they are.
        other => {
            let members: Vec<String> = match entry {
                Js::Obj(members) => members.iter().filter(|(k, _)| *k != "kind").map(|(k, v)| format!("{k} {}", value(v, cut))).collect(),
                _ => Vec::new(),
            };
            format!("{other}: {}", members.join(", "))
        }
    }
}

/// A text as itself, anything else as JSON.
fn plain(js: &Js) -> String {
    match js {
        Js::Str(s) => s.clone(),
        other => other.to_json(),
    }
}

/// A value as JSON, cut past VALUE_CHARS characters.
fn value(js: &Js, cut: &mut bool) -> String {
    let json = js.to_json();
    match json.char_indices().nth(VALUE_CHARS) {
        Some((at, _)) => {
            *cut = true;
            format!("{}…", &json[..at])
        }
        None => json,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run() -> Js {
        Js::parse(
            br#"{"runId":"r1","file":"billing","movement":"Payment Failed","status":"failed","startedAt":"t0","finishedAt":"t1","attempt":2,"deliveryId":null,"languageVersion":"0.14.2",
            "event":{"adapterType":"stripe","triggerType":"arrival","occurredAt":"t-1","arrival":{"adapterType":"stripe","edge":"Changes",
              "landing":{"recordId":"evt_1","recordType":"InvoiceChange","fields":{"id":"evt_1","type":"invoice.payment_failed","object":{"id":"in_1","amount_due":49000},"Id":"evt_1","Kind":"payment_failed"}},
              "parents":[{"recordId":"in_1","recordType":"Invoice","fields":{"id":"in_1","amount_due":490,"Id":"in_1","Amount Due":490}}],
              "about":{"recordType":"Invoice","externalId":"in_1"}}},
            "chain":[],"writes":1,"writeRecords":[{"adapter":"slack","recordType":"Message","recordId":"C1:1","action":"create","committed":true,"values":{"Message":"hello"}}],
            "error":"no plan for kwame@example.com","returned":null,"traceEntries":3,
            "trace":[{"kind":"gate","outcome":false},{"kind":"block","root":"chat-[ch:Channels WHERE ch.Name == \"accounts\"]->","positions":1},{"kind":"plugin","plugin":"render","ms":3}],
            "parked":[],"stranded":[],
            "attempts":[{"attempt":1,"status":"failed","startedAt":"s0","writes":0,"error":"CRM answered 503"},{"attempt":2,"status":"failed","startedAt":"t0","writes":1,"error":"no plan for kwame@example.com"}],
            "cancelRequested":false,"cancelReason":null}"#,
        )
        .unwrap()
    }

    fn fields(names: &[(&str, &str)]) -> Vec<(String, String)> {
        names.iter().map(|(name, key)| (name.to_string(), key.to_string())).collect()
    }

    fn typed() -> Typing {
        let mut types = BTreeMap::new();
        types.insert("InvoiceChange".to_string(), Declared { about: None, fields: fields(&[("Id", "Id"), ("Kind", "Kind")]) });
        types.insert("Invoice".to_string(), Declared { about: Some("An invoice; amounts in major units of its `Currency`".into()), fields: fields(&[("Id", "Id"), ("Amount Due", "Amount Due")]) });
        Ok(types)
    }

    #[test]
    fn a_run_is_its_status_error_the_typed_fields_of_each_record_once_and_a_line_per_write_and_trace_entry() {
        let shown = text(&run(), &typed());
        assert_eq!(
            shown,
            [
                "run r1: billing:Payment Failed failed (attempt 2)",
                "started t0, finished t1, language 0.14.2",
                "error: no plan for kwame@example.com",
                "event: an arrival on Changes of stripe, occurred t-1",
                "  about: Invoice in_1",
                "  landed InvoiceChange evt_1:",
                "    Id: \"evt_1\"",
                "    Kind: \"payment_failed\"",
                "  carried Invoice in_1: An invoice; amounts in major units of its `Currency`",
                "    Id: \"in_1\"",
                "    Amount Due: 490",
                "writes (1):",
                "  create slack Message C1:1: {\"Message\":\"hello\"}",
                "trace (3):",
                "  if: false",
                "  block chat-[ch:Channels WHERE ch.Name == \"accounts\"]->: 1 landings",
                "  plugin: plugin \"render\", ms 3",
                "attempts:",
                "  1 failed, started s0, 0 writes: CRM answered 503",
                "  2 failed, started t0, 1 writes: no plan for kwame@example.com",
            ]
            .join("\n")
        );
    }

    #[test]
    fn a_field_its_module_keys_by_id_is_shown_by_its_name() {
        let mut types = BTreeMap::new();
        types.insert("InvoiceChange".to_string(), Declared { about: None, fields: fields(&[("Event Type", "type")]) });
        let shown = text(&run(), &Ok(types));
        assert!(shown.contains("  landed InvoiceChange evt_1:\n    Event Type: \"invoice.payment_failed\"\n"), "{shown}");
        assert!(shown.contains("    (every field shown: its module declares no record type Invoice)"), "{shown}");
    }

    #[test]
    fn a_module_that_cannot_describe_itself_shows_every_field_and_says_why() {
        let shown = text(&run(), &Err("the server is down".into()));
        assert!(shown.contains("(every field shown, raw and typed: the module could not say which its record types declare: the server is down)"), "{shown}");
        assert!(shown.contains("    object: {\"id\":\"in_1\",\"amount_due\":49000}\n"), "{shown}");
    }

    #[test]
    fn a_long_value_is_cut_once_said() {
        let mut run = run();
        if let Js::Obj(fields) = &mut run {
            fields.insert("returned".into(), Js::Obj(crate::obj! { "value" => Js::str("x".repeat(400)) }));
        }
        let shown = text(&run, &typed());
        assert!(shown.contains(&format!("returned: \"{}…", "x".repeat(VALUE_CHARS - 1))), "{shown}");
        assert!(shown.ends_with("(a value over 300 characters is cut; --json shows it whole)"), "{shown}");
    }
}

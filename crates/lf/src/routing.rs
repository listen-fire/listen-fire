//! Routing read from source: every `listen … fire …` across the project's
//! files is the routing table (as movement-engine's
//! `movement/file_listeners.ts` reads it), plus the scope gate an inbound event must
//! clear to reach a listen (`triggers/listen_config.ts`) and the trigger
//! event a run is handed (`triggers/trigger_event.ts`, with
//! `engine/inbound/discriminate.ts`).

use std::collections::HashMap;

use movement_parser::ast::{NamedArg, RValue, Statement};
use movement_parser::util::form::external_text;
use serde_json::Value as Json;

use crate::json::{Js, Obj};
use crate::wire::js_of_json;

/// One `listen` statement, with its instance's construction resolved (`FileListener`).
#[derive(Debug, Clone)]
pub struct Listen {
    /// The file it is in, by name.
    pub file: String,
    /// The adapter slug (the construction's callee, import alias resolved).
    pub adapter: String,
    /// The listen's config block, statically evaluated.
    pub config: Obj,
    pub movement_name: String,
    /// The credential its construction names (`connect … using X`), by its
    /// name in the secrets (an import alias resolved); None when the
    /// construction names none, and for a host unit.
    pub credential: Option<String>,
    /// Its construction's other arguments (`{ base: "CRM" }`), by name, as
    /// their source text: those the module declares as position args say
    /// which position the connection is in (RunningExternal::position_settings).
    pub args: Vec<(String, String)>,
}

impl Listen {
    /// The listen's pipeline, `listen:<file>:<movement>`: what its receipts,
    /// its runs and its polls name it by.
    pub fn pipeline(&self) -> String {
        format!("listen:{}:{}", self.file, self.movement_name)
    }

    /// Whether an event delivered for `credential` reaches this listen (the
    /// platform's per-trigger credential narrowing): a listen whose
    /// construction names a credential hears only that credential's
    /// deliveries. A listen that names none hears every delivery, and a
    /// delivery that names none (addressed to the module's install, which
    /// serves every connection) reaches every listen.
    pub fn hears(&self, credential: Option<&str>) -> bool {
        match (self.credential.as_deref(), credential) {
            (Some(own), Some(delivered)) => own == delivered,
            _ => true,
        }
    }
}

/// `configValueOf`: a listen config value, statically evaluated; anything
/// that does not reduce to a static value keeps its raw text.
fn config_value_of(arg: &NamedArg) -> Js {
    let raw = external_text(&arg.value.raw).into_owned();
    if arg.is_type == Some(true) {
        return Js::Str(raw.trim().to_string());
    }
    let lowered = movement_parser::parse_expression(&arg.value.raw)
        .ok()
        .and_then(|tree| movement_parser::lowering::lower_expression_json(&tree, &arg.value.raw).ok());
    let Some(lowered) = lowered else { return Js::Str(raw.trim().to_string()) };
    let static_value = |e: &Json| -> Option<Js> {
        match e.get("type").and_then(Json::as_str) {
            Some("static") => Some(external_js(e.get("value").unwrap_or(&Json::Null))),
            _ => None,
        }
    };
    if let Some(value) = static_value(&lowered) {
        return value;
    }
    if lowered.get("type").and_then(Json::as_str) == Some("list")
        && let Some(elements) = lowered.get("elements").and_then(Json::as_array)
    {
        let read: Option<Vec<Js>> = elements
            .iter()
            .map(|e| match e.get("type").and_then(Json::as_str) {
                Some("static") => static_value(e),
                // `fields: [domains]` — bare names read as root-less property nodes.
                Some("property") => e.get("propertyTypeId").and_then(Json::as_str).map(|s| Js::Str(external_text(s).into_owned())),
                _ => None,
            })
            .collect();
        if let Some(read) = read {
            return Js::Arr(read);
        }
    }
    Js::Str(raw.trim().to_string())
}

/// A lowered static's value, its texts out of the engine's form.
fn external_js(value: &Json) -> Js {
    match value {
        Json::String(s) => Js::Str(external_text(s).into_owned()),
        other => js_of_json(other),
    }
}

/// The construction argument `connect … using X` writes the credential to.
const CREDENTIAL_ARG: &str = "credentials";

/// `collectListens` for one file: the listens of `file`, whose program is
/// `program` (crate::sources::Parsed reads them with its parse).
pub fn listens_of(file: &str, program: &movement_parser::ast::Program) -> Vec<Listen> {
    let mut listens = Vec::new();
    let mut originals: HashMap<String, String> = HashMap::new();
    // Each instance's adapter, credential and other arguments, by the instance's name.
    let mut constructions: HashMap<String, (String, Option<String>, Vec<(String, String)>)> = HashMap::new();
    let mut declared = Vec::new();
    for statement in &program.statements {
        match statement {
            Statement::Import(import) => {
                for name in &import.names {
                    if let Some(alias) = &name.alias {
                        originals.insert(alias.clone(), name.name.clone());
                    }
                }
            }
            Statement::Assign(assign) => {
                if let RValue::Construct { construct } = &assign.value {
                    let adapter = originals.get(&construct.callee).cloned().unwrap_or_else(|| construct.callee.clone());
                    let credential = construct
                        .args
                        .iter()
                        .find(|a| a.name == CREDENTIAL_ARG)
                        .and_then(|a| movement_parser::catalog::helpers::unwrap_credential_arg(&a.value.raw));
                    let mut args: Vec<(String, String)> =
                        construct.args.iter().filter(|a| a.name != CREDENTIAL_ARG).map(|a| (a.name.clone(), a.value.raw.clone())).collect();
                    args.sort();
                    constructions.insert(assign.name.clone(), (adapter, credential, args));
                }
            }
            Statement::Listen(listen) => declared.push(listen),
            _ => {}
        }
    }
    for listen in declared {
        // A unit the file does not bind itself is the host's own.
        let unit = movement_parser::version::RUN_HOST_UNITS.iter().find(|u| **u == listen.instance).map(|u| u.to_string());
        let Some((adapter, credential, args)) = constructions.get(&listen.instance).cloned().or(unit.map(|u| (u, None, Vec::new()))) else { continue };
        let credential = credential.map(|local| originals.get(&local).cloned().unwrap_or(local));
        let mut config = Obj::new();
        for arg in &listen.config {
            config.insert(arg.name.clone(), config_value_of(arg));
        }
        listens.push(Listen {
            file: file.to_string(),
            adapter,
            config,
            movement_name: listen.movement.clone(),
            credential,
            args,
        });
    }
    listens
}

/// `eventConfigList`.
fn event_config_list(events: Option<&Js>) -> Vec<String> {
    match events {
        Some(Js::Arr(items)) => items.iter().filter_map(Js::as_str).map(str::to_string).collect(),
        Some(Js::Str(s)) => vec![s.clone()],
        _ => Vec::new(),
    }
}

/// How an event reached lf: pushed (a webhook, `emit`, a unit's tick), or
/// returned by a poll of one listen's source.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arrival {
    Pushed,
    Polled,
}

/// `eventMatchesTriggerScope`: the listen's chosen events, an
/// Airtable-style table scope, and a changed field (`field`) with the value
/// it became (`becomes`). A source labels each event with its kind
/// (`eventType`), pushed or polled, and the chosen events narrow by it. A
/// polled event with no label (a module older than adapter protocol 2.3)
/// still reaches its listen: the poll was made for that listen with its
/// config (the caller says so, crate::runs).
pub fn event_matches_trigger_scope(event: &Js, config: &Obj, arrival: Arrival) -> bool {
    let events = event_config_list(config.get("events"));
    if !events.is_empty() {
        match (event.get("eventType").and_then(Js::as_str), arrival) {
            (Some(t), _) if events.iter().any(|e| e == t) => {}
            (None, Arrival::Polled) => {}
            (Some(_), _) | (None, Arrival::Pushed) => return false,
        }
    }
    if let Some(Js::Str(table)) = config.get("table")
        && !table.is_empty()
        && let Some(record_type) = event.get("recordType")
        && record_type.as_str() != Some(table.as_str())
    {
        return false;
    }
    if let Some(Js::Str(field)) = config.get("field")
        && !field.is_empty()
    {
        let changed = event.get("changedFields").and_then(Js::as_array).unwrap_or(&[]);
        if !changed.iter().any(|f| f.as_str() == Some(field.as_str())) {
            return false;
        }
        if let Some(value) = config.get("becomes")
            && !became_value(event.get("payload"), field, value)
        {
            return false;
        }
    }
    true
}

/// `becameValue`: the field's new value (`payload.fields`) is the value and
/// its previous one (`payload.previous`, `FieldChangePayload`) was not; a
/// field missing from `previous` had no value before.
fn became_value(payload: Option<&Js>, field: &str, value: &Js) -> bool {
    let cell = |key: &str| payload.and_then(|p| p.get(key)).and_then(|cells| cells.get(field));
    same_value(cell("fields"), value) && !same_value(cell("previous"), value)
}

/// `sameValue`: equal as data, a list or an object by its contents.
fn same_value(held: Option<&Js>, value: &Js) -> bool {
    match (held, value) {
        (None, _) => false,
        (Some(Js::Num(a)), Js::Num(b)) => a.as_f64() == b.as_f64(),
        (Some(held), value) => held.to_json() == value.to_json(),
    }
}

/// The listen config key that routes inbound mail: a module that declares
/// it (`@lf/email`) has each message reach the listen whose `key` is the
/// plus-suffix of the address it was sent to.
pub const ROUTING_KEY: &str = "key";

/// Whether a module's listen vocabulary declares the routing key.
pub fn routes_by_key(listen_vocabulary: &Obj) -> bool {
    let entries = listen_vocabulary.get("listenConfig").and_then(Js::as_array).unwrap_or(&[]);
    entries.iter().any(|entry| entry.get("key").and_then(Js::as_str) == Some(ROUTING_KEY))
}

/// The plus-suffix of the address a message was delivered to (its
/// `recipient`, `<box>+<key>@<domain>`), lowercased: a mail server hands the
/// address back in whatever case the sender typed. None for the box itself.
pub fn plus_suffix_of(event: &Js) -> Option<String> {
    let recipient = event.get("payload").and_then(|p| p.get("recipient")).and_then(Js::as_str)?;
    recipient.split(',').find_map(|address| {
        let address = address.trim();
        let address = address.rsplit_once('<').map_or(address, |(_, bracketed)| bracketed.trim_end_matches('>'));
        let (local, _domain) = address.rsplit_once('@')?;
        let (_box, key) = local.split_once('+')?;
        (!key.is_empty()).then(|| key.to_lowercase())
    })
}

/// The routing gate (the platform's `findTriggerByInboundKey`): a message
/// reaches a listen when its address's plus-suffix is the listen's `key`, and
/// a listen with no key hears only the mail sent to the box itself. A suffix
/// no listen has reaches none: mail is never fanned out to every listen.
pub fn address_matches_key(event: &Js, config: &Obj) -> bool {
    let key = config.get(ROUTING_KEY).and_then(Js::as_str).map(str::to_lowercase);
    plus_suffix_of(event) == key
}

/// The line a message no listen is keyed for is refused with.
pub fn unrouted_line(external: &str, event: &Js) -> String {
    match plus_suffix_of(event) {
        Some(key) => format!("no listen on {external} has the key \"{key}\" (the plus-suffix of the address the message was sent to): it runs nothing"),
        None => format!("no listen on {external} is without a key, and the message was sent to the box itself, with no plus-suffix: it runs nothing"),
    }
}

/// `readPath`.
fn read_path<'a>(value: &'a Js, path: &str) -> Option<&'a Js> {
    path.split('.').try_fold(value, |at, key| at.get(key))
}

/// `discriminateEvent`'s choice: the event type the event is.
fn select_event_type<'a>(event: &Js, event_types: &'a [Js]) -> Option<&'a Js> {
    if let Some(tag) = event.get("tag") {
        return event_types.iter().find(|t| t.get("tag") == Some(tag));
    }
    let payload = event.get("payload").unwrap_or(&Js::Null);
    event_types.iter().find(|t| {
        let Some(matcher) = t.get("match") else { return false };
        let path = matcher.get("path").and_then(Js::as_str).unwrap_or_default();
        let Some(Js::Str(value)) = read_path(payload, path) else { return false };
        match matcher.get("equals") {
            Some(Js::Arr(options)) => options.iter().any(|o| o.as_str() == Some(value)),
            Some(Js::Str(equals)) => equals == value,
            _ => false,
        }
    })
}

/// `triggerEventOf`: the event as a run is handed it.
pub fn trigger_event_of(pipeline_input_id: &str, adapter_type: &str, event: &Js, event_types: &[Js], now: &str) -> Js {
    let root_record_type =
        if event_types.is_empty() { None } else { select_event_type(event, event_types).and_then(|t| t.get("positionType")).cloned() };
    let external_type = event.get("recordType").cloned().or_else(|| root_record_type.clone());
    let truthy = |v: &Js| !matches!(v, Js::Null | Js::Bool(false)) && v.as_str() != Some("");
    let mut out = Obj::new();
    out.insert("pipelineInputId".into(), Js::str(pipeline_input_id));
    out.insert("adapterType".into(), Js::str(adapter_type));
    out.insert("triggerType".into(), Js::str("webhook"));
    if let Some(payload) = event.get("payload") {
        out.insert("payload".into(), payload.clone());
    }
    if let Some(change) = event.get("changeType").filter(|v| truthy(v)) {
        out.insert("changeType".into(), change.clone());
    }
    if let Some(root) = root_record_type.filter(truthy) {
        out.insert("rootRecordType".into(), root);
    }
    if let Some(external_id) = event.get("externalId") {
        let mut reference = Obj::new();
        reference.insert("adapterType".into(), Js::str(adapter_type));
        reference.insert("externalId".into(), external_id.clone());
        if let Some(record_type) = external_type.filter(truthy) {
            reference.insert("recordType".into(), record_type);
        }
        out.insert("externalRecordRef".into(), Js::Obj(reference));
    }
    for key in ["actor", "changedFields", "idempotencyKey"] {
        if let Some(value) = event.get(key).filter(|v| truthy(v)) {
            out.insert(key.into(), value.clone());
        }
    }
    out.insert("occurredAt".into(), event.get("occurredAt").filter(|v| !matches!(v, Js::Null)).cloned().unwrap_or_else(|| Js::str(now)));
    Js::Obj(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::{MovementFile, Parsed};
    use std::path::PathBuf;

    /// Every listen across the files.
    fn collect_listens(files: &[MovementFile]) -> Vec<Listen> {
        files.iter().flat_map(|file| Parsed::of(file).listens).collect()
    }

    fn js(text: &str) -> Js {
        Js::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn a_listen_is_read_with_its_construction_and_static_config() {
        let source = "import { acme_crm as crm_kind } from adapters\nimport { acme } from credentials\n\ncrm = connect crm_kind using acme\n\nfunction welcome(company: <crm-[:Company]->>) {\n  write crm-[:Company]-> { Name: \"x\" }\n}\n\nlisten to crm { events: [\"company.created\"] } fire welcome\n";
        let files = vec![MovementFile { name: "companies".into(), path: PathBuf::from("companies.mvt"), source: source.into(), version: None }];
        let listens = collect_listens(&files);
        assert_eq!(listens.len(), 1);
        let listen = &listens[0];
        assert_eq!((listen.adapter.as_str(), listen.movement_name.as_str()), ("acme_crm", "welcome"));
        assert_eq!(Js::Obj(listen.config.clone()).to_json(), r#"{"events":["company.created"]}"#);
    }

    #[test]
    fn a_listen_names_its_constructions_credential_and_hears_only_its_deliveries() {
        let source = "import { inbox } from adapters\nimport { inbox_main as a_cred, `Inbox B` } from credentials\n\na = connect inbox using a_cred\nb = connect inbox using `Inbox B`\nc = connect inbox\n\nfunction noted() {\n}\n\nlisten to a fire noted\nlisten to b fire noted\nlisten to c fire noted\nlisten to manual fire noted\n";
        let files = vec![MovementFile { name: "noted".into(), path: PathBuf::from("noted.mvt"), source: source.into(), version: None }];
        let listens = collect_listens(&files);
        let credentials: Vec<Option<&str>> = listens.iter().map(|l| l.credential.as_deref()).collect();
        assert_eq!(credentials, [Some("inbox_main"), Some("Inbox B"), None, None], "an alias is resolved to the secrets' name");
        let (a, c) = (&listens[0], &listens[2]);
        assert!(a.hears(Some("inbox_main")) && !a.hears(Some("Inbox B")), "a listen hears only its own connection's deliveries");
        assert!(a.hears(None), "a delivery that names no credential reaches every listen");
        assert!(c.hears(Some("inbox_main")) && c.hears(None), "a listen whose construction names none hears every delivery");
    }

    #[test]
    fn a_listen_names_its_file_not_its_place() {
        let file = |name: &str, movement: &str| MovementFile {
            name: name.into(),
            path: PathBuf::from(format!("{name}.mvt")),
            source: format!("function {movement}() {{\n}}\n\nlisten to manual fire {movement}\n"),
            version: None,
        };
        let pairs = |files: &[MovementFile]| {
            let mut pairs: Vec<(String, String)> = collect_listens(files).into_iter().map(|l| (l.file, l.movement_name)).collect();
            pairs.sort();
            pairs
        };
        let (orders, alerts) = (file("orders/sync", "sync"), file("alerts", "alert"));
        let forward = pairs(&[orders.clone(), alerts.clone()]);
        assert_eq!(forward, vec![("alerts".to_string(), "alert".to_string()), ("orders/sync".to_string(), "sync".to_string())]);
        assert_eq!(pairs(&[alerts, orders]), forward);
    }

    #[test]
    fn the_scope_gate_reads_the_chosen_events_and_the_table() {
        let config = match js(r#"{"events":["company.created"]}"#) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        assert!(event_matches_trigger_scope(&js(r#"{"eventType":"company.created"}"#), &config, Arrival::Pushed));
        assert!(!event_matches_trigger_scope(&js(r#"{"eventType":"company.updated"}"#), &config, Arrival::Pushed));
        assert!(!event_matches_trigger_scope(&js(r#"{}"#), &config, Arrival::Pushed));
        assert!(event_matches_trigger_scope(&js(r#"{}"#), &Obj::new(), Arrival::Pushed));
    }

    /// The table of cases the engine's TypeScript is held to as well
    /// (`eventMatchesTriggerScope`).
    #[test]
    fn the_field_and_becomes_gates_match_the_shared_table_of_cases() {
        let table = js(include_str!("../../../packages/engine-contracts/conformance/listen-field-change.json"));
        let cases = table.get("cases").and_then(Js::as_array).unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let Some(Js::Obj(config)) = case.get("config") else { panic!("a case has a config") };
            let event = case.get("event").unwrap();
            let expected = Js::is_true(case.get("matches"));
            for arrival in [Arrival::Pushed, Arrival::Polled] {
                assert_eq!(event_matches_trigger_scope(event, config, arrival), expected, "{:?}", case.get("case"));
            }
        }
    }

    #[test]
    fn a_becomes_gate_compares_numbers_as_numbers() {
        let config = match js(r#"{"field":"Score","becomes":3}"#) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        let event = js(r#"{"changedFields":["Score"],"payload":{"fields":{"Score":3.0},"previous":{"Score":2}}}"#);
        assert!(event_matches_trigger_scope(&event, &config, Arrival::Pushed));
        let unchanged = js(r#"{"changedFields":["Score"],"payload":{"fields":{"Score":3.0},"previous":{"Score":3}}}"#);
        assert!(!event_matches_trigger_scope(&unchanged, &config, Arrival::Pushed));
    }

    #[test]
    fn a_polled_event_with_no_event_type_is_not_narrowed_by_the_chosen_events() {
        let config = match js(r#"{"events":["company.created"],"table":"Company"}"#) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        assert!(event_matches_trigger_scope(&js(r#"{}"#), &config, Arrival::Polled));
        assert!(event_matches_trigger_scope(&js(r#"{"eventType":"company.created"}"#), &config, Arrival::Polled));
        assert!(!event_matches_trigger_scope(&js(r#"{"eventType":"company.updated"}"#), &config, Arrival::Polled));
        assert!(!event_matches_trigger_scope(&js(r#"{"recordType":"Person"}"#), &config, Arrival::Polled));
    }

    #[test]
    fn mail_reaches_the_listen_keyed_by_its_plus_suffix_and_no_other() {
        let keyed = |key: &str| match js(&format!(r#"{{"key":"{key}"}}"#)) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        let listens = [("deals", keyed("deals")), ("intros", keyed("Intros")), ("box", Obj::new())];
        let reached = |recipient: &str| -> Vec<&str> {
            let event = js(&format!(r#"{{"payload":{{"recipient":"{recipient}"}}}}"#));
            listens.iter().filter(|(_, config)| address_matches_key(&event, config)).map(|(name, _)| *name).collect()
        };
        assert_eq!(reached("inbox+deals@acme.test"), ["deals"]);
        assert_eq!(reached("Inbox <inbox+INTROS@acme.test>"), ["intros"]);
        assert_eq!(reached("inbox@acme.test"), ["box"]);
        assert!(reached("inbox+hiring@acme.test").is_empty());
        let stray = js(r#"{"payload":{"recipient":"inbox+hiring@acme.test"}}"#);
        assert!(unrouted_line("email", &stray).contains(r#"no listen on email has the key "hiring""#));
        let vocabulary = match js(r#"{"listenConfig":[{"key":"key","required":false}]}"#) {
            Js::Obj(map) => map,
            _ => unreachable!(),
        };
        assert!(routes_by_key(&vocabulary));
        assert!(!routes_by_key(&Obj::new()));
    }

    #[test]
    fn the_trigger_event_is_built_in_the_typescript_order() {
        let event = js(r#"{"payload":{"id":"c-1"},"externalId":"c-1","eventType":"company.created","changeType":"create","recordType":"Company"}"#);
        let types = vec![js(r#"{"tag":"company.created","positionType":"Company"}"#)];
        assert_eq!(
            trigger_event_of("listen:companies:welcome", "acme_crm", &event, &types, "2026-10-17T00:00:00.000Z").to_json(),
            r#"{"pipelineInputId":"listen:companies:welcome","adapterType":"acme_crm","triggerType":"webhook","payload":{"id":"c-1"},"changeType":"create","externalRecordRef":{"adapterType":"acme_crm","externalId":"c-1","recordType":"Company"},"occurredAt":"2026-10-17T00:00:00.000Z"}"#
        );
        let tagged = js(r#"{"payload":{},"tag":"company.created"}"#);
        assert_eq!(trigger_event_of("p", "a", &tagged, &types, "t").get("rootRecordType").and_then(Js::as_str), Some("Company"));
    }
}
